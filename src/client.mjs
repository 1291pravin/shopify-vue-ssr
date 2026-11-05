import { createApp, createSSRApp } from 'vue'

export function createIslandRegistry(names, components, { warn = console.warn } = {}) {
  const registry = Object.create(null)
  for (const name of names) {
    if (Object.hasOwn(components, name) && components[name]) registry[name] = components[name]
    else warn(`SSR island "${name}" is not registered in the components map`)
  }
  return registry
}

// Only fixed messages and route templates leave the browser. Never send Vue's
// raw warning text, props, DOM contents, URL queries, hashes, or error objects.
export const consoleReporter = event => console.warn('[SSR]', event)
export const callbackReporter = callback => event => callback(event)
export const dataLayerReporter = (eventName = 'ssr_problem') => event => {
  (window.dataLayer ??= []).push({ event: eventName, ...event })
}

export function mountIslands({ registry, scope = document, consent = () => false, reporter, page = 'storefront', observe = true, onMismatch = 'keep' } = {}) {
  if (!['keep', 'remount'].includes(onMismatch)) throw new Error('onMismatch must be "keep" or "remount"')
  const apps = new Map()
  window.__ssr ??= { hydrated: [], csr: [], mismatches: [] }
  let active
  const report = (type, component, key) => {
    try {
      if (reporter && consent() === true) reporter({ type, component: Object.hasOwn(registry, component) ? component : 'unknown', key: /^[a-f0-9]{32}$/.test(key) ? key : '', page,
        message: type === 'hydration-mismatch' ? 'Island hydration mismatch' : 'Island mount failed', detail: { phase: 'mount' } })
    } catch { /* A reporter must never stop an island from mounting. */ }
  }
  const record = (message, type = 'hydration-mismatch') => {
    window.__ssr.mismatches.push(`${active?.name ?? 'island'}: ${message}`)
    if (active) { report(type, active.name, active.key); if (type === 'hydration-mismatch') active.mismatched = true }
  }
  const originals = {}
  for (const method of ['warn', 'error']) {
    originals[method] = console[method]
    console[method] = (...values) => {
      const text = values.map(value => value instanceof Error ? value.message : String(value)).join(' ')
      if (active && /hydration/i.test(text)) record(text)
      originals[method](...values)
    }
  }
  function load(target = document) {
    const islands = [...target.querySelectorAll('vue-island')]
    if (target.nodeType === 1 && target.matches('vue-island')) islands.unshift(target)
    for (const island of islands) {
      if (apps.has(island)) continue
      const name = island.dataset.component ?? '', key = island.dataset.ssrKey ?? ''
      const state = active = { name, key, mismatched: false }
      let app
      try {
        const root = island.querySelector(':scope > [data-ssr-root]')
        const data = island.querySelector(':scope > script[data-props]')
        if (!root || !data) throw new Error('Island root or exact props JSON is missing')
        let props
        try { props = JSON.parse(data.textContent ?? '') }
        catch (error) { throw Object.assign(new Error(`Invalid props JSON for island "${name}" on ${window.location.href}: ${error.message}`), { type: 'invalid-props' }) }
        if (!props || typeof props !== 'object' || Array.isArray(props)) throw new Error('Island props must be a JSON object')
        const clientData = island.querySelector(':scope > script[data-client-props]')
        if (clientData) {
          let clientProps
          try {
            clientProps = JSON.parse(clientData.textContent ?? '')
            if (!clientProps || typeof clientProps !== 'object' || Array.isArray(clientProps)) throw new Error('Client props must be a JSON object')
          } catch (error) { throw Object.assign(new Error(`Invalid client props JSON for island "${name}" on ${window.location.href}: ${error.message}`), { type: 'invalid-props' }) }
          props = { ...props, ...clientProps }
        }
        if (!Object.hasOwn(registry, name)) throw new Error(`Unknown island component: ${name}`)
        const hydrate = root.dataset.ssr === '1'
        let failed = false
        const start = factory => {
          const instance = factory(registry[name], props)
          instance.config.warnHandler = message => {
            if (/hydration|mismatch/i.test(message)) {
              window.__ssr.mismatches.push(`${name}: ${message}`)
              report('hydration-mismatch', name, key)
              state.mismatched = true
              originals.warn(message)
            }
          }
          instance.config.errorHandler = error => { failed = true; window.__ssr.mismatches.push(`${name}: ${String(error)}`); report('mount-error', name, key) }
          instance.mount(root)
          return instance
        }
        app = start(hydrate ? createSSRApp : createApp)
        // A plain mismatch (for example a cart count that differs) is patched by Vue and the island keeps
        // working, so by default it stays hydrated. If hydration broke the island, or onMismatch is
        // 'remount', the stored HTML is discarded and the island renders again in the browser with the same props.
        let recovered = false
        if (hydrate && (failed || (state.mismatched && onMismatch === 'remount'))) {
          app.unmount()
          root.textContent = ''
          failed = false
          app = start(createApp)
          recovered = true
        }
        if (failed) { app.unmount(); continue }
        apps.set(island, app)
        if (recovered) root.dataset.ssrRecovered = '1'
        window.__ssr[hydrate && !recovered ? 'hydrated' : 'csr'].push(recovered ? { component: name, key, recovered: true } : { component: name, key })
      } catch (error) { record(error.message, 'mount-error'); if (error.type === 'invalid-props') originals.error(`[SSR] ${error.message}`); app?.unmount() }
      finally { active = undefined }
    }
  }
  function unload(target) {
    for (const [island, app] of apps) if (island === target || target.contains(island)) { app.unmount(); apps.delete(island) }
  }
  const onLoad = event => { if (event.target?.nodeType === 1) load(event.target) }
  const onUnload = event => { if (event.target?.nodeType === 1) unload(event.target) }
  const onReady = () => load(scope)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true })
  else onReady()
  if (observe) {
    document.addEventListener('shopify:section:load', onLoad)
    document.addEventListener('shopify:section:unload', onUnload)
  }
  return { load, unload, destroy() {
    unload(document)
    document.removeEventListener('DOMContentLoaded', onReady)
    document.removeEventListener('shopify:section:load', onLoad)
    document.removeEventListener('shopify:section:unload', onUnload)
    for (const method of ['warn', 'error']) console[method] = originals[method]
  } }
}
