import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'

export function startReport(command, config, buildId) {
  let gitCommit = null
  try { gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: config.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { /* A new install need not be a git repo. */ }
  return { schemaVersion: 1, runId: randomUUID(), time: new Date().toISOString(), command, storeId: config.storeId ?? 'default', store: config.store ?? null, buildId, gitCommit, fullCrawl: false, sitemap: null, pages: [], failures: [], counts: {} }
}
export function addFailure(report, context, type, error, extra = {}) {
  const signature = { storeId: report.storeId, store: report.store, type, page: context.page, component: context.component, key: context.key, buildId: report.buildId, width: extra.width ?? null }
  const id = createHash('sha256').update(JSON.stringify(signature)).digest('hex').slice(0, 16)
  const failure = { ...signature, id, message: error?.message ?? String(error), stack: error?.stack ?? '', ...extra }
  if (!report.failures.some(existing => existing.id === id)) report.failures.push(failure)
  return failure
}
export async function finishReport(report, config) {
  const dir = config.reportDir
  await mkdir(join(dir, 'cases'), { recursive: true })
  const counts = { hit: 0, filled: 0, failed: 0, skipped: 0, misses: 0, failures: report.failures.length }
  for (const page of report.pages) for (const island of page.islands) { counts[island.status]++; if (island.miss) counts.misses++ }
  counts.islands = counts.hit + counts.filled + counts.failed + counts.skipped
  counts.coverage = counts.islands ? counts.hit / counts.islands : 0
  report.counts = counts
  report.completedAt = new Date().toISOString()
  for (const failure of report.failures) {
    const saved = { schemaVersion: 1, storeId: report.storeId, store: report.store, id: failure.id, component: failure.component, key: failure.key, page: failure.page, buildId: report.buildId,
      exactProps: failure.exactProps ?? null, widths: failure.widths ?? config.widths, renderedHtml: failure.renderedHtml ?? null,
      error: { type: failure.type, message: failure.message, stack: failure.stack }, mismatch: failure.mismatch ?? null,
      transport: failure.transport ?? null, deployedBuildId: failure.deployedBuildId ?? null,
      width: failure.width, repro: `npx shopify-vue-ssr repro ${failure.id} --store ${report.storeId}` }
    await writeFile(join(dir, 'cases', failure.id + '.json'), JSON.stringify(saved, null, 2) + '\n')
  }
  await writeFile(join(dir, 'failures.jsonl'), report.failures.map(f => JSON.stringify(f)).join('\n') + (report.failures.length ? '\n' : ''))
  await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  const escape = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ')
  const lines = [`# SSR health - ${report.storeId}`, '', `Store: ${report.storeId} (${report.store ?? 'unconfigured'})`, `Run: ${report.runId}`, `Command: ${report.command}; build: ${report.buildId ?? 'unavailable'}`, '',
    `${counts.islands} islands: ${counts.hit} hits, ${counts.filled} filled, ${counts.failed} failed, ${counts.skipped} skipped. Coverage: ${(counts.coverage * 100).toFixed(1)}%.`,
    `Full sitemap crawl: ${report.fullCrawl ? 'yes' : 'no'}. Failures: ${counts.failures}.`, '', '| Type | Page / component | Why | Reproduce |', '| --- | --- | --- | --- |']
  for (const f of report.failures) lines.push(`| ${f.type} | ${escape(f.page)} / ${escape(f.component)} | ${escape(f.message)} | \`npx shopify-vue-ssr repro ${f.id} --store ${report.storeId}\` |`)
  if (report.hint) lines.push('', report.hint)
  for (const warning of report.warnings ?? []) lines.push('', `Warning: ${escape(warning)}`)
  await writeFile(join(dir, 'summary.md'), lines.join('\n') + '\n')
  // Preserve the latest *complete* sitemap inventory across partial/failed runs.
  // Build-mismatched or unreachable pages never authorize pruning.
  if (report.fullCrawl && !report.failures.length) await writeFile(join(dir, 'latest-full-crawl.json'), JSON.stringify(report, null, 2) + '\n')
  if (report.sitemap) await writeFile(join(dir, 'latest-sitemap-run.json'), JSON.stringify(report, null, 2) + '\n')
  return report
}
