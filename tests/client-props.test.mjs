import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Liquid } from 'liquidjs'
import { findIslands, verifyIsland } from '../src/pages.mjs'
import { cacheKey } from '../src/key.mjs'

const buildId = 'a'.repeat(64)
const source = (await readFile(new URL('../templates/vue-island.liquid', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
const liquid = new Liquid({ templates: { 'ssr-build-id': buildId }, strictFilters: true })
liquid.registerFilter('md5', value => createHash('md5').update(value).digest('hex'))
// LiquidDoc is Shopify metadata, not rendered content; LiquidJS does not implement it.
const render = scope => liquid.parseAndRender(source.replace(/{% doc %}[\s\S]*?{% enddoc %}/, ''), scope)
const props = '{ "title": "Shop \\u003c/script>", "cartCount": 0 }'
const key = cacheKey(buildId, 'Header', props)
const fragment = { html: { value: '<header>Cart 0</header>' }, component: { value: 'Header' } }
const context = { component: 'Header', props, settings: { ssr_enabled: true }, metaobjects: { ssr_fragment: { [key]: fragment } } }

test('omitting client_props preserves legacy output bytes for hits, misses and disabled cache', async () => {
  for (const [settings, metaobjects, root] of [
    [context.settings, context.metaobjects, '<div data-ssr-root data-ssr="1"><header>Cart 0</header></div>'],
    [context.settings, { ssr_fragment: {} }, `<div data-ssr-root data-ssr-miss="${key}"></div>`],
    [{ ssr_enabled: false }, context.metaobjects, `<div data-ssr-root data-ssr-miss="${key}"></div>`],
  ]) {
    const expected = `<vue-island data-component="Header" data-ssr-key="${key}" data-ssr-build="${buildId}">\n  <script type="application/json" data-props>${props}</script>${root}</vue-island>\n`
    assert.equal(await render({ ...context, settings, metaobjects }), expected)
    assert.equal(await render({ ...context, settings, metaobjects, client_props: '' }), expected)
  }
})

test('client_props is escaped separately and never changes shared keys, lookup or cached HTML', async () => {
  const baseline = findIslands(await render(context))[0]
  for (const client_props of ['{}', '{"cartCount":3}', '{"cartCount":8,"note":"</script><script>visitor-only</script>"}']) {
    for (const hit of [true, false]) {
      const html = await render({ ...context, metaobjects: hit ? context.metaobjects : { ssr_fragment: {} }, client_props })
      const parsed = findIslands(html)[0]
      assert.deepEqual(parsed, { ...baseline, hit, miss: hit ? undefined : key })
      assert.deepEqual(verifyIsland(parsed, buildId), JSON.parse(props))
      const escaped = client_props.replaceAll('<', '\\u003c')
      assert.ok(html.includes(`<script type="application/json" data-client-props>${escaped}</script>`))
      assert.equal(html.includes('<header>Cart 0</header>'), hit)
      assert.ok(!html.includes('<script>visitor-only'))
    }
  }
})

test('shared literal less-than escaping and exact bytes remain unchanged with client props', async () => {
  const raw = '{ "title": "</script>" }', escaped = raw.replaceAll('<', '\\u003c')
  const html = await render({ ...context, props: raw, client_props: '{"note":"<visitor>"}' })
  const parsed = findIslands(html)[0]
  assert.equal(parsed.exactProps, escaped)
  assert.equal(parsed.key, cacheKey(buildId, 'Header', escaped))
  assert.deepEqual(verifyIsland(parsed, buildId), JSON.parse(raw))
})
