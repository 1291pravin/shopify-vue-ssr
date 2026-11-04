import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
export function includePruneHealth(report, cleanup) {
  if (cleanup.storeId !== report.storeId || cleanup.store !== report.store) throw new Error('Prune report belongs to a different store')
  if (Date.parse(cleanup.time) < Date.parse(report.completedAt ?? report.time)) return report
  return { ...report, failures: [...report.failures, ...cleanup.failures, ...(cleanup.blocked ? [{ type: 'prune-blocked', message: cleanup.skipped.join('; ') }] : [])] }
}

export async function updateHealthIssue(report, summaryFile, gh = args => exec('gh', args, { windowsHide: true })) {
  const title = `SSR health - ${report.storeId ?? 'default'}`
  const { stdout } = await gh(['issue', 'list', '--state', 'open', '--search', `"${title}" in:title`, '--limit', '100', '--json', 'number,title'])
  const matches = JSON.parse(stdout).filter(issue => issue.title === title).sort((a, b) => a.number - b.number)
  const hasFailures = report.failures.length > 0 || report.counts.failed > 0
  const issue = matches[0]
  if (hasFailures) {
    if (issue) await gh(['issue', 'edit', String(issue.number), '--body-file', summaryFile])
    else await gh(['issue', 'create', '--title', title, '--body-file', summaryFile])
    for (const duplicate of matches.slice(1)) await gh(['issue', 'close', String(duplicate.number)])
    return issue ? 'updated' : 'opened'
  }
  if (report.fullCrawl && issue) {
    for (const open of matches) await gh(['issue', 'close', String(open.number)])
    return 'closed'
  }
  return 'unchanged'
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reportDir = resolve(process.argv[2] ?? 'ssr-report')
  console.log(await updateHealthIssue(JSON.parse(await readFile(resolve(reportDir, 'report.json'), 'utf8')), resolve(reportDir, 'summary.md')))
}
