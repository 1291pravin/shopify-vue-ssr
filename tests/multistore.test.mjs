import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { normalizeOptions, selectStore, loadConfig } from '../src/config.mjs'
import { resolveCredentials, createAdmin, createTokenSource } from '../src/admin.mjs'
import { runPages } from '../src/sync.mjs'
import { updateHealthIssue } from '../src/health-issue.mjs'
import { prune } from '../src/prune.mjs'
import { workflowMatrix, workflowSyncArgs } from '../src/workflow.mjs'
import { bundleId } from '../src/key.mjs'
import { fragmentDefinition, buildDefinition } from './helpers/admin.mjs'

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
  // Every network request in CLI integration tests is intercepted. No live store is used.
  await writeFile(join(root, 'mock-network.mjs'), `
    import { appendFileSync } from 'node:fs'
    globalThis.fetch = async (url, options = {}) => {
      appendFileSync(${JSON.stringify(join(root, 'requests.jsonl'))}, JSON.stringify({url, body: options.body}) + '\\n')
      if (url.includes('/admin/api/')) return Response.json({ data: { metaobjectDefinitionByType: options.body.includes('ssr_build') ? ${JSON.stringify(buildDefinition)} : ${JSON.stringify(fragmentDefinition)} } })
      if (url === 'https://fr.example/sitemap.xml') throw new Error('mock first store unavailable')
      if (url === 'https://de.example/sitemap.xml') return new Response('<urlset><url><loc>https://de.example/page</loc></url></urlset>')
      if (url === 'https://de.example/page') return new Response('<main>public page with no islands</main>')
      throw new Error('Unexpected network request: ' + url)
    }
  `)
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

test('legacy single store becomes default; domain env override applies only to default', () => {
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
    assert.equal(selectStore(mixedIds, 'default').store, 'example-override.myshopify.com')
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
    const report = await runPages('doctor', ['same-page.html'], selected, { reader: async () => { throw new Error('mock offline') } })
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

test('CLI stores --json reads ids from TS config and --config; single-store compatibility emits default', async () => {
  assert.deepEqual(JSON.parse((await run(['stores', '--json'])).stdout), ['fr', 'de'])
  await writeFile(join(root, 'legacy.vite.ts'), `import { shopifyVueSsr } from 'shopify-vue-ssr'; export default { plugins: [shopifyVueSsr({ store: 'example-legacy.myshopify.com' })] }`)
  assert.deepEqual(JSON.parse((await run(['stores', '--json', '--config', 'legacy.vite.ts'])).stdout), ['default'])
})

test('CLI requires store selection for store operations and rejects ambiguous/unsupported flags', async () => {
  for (const command of ['init', 'doctor', 'sync', 'prune', 'health-issue']) {
    const result = await run([command])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Several stores configured/)
  }
  for (const args of [['doctor', '--store', 'missing'], ['doctor', '--store', 'fr', '--all-stores'], ['sync', '--all-stores'], ['prune', '--all-stores'], ['doctor', '--all-stores', '--sitemap', 'https://example.test']]) {
    assert.equal((await run(args)).code, 1)
  }
})

test('offline check defaults to every store and retains separate report identities', async () => {
  const result = await run(['check'])
  assert.equal(result.code, 0)
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

test('doctor --all-stores uses each sitemap and continues after a store fails; init --all-stores reuses definitions', async () => {
  const bootstrap = pathToFileURL(join(root, 'mock-network.mjs')).href
  const env = { ...process.env, SHOPIFY_STORE: '', SHOPIFY_ADMIN_TOKEN: 'mock-only', SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: '' }
  const runMocked = async args => {
    try { return { ...await exec(process.execPath, ['--import', bootstrap, cli, ...args, '--root', root], { env }), code: 0 } } catch (error) { return error }
  }
  const doctor = await runMocked(['doctor', '--all-stores'])
  assert.equal(doctor.code, 1)
  const fr = JSON.parse(await readFile(join(root, 'ssr-report/fr/report.json'), 'utf8'))
  const de = JSON.parse(await readFile(join(root, 'ssr-report/de/report.json'), 'utf8'))
  assert.equal(fr.sitemap, stores.fr.sitemap)
  assert.equal(fr.failures.length, 1)
  assert.equal(de.sitemap, stores.de.sitemap)
  assert.equal(de.fullCrawl, true)
  assert.equal(de.failures.length, 0)
  const before = await readFile(join(root, 'vite.config.ts'), 'utf8')
  const init = await runMocked(['init', '--all-stores'])
  assert.equal(init.code, 0, init.stderr)
  assert.match(init.stdout, /"storeId": "fr"/)
  assert.match(init.stdout, /"storeId": "de"/)
  assert.equal(await readFile(join(root, 'vite.config.ts'), 'utf8'), before)
  const requests = (await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const admin = requests.filter(request => request.url.includes('/admin/api/'))
  assert.equal(admin.length, 4)
  assert.ok(admin.every(request => !request.body.includes('mutation')))
})

test('prune refuses another store id even when the domain matches', async () => {
  const fr = selectStore(config, 'fr')
  await writeFile(join(fr.reportDir, 'latest-full-crawl.json'), JSON.stringify({ storeId: 'de', store: fr.store }))
  let calls = 0
  const result = await prune(fr, { admin: async () => { calls++ } })
  assert.match(result.failures[0].message, /different store/)
  assert.equal(calls, 0)
})

test('health issue lifecycle uses exact per-store titles and leaves other store issues untouched', async () => {
  const existing = [{ number: 1, title: 'SSR health - fr' }, { number: 2, title: 'SSR health - de' }, { number: 3, title: 'SSR health - fr extra' }]
  let calls = []
  const gh = async args => { calls.push(args); return { stdout: args[1] === 'list' ? JSON.stringify(existing) : '' } }
  const report = { storeId: 'fr', failures: [{}], counts: { failed: 1 }, fullCrawl: false }
  assert.equal(await updateHealthIssue(report, '/fr/summary.md', gh), 'updated')
  assert.ok(calls.some(args => args[1] === 'edit' && args[2] === '1'))
  calls = []
  assert.equal(await updateHealthIssue({ ...report, failures: [], counts: { failed: 0 } }, '/fr/summary.md', gh), 'unchanged')
  assert.equal(await updateHealthIssue({ ...report, failures: [], counts: { failed: 0 }, fullCrawl: true }, '/fr/summary.md', gh), 'closed')
  assert.deepEqual(calls.filter(args => args[1] === 'close').map(args => args[2]), ['1'])
  calls = []
  assert.equal(await updateHealthIssue({ ...report, storeId: 'eu' }, '/eu/summary.md', gh), 'opened')
  assert.ok(calls.some(args => args[1] === 'create' && args.includes('SSR health - eu')))
})

test('workflow matrix renders configured ids, credential aliases and optional dispatch selection', () => {
  const ids = ['fr', 'de']
  assert.deepEqual(workflowMatrix(config, ids), { store: [{ id: 'fr', suffix: 'FR', credentials: 'FR' }, { id: 'de', suffix: 'DE', credentials: 'OTHER_ORG' }] })
  assert.deepEqual(workflowMatrix(config, ids, 'de').store.map(store => store.id), ['de'])
  for (const invalid of ['unknown', '', 1, [], {}]) assert.throws(() => workflowMatrix(config, ids, invalid), /configured store id/)
})

test('workflow dispatch args target only the selected store and validate its public origins', () => {
  const fr = selectStore(config, 'fr')
  assert.deepEqual(workflowSyncArgs(fr, null), ['sync', '--store', 'fr', '--sitemap', stores.fr.sitemap])
  const urls = ['https://fr.example/products/one', 'https://example-fr.myshopify.com/pages/one']
  assert.deepEqual(workflowSyncArgs(fr, urls), ['sync', '--store', 'fr', ...urls])
  for (const invalid of [[], 'url', ['http://fr.example'], ['https://de.example'], ['https://fr.example:444'], ['https://user:pass@fr.example'], ['--yes'], [3]]) assert.throws(() => workflowSyncArgs(fr, invalid), /Dispatch urls/)
})

test('init installs the workflow template with matrix, per-store concurrency, artifacts, issues and secrets', async () => {
  const template = await readFile(new URL('../templates/ssr-sync.yml', import.meta.url), 'utf8')
  const installed = join(root, '.github/workflows/ssr-sync.yml')
  assert.equal(template, await readFile(installed, 'utf8'))
  for (const pattern of [/shopify-vue-ssr', 'stores', '--json'/, /fail-fast: false/, /fromJSON\(needs.stores.outputs.matrix\)/, /group: ssr-health-\$\{\{ matrix.store.id \}\}/, /name: ssr-report-\$\{\{ matrix.store.id \}\}/, /path: ssr-report\/\$\{\{ matrix.store.id \}\}\//, /health-issue --store "\$STORE_ID"/, /GITHUB_EVENT_PATH/, /payload.store/, /payload.urls/, /secrets\[format\('SHOPIFY_CLIENT_ID_/, /workflowSyncArgs/]) assert.match(template, pattern)
  assert.ok([...template.matchAll(/uses: (.+)/g)].every(match => match[1].startsWith('actions/')))
})

test('actual workflow setup script renders scheduled/manual and store-filtered matrices from event files', async () => {
  const template = (await readFile(new URL('../templates/ssr-sync.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
  const scripts = [...template.matchAll(/<<'NODE'\n([\s\S]*?)\n          NODE/g)].map(match => match[1].split('\n').map(line => line.slice(10)).join('\n'))
  assert.equal(scripts.length, 2)
  // Adapt only executable/import paths for Windows; execute the shipped template logic.
  const script = scripts[0].replace("execFileSync('npx', ['--no-install', 'shopify-vue-ssr',", `execFileSync(process.execPath, [${JSON.stringify(cli)},`)
    .replaceAll('./node_modules/shopify-vue-ssr/src/config.mjs', pathToFileURL(join(workspace, 'src/config.mjs')).href)
    .replaceAll('./node_modules/shopify-vue-ssr/src/workflow.mjs', pathToFileURL(join(workspace, 'src/workflow.mjs')).href)
  const eventFile = join(root, 'event.json'), outputFile = join(root, 'github-output')
  for (const [event, expected] of [[{}, ['fr', 'de']], [{ client_payload: {} }, ['fr', 'de']], [{ client_payload: { store: 'de', urls: ['https://de.example/page'] } }, ['de']]]) {
    await writeFile(eventFile, JSON.stringify(event))
    await writeFile(outputFile, '')
    execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, env: { ...process.env, SHOPIFY_STORE: '', GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: outputFile } })
    const matrix = JSON.parse((await readFile(outputFile, 'utf8')).trim().slice('matrix='.length))
    assert.deepEqual(matrix.store.map(store => store.id), expected)
  }
})
