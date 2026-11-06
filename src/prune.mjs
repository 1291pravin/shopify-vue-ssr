import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { operations, createAdmin } from './admin.mjs'
import { pruneOptions } from './config.mjs'
import { createPageReader, deployedBuild, findIslands, pageThemeId } from './pages.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const values = entry => Object.fromEntries((entry.fields ?? []).map(field => [field.key, field.value]))
const bytes = entry => (entry.fields ?? []).reduce((sum, field) => sum + Buffer.byteLength(field.value ?? '', 'utf8'), 0)
const totals = entries => ({ entries: entries.length, bytes: entries.reduce((sum, entry) => sum + bytes(entry), 0) })
export const inventoryQuery = type => `{ metaobjects(type: ${JSON.stringify(type)}) { edges { node { id type handle updatedAt fields { key value } } } } }`

// Stream JSONL without persisting HTML or holding a second copy of the download.
export async function parseInventory(source, type) {
  const entries = [], ids = new Set()
  let pending = ''
  const decoder = new TextDecoder()
  function line(text) {
    if (!text.trim()) return
    const entry = JSON.parse(text)
    if (entry.__parentId || entry.type !== type || !entry.id || !entry.handle || !Array.isArray(entry.fields) || ids.has(entry.id)) throw new Error('Invalid or duplicate bulk inventory row')
    ids.add(entry.id); entries.push(entry)
  }
  for await (const chunk of source) {
    pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let end
    while ((end = pending.indexOf('\n')) !== -1) { line(pending.slice(0, end)); pending = pending.slice(end + 1) }
  }
  line(pending + decoder.decode())
  return entries
}

export async function bulkList(admin, type, { fetcher = fetch, pause = sleep, maxPolls = 360 } = {}) {
  const payload = (await admin(operations.bulkQuery, { query: inventoryQuery(type) }, true)).bulkOperationRunQuery
  if (!payload?.bulkOperation?.id || payload.userErrors?.length) throw new Error(JSON.stringify(payload?.userErrors ?? payload))
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const operation = (await admin(operations.bulkStatus, { id: payload.bulkOperation.id })).node
    if (!operation) throw new Error('Bulk inventory operation disappeared')
    if (operation.status === 'COMPLETED') {
      if (!operation.url && Number(operation.objectCount) === 0) return []
      if (!operation.url) throw new Error('Completed bulk inventory has no download URL')
      const response = await fetcher(operation.url)
      if (!response.ok || !response.body) throw new Error(`Bulk inventory download HTTP ${response.status}`)
      const entries = await parseInventory(response.body, type)
      if (entries.length !== Number(operation.objectCount)) throw new Error('Incomplete bulk inventory download')
      return entries
    }
    if (!['CREATED', 'RUNNING'].includes(operation.status)) throw new Error(`Bulk inventory ${operation.status}: ${operation.errorCode ?? 'unknown error'}`)
    await pause(5000)
  }
  throw new Error('Bulk inventory timed out; no partial results used')
}

export async function bulkDelete(admin, ids, { pause = sleep, maxPolls = 360, beforeBatch = async () => {}, onSubmitted = () => {}, onDeleted = () => {} } = {}) {
  // Shopify input arrays are limited to 250. Always target exact IDs, never a type.
  for (let offset = 0; offset < ids.length; offset += 250) {
    const batch = ids.slice(offset, offset + 250)
    await beforeBatch()
    const payload = (await admin(operations.bulkDelete, { where: { ids: batch } }, true)).metaobjectBulkDelete
    if (!payload?.job?.id || payload.userErrors?.length) throw new Error(JSON.stringify(payload?.userErrors ?? payload))
    onSubmitted(batch)
    let done = payload.job.done
    for (let attempt = 0; !done && attempt < maxPolls; attempt++) {
      await pause(2000)
      const job = (await admin(operations.job, { id: payload.job.id })).job
      if (!job) throw new Error('Bulk deletion job disappeared')
      done = job.done
    }
    if (!done) throw new Error('Bulk deletion timed out; job may still be running')
    const remaining = (await admin(operations.nodes, { ids: batch })).nodes
    if (!Array.isArray(remaining) || remaining.length !== batch.length) throw new Error('Invalid deletion verification response')
    const deleted = batch.filter((_id, index) => remaining[index] === null)
    onDeleted(deleted)
    if (deleted.length !== batch.length) throw new Error('Bulk deletion completed but some selected objects still exist')
  }
}

export function selectPrunable(entries, builds, { deployedBuildId, crawl, latestRun, themeId, now = Date.now(), ...options } = {}) {
  const settings = pruneOptions(options)
  const result = { selected: [], deletedBuilds: [], keptBuilds: [], counts: { oldBuilds: 0, staleContent: 0, legacy: 0 }, retained: { seen: 0, grace: 0, invalidTimestamp: 0, crawlGuard: 0 }, skipped: [], blocked: false }
  if (!deployedBuildId) return { ...result, blocked: true, skipped: ['Deployed build could not be confirmed; nothing selected'] }
  const history = new Map(builds.map(build => [build.handle, Date.parse(values(build).last_seen) || 0]))
  const ids = new Set([...history.keys(), ...entries.map(entry => values(entry).build).filter(Boolean)])
  ids.delete(deployedBuildId)
  const cutoff = now - settings.graceDays * 86400000
  // Only the latest observation of each theme within the history window pins a
  // build. Tied observations protect both builds. Active themes may exceed the
  // keepBuilds minimum, which is intentional.
  const themes = new Map()
  try {
    for (const build of builds) {
      const observations = JSON.parse(values(build).themes ?? '{}')
      if (!observations || Array.isArray(observations) || typeof observations !== 'object') throw new Error('Invalid themes history')
      for (const [id, at] of Object.entries(observations)) {
        const time = Date.parse(at)
        if (!Number.isFinite(time)) throw new Error('Invalid theme history timestamp')
        if (time < cutoff) continue
        const previous = themes.get(id)
        if (!previous || time > previous.time) themes.set(id, { time, builds: [build.handle] })
        else if (time === previous.time) previous.builds.push(build.handle)
      }
    }
  } catch (error) { return { ...result, blocked: true, skipped: [`${error.message}; nothing selected`] } }
  const recent = [...ids].sort((a, b) => (history.get(b) ?? 0) - (history.get(a) ?? 0) || a.localeCompare(b)).slice(0, settings.keepBuilds - 1)
  result.keptBuilds = [...new Set([deployedBuildId, ...recent, ...[...themes.values()].flatMap(theme => theme.builds)])]
  const kept = new Set(result.keptBuilds)
  result.deletedBuilds = [...ids].filter(id => !kept.has(id)).sort()
  const sharedByOtherTheme = [...themes].some(([id, theme]) => id !== String(themeId ?? crawl?.theme ?? crawl?.pages?.find(page => page.themeId)?.themeId) && theme.builds.includes(deployedBuildId))
  const clean = !sharedByOtherTheme && crawl?.fullCrawl && crawl.sitemap && Array.isArray(crawl.failures) && !crawl.failures.length && crawl.buildId === deployedBuildId &&
    (!latestRun || (latestRun.runId === crawl.runId && latestRun.fullCrawl && !latestRun.failures?.length))
  // Seen keys protect the deployed build even when a newer crawl failed.
  const seen = new Set([crawl, latestRun].filter(run => run?.buildId === deployedBuildId).flatMap(run => run.pages?.flatMap(page => page.islands.map(island => island.key)) ?? []))
  if (!clean) result.skipped.push('Stale content: latest full sitemap run is missing, failed, incomplete or belongs to another build')
  for (const entry of entries) {
    const build = values(entry).build
    if (seen.has(entry.handle)) { result.retained.seen++; continue }
    const old = Number.isFinite(Date.parse(entry.updatedAt)) && Date.parse(entry.updatedAt) < cutoff
    let rule
    if (build && !kept.has(build)) rule = 'oldBuilds'
    else if (build === deployedBuildId && clean && !seen.has(entry.handle) && old && Date.parse(entry.updatedAt) < Date.parse(crawl.time)) rule = 'staleContent'
    else if (!build && old) rule = 'legacy'
    if (rule) { result.counts[rule]++; result.selected.push({ id: entry.id, handle: entry.handle, build: build || null, bytes: bytes(entry), rule }) }
    else if (!Number.isFinite(Date.parse(entry.updatedAt))) result.retained.invalidTimestamp++
    else if (!old || (build && clean && Date.parse(entry.updatedAt) >= Date.parse(crawl.time))) result.retained.grace++
    else result.retained.crawlGuard++
  }
  const historyDeletes = builds.filter(build => result.deletedBuilds.includes(build.handle)).length
  if (result.selected.length + historyDeletes > settings.maxDelete) {
    result.blocked = true
    result.skipped.push(`maxDelete ${settings.maxDelete} exceeded by ${result.selected.length + historyDeletes} objects; nothing will be deleted`)
  }
  return result
}

async function optionalJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

// purge keeps only the confirmed deployed build and the keys its crawl saw. recent applies
// the configured retention policy (keepBuilds, graceDays and observed themes).
export const purgeOptions = { keepBuilds: 1, graceDays: 0 }

export async function prune(config, { yes = false, admin, reader = createPageReader(), now = Date.now(), probe, expectedBuildId, themeId, mode = 'recent', ...overrides } = {}) {
  if (!['purge', 'recent'].includes(mode)) throw new Error('Cleanup mode must be "purge" or "recent"')
  const settings = pruneOptions({ ...config.prune, ...overrides, ...(mode === 'purge' ? purgeOptions : {}) })
  const report = { schemaVersion: 1, command: 'prune', time: new Date(now).toISOString(), storeId: config.storeId ?? 'default', store: config.store,
    dryRun: !yes, mode, options: settings, deployedBuildId: null, selected: [], keptBuilds: [], deletedBuilds: [], counts: { oldBuilds: 0, staleContent: 0, legacy: 0 },
    skipped: [], failures: [], deleted: { fragments: 0, builds: 0 }, before: null, after: null, projectedAfter: null, byteMeasure: 'UTF-8 field values; excludes Shopify storage overhead' }
  let entries, builds
  const deletedFragments = new Set(), deletedBuilds = new Set(), pending = new Set()
  try {
    const crawl = await optionalJson(join(config.reportDir, 'latest-full-crawl.json'))
    const latestRun = await optionalJson(join(config.reportDir, 'latest-sitemap-run.json'))
    for (const value of [crawl, latestRun].filter(Boolean)) {
      if (value.store !== config.store || value.storeId !== report.storeId) throw new Error('Crawl report belongs to a different store')
      if (config.sitemap && value.sitemap !== config.sitemap) throw new Error('Crawl report belongs to a different sitemap')
    }
    probe ??= new URL('/', config.sitemap ?? `https://${config.store}`).href
    const confirm = async () => {
      const html = await reader(probe)
      const id = deployedBuild(html, findIslands(html))
      if (!id) throw new Error('Fresh storefront page contains no unambiguous build marker')
      if (expectedBuildId && id !== expectedBuildId) throw new Error('Fresh storefront build differs from the local build; deploy the matching build before cleanup')
      if (themeId && pageThemeId(html) && pageThemeId(html) !== String(themeId)) throw new Error('Fresh storefront theme differs from --theme; cleanup stopped')
      return id
    }
    try { report.deployedBuildId = await confirm() }
    catch (error) { report.skipped.push(`Deployment confirmation: ${error.message}`) }
    admin ??= createAdmin(config)
    entries = await bulkList(admin, 'ssr_fragment')
    builds = await bulkList(admin, 'ssr_build')
    report.before = { fragments: totals(entries), builds: totals(builds) }
    const selection = selectPrunable(entries, builds, { ...settings, deployedBuildId: report.deployedBuildId, crawl, latestRun, themeId, now })
    Object.assign(report, { ...selection, skipped: [...report.skipped, ...selection.skipped] })
    const history = builds.filter(build => selection.deletedBuilds.includes(build.handle))
    const selectedIds = new Set(selection.selected.map(entry => entry.id)), historyIds = new Set(history.map(build => build.id))
    report.projectedAfter = selection.blocked ? report.before : { fragments: totals(entries.filter(entry => !selectedIds.has(entry.id))), builds: totals(builds.filter(build => !historyIds.has(build.id))) }
    if (yes && !selection.blocked && (selection.selected.length || history.length)) {
      // Recheck immediately before each batch, including history deletion.
      const beforeBatch = async () => { if (await confirm() !== report.deployedBuildId) throw new Error('Deployed build changed since inventory; remaining deletion stopped') }
      const track = deleted => ({ beforeBatch, onSubmitted: ids => ids.forEach(id => pending.add(id)), onDeleted: ids => ids.forEach(id => { pending.delete(id); deleted.add(id) }) })
      await bulkDelete(admin, selection.selected.map(entry => entry.id), track(deletedFragments))
      await bulkDelete(admin, history.map(build => build.id), track(deletedBuilds))
    }
  } catch (error) { report.failures.push({ type: 'prune-error', message: error.message }) }
  report.deleted = { fragments: deletedFragments.size, builds: deletedBuilds.size }
  report.pendingDeletionIds = [...pending]
  if (pending.size) report.skipped.push('After totals are unknown: submitted deletion outcomes could not all be verified')
  else if (entries && builds) report.after = { fragments: totals(entries.filter(entry => !deletedFragments.has(entry.id))), builds: totals(builds.filter(build => !deletedBuilds.has(build.id))) }
  await mkdir(config.reportDir, { recursive: true })
  await writeFile(join(config.reportDir, 'prune.json'), JSON.stringify(report, null, 2) + '\n')
  const section = ['## Cache cleanup', '', `Mode: ${report.dryRun ? 'dry run' : 'delete'} (${report.mode}); deployed build: ${report.deployedBuildId ?? 'unconfirmed'}.`,
    `Selected: ${report.counts.oldBuilds} old-build, ${report.counts.staleContent} stale-content, ${report.counts.legacy} legacy fragments. Deleted: ${report.deleted.fragments} fragments, ${report.deleted.builds} build records.`,
    `Retained by guard: ${JSON.stringify(report.retained ?? {})}.`,
    `Builds kept: ${report.keptBuilds.join(', ') || 'unknown'}. Builds selected for deletion: ${report.deletedBuilds.join(', ') || 'none'}.`,
    `Before: ${JSON.stringify(report.before)}. After: ${JSON.stringify(report.after)}. Projected: ${JSON.stringify(report.projectedAfter)}. Bytes count UTF-8 field values.`,
    ...report.skipped.map(reason => `Skipped: ${reason}`), ...report.failures.map(failure => `Failure: ${failure.message}`), ''].join('\n')
  let summary = ''
  try { summary = await readFile(join(config.reportDir, 'summary.md'), 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  await writeFile(join(config.reportDir, 'summary.md'), summary.split('\n## Cache cleanup')[0].trimEnd() + '\n\n' + section)
  return report
}
