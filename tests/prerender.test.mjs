import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { prerender, runCheck } from '../src/prerender.mjs'
import { createPageReader, sitemapUrls, pageThemeId } from '../src/pages.mjs'
import { bundleId, cacheKey } from '../src/key.mjs'
import { operations, touchBuild, ensureBuildDefinition } from '../src/admin.mjs'
import { selectPrunable } from '../src/prune.mjs'
import { buildDefinition } from './helpers/admin.mjs'
import { commands, help, parseArgs } from '../src/cli.mjs'
import { repro } from '../src/repro.mjs'

const out = resolve(import.meta.dirname, '../out'), site = 'https://example.com'
const quiet = () => {}
async function temp(fn) {
  await mkdir(out, { recursive: true })
  const root = await mkdtemp(join(out, 'prerender-test-'))
  const code = '// mock component bundle', buildId = bundleId(code)
  const config = { root, outDir: join(root, 'dist-ssr'), themeDir: join(root, 'theme'), fixturesDir: join(root, 'ssr-fixtures'), reportDir: join(root, 'ssr-report/default'), storeId: 'default', store: 'your-store.myshopify.com', widths: [375, 1440] }
  await mkdir(config.outDir)
  await writeFile(join(config.outDir, 'server-entry.mjs'), code)
  await writeFile(join(config.outDir, 'build.json'), JSON.stringify({ buildId, entry: 'server-entry.mjs', components: ['Good'] }))
  try { return await fn(config, buildId) }
  finally { assert.equal(dirname(root), out); await rm(root, { recursive: true, force: true }) }
}
function island(buildId, { name = 'Good', props = '{}', hit = false } = {}) {
  const key = cacheKey(buildId, name, props)
  return `<vue-island data-component="${name}" data-ssr-build="${buildId}" data-ssr-key="${key}"><script data-props>${props}</script><div data-ssr-root ${hit ? 'data-ssr="1"' : `data-ssr-miss="${key}"`}></div></vue-island>`
}
function mockAdmin() {
  const calls = []
  return { calls, admin: async (query, vars) => {
    calls.push({ query, vars })
    if (query === operations.build) return { metaobjectByHandle: null }
    return { metaobjectUpsert: { metaobject: { id: 'mock' }, userErrors: [] } }
  } }
}
const good = async () => ({ ok: true, html: '<p>local render</p>' })
const xml = urls => `<urlset>${urls.map(url => `<url><loc>${url}</loc></url>`).join('')}</urlset>`

test('invalid props JSON identifies the component, page and parse error before rendering or writing, and replays offline', () => temp(async (config, buildId) => {
  const props = '{"title":"sample",}', messages = []
  let calls = 0, parseError
  try { JSON.parse(props) } catch (error) { parseError = error.message }
  const report = await prerender(['saved.html'], config, { log: message => messages.push(message), reader: async () => island(buildId, { props }),
    admin: async () => { calls++; throw new Error('must not write') }, verify: async () => { calls++; throw new Error('must not render') } })
  assert.equal(calls, 0)
  const failure = report.failures[0]
  assert.equal(failure.type, 'invalid-props')
  assert.ok(failure.message.includes(`Invalid props JSON for island "Good" on ${join(config.root, 'saved.html')}`))
  assert.ok(failure.message.includes(parseError))
  assert.ok(messages.includes(failure.message))
  assert.equal(failure.exactProps, props)
  assert.ok((await readFile(join(config.reportDir, 'summary.md'), 'utf8')).includes('Invalid props JSON'))
  const replay = await repro(failure.id, config)
  assert.equal(replay.reproduced, true)
  assert.equal(replay.type, 'invalid-props')
  assert.equal(replay.error.message, failure.message)
}))

test('prerender expands same-host sitemap indexes, previews every page, verifies misses and records served theme ids', () => temp(async (config, buildId) => {
  const requests = [], mock = mockAdmin(), verified = []
  const reader = async url => {
    requests.push(url)
    if (url === `${site}/sitemap.xml`) return `<sitemapindex><sitemap><loc>${site}/products.xml</loc></sitemap><sitemap><loc>${site}/pages.xml</loc></sitemap></sitemapindex>`
    if (url.endsWith('products.xml')) return xml([`${site}/products/one`, `${site}/shared`])
    if (url.endsWith('pages.xml')) return xml([`${site}/shared`])
    assert.equal(new URL(url).searchParams.get('preview_theme_id'), '42')
    return `<script>Shopify.theme = {"id":42,"role":"unpublished"};</script>` + island(buildId, { hit: url.includes('/shared') })
  }
  const report = await prerender([site], config, { reader, cleanup: 'none', theme: '42', admin: mock.admin, log: quiet, verify: async (_config, input) => { verified.push(input); return good() } })
  assert.equal(report.fullCrawl, true); assert.equal(report.pages.length, 2)
  assert.equal(report.counts.filled, 1); assert.equal(report.counts.hit, 1)
  assert.equal(verified.length, 1); assert.equal(report.failures.length, 0)
  assert.ok(report.pages.every(page => page.themeId === '42'))
  const history = mock.calls.filter(call => call.query === operations.upsertBuild)
  assert.equal(history.length, 1)
  assert.ok(JSON.parse(history[0].vars.metaobject.fields.find(field => field.key === 'themes').value)['42'])
  assert.equal(mock.calls.find(call => call.query === operations.upsert).vars.html, '<p>local render</p>')
  // Two sitemap pages plus the homepage opened before the sitemap (session and preview cookies).
  assert.equal(requests.filter(url => url.includes('preview_theme_id')).length, 3)
  assert.equal(requests[0], `${site}/?preview_theme_id=42`)
  assert.equal(requests[1], `${site}/sitemap.xml`)
}))

test('sitemap indexes reject foreign hosts, cyclic indexes, empty and non-XML responses safely', async () => {
  await assert.rejects(sitemapUrls(`${site}/sitemap.xml`, async () => xml(['https://foreign.invalid/page'])), /cross-origin/)
  await assert.rejects(sitemapUrls(`${site}/sitemap.xml`, async () => '<html>password or error</html>'), /Expected sitemap XML/)
  await assert.rejects(sitemapUrls(`${site}/sitemap.xml`, async () => xml([])), /Empty sitemap/)
  await assert.rejects(sitemapUrls(`${site}/sitemap.xml`, async () => `<sitemapindex><sitemap><loc>${site}/sitemap.xml</loc></sitemap></sitemapindex>`), /cyclic sitemap index/)
})

test('limited sitemap runs cannot authorize stale cleanup and concurrency bounds work without duplicate writes', () => temp(async (config, buildId) => {
  let active = 0, maximum = 0, rendered = 0
  const mock = mockAdmin()
  const reader = async url => {
    if (url.endsWith('/sitemap.xml')) return xml(Array.from({ length: 7 }, (_, i) => `${site}/${i}`))
    active++; maximum = Math.max(maximum, active)
    await new Promise(accept => setImmediate(accept))
    active--; return island(buildId)
  }
  const report = await prerender([site], config, { reader, cleanup: 'none', limit: 4, concurrency: 2, admin: mock.admin, log: quiet, verify: async () => { rendered++; await new Promise(accept => setImmediate(accept)); return good() } })
  assert.equal(report.fullCrawl, false); assert.equal(report.pages.length, 4)
  assert.ok(maximum <= 2); assert.equal(maximum, 2); assert.equal(rendered, 1)
  assert.equal(mock.calls.filter(call => call.query === operations.upsert).length, 1)
}))

test('saved HTML uses real file bytes and dry-run verifies with no Admin calls; captures props for offline check', () => temp(async (config, buildId) => {
  const props = '{ "title": "\\u003cstrong>exact", "items": [] }'
  await writeFile(join(config.root, 'saved.html'), island(buildId, { props }))
  let calls = 0
  const report = await prerender(['saved.html'], config, { dryRun: true, log: quiet, admin: async () => { throw new Error('unexpected Admin call') }, verify: async (_config, input) => {
    calls++; assert.equal(input.exactProps, props); return good()
  } })
  assert.equal(report.fullCrawl, false); assert.equal(report.failures.length, 0); assert.equal(calls, 1)
  const files = await readdir(join(config.reportDir, 'props/Good'))
  assert.equal(files.length, 1)
  assert.equal(JSON.parse(await readFile(join(config.reportDir, 'props/Good', files[0]), 'utf8')).exactProps, props)
  const checked = await runCheck(config, { verify: async (_config, input) => { calls++; assert.equal(input.exactProps, props); return good() } })
  assert.equal(checked.counts.skipped, 1); assert.equal(checked.failures.length, 0); assert.equal(calls, 2)
}))

test('prerender and check ignore even malformed client props and save only exact shared props', () => temp(async (config, buildId) => {
  const props = '{ "title": "shared", "cartCount": 0 }', mock = mockAdmin(), inputs = []
  const verify = async (_config, input) => {
    inputs.push(input)
    assert.deepEqual(input, { component: 'Good', exactProps: props })
    return good()
  }
  const pages = ['{"cartCount":3,"visitor":"visitor-only"}', '{invalid-client-json']
    .map(value => island(buildId, { props }).replace('<script data-props>', `<script type="application/json" data-client-props>${value}</script><script data-props>`)).join('')
  const report = await prerender(['saved.html'], config, { log: quiet, reader: async () => pages, admin: mock.admin, verify })
  assert.equal(report.failures.length, 0)
  assert.equal(report.counts.filled, 1)
  assert.equal(inputs.length, 1)
  const writes = mock.calls.filter(call => call.query === operations.upsert)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].vars.html, '<p>local render</p>')
  const files = await readdir(join(config.reportDir, 'props/Good'))
  assert.equal(files.length, 1)
  const saved = await readFile(join(config.reportDir, 'props/Good', files[0]), 'utf8')
  assert.deepEqual(JSON.parse(saved), { schemaVersion: 1, component: 'Good', exactProps: props })
  const checked = await runCheck(config, { verify })
  assert.equal(checked.failures.length, 0)
  assert.equal(inputs.length, 2)
  const reports = await Promise.all(['report.json', 'summary.md', 'failures.jsonl'].map(file => readFile(join(config.reportDir, file), 'utf8')))
  assert.doesNotMatch([saved, JSON.stringify(mock.calls), ...reports].join(''), /visitor-only|client.props|invalid-client-json/)
}))

test('build mismatch in any page marker blocks every write for that page, even when earlier islands match', () => temp(async (config, buildId) => {
  const mock = mockAdmin()
  const report = await prerender(['saved.html'], config, { log: quiet, admin: mock.admin, reader: async () => island(buildId) + island('b'.repeat(64)), verify: async () => { throw new Error('must not render') } })
  assert.equal(mock.calls.length, 0); assert.equal(report.failures.length, 2)
  assert.ok(report.failures.every(failure => failure.type === 'build-mismatch' && /Deploy the matching build/.test(failure.message)))
}))

test('a requested preview that serves another theme fails before history or cache writes', () => temp(async (config, buildId) => {
  const mock = mockAdmin()
  const report = await prerender(['saved.html'], config, { theme: '42', log: quiet, admin: mock.admin, reader: async () => '<script>Shopify.theme = {id:99};</script>' + island(buildId) })
  assert.equal(mock.calls.length, 0); assert.match(report.failures[0].message, /serves theme 99/)
}))

test('unregistered components stay client-rendered; over 20 unique registered keys warn and fall back; props stay capped/deduplicated', () => temp(async (config, buildId) => {
  const html = Array.from({ length: 25 }, (_, i) => island(buildId, { props: JSON.stringify({ i }) })).join('') + island(buildId, { name: 'Other' })
  let verified = 0
  const options = { dryRun: true, log: quiet, reader: async () => html, verify: async (_config, { component }) => { assert.equal(component, 'Good'); verified++; return good() } }
  const report = await prerender(['saved.html'], config, options)
  assert.equal(verified, 20); assert.equal(report.failures.length, 0)
  assert.match(report.warnings[0], /25 unique cache islands.*20 handle lookups/)
  assert.equal(report.pages[0].islands.filter(island => /lookup limit/.test(island.why)).length, 5)
  assert.match(report.pages[0].islands.at(-1).why, /not registered/)
  assert.equal((await readdir(join(config.reportDir, 'props/Good'))).length, 20)
  await prerender(['saved.html'], config, options)
  assert.equal((await readdir(join(config.reportDir, 'props/Good'))).length, 20)
  const duplicate = await prerender(['saved.html'], config, { ...options, reader: async () => island(buildId).repeat(21) })
  assert.equal(duplicate.warnings.length, 0)
  const latestProps = '{"latest":"new content"}'
  await prerender(['saved.html'], config, { ...options, reader: async () => island(buildId, { props: latestProps }) })
  const files = await readdir(join(config.reportDir, 'props/Good'))
  assert.equal(files.length, 20)
  const samples = await Promise.all(files.map(file => readFile(join(config.reportDir, 'props/Good', file), 'utf8')))
  assert.ok(samples.some(value => JSON.parse(value).exactProps === latestProps))
}))

test('sitemap runs purge by default, no-delete and saved files skip it, dry-run previews it, and failures block it', () => temp(async (config, buildId) => {
  const calls = [], base = { log: quiet, reader: async url => url.endsWith('/sitemap.xml') ? xml([`${site}/page`]) : island(buildId, { hit: true }), verify: good,
    cleanupCache: async (_config, options) => { calls.push(options); return { blocked: false, failures: [] } }, admin: mockAdmin().admin }
  await prerender([site], config, { ...base, cleanup: 'none' }); assert.equal(calls.length, 0)
  await writeFile(join(config.root, 'saved.html'), island(buildId, { hit: true }))
  await prerender(['saved.html'], config, base); assert.equal(calls.length, 0)
  await prerender([site], config, { ...base, dryRun: true }); assert.equal(calls.length, 1); assert.equal(calls[0].yes, false); assert.equal(calls[0].mode, 'purge')
  await prerender([site], config, { ...base, theme: '42' }); assert.equal(calls.length, 2); assert.equal(calls[1].yes, true); assert.equal(calls[1].mode, 'purge')
  assert.equal(calls[1].expectedBuildId, buildId); assert.match(calls[1].probe, /preview_theme_id=42/)
  await prerender([site], config, { ...base, cleanup: 'recent' }); assert.equal(calls[2].mode, 'recent')
  await assert.rejects(prerender([site], config, { ...base, cleanup: true }), /cleanup must be/)
  const failed = await prerender([site], config, { ...base, reader: async () => { throw new Error('offline') } })
  assert.equal(calls.length, 3); assert.equal(failed.failures.length, 1)
  const blocked = await prerender([site], config, { ...base, cleanupCache: async () => ({ blocked: true, skipped: ['safety cap'], failures: [] }) })
  assert.ok(blocked.failures.some(failure => failure.type === 'cleanup-blocked'))
}))

test('password form login carries hidden fields and cookies from sitemap through concurrent page reads', () => temp(async (config, buildId) => {
  const requests = []
  let logins = 0
  const fetcher = async (url, options) => {
    requests.push({ url, options })
    if (options.method === 'POST') {
      logins++; assert.equal(url, `${site}/password`)
      const body = new URLSearchParams(options.body)
      assert.equal(body.get('password'), 'mock-password'); assert.equal(body.get('authenticity_token'), 'mock-csrf')
      return new Response('', { status: 302, headers: { location: '/', 'set-cookie': 'storefront=ok; Path=/; Secure; HttpOnly' } })
    }
    if (!options.headers.Cookie?.includes('storefront=ok')) return new Response('<form method="post" action="/password"><input type="hidden" name="authenticity_token" value="mock-csrf"><input name="password"></form>')
    return new Response(url.endsWith('/sitemap.xml') ? xml([`${site}/one`, `${site}/two`]) : island(buildId, { hit: true }))
  }
  const report = await prerender([site], config, { dryRun: true, cleanup: 'none', log: quiet, reader: createPageReader({ fetcher, password: 'mock-password' }) })
  assert.equal(logins, 1); assert.equal(report.failures.length, 0); assert.equal(report.counts.hit, 2)
  assert.ok(requests.filter(request => /\/(one|two)$/.test(request.url)).every(request => /storefront=ok/.test(request.options.headers.Cookie)))
  assert.doesNotMatch(await readFile(join(config.reportDir, 'report.json'), 'utf8'), /mock-password|mock-csrf|storefront=ok/)
}))

test('challenge pages and rejected passwords fail clearly with saved-HTML guidance; form actions/redirects cannot leak passwords cross-origin', async () => {
  const challenge = createPageReader({ password: 'mock', fetcher: async () => new Response('<title>Just a moment</title><form id="challenge-form"></form>', { status: 403 }) })
  await assert.rejects(challenge(`${site}/sitemap.xml`), /challenge.*saved .html/i)
  const rejected = createPageReader({ password: 'mock', fetcher: async () => new Response('<form action="/password"><input name="password"></form>') })
  await assert.rejects(rejected(site), /password rejected.*saved .html/i)
  let posts = 0
  const foreign = createPageReader({ password: 'mock', fetcher: async (_url, options) => { if (options.method === 'POST') posts++; return new Response('<form action="https://foreign.invalid/password"><input name="password"></form>') } })
  await assert.rejects(foreign(site), /cross-origin password form/); assert.equal(posts, 0)
  const redirect = createPageReader({ password: 'mock', fetcher: async () => new Response('', { status: 302, headers: { location: 'https://foreign.invalid' } }) })
  await assert.rejects(redirect(site), /cross-origin storefront redirect/)
})

test('normal customer login forms and Shopify captcha helpers are not storefront password/challenge pages', async () => {
  const html = '<script>Shopify.captcha.protect = function(form) {};</script><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script><form action="/account/login"><input name="password"><input type="hidden" name="form_type" value="customer_login"></form>'
  let posts = 0
  const reader = createPageReader({ password: 'mock', fetcher: async (_url, options) => { if (options.method === 'POST') posts++; return new Response(html) } })
  assert.equal(await reader(site), html); assert.equal(posts, 0)
})

test('missing captured props is a successful offline check without a build', () => temp(async config => {
  await rm(join(config.outDir, 'build.json'))
  const report = await runCheck(config)
  assert.equal(report.failures.length, 0); assert.equal(report.counts.islands, 0); assert.match(report.hint, /No saved props yet/)
  assert.equal(pageThemeId('<script>Shopify.theme = {"id":123,"name":"example"}</script>'), '123')
}))

test('password-env selects the named secret for the built-in page reader', () => temp(async (config, buildId) => {
  const previous = globalThis.fetch
  const previousPassword = process.env.SHOPIFY_STOREFRONT_PASSWORD
  let logins = 0
  globalThis.fetch = async (url, options) => {
    if (options.method === 'POST') {
      logins++; assert.equal(new URLSearchParams(options.body).get('password'), 'custom-password')
      return new Response('ok', { headers: { 'set-cookie': 'storefront=1; Path=/; Secure' } })
    }
    if (!options.headers.Cookie) return new Response('<form action="/password"><input name="password"></form>')
    return new Response(url.endsWith('/sitemap.xml') ? xml([`${site}/page`]) : island(buildId, { hit: true }))
  }
  try {
    const report = await prerender([site], config, { dryRun: true, cleanup: 'none', log: quiet, env: { PREVIEW_SECRET: 'custom-password' }, passwordEnv: 'PREVIEW_SECRET' })
    assert.equal(logins, 1); assert.equal(report.counts.hit, 1); assert.equal(report.failures.length, 0)
    process.env.SHOPIFY_STOREFRONT_PASSWORD = 'other-store-password'
    const missing = await prerender([site], config, { dryRun: true, cleanup: 'none', log: quiet, env: {}, passwordEnv: 'PREVIEW_SECRET' })
    assert.match(missing.failures[0].message, /password required/); assert.equal(logins, 1)
  } finally {
    globalThis.fetch = previous
    if (previousPassword === undefined) delete process.env.SHOPIFY_STOREFRONT_PASSWORD
    else process.env.SHOPIFY_STOREFRONT_PASSWORD = previousPassword
  }
}))

test('build definition migrates theme metadata once and history preserves previous theme observations', async () => {
  const definition = structuredClone(buildDefinition)
  definition.fieldDefinitions = definition.fieldDefinitions.filter(field => field.key !== 'themes')
  let updates = 0, existing = { fields: [{ key: 'first_seen', value: '2026-01-01T00:00:00Z' }, { key: 'themes', value: '{"11":"2026-11-01T00:00:00Z"}' }] }
  const admin = async (query, vars) => {
    if (query === operations.buildDefinition) return { metaobjectDefinitionByType: definition }
    if (query === operations.updateDefinition) { updates++; definition.fieldDefinitions.push({ key: 'themes', type: { name: 'json' } }); return { metaobjectDefinitionUpdate: { metaobjectDefinition: { id: definition.id }, userErrors: [] } } }
    if (query === operations.build) return { metaobjectByHandle: existing }
    assert.equal(query, operations.upsertBuild)
    const themes = JSON.parse(vars.metaobject.fields.find(field => field.key === 'themes').value)
    assert.equal(themes['11'], '2026-11-01T00:00:00Z'); assert.equal(themes['22'], '2026-11-05T00:00:00.000Z')
    assert.ok(!vars.metaobject.fields.some(field => field.key === 'first_seen'))
    return { metaobjectUpsert: { metaobject: { id: 'history' }, userErrors: [] } }
  }
  await ensureBuildDefinition(admin); await ensureBuildDefinition(admin); assert.equal(updates, 1)
  await touchBuild(admin, 'a'.repeat(64), Date.parse('2026-11-05T00:00:00Z'), '22')
})

test('cleanup protects recent themes beyond keepBuilds, expires old theme observations, and guards shared-build stale props', () => {
  const now = Date.parse('2026-11-05'), current = 'a'.repeat(64), preview = 'b'.repeat(64), old = 'c'.repeat(64)
  const record = (handle, theme, at) => ({ handle, id: handle, fields: [{ key: 'last_seen', value: at }, { key: 'themes', value: JSON.stringify({ [theme]: at }) }] })
  const rows = [current, preview, old].map(build => ({ id: build, handle: build, fields: [{ key: 'build', value: build }], updatedAt: '2020-01-01' }))
  const builds = [record(current, '11', '2026-11-04'), record(preview, '22', '2026-11-03'), record(old, '33', '2026-01-01')]
  const result = selectPrunable(rows, builds, { deployedBuildId: current, keepBuilds: 1, now })
  assert.deepEqual(result.keptBuilds, [current, preview]); assert.deepEqual(result.selected.map(row => row.id), [old])
  const crawl = { runId: 'clean', fullCrawl: true, sitemap: `${site}/sitemap.xml`, buildId: current, theme: '11', time: '2026-11-04', failures: [], pages: [] }
  const shared = [...builds, record(current, '44', '2026-11-04')]
  assert.equal(selectPrunable([rows[0]], shared, { deployedBuildId: current, crawl, now }).selected.length, 0)
  const malformed = [record(old, '33', 'bad timestamp')]
  assert.equal(selectPrunable(rows, malformed, { deployedBuildId: current, now }).blocked, true)
})

test('command help matches README flags and defaults exactly and removed commands/foreign flags are rejected', async () => {
  // Windows checkouts may convert to CRLF; compare on LF.
  const readme = (await readFile(new URL('../README.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
  for (const command of Object.keys(commands)) {
    const section = readme.split(`### ${command}\n`)[1].split('\n### ')[0].split('\n## ')[0]
    const lines = help(command).split('\n')
    const flags = []
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^(--[\w-]+)(?: <([^>]+)>)? \(default: (.*)\)$/)
      if (!match) continue
      flags.push(match[1])
      assert.ok(section.includes(`| \`${match[1]}${match[2] ? ` <${match[2]}>` : ''}\` | ${match[3]} | ${lines[i + 1].trim()} |`), `${command} ${match[1]}`)
    }
    assert.equal((section.match(/^\| `--/gm) ?? []).length, flags.length)
  }
  for (const command of ['init', 'sync', 'doctor', 'prune', 'islands', 'stores', 'health-issue']) assert.throws(() => parseArgs(command, []), /Unknown command/)
  assert.throws(() => parseArgs('build', ['--no-delete']), /Unknown option/)
  assert.throws(() => parseArgs('prerender', ['--cleanup']), /Unknown option/)
  assert.throws(() => parseArgs('setup', ['--timeout']), /Missing value/)
})

test('storefront 429 is retried with backoff before failing', async () => {
  const { createPageReader } = await import('../src/pages.mjs')
  const waits = []
  let calls = 0
  const reader = createPageReader({ password: '', pause: async ms => { waits.push(ms) }, fetcher: async () => ++calls < 3
    ? new Response('', { status: 429, headers: { 'retry-after': '5' } })
    : new Response('<html><body>ok</body></html>', { status: 200 }) })
  assert.match(await reader('https://example.com/products/tea'), /ok/)
  assert.deepEqual(waits, [5000, 5000])

  const always = createPageReader({ password: '', retries: 2, pause: async () => {}, fetcher: async () => new Response('', { status: 429 }) })
  await assert.rejects(always('https://example.com/'), /rate limited \(HTTP 429\) after 2 retries.*--concurrency/)
})

test('password stores: the homepage is opened first so sitemap.xml is fetched with the session cookie', () => temp(async (config, buildId) => {
  const order = []
  const fetcher = async (url, options) => {
    order.push(`${options.method ?? 'GET'} ${new URL(url).pathname}`)
    if (options.method === 'POST') return new Response('', { status: 302, headers: { location: '/', 'set-cookie': 'storefront=ok; Path=/; Secure; HttpOnly' } })
    const loggedIn = options.headers.Cookie?.includes('storefront=ok')
    // Seen on real stores: before login, sitemap.xml does not show the password form, only pages do.
    if (url.endsWith('/sitemap.xml')) return loggedIn ? new Response(xml([`${site}/one`])) : new Response('Not found', { status: 404 })
    if (!loggedIn) return new Response('<form method="post" action="/password"><input type="hidden" name="authenticity_token" value="mock-csrf"><input name="password"></form>')
    return new Response(island(buildId, { hit: true }))
  }
  const report = await prerender([site], config, { dryRun: true, cleanup: 'none', log: quiet, reader: createPageReader({ fetcher, password: 'mock-password' }) })
  assert.equal(report.failures.length, 0)
  assert.equal(report.counts.hit, 1)
  assert.equal(order[0], 'GET /')
  assert.ok(order.indexOf('POST /password') < order.indexOf('GET /sitemap.xml'))
  assert.equal(order.filter(entry => entry === 'GET /sitemap.xml').length, 1)
}))
