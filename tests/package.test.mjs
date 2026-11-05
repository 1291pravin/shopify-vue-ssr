import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildProject } from '../src/build.mjs'
import { loadConfig } from '../src/config.mjs'
import { cacheKey, scriptSafeJson } from '../src/key.mjs'
import { renderAndVerify, readBuild } from '../src/verify.mjs'
import { findIslands } from '../src/pages.mjs'
import { prerender, runCheck } from '../src/prerender.mjs'
import { repro } from '../src/repro.mjs'
import { selectPrunable } from '../src/prune.mjs'
import { withHistory } from './helpers/admin.mjs'
import { createAdmin } from '../src/admin.mjs'
import { createPageReader, sitemapUrls } from '../src/pages.mjs'

const inspectPages = (inputs, config, options = {}) => prerender(inputs, config, { ...options, dryRun: true })
let root, config, build
const exec = promisify(execFile)
const workspace = resolve(import.meta.dirname, '..')
const out = resolve(workspace, 'out')
const components = {
  Good: `<script setup>defineProps({ text: { default: 'safe' } })</script><template><section>{{ text }}</section></template>`,
  Broken: `<script setup>const value = typeof window</script><template><section>{{ value }}</section></template>`,
  Width: `<script setup>const value = typeof window === 'undefined' ? 1440 : window.innerWidth</script><template><p>{{ value }}</p></template>`,
  Throws: `<script setup>\nconst value = 1\nthrow new Error('injected render failure')\n</script><template><p>{{ value }}</p></template>`,
  Large: `<template><section>{{ '\u00e9'.repeat(33000) }}</section></template>`,
  Attribute: `<script setup>const kind = typeof window</script><template><div :class="kind">same text</div></template>`,
  MountError: `<script setup>\nif (typeof window !== 'undefined') throw new Error('client only error')\n</script><template><p>hello</p></template>`,
}
before(async () => {
  await mkdir(out, { recursive: true })
  root = await mkdtemp(join(out, 'package-test-'))
  config = { root, outDir: join(root, 'dist-ssr'), themeDir: join(root, 'theme'), fixturesDir: join(root, 'ssr-fixtures'), reportDir: join(root, 'ssr-report'), widths: [375, 1440], store: 'example.myshopify.com', sitemap: 'https://example.myshopify.com/sitemap.xml' }
  await mkdir(join(root, 'src/islands'), { recursive: true })
  for (const [name, source] of Object.entries(components)) await writeFile(join(root, 'src/islands', name + '.vue'), source)
  await writeFile(join(root, 'src/client.ts'), `import { mountIslands } from 'shopify-vue-ssr/client'; import { registry } from 'virtual:shopify-vue-ssr/islands'; mountIslands({ registry })`)
  await writeFile(join(root, 'vite.config.ts'), `import vue from '@vitejs/plugin-vue'; import { shopifyVueSsr } from 'shopify-vue-ssr'; export default { plugins: [vue({template:{compilerOptions:{comments:false}}}), shopifyVueSsr({islands:'src/islands/**/*.vue', store:'example.myshopify.com', sitemap:'https://example.myshopify.com/sitemap.xml'})] }`)
  config = await loadConfig(root)
  build = await buildProject(config)
}, { timeout: 120000 })
after(async () => {
  if (root && dirname(root) === out) await rm(root, { recursive: true, force: true })
})

function island(component, { props = '{}', hit = false, buildId = build.buildId, key = cacheKey(buildId, component, props), fragment = '' } = {}) {
  return `<vue-island data-component="${component}" data-ssr-key="${key}" data-ssr-build="${buildId}"><script data-props type="application/json">${props}</script><div data-ssr-root ${hit ? 'data-ssr="1"' : `data-ssr-miss="${key}"`}>${fragment}</div></vue-island>`
}
const verify = component => renderAndVerify(config, { component, exactProps: '{}' })
const payload = { metaobjectUpsert: { metaobject: { id: 'gid://shopify/Metaobject/1', handle: 'test' }, userErrors: [] } }

test('UTF-8 keys preserve exact bytes and safe JSON transport', () => {
  assert.equal(cacheKey('', '', ''), '7d010443693eec253a121e2aa2ba177c')
  assert.notEqual(cacheKey('b', 'Good', '{}'), cacheKey('b', 'Good', '{ }'))
  assert.equal(scriptSafeJson({ x: '</script>' }), '{"x":"\\u003c/script>"}')
})

test('auto discovers every island and generates package snippets and source maps', async () => {
  assert.deepEqual(build.components, Object.keys(components).sort())
  assert.equal((await readFile(join(config.themeDir, 'snippets/ssr-build-id.liquid'), 'utf8')), build.buildId)
  assert.match(await readFile(join(config.themeDir, 'snippets/vue-island.liquid'), 'utf8'), /data-ssr-build/)
  assert.ok(JSON.parse(await readFile(join(config.outDir, 'server-entry.mjs.map'), 'utf8')).sources.some(name => name.endsWith('/Throws.vue')))
  assert.equal((await verify('Good')).ok, true)
})

test('verification uses client compilation, catches differing window and viewport output, and gives first DOM path', async () => {
  const result = await verify('Broken')
  assert.equal(result.ok, false)
  assert.equal(result.type, 'hydration-mismatch')
  assert.equal(result.width, 375)
  assert.match(result.mismatch.path, /section.*#text/)
  assert.match(result.mismatch.serverHtml, /undefined/)
  assert.match(result.mismatch.clientHtml, /object/)
  const widths = await renderAndVerify(config, { component: 'Width', exactProps: '{}', widths: [1440, 375] })
  assert.equal(widths.width, 375)
  const attribute = await verify('Attribute')
  assert.equal(attribute.ok, false)
  assert.match(attribute.mismatch.serverHtml, /undefined/)
  assert.match(attribute.mismatch.clientHtml, /object/)
})

test('source-mapped setup error points to actual .vue line and multibyte oversize is rejected', async () => {
  const result = await verify('Throws')
  assert.equal(result.type, 'render-error')
  assert.match(result.error.message, /injected render failure/)
  assert.match(result.error.stack, /Throws\.vue:3:/)
  assert.equal((await verify('Large')).type, 'too-large')
  const clientError = await verify('MountError')
  assert.equal(clientError.ok, false)
  assert.match(clientError.error.stack, /MountError\.vue:2:/)
})

test('pre-storage verification blocks real mismatch, render error and oversized HTML; only own good render is upserted', async () => {
  const calls = []
  const html = ['Broken', 'Throws', 'Large', 'Good'].map(name => island(name)).join('')
  const report = await prerender(['capture.html'], config, { reader: async () => html, admin: withHistory(async (_query, vars) => { calls.push(vars); return payload }) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'Good')
  assert.equal(calls[0].html, '<section>safe</section>')
  assert.equal(calls[0].build, build.buildId)
  assert.deepEqual(report.failures.map(f => f.type), ['hydration-mismatch', 'render-error', 'too-large'])
  assert.deepEqual(report.counts, { hit: 0, filled: 1, failed: 3, skipped: 0, misses: 4, failures: 3, islands: 4, coverage: 0 })
})

test('reports, stable cases and offline repro retain exact props, DOM difference, mapped stack and command', async () => {
  const html = island('Broken', { props: '{ "text": "exact bytes" }' })
  const report = await prerender(['capture.html'], config, { dryRun: true, reader: async () => html })
  const failure = report.failures[0]
  const saved = JSON.parse(await readFile(join(config.reportDir, 'cases', failure.id + '.json'), 'utf8'))
  assert.equal(saved.schemaVersion, 1)
  assert.equal(saved.exactProps, '{ "text": "exact bytes" }')
  assert.deepEqual(saved.widths, [375, 1440])
  assert.match(saved.renderedHtml, /undefined/)
  assert.ok(saved.mismatch.path)
  assert.equal(saved.repro, `npx shopify-vue-ssr repro ${failure.id} --store default`)
  assert.match(await readFile(join(config.reportDir, 'summary.md'), 'utf8'), new RegExp(failure.id))
  assert.equal(JSON.parse((await readFile(join(config.reportDir, 'failures.jsonl'), 'utf8')).trim()).id, saved.id)
  assert.equal(JSON.parse(await readFile(join(config.reportDir, 'report.json'), 'utf8')).runId, report.runId)
  const result = await repro(failure.id, config)
  assert.equal(result.reproduced, true)
  assert.equal(result.type, 'hydration-mismatch')
  const second = await prerender(['capture.html'], config, { dryRun: true, reader: async () => html })
  assert.equal(second.failures[0].id, failure.id)
  const cli = resolve(workspace, 'src/cli.mjs'), caseFile = join(config.reportDir, 'cases', failure.id + '.json')
  const { stdout } = await exec(process.execPath, [cli, 'repro', caseFile, '--root', root, '--json']).catch(error => error)
  assert.match(stdout, /"reproduced": true/)
  // Default output is the short form an agent reads first: type, DOM path and source location.
  const short = (await exec(process.execPath, [cli, 'repro', caseFile, '--root', root]).catch(error => error)).stdout
  assert.match(short, /^Reproduced: hydration-mismatch at \d+px/)
  assert.match(short, /First difference at root\//)
  assert.match(short, /Broken\.vue:\d+:\d+/)
  assert.doesNotMatch(short, /\[object /)
})

test('build mismatch, old markerless capture and tampered keys store nothing; dry-run reports hits and misses without writes', async () => {
  let writes = 0
  const admin = async () => { writes++; return payload }
  const stale = await prerender(['old.html'], config, { reader: async () => island('Good', { buildId: '0'.repeat(64) }), admin })
  assert.equal(stale.failures[0].type, 'build-mismatch')
  assert.match(stale.failures[0].message, /Deploy the matching build/)
  const old = await prerender(['old.html'], config, { reader: async () => island('Good').replace(/ data-ssr-build="[^"]+"/, ''), admin })
  assert.equal(old.failures[0].type, 'build-mismatch')
  const tampered = await prerender(['bad.html'], config, { reader: async () => island('Good', { key: 'tampered' }), admin })
  assert.equal(tampered.failures[0].type, 'key-mismatch')
  const doctor = await inspectPages(['page.html'], config, { reader: async () => island('Good', { hit: true }) + island('Good'), admin })
  assert.equal(doctor.counts.hit, 1)
  assert.equal(doctor.counts.misses, 1)
  assert.equal(doctor.counts.coverage, 0.5)
  assert.equal(writes, 0)
})

test('dry-run renders and verifies without writes; upsert and fetch errors retain context; duplicate misses deduplicate', async () => {
  let writes = 0
  const admin = withHistory(async () => { writes++; throw new Error('injected upsert failure') })
  const dry = await prerender(['page.html'], config, { dryRun: true, reader: async () => island('Good'), admin })
  assert.equal(dry.counts.skipped, 1)
  assert.equal(dry.failures.length, 0)
  assert.equal(writes, 0)
  const failure = await prerender(['page.html'], config, { reader: async () => island('Good'), admin })
  assert.equal(failure.failures[0].type, 'upsert-error')
  const fetchFailure = await inspectPages(['page.html'], config, { reader: async () => { throw new Error('offline') } })
  assert.equal(fetchFailure.failures[0].type, 'fetch-error')
  const duplicate = await prerender(['page.html'], config, { reader: async () => island('Good') + island('Good'), admin: withHistory(async () => { writes++; return payload }) })
  assert.equal(duplicate.counts.filled, 1)
  assert.equal(duplicate.counts.skipped, 1)
  assert.equal(writes, 2)
})

test('check verifies saved props and optional fixtures and reports failures', async () => {
  for (const component of build.components) {
    await mkdir(join(config.fixturesDir, component), { recursive: true })
    await writeFile(join(config.fixturesDir, component, 'one.json'), '{}')
  }
  const report = await runCheck(config)
  assert.ok(report.failures.some(f => f.type === 'render-error'))
  assert.ok(report.failures.some(f => f.type === 'hydration-mismatch'))
  assert.ok(report.pages.some(p => p.page.includes('props')))
  assert.ok(report.pages.some(p => p.islands[0].component === 'Good' && p.islands[0].status === 'skipped'))
})

test('manifest integrity failure writes a structured report and does not render', async () => {
  const file = join(config.outDir, 'server-entry.mjs')
  const original = await readFile(file, 'utf8')
  await writeFile(file, original + '\n// tampered')
  try {
    await assert.rejects(readBuild(config), /differs/)
    const report = await prerender(['page.html'], config)
    assert.equal(report.failures[0].type, 'build-mismatch')
  } finally { await writeFile(file, original) }
})

test('malformed saved cases still produce a complete check report', async () => {
  const local = { ...config, reportDir: join(root, 'malformed-report') }
  await mkdir(join(local.reportDir, 'cases'), { recursive: true })
  await writeFile(join(local.reportDir, 'cases/corrupt.json'), '{invalid-json')
  const report = await runCheck(local, { verify: async () => ({ ok: true, html: '<p>safe</p>' }) })
  assert.ok(report.failures.some(f => f.page.endsWith('corrupt.json')))
  assert.equal(JSON.parse(await readFile(join(local.reportDir, 'report.json'), 'utf8')).runId, report.runId)
})

test('full sitemap inventory is retained across partial and failed runs; seen keys stay protected', async () => {
  const sitemap = config.sitemap
  const reader = async url => url === sitemap ? '<urlset><url><loc>https://example.myshopify.com/a</loc></url></urlset>' : island('Good', { hit: true })
  await inspectPages(['https://example.myshopify.com'], config, { reader })
  const crawl = JSON.parse(await readFile(join(config.reportDir, 'latest-full-crawl.json'), 'utf8'))
  await inspectPages(['partial.html'], config, { reader: async () => { throw new Error('offline') } })
  assert.equal(JSON.parse(await readFile(join(config.reportDir, 'latest-full-crawl.json'), 'utf8')).runId, crawl.runId)
  const entries = [
    { id: 'keep', handle: cacheKey(build.buildId, 'Good', '{}'), updatedAt: '2020-01-01', fields: [{ key: 'build', value: build.buildId }] },
    { id: 'delete', handle: 'unused', updatedAt: '2020-01-01', fields: [] },
    { id: 'new', handle: 'new', updatedAt: new Date().toISOString(), fields: [] },
  ]
  assert.deepEqual(selectPrunable(entries, [], { deployedBuildId: build.buildId, crawl }).selected.map(e => e.id), ['delete'])
  const latestRun = JSON.parse(await readFile(join(config.reportDir, 'latest-sitemap-run.json'), 'utf8'))
  assert.equal(latestRun.runId, crawl.runId)
})

test('direct Admin API and local CLI share result shape and retry throttling with backoff', async () => {
  const oldToken = process.env.SHOPIFY_ADMIN_TOKEN
  process.env.SHOPIFY_ADMIN_TOKEN = 'test-token'
  let calls = 0, waits = []
  try {
    const admin = createAdmin(config, { sleep: async ms => waits.push(ms), fetcher: async (_url, opts) => {
      assert.equal(opts.headers['X-Shopify-Access-Token'], 'test-token')
      calls++
      if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '1' } })
      if (calls === 2) return Response.json({ errors: [{ extensions: { code: 'THROTTLED' } }] })
      return Response.json({ data: { ok: true } })
    } })
    assert.deepEqual(await admin('query { shop { id } }'), { ok: true })
    assert.deepEqual(waits, [1000, 1000])
    delete process.env.SHOPIFY_ADMIN_TOKEN
    const cli = createAdmin(config, { cli: async args => {
      assert.ok(args.includes('--store'))
      assert.ok(args.includes('--allow-mutations'))
      assert.ok(args.includes('--version'))
      return { stdout: JSON.stringify({ data: { ok: true } }) }
    } })
    assert.deepEqual(await cli('mutation { ignored }', {}, true), { ok: true })
  } finally { if (oldToken === undefined) delete process.env.SHOPIFY_ADMIN_TOKEN; else process.env.SHOPIFY_ADMIN_TOKEN = oldToken }
})

test('client credentials are exchanged for a cached 24-hour token', async () => {
  const env = { SHOPIFY_CLIENT_ID: 'id-1', SHOPIFY_CLIENT_SECRET: 'secret-1' }
  const tokenRequests = [], apiTokens = []
  const fetcher = async (url, opts) => {
    if (url.endsWith('/admin/oauth/access_token')) {
      const body = new URLSearchParams(opts.body)
      tokenRequests.push(Object.fromEntries(body))
      return Response.json({ access_token: `token-${tokenRequests.length}`, expires_in: 86399 })
    }
    apiTokens.push(opts.headers['X-Shopify-Access-Token'])
    return Response.json({ data: { ok: true } })
  }
  const admin = createAdmin(config, { fetcher, env })
  await admin('query { shop { id } }')
  await admin('query { shop { id } }')
  assert.deepEqual(tokenRequests, [{ grant_type: 'client_credentials', client_id: 'id-1', client_secret: 'secret-1' }])
  assert.deepEqual(apiTokens, ['token-1', 'token-1'])

  const failing = createAdmin(config, { env, fetcher: async () => new Response('shop_not_permitted', { status: 400 }) })
  await assert.rejects(failing('query { shop { id } }'), /same Shopify organization/)
})

test('password login preserves cookies and sitemap index expansion rejects foreign hosts', async () => {
  let auth = false, requests = []
  const reader = createPageReader({ password: 'test-password', fetcher: async (url, options) => {
    requests.push({ url, options })
    if (options.method === 'POST') { auth = true; assert.match(options.body, /form_type=storefront_password/); return new Response('ok', { headers: { 'set-cookie': 'storefront=1; Path=/; Secure' } }) }
    if (auth) { assert.match(options.headers.Cookie, /storefront=1/); return new Response('<vue-island>ok</vue-island>') }
    return new Response('<form action="/password"><input name="password"></form>')
  } })
  assert.match(await reader('https://example.myshopify.com/'), /vue-island/)
  assert.equal(requests.length, 3)
  const xml = url => Promise.resolve(url.endsWith('index.xml') ? '<sitemapindex><sitemap><loc>https://example.myshopify.com/child.xml</loc></sitemap></sitemapindex>' : '<urlset><url><loc>https://example.myshopify.com/a?x=1&amp;y=2</loc></url></urlset>')
  assert.deepEqual(await sitemapUrls('https://example.myshopify.com/index.xml', xml), ['https://example.myshopify.com/a?x=1&y=2'])
  await assert.rejects(sitemapUrls('https://example.myshopify.com/index.xml', async () => '<urlset><loc>https://other.invalid/</loc></urlset>'), /cross-origin/)
})

test('package metadata exposes CLI and includes install templates', async () => {
  const destination = join(root, 'consumer')
  await mkdir(destination)
  // Installing the tarball in a clean directory is also exercised by the
  // repository's final smoke check.
  const pkg = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8'))
  assert.equal(pkg.private, undefined)
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.repository, 'github:1291pravin/shopify-vue-ssr')
  assert.equal(pkg.bin['shopify-vue-ssr'], './src/cli.mjs')
  await cp(resolve(workspace, 'templates'), join(destination, 'templates'), { recursive: true })
  assert.match(await readFile(join(destination, 'templates/AGENTS.md'), 'utf8'), /prerender/)
})
