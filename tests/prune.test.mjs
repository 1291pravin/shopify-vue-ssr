import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { operations, createAdmin, ensureDefinition, ensureBuildDefinition, touchBuild, upsertFragment } from '../src/admin.mjs'
import { parseInventory, bulkList, bulkDelete, selectPrunable, prune, inventoryQuery } from '../src/prune.mjs'
import { normalizeOptions, pruneOptions } from '../src/config.mjs'
import { runPages } from '../src/sync.mjs'
import { bundleId, cacheKey } from '../src/key.mjs'
import { fragmentDefinition, buildDefinition } from './helpers/admin.mjs'

const out = resolve(import.meta.dirname, '../out')
const current = 'a'.repeat(64), now = Date.parse('2026-11-04T12:00:00Z')
const fragment = (id, build, updatedAt = '2026-01-01', handle = id) => ({ id, handle, type: 'ssr_fragment', updatedAt, fields: [{ key: 'html', value: 'cafe\u00e9' }, ...(build ? [{ key: 'build', value: build }] : [])] })
const history = (handle, lastSeen) => ({ id: `history-${handle}`, handle, type: 'ssr_build', fields: [{ key: 'last_seen', value: lastSeen }] })
const crawl = { runId: 'clean', time: '2026-11-03', fullCrawl: true, buildId: current, sitemap: 'https://example.myshopify.com/sitemap.xml', failures: [], pages: [{ islands: [{ key: 'seen' }] }] }
const select = (entries, builds = [], options = {}) => selectPrunable(entries, builds, { deployedBuildId: current, crawl, now, ...options })
async function temp(fn) {
  await mkdir(out, { recursive: true })
  const root = await mkdtemp(join(out, 'prune-test-'))
  try { return await fn(root) } finally { assert.equal(dirname(root), out); await rm(root, { recursive: true, force: true }) }
}
function inventoryAdmin(entries, builds = []) {
  const calls = [], removed = new Set()
  const admin = async (query, vars, mutation) => {
    calls.push({ query, vars, mutation })
    if (query === operations.bulkQuery) return { bulkOperationRunQuery: { bulkOperation: { id: vars.query.includes('ssr_fragment') ? 'fragments' : 'builds' }, userErrors: [] } }
    if (query === operations.bulkStatus) {
      const rows = (vars.id === 'fragments' ? entries : builds).filter(row => !removed.has(row.id))
      return { node: { status: 'COMPLETED', objectCount: String(rows.length), url: rows.length ? 'data:application/jsonl,' + encodeURIComponent(rows.map(row => JSON.stringify(row)).join('\n')) : null } }
    }
    if (query === operations.bulkDelete) { vars.where.ids.forEach(id => removed.add(id)); return { metaobjectBulkDelete: { job: { id: 'delete-job', done: true }, userErrors: [] } } }
    if (query === operations.nodes) return { nodes: vars.ids.map(id => removed.has(id) ? null : { id }) }
    throw new Error('Unexpected operation')
  }
  return { admin, calls, removed }
}

test('prune defaults and config/CLI override values reject unsafe numbers', () => {
  assert.deepEqual(pruneOptions(), { keepBuilds: 3, graceDays: 14, maxDelete: 20000 })
  assert.equal(normalizeOptions({ prune: { keepBuilds: 2 } }, out).prune.keepBuilds, 2)
  for (const options of [{ keepBuilds: 0 }, { graceDays: -1 }, { maxDelete: 1.5 }, { maxDelete: NaN }, { wrong: 3 }]) assert.throws(() => pruneOptions(options), /Invalid prune/)
})

test('old builds keep deployed plus the most recently seen other builds; missing history is oldest', () => {
  const builds = [history('old', '2026-01-01'), history('recent', '2026-11-01'), history('other', '2026-11-02')]
  const result = select([fragment('a', 'old', '2026-11-04'), fragment('b', 'recent', '2026-11-04'), fragment('c', current, '2026-11-04'), fragment('unknown', 'untracked')], builds)
  assert.deepEqual(result.keptBuilds, [current, 'other', 'recent'])
  assert.deepEqual(result.deletedBuilds, ['old', 'untracked'])
  assert.deepEqual(result.selected.map(entry => entry.id), ['a', 'unknown'])
  assert.equal(result.counts.oldBuilds, 2)
})

test('rollback refresh retains an old build according to last_seen rather than first_seen', () => {
  const builds = [history('rollback', '2026-11-04'), history('newer', '2026-11-02'), history('newest', '2026-11-03')]
  assert.deepEqual(select([], builds).keptBuilds, [current, 'rollback', 'newest'])
  assert.deepEqual(select([], builds, { deployedBuildId: 'rollback', keepBuilds: 2 }).keptBuilds, ['rollback', 'newest'])
})

test('stale content honors grace, seen keys, invalid dates and run snapshot time', () => {
  const result = select([fragment('stale', current), fragment('seen-id', current, '2020-01-01', 'seen'), fragment('fresh', current, '2026-11-01'), fragment('invalid', current, 'invalid')])
  assert.deepEqual(result.selected.map(entry => entry.id), ['stale'])
  assert.equal(result.counts.staleContent, 1)
  assert.equal(select([fragment('after-crawl', current, '2026-11-03T12:00:00Z')], [], { graceDays: 0 }).selected.length, 0)
  assert.equal(select([fragment('boundary', current, new Date(now - 14 * 86400000).toISOString())]).selected.length, 0)
})

test('legacy entries require grace and deployed seen handles remain protected', () => {
  const result = select([fragment('legacy', null), fragment('legacy-seen', null, '2020-01-01', 'seen'), fragment('legacy-new', null, '2026-11-04')])
  assert.deepEqual(result.selected.map(entry => entry.id), ['legacy'])
  assert.equal(result.counts.legacy, 1)
})

test('unconfirmed deployment selects nothing, including legacy and old builds', () => {
  const result = select([fragment('old', 'old'), fragment('legacy', null)], [], { deployedBuildId: null })
  assert.equal(result.blocked, true)
  assert.equal(result.selected.length, 0)
  assert.match(result.skipped[0], /confirmed/)
})

test('failed or incomplete latest full run blocks stale content but allows independent old/legacy rules', () => {
  for (const latestRun of [{ ...crawl, runId: 'failed', failures: [{}] }, { ...crawl, runId: 'unfinished', fullCrawl: false }]) {
    const result = select([fragment('stale', current), fragment('old', 'old'), fragment('legacy', null)], [], { keepBuilds: 1, latestRun })
    assert.deepEqual(result.selected.map(entry => entry.id), ['old', 'legacy'])
    assert.match(result.skipped[0], /Stale content/)
  }
  assert.equal(select([fragment('stale', current)], [], { crawl: null }).selected.length, 0)
  assert.equal(select([fragment('stale', current)], [], { crawl: { ...crawl, buildId: 'other' } }).selected.length, 0)
})

test('maxDelete cap includes build history records and permits exactly the cap', () => {
  const rows = [fragment('old', 'old')], builds = [history('old', '2020-01-01')]
  assert.equal(select(rows, builds, { keepBuilds: 1, maxDelete: 1 }).blocked, true)
  assert.equal(select(rows, builds, { keepBuilds: 1, maxDelete: 2 }).blocked, false)
})

test('init adds only the missing build field and creates private build history idempotently', async () => {
  const old = structuredClone(fragmentDefinition); old.fieldDefinitions.pop()
  old.fieldDefinitions.push({ key: 'custom', type: { name: 'single_line_text_field' }, validations: [{ name: 'max', value: '10' }] })
  const original = structuredClone(old)
  let build = null
  const mutations = []
  const admin = async (query, vars, mutation) => {
    if (!mutation) return { metaobjectDefinitionByType: query === operations.definition ? old : build }
    mutations.push(vars)
    if (query === operations.updateDefinition) {
      assert.deepEqual(vars.definition, { fieldDefinitions: [{ create: { name: 'Build', key: 'build', type: 'single_line_text_field' } }] })
      old.fieldDefinitions.push({ key: 'build', type: { name: 'single_line_text_field' } })
      return { metaobjectDefinitionUpdate: { metaobjectDefinition: { id: old.id }, userErrors: [] } }
    }
    assert.equal(vars.definition.type, 'ssr_build')
    assert.equal(vars.definition.access.storefront, 'NONE')
    assert.ok(vars.definition.fieldDefinitions.every(field => field.type === 'date_time'))
    build = structuredClone(buildDefinition)
    return { metaobjectDefinitionCreate: { metaobjectDefinition: { id: build.id }, userErrors: [] } }
  }
  for (let i = 0; i < 2; i++) { await ensureDefinition(admin); await ensureBuildDefinition(admin) }
  assert.equal(mutations.length, 2)
  assert.deepEqual(old.fieldDefinitions.slice(0, -1), original.fieldDefinitions)
  assert.deepEqual(old.access, original.access)
})

test('init refuses incompatible fragment or build definitions without mutation', async () => {
  for (const change of [definition => { definition.access.storefront = 'NONE' }, definition => { definition.fieldDefinitions[2].type.name = 'number_integer' }, definition => { definition.capabilities.publishable.enabled = true }]) {
    const definition = structuredClone(fragmentDefinition); change(definition)
    await assert.rejects(ensureDefinition(async (_q, _v, mutation) => { assert.ok(!mutation); return { metaobjectDefinitionByType: definition } }), /incompatible/)
  }
  const definition = structuredClone(buildDefinition); definition.access.storefront = 'PUBLIC_READ'
  await assert.rejects(ensureBuildDefinition(async () => ({ metaobjectDefinitionByType: definition })), /incompatible/)
})

test('fragment upsert includes build; history first_seen is preserved and last_seen refreshes on rollback', async () => {
  const calls = []
  let firstSeen
  const admin = async (query, vars) => {
    if (query === operations.build) return { metaobjectByHandle: firstSeen ? { fields: [{ key: 'first_seen', value: firstSeen }] } : null }
    calls.push({ query, vars })
    if (query === operations.upsertBuild) firstSeen ??= vars.metaobject.fields.find(field => field.key === 'first_seen')?.value
    return { metaobjectUpsert: { metaobject: { id: 'id' }, userErrors: [] } }
  }
  await upsertFragment(admin, { key: 'key', name: 'Good', html: '<p>safe</p>', build: current })
  assert.equal(calls[0].vars.build, current)
  await touchBuild(admin, current, now - 86400000)
  await touchBuild(admin, current, now)
  assert.equal(calls[1].vars.metaobject.fields.length, 2)
  assert.deepEqual(calls[2].vars.metaobject.fields, [{ key: 'last_seen', value: new Date(now).toISOString() }])
})

test('sync records history on all-hit and empty verified pages; dry run and doctor never touch history', async () => temp(async root => {
  const config = { root, outDir: join(root, 'dist'), reportDir: join(root, 'reports'), storeId: 'test', store: 'example.myshopify.com', widths: [375] }
  const server = '// test build', id = bundleId(server), props = '{}', key = cacheKey(id, 'Good', props)
  await mkdir(config.outDir)
  await writeFile(join(config.outDir, 'server-entry.mjs'), server)
  await writeFile(join(config.outDir, 'build.json'), JSON.stringify({ entry: 'server-entry.mjs', buildId: id, components: ['Good'] }))
  const html = `<vue-island data-component="Good" data-ssr-build="${id}" data-ssr-key="${key}"><script data-props>${props}</script><div data-ssr-root data-ssr="1"></div></vue-island>`
  let writes = 0
  const admin = async (query) => {
    if (query === operations.build) return { metaobjectByHandle: null }
    assert.equal(query, operations.upsertBuild); writes++
    return { metaobjectUpsert: { metaobject: { id: 'history' }, userErrors: [] } }
  }
  for (const [command, dryRun, page] of [['sync', false, html + html], ['sync', true, html], ['doctor', false, html], ['sync', false, `<meta name="ssr-build-id" content="${id}">`]]) {
    assert.equal((await runPages(command, ['page'], config, { dryRun, reader: async () => page, admin })).failures.length, 0)
  }
  assert.equal(writes, 2)
}))

test('JSONL parser streams split UTF-8, CRLF, empty lines and no terminal newline; rejects malformed/foreign rows', async () => {
  const row = fragment('one', current), raw = Buffer.from(JSON.stringify(row) + '\r\n\n' + JSON.stringify(fragment('two', null)))
  async function* chunks() { for (let i = 0; i < raw.length; i += 3) yield raw.subarray(i, i + 3) }
  assert.deepEqual(await parseInventory(chunks(), 'ssr_fragment'), [row, fragment('two', null)])
  for (const raw of ['{broken', JSON.stringify(history('other', '2020-01-01')), JSON.stringify(row) + '\n' + JSON.stringify(row)]) await assert.rejects(parseInventory([raw], 'ssr_fragment'))
})

test('bulk inventory polls exact operation, accepts zero results and rejects failed/partial or truncated exports', async () => {
  const row = fragment('one', current)
  let polls = 0
  const admin = async query => query === operations.bulkQuery ? { bulkOperationRunQuery: { bulkOperation: { id: 'bulk-id' }, userErrors: [] } } : { node: ++polls === 1 ? { status: 'RUNNING' } : { status: 'COMPLETED', objectCount: '1', url: 'https://download.test' } }
  const waits = []
  assert.deepEqual(await bulkList(admin, 'ssr_fragment', { pause: async ms => waits.push(ms), fetcher: async () => new Response(JSON.stringify(row)) }), [row])
  assert.deepEqual(waits, [5000])
  const failed = async query => query === operations.bulkQuery ? { bulkOperationRunQuery: { bulkOperation: { id: 'x' }, userErrors: [] } } : { node: { status: 'FAILED', errorCode: 'TIMEOUT', partialDataUrl: 'ignored' } }
  await assert.rejects(bulkList(failed, 'ssr_fragment'), /FAILED/)
  await assert.rejects(bulkList(admin, 'ssr_fragment', { fetcher: async () => new Response('') }), /Incomplete/)
  assert.deepEqual(await bulkList(inventoryAdmin([], []).admin, 'ssr_fragment'), [])
  assert.match(inventoryQuery('ssr_fragment'), /edges.*id type handle updatedAt fields/)
})

test('bulk deletion batches exact IDs at 250, backs off throttles and verifies disappearance after jobs', async () => {
  const batches = [], waits = []
  let throttled = false, polls = 0
  const admin = createAdmin({ root: out, store: 'example.myshopify.com' }, { env: { SHOPIFY_ADMIN_TOKEN: 'mock' }, sleep: async ms => waits.push(ms), fetcher: async (_url, options) => {
    const { query, variables } = JSON.parse(options.body)
    if (query === operations.bulkDelete) {
      if (!throttled) { throttled = true; return Response.json({ errors: [{ extensions: { code: 'THROTTLED' } }] }) }
      batches.push(variables.where.ids)
      return Response.json({ data: { metaobjectBulkDelete: { job: { id: 'job', done: false }, userErrors: [] } } })
    }
    if (query === operations.job) { polls++; return Response.json({ data: { job: { done: true } } }) }
    return Response.json({ data: { nodes: variables.ids.map(() => null) } })
  } })
  let deleted = 0
  await bulkDelete(admin, Array.from({ length: 501 }, (_, i) => `id-${i}`), { pause: async ms => waits.push(ms), onDeleted: ids => { deleted += ids.length } })
  assert.deepEqual(batches.map(batch => batch.length), [250, 250, 1])
  assert.equal(polls, 3); assert.equal(deleted, 501)
  assert.deepEqual(waits, [500, 2000, 2000, 2000])
})

test('bulk deletion refuses user errors, remaining objects and timed out jobs', async () => {
  await assert.rejects(bulkDelete(async () => ({ metaobjectBulkDelete: { userErrors: [{ message: 'denied' }] } }), ['id']), /denied/)
  const admin = async query => query === operations.bulkDelete ? { metaobjectBulkDelete: { job: { id: 'job', done: true }, userErrors: [] } } : { nodes: [{ id: 'still-present' }] }
  await assert.rejects(bulkDelete(admin, ['id']), /still exist/)
  await assert.rejects(bulkDelete(async () => ({ metaobjectBulkDelete: { job: { id: 'job', done: false }, userErrors: [] } }), ['id'], { maxPolls: 0 }), /timed out/)
})

test('prune reports dry-run candidates, cap/confirmation guards, actual deletions and bytes without HTML', async () => temp(async root => {
  const config = { root, reportDir: join(root, 'reports'), storeId: 'test', store: 'example.myshopify.com', sitemap: crawl.sitemap, prune: { keepBuilds: 1, graceDays: 14, maxDelete: 20 } }
  await mkdir(config.reportDir)
  const saved = { ...crawl, storeId: config.storeId, store: config.store }
  await writeFile(join(config.reportDir, 'latest-full-crawl.json'), JSON.stringify(saved))
  await writeFile(join(config.reportDir, 'latest-sitemap-run.json'), JSON.stringify(saved))
  const entries = [fragment('old', 'old'), fragment('stale', current), fragment('legacy', null), fragment('seen', current)]
  const builds = [history('old', '2020-01-01')], reader = async () => `<meta name="ssr-build-id" content="${current}">`
  const mock = inventoryAdmin(entries, builds)
  const dry = await prune(config, { admin: mock.admin, reader, now })
  assert.deepEqual(dry.counts, { oldBuilds: 1, staleContent: 1, legacy: 1 })
  assert.equal(dry.before.fragments.entries, 4); assert.equal(dry.projectedAfter.fragments.entries, 1)
  assert.deepEqual(dry.after, dry.before); assert.equal(mock.removed.size, 0)
  assert.ok(!JSON.stringify(dry).includes('cafe'))
  const capped = await prune(config, { admin: mock.admin, reader, now, yes: true, maxDelete: 3 })
  assert.equal(capped.blocked, true); assert.equal(mock.removed.size, 0)
  const blocked = await prune(config, { admin: mock.admin, now, yes: true, reader: async () => { throw new Error('Storefront password required') } })
  assert.equal(blocked.blocked, true); assert.equal(blocked.selected.length, 0); assert.equal(mock.removed.size, 0)
  const live = await prune(config, { admin: mock.admin, reader, now, yes: true })
  assert.deepEqual(live.deleted, { fragments: 3, builds: 1 }); assert.equal(live.after.fragments.entries, 1)
  assert.equal(live.after.fragments.bytes, live.projectedAfter.fragments.bytes)
  const report = JSON.parse(await readFile(join(config.reportDir, 'prune.json'), 'utf8'))
  assert.equal(report.storeId, 'test'); assert.equal(report.store, config.store); assert.equal(report.dryRun, false)
  const summary = await readFile(join(config.reportDir, 'summary.md'), 'utf8')
  assert.equal(summary.match(/## Cache cleanup/g).length, 1); assert.match(summary, /Deleted: 3 fragments/)
}))

test('deployment changes during inventory stop deletion; inventory errors persist failure reports', async () => temp(async root => {
  const config = { root, reportDir: root, storeId: 'test', store: 'example.myshopify.com' }
  let probes = 0
  const mock = inventoryAdmin([fragment('legacy', null)])
  const report = await prune(config, { admin: mock.admin, now, yes: true, reader: async () => `<meta name="ssr-build-id" content="${++probes === 1 ? current : 'b'.repeat(64)}">` })
  assert.match(report.failures[0].message, /changed since inventory/); assert.equal(mock.removed.size, 0)
  const failed = await prune(config, { admin: async () => { throw new Error('inventory unavailable') }, now, reader: async () => '' })
  assert.match(failed.failures[0].message, /inventory unavailable/)
  assert.equal(JSON.parse(await readFile(join(root, 'prune.json'), 'utf8')).failures.length, 1)
}))

test('daily workflow runs full sync then cleanup only on success through the per-store matrix', async () => {
  const text = (await readFile(new URL('../templates/ssr-sync.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
  assert.match(text, /cron: '0 3 \* \* \*'/)
  assert.match(text, /result.status === 0.*schedule === '0 3 \* \* \*'/)
  assert.match(text, /!report.fullCrawl \|\| report.failures.length \|\| report.dryRun/)
  assert.match(text, /'prune', '--store', config.storeId, '--yes'/)
  assert.match(text, /health-issue --store/)
  const script = [...text.matchAll(/<<'NODE'\n([\s\S]*?)\n          NODE/g)][1][1].split('\n').map(line => line.slice(10)).join('\n')
  // Execute shipped sync/cleanup branching with fake process I/O, without network or child commands.
  const body = script.replace(/^import .*\n/gm, '')
  for (const scenario of [{ schedule: '0 3 * * *', status: 0, full: true, failures: [], prune: true }, { schedule: '0 3 * * *', status: 1, full: false, failures: [{}], prune: false }, { schedule: '*/30 * * * *', status: 0, full: true, failures: [], prune: false }]) {
    const calls = [], config = { storeId: 'test' }, report = { command: 'sync', fullCrawl: scenario.full, failures: scenario.failures, dryRun: false }
    const Exit = class extends Error {}
    const execute = new Function('loadConfig', 'selectStore', 'workflowSyncArgs', 'readFileSync', 'spawnSync', 'process', `return (async () => { ${body} })()`)
    await assert.rejects(execute(async () => config, x => x, () => ['sync', '--store', 'test', '--sitemap', crawl.sitemap], file => JSON.stringify(file === 'event' ? { schedule: scenario.schedule } : report), (_cmd, args) => { calls.push(args); return { status: calls.length === 1 ? scenario.status : 0 } }, { env: { STORE_ID: 'test', GITHUB_EVENT_PATH: 'event' }, exit: () => { throw new Exit() } }), Exit)
    assert.equal(calls.some(args => args.includes('prune')), scenario.prune)
  }
})

test('prune CLI overrides plugin defaults, rejects invalid flags and reports guards through exit status', async () => temp(async root => {
  const cli = resolve(import.meta.dirname, '../src/cli.mjs')
  await writeFile(join(root, 'vite.config.ts'), `import { shopifyVueSsr } from 'shopify-vue-ssr'; export default { plugins: [shopifyVueSsr({ store: 'example.myshopify.com', prune: { keepBuilds: 4, graceDays: 30, maxDelete: 10 } })] }`)
  const bootstrap = join(root, 'mock-fetch.mjs')
  await writeFile(bootstrap, `globalThis.fetch = async (url, options = {}) => {
    if (!options.body) return new Response('<meta name="ssr-build-id" content="${current}">')
    const { query } = JSON.parse(options.body)
    if (query.includes('bulkOperationRunQuery')) return Response.json({ data: { bulkOperationRunQuery: { bulkOperation: { id: 'operation' }, userErrors: [] } } })
    return Response.json({ data: { node: { status: 'COMPLETED', objectCount: '0', url: null } } })
  }`)
  const env = { ...process.env, SHOPIFY_STORE: '', SHOPIFY_ADMIN_TOKEN: 'mock', SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: '', SHOPIFY_CLIENT_ID_DEFAULT: '', SHOPIFY_CLIENT_SECRET_DEFAULT: '' }
  const { pathToFileURL } = await import('node:url')
  const run = args => execFileSync(process.execPath, ['--import', pathToFileURL(bootstrap).href, cli, 'prune', '--root', root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const report = JSON.parse(run(['--keep-builds', '2', '--grace-days', '7', '--max-delete', '5']))
  assert.deepEqual(report.options, { keepBuilds: 2, graceDays: 7, maxDelete: 5 })
  assert.equal(report.dryRun, true)
  assert.deepEqual(JSON.parse(run([])).options, { keepBuilds: 4, graceDays: 30, maxDelete: 10 })
  assert.equal(JSON.parse(run(['--older-than', '9d'])).options.graceDays, 9)
  for (const args of [['--keep-builds', '0'], ['--max-delete', 'bad'], ['--yes', '--dry-run'], ['--older-than', '9'], ['--older-than', '9d', '--grace-days', '7']]) assert.throws(() => run(args))
}))

test('cleanup errors and safety blocks reach the store health issue; stale cleanup does not reopen it', async () => {
  const { includePruneHealth, updateHealthIssue } = await import('../src/health-issue.mjs')
  const report = { storeId: 'test', store: 'example.myshopify.com', completedAt: '2026-11-04T01:00:00Z', fullCrawl: true, failures: [], counts: { failed: 0 } }
  const cleanup = { storeId: report.storeId, store: report.store, time: '2026-11-04T02:00:00Z', failures: [{ type: 'prune-error', message: 'timeout' }], skipped: [] }
  let calls = []
  const gh = async args => { calls.push(args); return { stdout: args[1] === 'list' ? JSON.stringify([{ title: 'SSR health - test', number: 1 }]) : '' } }
  assert.equal(await updateHealthIssue(includePruneHealth(report, cleanup), '/summary.md', gh), 'updated')
  assert.ok(calls.some(args => args[1] === 'edit')); assert.ok(!calls.some(args => args[1] === 'close'))
  calls = []
  assert.equal(await updateHealthIssue(includePruneHealth(report, { ...cleanup, failures: [], blocked: true, skipped: ['maxDelete exceeded'] }), '/summary.md', gh), 'updated')
  assert.equal(includePruneHealth(report, { ...cleanup, time: '2026-11-03' }), report)
  assert.throws(() => includePruneHealth(report, { ...cleanup, storeId: 'other' }), /different store/)
})

test('seen deployed keys override inconsistent build metadata; failed latest run keys protect legacy', () => {
  const latestRun = { ...crawl, runId: 'failed', failures: [{}], pages: [{ islands: [{ key: 'newly-seen' }] }] }
  const result = select([fragment('corrupt-label', 'old', '2020-01-01', 'seen'), fragment('legacy-seen', null, '2020-01-01', 'newly-seen')], [], { keepBuilds: 1, latestRun })
  assert.equal(result.selected.length, 0)
  assert.equal(result.retained.seen, 2)
})

test('unverifiable submitted jobs report unknown after totals and keep history records', async () => temp(async root => {
  const config = { root, reportDir: root, storeId: 'test', store: 'example.myshopify.com', prune: { keepBuilds: 1 } }
  const mock = inventoryAdmin([fragment('old', 'old')], [history('old', '2020-01-01')])
  const admin = async (query, vars, mutation) => {
    if (query === operations.nodes) throw new Error('verification unavailable')
    return mock.admin(query, vars, mutation)
  }
  const report = await prune(config, { admin, now, yes: true, reader: async () => `<meta name="ssr-build-id" content="${current}">` })
  assert.equal(report.after, null)
  assert.deepEqual(report.pendingDeletionIds, ['old'])
  assert.match(report.failures[0].message, /verification unavailable/)
  assert.ok(!mock.removed.has('history-old'))
}))

test('a running sitemap attempt disables stale-content cleanup before fetching finishes', async () => temp(async root => {
  const config = { root, outDir: join(root, 'dist'), reportDir: root, storeId: 'test', store: 'example.myshopify.com', widths: [375] }
  const server = '// test build', id = bundleId(server)
  await mkdir(config.outDir)
  await writeFile(join(config.outDir, 'server-entry.mjs'), server)
  await writeFile(join(config.outDir, 'build.json'), JSON.stringify({ entry: 'server-entry.mjs', buildId: id, components: [] }))
  await writeFile(join(root, 'latest-sitemap-run.json'), JSON.stringify(crawl))
  let observed = false
  const report = await runPages('doctor', [], config, { sitemap: crawl.sitemap, reader: async () => {
    const latestRun = JSON.parse(await readFile(join(root, 'latest-sitemap-run.json'), 'utf8'))
    observed = true
    assert.equal(latestRun.fullCrawl, false)
    const selected = select([fragment('stale', current)], [], { latestRun })
    assert.equal(selected.selected.length, 0)
    throw new Error('interrupted fetch')
  } })
  assert.equal(observed, true)
  assert.equal(report.failures.length, 1)
}))
