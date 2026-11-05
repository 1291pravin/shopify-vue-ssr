import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://store.invalid/customers/private-email@example.com?email=private-email@example.com#secret' })
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node']) globalThis[key] = dom.window[key]
const { defineComponent, defineAsyncComponent, h, ref, nextTick } = await import('vue')
const { mountIslands, createIslandRegistry, callbackReporter, dataLayerReporter, consoleReporter } = await import('../src/client.mjs')
const Good = defineComponent({ render() { return h('p', 'expected') } })
const Bad = defineComponent({ setup() { throw new Error('private-email@example.com') } })
function element({ component = 'Good', props = '{}', clientProps, hit = false } = {}) {
  const node = document.createElement('vue-island')
  node.dataset.component = component; node.dataset.ssrKey = 'a'.repeat(32)
  node.innerHTML = `<script data-props type="application/json">${props}</script><div data-ssr-root ${hit ? 'data-ssr="1"' : 'data-ssr-miss="test"'}><p>server text</p></div>`
  if (clientProps !== undefined) {
    const script = document.createElement('script')
    script.type = 'application/json'; script.dataset.clientProps = ''; script.textContent = clientProps
    node.prepend(script)
  }
  document.body.append(node)
  return node
}
after(() => { dom.window.close(); for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node']) delete globalThis[key] })

test('client props shallow-merge with precedence on cache misses without changing shared JSON', () => {
  let received
  const Header = defineComponent({ props: ['title', 'count', 'customer', 'menu'], setup(props) {
    received = { ...props }
    return () => h('p', `${props.title}: ${props.count}`)
  } })
  const props = '{ "title": "Shop", "count": 0, "customer": true, "menu": {"shared":true} }'
  const node = element({ component: 'Header', props, clientProps: '{"count":3,"customer":false,"menu":{"visitor":true}}' })
  const runtime = mountIslands({ registry: { Header }, scope: node, observe: false })
  try {
    runtime.load(node)
    assert.deepEqual(received, { title: 'Shop', count: 3, customer: false, menu: { visitor: true } })
    assert.equal(node.querySelector('p').textContent, 'Shop: 3')
    assert.equal(node.querySelector('[data-props]').textContent, props)
  } finally { runtime.destroy(); document.body.innerHTML = '' }
})

test('invalid client props identify the island locally and keep reporter metadata private', () => {
  const previous = console.error
  console.error = () => {}
  try {
    for (const clientProps of ['{"private":"visitor-only",}', '', 'null', '[]', '3', '"text"']) {
      const messages = [], events = []
      console.error = message => messages.push(message)
      const node = element({ clientProps })
      const runtime = mountIslands({ registry: { Good }, scope: node, observe: false, consent: () => true, reporter: event => events.push(event) })
      try {
        runtime.load(node)
        assert.match(messages[0], /Invalid client props JSON for island "Good" on https:\/\/store.invalid/)
        assert.equal(node.querySelector('[data-ssr-root]').hasAttribute('data-v-app'), false)
        assert.equal(events[0].message, 'Island mount failed')
        assert.doesNotMatch(JSON.stringify(events), /visitor-only|private|JSON|store.invalid/)
      } finally { runtime.destroy(); document.body.innerHTML = '' }
    }
  } finally { console.error = previous }
})

test('registry selects existing sync/async components, warns on missing own names and handles special keys', () => {
  const Async = defineAsyncComponent(() => Promise.resolve(Good))
  const components = Object.assign(Object.create({ Inherited: Good }), { Good, Async })
  Object.defineProperty(components, '__proto__', { value: Good, enumerable: true })
  const warnings = []
  const registry = createIslandRegistry(['Good', 'Async', 'Missing', 'Inherited', '__proto__'], components, { warn: message => warnings.push(message) })
  assert.equal(registry.Good, Good)
  assert.equal(registry.Async, Async)
  assert.equal(registry.__proto__, Good)
  assert.equal(Object.getPrototypeOf(registry), null)
  assert.equal(Object.hasOwn(registry, 'Missing'), false)
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /Missing.*not registered/)
  assert.match(warnings[1], /Inherited.*not registered/)
})

test('async component roots hydrate existing DOM with exact props and become interactive; misses mount too', async () => {
  const Counter = defineComponent({ props: ['start'], setup(props) {
    const count = ref(props.start)
    return () => h('button', { onClick: () => count.value++ }, String(count.value))
  } })
  let resolveLoader, calls = 0
  const Async = defineAsyncComponent(() => { calls++; return new Promise(resolve => { resolveLoader = resolve }) })
  const registry = createIslandRegistry(['Counter'], { Counter: Async })
  const node = element({ component: 'Counter', props: '{ "start": 2 }', hit: true })
  node.querySelector('[data-ssr-root]').innerHTML = '<button>2</button>'
  const button = node.querySelector('button'), events = []
  const runtime = mountIslands({ registry, scope: node, observe: false, consent: () => true, reporter: event => events.push(event) })
  try {
    runtime.load(node)
    assert.equal(calls, 1)
    assert.equal(node.querySelector('button'), button)
    resolveLoader(Counter)
    await new Promise(resolve => setImmediate(resolve)); await nextTick()
    assert.equal(node.querySelector('button'), button)
    button.click(); await nextTick()
    assert.equal(button.textContent, '3')
    assert.deepEqual(events, [])
    const miss = element({ component: 'Counter', props: '{"start":4}' })
    runtime.load(miss)
    await new Promise(resolve => setImmediate(resolve)); await nextTick()
    assert.equal(miss.querySelector('button').textContent, '4')
    assert.equal(calls, 1)
  } finally { runtime.destroy(); document.body.innerHTML = '' }
})

test('invalid props JSON logs component, actual page and parse error locally while reporters keep fixed metadata', () => {
  const previous = console.error, messages = [], events = []
  console.error = message => messages.push(message)
  const node = element({ props: '{"text":"private-email@example.com",}' })
  const runtime = mountIslands({ registry: { Good }, scope: node, observe: false, consent: () => true, reporter: event => events.push(event), page: 'product' })
  try {
    runtime.load(node)
    assert.match(messages[0], /Invalid props JSON for island "Good" on https:\/\/store.invalid/)
    let parseError
    try { JSON.parse('{"text":"private-email@example.com",}') } catch (error) { parseError = error.message }
    assert.ok(messages[0].includes(parseError))
    assert.ok(messages[0].includes(window.location.href))
    assert.equal(node.querySelector('[data-ssr-root]').hasAttribute('data-v-app'), false)
    assert.equal(events[0].message, 'Island mount failed')
    assert.doesNotMatch(JSON.stringify(events), /private-email|secret|JSON|store.invalid/)
  } finally { runtime.destroy(); console.error = previous; document.body.innerHTML = '' }
})

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

test('by default a plain mismatch stays hydrated: Vue patches it and the island keeps working', async () => {
  const originalWarn = console.warn, originalError = console.error
  console.warn = () => {}; console.error = () => {}
  const Cart = defineComponent({ props: ['count'], setup(props) {
    const count = ref(props.count)
    return () => h('button', { class: 'cart', onClick: () => count.value++ }, `Cart ${count.value}`)
  } })
  const node = element({ component: 'Cart', props: '{"count":0}', clientProps: '{"count":3}', hit: true })
  node.querySelector('[data-ssr-root]').innerHTML = '<button class="cart">Cart 0</button>'
  const button = node.querySelector('button')
  window.__ssr = { hydrated: [], csr: [], mismatches: [] }
  const runtime = mountIslands({ registry: { Cart }, observe: false })
  try {
    assert.equal(node.querySelector('button'), button)
    assert.equal(button.textContent, 'Cart 3')
    assert.equal(window.__ssr.hydrated.length, 1)
    assert.ok(window.__ssr.mismatches.length >= 1)
    button.click(); await nextTick()
    assert.equal(button.textContent, 'Cart 4')
  } finally { runtime.destroy(); console.warn = originalWarn; console.error = originalError; document.body.innerHTML = '' }
})

test('an island that breaks while hydrating is always remounted on the client', () => {
  const originalWarn = console.warn, originalError = console.error
  console.warn = () => {}; console.error = () => {}
  let calls = 0
  // Throws only on the first (hydrating) setup, like code that trips over server HTML.
  const Flaky = defineComponent({ setup() { if (calls++ === 0) throw new Error('hydration broke'); return () => h('p', 'client') } })
  const node = element({ component: 'Flaky', hit: true })
  window.__ssr = { hydrated: [], csr: [], mismatches: [] }
  const runtime = mountIslands({ registry: { Flaky }, observe: false })
  try {
    assert.equal(node.querySelector('[data-ssr-root]').textContent, 'client')
    assert.deepEqual(window.__ssr.csr, [{ component: 'Flaky', key: 'a'.repeat(32), recovered: true }])
  } finally { runtime.destroy(); console.warn = originalWarn; console.error = originalError; document.body.innerHTML = '' }
})

test('onMismatch remount discards the stored HTML and remounts the island on the client', async () => {
  const originalWarn = console.warn, originalError = console.error
  console.warn = () => {}; console.error = () => {}
  // The cached shared props say 0; the browser-only visitor override says 3.
  const Cart = defineComponent({ props: ['count'], setup(props) {
    const count = ref(props.count)
    return () => h('button', { class: 'cart', onClick: () => count.value++ }, `Cart ${count.value}`)
  } })
  const node = element({ component: 'Cart', props: '{"count":0}', clientProps: '{"count":3}', hit: true })
  node.querySelector('[data-ssr-root]').innerHTML = '<button class="cart">Cart 0</button>'
  window.__ssr = { hydrated: [], csr: [], mismatches: [] }
  const events = []
  const runtime = mountIslands({ registry: { Cart }, consent: () => true, reporter: callbackReporter(event => events.push(event)), observe: false, onMismatch: 'remount' })
  try {
    const root = node.querySelector('[data-ssr-root]')
    assert.equal(root.textContent, 'Cart 3')
    assert.equal(root.querySelectorAll('button').length, 1)
    assert.equal(root.dataset.ssrRecovered, '1')
    assert.deepEqual(window.__ssr.hydrated, [])
    assert.deepEqual(window.__ssr.csr, [{ component: 'Cart', key: 'a'.repeat(32), recovered: true }])
    assert.ok(window.__ssr.mismatches.length >= 1)
    assert.ok(events.some(event => event.type === 'hydration-mismatch'))
    root.querySelector('button').click(); await nextTick()
    assert.equal(root.textContent, 'Cart 4')
  } finally { runtime.destroy(); console.warn = originalWarn; console.error = originalError; document.body.innerHTML = '' }
})

test('a matching fragment stays hydrated without a remount', () => {
  const node = element({ hit: true })
  const clientData = document.createElement('script')
  clientData.type = 'application/json'; clientData.dataset.clientProps = ''; clientData.textContent = '{}'
  node.append(clientData)
  node.querySelector('[data-ssr-root]').innerHTML = '<p>expected</p>'
  const paragraph = node.querySelector('p')
  window.__ssr = { hydrated: [], csr: [], mismatches: [] }
  const runtime = mountIslands({ registry: { Good }, observe: false })
  try {
    assert.equal(node.querySelector('p'), paragraph)
    assert.equal(window.__ssr.hydrated.length, 1)
    assert.equal(window.__ssr.csr.length, 0)
  } finally { runtime.destroy(); document.body.innerHTML = '' }
})
