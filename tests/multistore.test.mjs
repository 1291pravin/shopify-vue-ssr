import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { normalizeOptions, selectStore, loadConfig } from '../src/config.mjs'
import { resolveCredentials, createAdmin, createTokenSource } from '../src/admin.mjs'
import { prerender } from '../src/prerender.mjs'
import { prune } from '../src/prune.mjs'
import { bundleId } from '../src/key.mjs'

const exec = promisify(execFile)
const workspace = resolve(import.meta.dirname, '..'), out = join(workspace, 'out')
const cli = join(workspace, 'src/cli.mjs')
const stores = {
  fr: { domain: 'example-fr.myshopify.com', sitemap: 'https://fr.example/sitemap.xml' },
  de: { domain: 'example-de.myshopify.com', sitemap: 'https://de.example/sitemap.xml', credentials: 'OTHER_ORG' },
}
let root, config, buildId
const run = async (args, extra = {}) => {
  try { return { ...await exec(process.execPath, [cli, ...args, '--root', root], { env: { ...process.env, SHOPIFY_STORE: '', ...extra.env }, ...extra }), code: 0 } }
  catch (error) { return error }
}
before(async () => {
  await mkdir(out, { recursive: true })
  root = await mkdtemp(join(out, 'multistore-test-'))
  await writeFile(join(root, 'vite.config.ts'), `import { shopifyVueSsr } from 'shopify-vue-ssr'; export default { plugins: [shopifyVueSsr({ stores: ${JSON.stringify(stores)} })] }`)
  config = await loadConfig(root)
  const server = '// shared build\n'
  buildId = bundleId(server)
  await mkdir(config.outDir, { recursive: true })
  await writeFile(join(config.outDir, 'server-entry.mjs'), server)
  await writeFile(join(config.outDir, 'build.json'), JSON.stringify({ entry: 'server-entry.mjs', buildId, components: [] }))

})
after(async () => { if (root && dirname(root) === out) await rm(root, { recursive: true, force: true }) })

test('store selection isolates domain, sitemap and report path without changing shared build paths', () => {
  assert.throws(() => selectStore(config), /Several stores configured.*--store/)
  assert.throws(() => selectStore(config, 'unknown'), /Unknown store.*fr, de/)
  for (const id of ['fr', 'de']) {
    const selected = selectStore(config, id)
    assert.equal(selected.storeId, id)
    assert.equal(selected.store, stores[id].domain)
    assert.equal(selected.sitemap, stores[id].sitemap)
    assert.equal(selected.reportDir, join(root, 'ssr-report', id))
    assert.equal(selected.outDir, config.outDir)
    assert.equal(selectStore(selected, id).reportDir, selected.reportDir)
  }
})

test('legacy single store becomes default; domain env override applies only to single-store configuration', () => {
  const previous = process.env.SHOPIFY_STORE
  try {
    process.env.SHOPIFY_STORE = 'example-override.myshopify.com'
    const legacy = normalizeOptions({ store: 'example-old.myshopify.com', sitemap: 'https://old.example/sitemap.xml' }, root)
    assert.equal(legacy.storeId, 'default')
    assert.equal(legacy.store, 'example-override.myshopify.com')
    assert.equal(legacy.sitemap, 'https://old.example/sitemap.xml')
    assert.equal(legacy.reportDir, join(root, 'ssr-report/default'))
    const named = normalizeOptions({ stores: { fr: stores.fr } }, root)
    assert.equal(named.store, stores.fr.domain)
    const mixedIds = normalizeOptions({ stores: { default: stores.fr, de: stores.de } }, root)
    assert.equal(selectStore(mixedIds, 'default').store, stores.fr.domain)
    assert.equal(selectStore(mixedIds, 'de').store, stores.de.domain)
  } finally { if (previous === undefined) delete process.env.SHOPIFY_STORE; else process.env.SHOPIFY_STORE = previous }
})

test('invalid store maps, unsafe ids, duplicate suffixes and mixed configuration fail clearly', () => {
  for (const bad of [null, [], {}, { '../escape': stores.fr }, { fr: stores.fr, FR: stores.fr }, { fr: null }, { fr: { domain: 'foreign.example', sitemap: stores.fr.sitemap } }, { fr: { ...stores.fr, credentials: 'bad-suffix' } }]) {
    assert.throws(() => normalizeOptions({ stores: bad }, root), /stores|store|Store|suffix/)
  }
  assert.throws(() => normalizeOptions({ stores, store: 'example-old.myshopify.com' }, root), /Choose stores/)
})

test('credential suffix pairs override the shared app; other-organization aliases are supported', () => {
  const env = { SHOPIFY_CLIENT_ID: 'base', SHOPIFY_CLIENT_SECRET: 'base-secret', SHOPIFY_CLIENT_ID_FR: 'fr', SHOPIFY_CLIENT_SECRET_FR: 'fr-secret', SHOPIFY_CLIENT_ID_OTHER_ORG: 'other', SHOPIFY_CLIENT_SECRET_OTHER_ORG: 'other-secret' }
  assert.deepEqual(resolveCredentials(selectStore(config, 'fr'), env), { clientId: 'fr', clientSecret: 'fr-secret' })
  assert.deepEqual(resolveCredentials(selectStore(config, 'de'), env), { clientId: 'other', clientSecret: 'other-secret' })
  assert.deepEqual(resolveCredentials(selectStore(config, 'de'), { ...env, SHOPIFY_CLIENT_ID_DE: 'de', SHOPIFY_CLIENT_SECRET_DE: 'de-secret' }), { clientId: 'de', clientSecret: 'de-secret' })
  assert.equal(resolveCredentials({ storeId: 'eu' }, env).clientId, 'base')
  assert.throws(() => resolveCredentials({ storeId: 'fr' }, { ...env, SHOPIFY_CLIENT_SECRET_FR: '' }), /requires both.*_FR/)
})

test('one shared app exchanges and caches separate tokens for each domain, including parallel requests and expiry', async () => {
  const env = { SHOPIFY_CLIENT_ID: 'shared', SHOPIFY_CLIENT_SECRET: 'shared-secret' }
  const exchanges = [], api = []
  let now = 0
  const fetcher = async (url, options) => {
    if (url.endsWith('/access_token')) {
      exchanges.push({ url, ...Object.fromEntries(new URLSearchParams(options.body)) })
      return Response.json({ access_token: new URL(url).hostname + '-token-' + exchanges.length, expires_in: 120 })
    }
    api.push({ url, token: options.headers['X-Shopify-Access-Token'] })
    return Response.json({ data: { ok: true } })
  }
  const fr = createTokenSource(stores.fr.domain, { env, fetcher, now: () => now, storeId: 'fr' })
  const again = createTokenSource(stores.fr.domain, { env, fetcher, now: () => now, storeId: 'fr' })
  const de = createTokenSource(stores.de.domain, { env, fetcher, now: () => now, storeId: 'de' })
  const tokens = await Promise.all([fr(), fr(), again(), de(), de()])
  assert.equal(exchanges.length, 2)
  assert.equal(tokens[0], tokens[2])
  assert.notEqual(tokens[0], tokens[3])
  now = 61_000
  await Promise.all([fr(), again(), de()])
  assert.equal(exchanges.length, 4)
  const clients = ['fr', 'de'].map(id => createAdmin(selectStore(config, id), { env, fetcher }))
  await Promise.all(clients.map(admin => admin('query { ignored }')))
  assert.match(api[0].url, /example-fr/)
  assert.match(api[0].token, /example-fr/)
  assert.match(api[1].token, /example-de/)
})

test('failed token exchanges can retry and credentials rotation does not reuse a token', async () => {
  const env = { SHOPIFY_CLIENT_ID: 'one', SHOPIFY_CLIENT_SECRET: 'first' }
  let count = 0
  const fetcher = async () => ++count === 1 ? new Response('denied', { status: 400 }) : Response.json({ access_token: `token-${count}` })
  const token = createTokenSource(stores.fr.domain, { env, fetcher })
  await assert.rejects(token(), /Token request failed/)
  assert.equal(await token(), 'token-2')
  env.SHOPIFY_CLIENT_SECRET = 'rotated'
  assert.equal(await createTokenSource(stores.fr.domain, { env, fetcher })(), 'token-3')
})

test('per-store reports, failures and cases retain identity; cases replay by path without store selection', async () => {
  const ids = []
  for (const id of ['fr', 'de']) {
    const selected = selectStore(config, id)
    const report = await prerender(['same-page.html'], selected, { reader: async () => { throw new Error('mock offline') } })
    const savedReport = JSON.parse(await readFile(join(selected.reportDir, 'report.json'), 'utf8'))
    const failure = JSON.parse((await readFile(join(selected.reportDir, 'failures.jsonl'), 'utf8')).trim())
    const file = join(selected.reportDir, 'cases', failure.id + '.json')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    for (const record of [report, savedReport, failure, saved]) { assert.equal(record.storeId, id); assert.equal(record.store, stores[id].domain) }
    assert.match(saved.repro, new RegExp(`--store ${id}$`))
    const summary = await readFile(join(selected.reportDir, 'summary.md'), 'utf8')
    assert.ok(summary.includes(stores[id].domain))
    const replay = await run(['repro', file, '--json'])
    assert.equal(JSON.parse(replay.stdout).storeId, id)
    assert.equal(JSON.parse(replay.stdout).type, 'fetch-error')
    const byId = await run(['repro', saved.id, '--store', id, '--json'])
    assert.equal(JSON.parse(byId.stdout).store, stores[id].domain)
    ids.push(failure.id)
  }
  assert.notEqual(...ids)
})

test('CLI requires store selection for store operations and rejects ambiguous/unsupported flags', async () => {
  for (const command of ['setup', 'prerender']) {
    const result = await run([command])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Several stores configured/)
  }
  for (const args of [['prerender', '--store', 'missing'], ['prerender', '--store', 'fr', '--all-stores'], ['prerender', '--all-stores'], ['prerender', '--all-stores'], ['prerender', '--all-stores', '--sitemap', 'https://example.test']]) {
    assert.equal((await run(args)).code, 1)
  }
})

test('offline check defaults to every store and retains separate report identities', async () => {
  await mkdir(join(root, 'src/islands'), { recursive: true })
  await writeFile(join(root, 'src/islands/Placeholder.vue'), '<template><p>Public example</p></template>')
  const result = await run(['check'])
  assert.equal(result.code, 0, result.stderr)
  const firstRuns = {}
  for (const id of ['fr', 'de']) {
    const report = JSON.parse(await readFile(join(root, 'ssr-report', id, 'report.json'), 'utf8'))
    assert.equal(report.command, 'check')
    assert.equal(report.storeId, id)
    assert.equal(report.store, stores[id].domain)
    firstRuns[id] = report.runId
  }
  const brokenCase = join(root, 'ssr-report/fr/cases/broken.json')
  await writeFile(brokenCase, '{invalid')
  try {
    assert.equal((await run(['check'])).code, 1)
    const second = JSON.parse(await readFile(join(root, 'ssr-report/de/report.json'), 'utf8'))
    assert.notEqual(second.runId, firstRuns.de)
    assert.equal(second.failures.length, 0)
  } finally { await rm(brokenCase) }
})

test('prune refuses another store id even when the domain matches', async () => {
  const fr = selectStore(config, 'fr')
  await writeFile(join(fr.reportDir, 'latest-full-crawl.json'), JSON.stringify({ storeId: 'de', store: fr.store }))
  let calls = 0
  const result = await prune(fr, { admin: async () => { calls++ } })
  assert.match(result.failures[0].message, /different store/)
  assert.equal(calls, 0)
})
