import { registry } from 'virtual:shopify-vue-ssr/islands'
import { createApp, createSSRApp, getCurrentInstance, nextTick } from 'vue'

function describe(node) {
  const text = node?.outerHTML ?? node?.textContent ?? null
  return text && text.length > 600 ? text.slice(0, 600) + '...' : text
}
// Vue passes DOM nodes as warning arguments; print them as a readable selector, not "[object HTMLElement]".
function label(value) {
  if (!value || typeof value !== 'object' || !('nodeType' in value)) return String(value)
  if (value.nodeType !== 1) return JSON.stringify((value.textContent ?? '').slice(0, 80))
  const classes = [...value.classList].slice(0, 2).map(name => '.' + name.replace(/[^\w-]/g, '\\$&')).join('')
  return ` <${value.nodeName.toLowerCase()}${classes}>`
}
function firstDifference(a, b, path = 'root') {
  if (!a || !b || a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return { path, serverHtml: describe(a), clientHtml: describe(b) }
  if (a.nodeType === 3 || a.nodeType === 8) { if (a.textContent !== b.textContent) return { path, serverHtml: describe(a), clientHtml: describe(b) }; return }
  // Style is compared after the browser normalises it ("a:1px" and "a: 1px" are the same declaration).
  const value = (el, key) => key === 'style' ? el.style.cssText : el.getAttribute(key)
  if (path !== 'root' && a.nodeType === 1 && (a.getAttributeNames().sort().join() !== b.getAttributeNames().sort().join() || a.getAttributeNames().some(key => value(a, key) !== value(b, key)))) return { path, serverHtml: describe(a), clientHtml: describe(b) }
  for (let i = 0; i < Math.max(a.childNodes.length, b.childNodes.length); i++) {
    const child = a.childNodes[i] ?? b.childNodes[i]
    const firstClass = child.nodeType === 1 ? child.classList[0] : undefined
    const result = firstDifference(a.childNodes[i], b.childNodes[i], `${path}/${child.nodeName.toLowerCase()}${firstClass ? '.' + firstClass : ''}[${i + 1}]`)
    if (result) return result
  }
}
export async function verify({ component, props, html }) {
  if (!Object.hasOwn(registry, component)) throw new Error(`Unknown island component: ${component}`)
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.append(root)
  const before = root.cloneNode(true)
  const warnings = [], errors = []
  let renderSource
  const original = { warn: console.warn, error: console.error }
  for (const method of ['warn', 'error']) console[method] = (...args) => {
    const message = args.map(label).join(' ')
    if (/hydration|mismatch/i.test(message)) warnings.push(message)
    else if (method === 'error') errors.push({ message, stack: new Error(message).stack })
  }
  const app = createSSRApp(registry[component], props)
  app.config.warnHandler = (message, instance) => {
    if (/hydration|mismatch/i.test(message)) {
      warnings.push(message)
      renderSource ??= instance?.$?.render?.toString()
    } else errors.push({ message, stack: new Error(message).stack })
  }
  app.config.errorHandler = error => errors.push({ message: error.message, stack: error.stack })
  try {
    app.mount(root)
    let clientHtml = root.innerHTML, mismatch
    if (warnings.length) {
      // Vue intentionally leaves some mismatched attributes unchanged. A fresh
      // client render supplies the expected tree. Suppress mounted enhancements
      // so the diff compares initial trees, not deliberate after-mount changes.
      const expected = document.createElement('div')
      document.body.append(expected)
      const client = createApp(registry[component], props)
      client.mixin({ beforeMount() { const instance = getCurrentInstance(); if (instance) instance.m = null } })
      client.config.errorHandler = error => errors.push({ message: error.message, stack: error.stack })
      try {
        client.mount(expected)
        clientHtml = expected.innerHTML
        mismatch = firstDifference(before, expected) ?? { path: 'root', serverHtml: html, clientHtml }
      } finally { client.unmount(); expected.remove() }
    }
    await nextTick(); await nextTick()
    return { ok: !warnings.length && !errors.length, warnings, errors, mismatch, serverHtml: html, clientHtml, renderSource }
  } finally { app.unmount(); root.remove(); console.warn = original.warn; console.error = original.error }
}
