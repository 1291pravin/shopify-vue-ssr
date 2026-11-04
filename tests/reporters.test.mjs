import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://store.invalid/customers/private-email@example.com?email=private-email@example.com#secret' })
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node']) globalThis[key] = dom.window[key]
const { defineComponent, h } = await import('vue')
const { mountIslands, callbackReporter, dataLayerReporter, consoleReporter } = await import('../src/client.mjs')
const Good = defineComponent({ render() { return h('p', 'expected') } })
const Bad = defineComponent({ setup() { throw new Error('private-email@example.com') } })
function element({ component = 'Good', props = '{}', hit = false } = {}) {
  const node = document.createElement('vue-island')
  node.dataset.component = component; node.dataset.ssrKey = 'a'.repeat(32)
  node.innerHTML = `<script data-props type="application/json">${props}</script><div data-ssr-root ${hit ? 'data-ssr="1"' : 'data-ssr-miss="test"'}><p>server text</p></div>`
  document.body.append(node)
  return node
}
after(() => { dom.window.close(); for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node']) delete globalThis[key] })

test('reporters stay silent without explicit consent, including thrown/false/nonboolean consent', () => {
  for (const consent of [undefined, () => false, () => 'yes', () => { throw new Error('no') }]) {
    const events = []
    element({ component: 'Bad' })
    const runtime = mountIslands({ registry: { Good, Bad }, consent, reporter: callbackReporter(event => events.push(event)), observe: false })
    runtime.load()
    assert.equal(events.length, 0)
    runtime.destroy(); document.body.innerHTML = ''
  }
})

test('consenting mount errors and mismatches send fixed metadata without props, raw errors or actual URL', () => {
  const originalWarn = console.warn
  console.warn = () => {}
  const events = []
  element({ component: 'Bad', props: '{"text":"private-email@example.com"}' })
  element({ hit: true })
  const runtime = mountIslands({ registry: { Good, Bad }, consent: () => true, page: 'product', reporter: callbackReporter(event => events.push(event)), observe: false })
  try {
    runtime.load()
    assert.ok(events.some(event => event.type === 'mount-error'))
    assert.ok(events.some(event => event.type === 'hydration-mismatch'))
    assert.deepEqual(Object.keys(events[0]).sort(), ['component', 'detail', 'key', 'message', 'page', 'type'])
    assert.doesNotMatch(JSON.stringify(events), /private-email|secret|server text|expected on client/)
    assert.equal(events[0].page, 'product')
    let logged
    console.warn = (...args) => { logged = args }
    consoleReporter(events[0]); assert.equal(logged[0], '[SSR]')
    dataLayerReporter()(events[0]); assert.equal(window.dataLayer.at(-1).event, 'ssr_problem')
    dataLayerReporter('custom_ssr')(events[0]); assert.equal(window.dataLayer.at(-1).event, 'custom_ssr')
  } finally { runtime.destroy(); console.warn = originalWarn; document.body.innerHTML = '' }
})

test('reporter failures never stop valid islands; theme editor load and unload work', () => {
  const node = element()
  element({ component: 'Bad' })
  const runtime = mountIslands({ registry: { Good, Bad }, consent: () => true, reporter: () => { throw new Error('network') } })
  try {
    runtime.load()
    assert.equal(node.querySelector('p').textContent, 'expected')
    const added = element()
    added.dispatchEvent(new window.Event('shopify:section:load', { bubbles: true }))
    assert.equal(added.querySelector('p').textContent, 'expected')
    added.dispatchEvent(new window.Event('shopify:section:unload', { bubbles: true }))
    assert.equal(added.querySelector('p'), null)
  } finally { runtime.destroy(); document.body.innerHTML = '' }
})
