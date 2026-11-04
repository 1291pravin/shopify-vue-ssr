import { join } from 'node:path'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { readBuild, renderAndVerify } from './verify.mjs'
import { createAdmin, upsertFragment, touchBuild } from './admin.mjs'
import { findIslands, verifyIsland, deployedBuild, createPageReader, sitemapUrls } from './pages.mjs'
import { startReport, addFailure, finishReport } from './report.mjs'
export { findIslands, verifyIsland } from './pages.mjs'

export async function runPages(command, inputs, config, { dryRun = false, sitemap, reader = createPageReader(), verify = renderAndVerify, admin } = {}) {
  const report = startReport(command, config, null)
  report.dryRun = dryRun
  report.sitemap = sitemap ?? null
  // An interrupted sitemap attempt must invalidate earlier stale-content permission.
  if (sitemap) {
    await mkdir(config.reportDir, { recursive: true })
    await writeFile(join(config.reportDir, 'latest-sitemap-run.json'), JSON.stringify(report, null, 2) + '\n')
  }
  let build
  try { build = await readBuild(config) }
  catch (error) {
    addFailure(report, { page: inputs[0] ?? sitemap ?? '', component: null, key: null }, 'build-mismatch', error)
    return finishReport(report, config)
  }
  report.buildId = build.buildId
  let pages = inputs
  if (sitemap) {
    try { pages = await sitemapUrls(sitemap, reader); report.fullCrawl = true }
    catch (error) { addFailure(report, { page: sitemap, component: null, key: null }, 'fetch-error', error); return finishReport(report, config) }
  }
  const seen = new Set()
  let historyRecorded = false
  for (const page of pages) {
    const coverage = { page, islands: [] }
    report.pages.push(coverage)
    let html
    try { html = await reader(page) }
    catch (error) { addFailure(report, { page, component: null, key: null }, 'fetch-error', error); continue }
    const islands = findIslands(html)
    const deployed = deployedBuild(html, islands)
    if (!islands.length && deployed === build.buildId && command === 'sync' && !dryRun && !historyRecorded) {
      try { admin ??= createAdmin(config); await touchBuild(admin, build.buildId); historyRecorded = true }
      catch (error) { addFailure(report, { page, component: null, key: null }, 'upsert-error', error) }
    }
    if (!islands.length) {
      coverage.reason = 'No islands on page'
      // A password or error page must never become a clean full crawl.
      if (/name=["'](?:password|storefront_password)["']/i.test(html)) addFailure(report, { page, component: null, key: null }, 'fetch-error', new Error('Storefront password required'))
      continue
    }
    for (const island of islands) {
      const context = { page, component: island.name ?? null, key: island.key ?? null }
      const item = { component: context.component, key: context.key, status: 'skipped', miss: !island.hit, why: '' }
      coverage.islands.push(item)
      const fail = (type, error, extra = {}) => {
        item.status = 'failed'; item.why = error.message
        addFailure(report, context, type, error, { exactProps: island.exactProps ?? null, widths: config.widths,
          transport: { name: island.name, key: island.key, miss: island.miss, hit: island.hit, buildId: island.buildId }, ...extra })
      }
      if (deployed !== build.buildId || island.buildId !== build.buildId) {
        fail('build-mismatch', new Error('theme not deployed with this build'), { deployedBuildId: deployed })
        continue
      }
      try { verifyIsland(island, build.buildId) }
      catch (error) { fail('key-mismatch', error); continue }
      if (command === 'sync' && !dryRun && !historyRecorded) {
        try { admin ??= createAdmin(config); await touchBuild(admin, build.buildId); historyRecorded = true }
        catch (error) { fail('upsert-error', error); continue }
      }
      if (island.hit) { item.status = 'hit'; item.why = 'Cached fragment served'; continue }
      if (command === 'doctor') { item.why = 'Cache miss'; continue }
      if (seen.has(island.key)) { item.why = 'Duplicate miss already verified in this run'; continue }
      let result
      try { result = await verify(config, { component: island.name, exactProps: island.exactProps }) }
      catch (error) { fail('render-error', error); continue }
      if (!result.ok) {
        fail(result.type, result.error, { renderedHtml: result.html ?? null, mismatch: result.mismatch ?? null, width: result.width, clientHtml: result.clientHtml })
        continue
      }
      if (dryRun) { item.why = 'Rendered and verified; dry run, nothing stored'; seen.add(island.key); continue }
      try {
        admin ??= createAdmin(config)
        await upsertFragment(admin, { key: island.key, name: island.name, html: result.html, build: build.buildId })
        item.status = 'filled'; item.why = 'Rendered, verified and stored'; seen.add(island.key)
      } catch (error) { fail('upsert-error', error, { renderedHtml: result.html }) }
    }
  }
  return finishReport(report, config)
}

export async function runCheck(config, { verify = renderAndVerify } = {}) {
  let build
  try { build = await readBuild(config) }
  catch (error) { const report = startReport('check', config, null); addFailure(report, { page: '', component: null, key: null }, 'build-mismatch', error); return finishReport(report, config) }
  const report = startReport('check', config, build.buildId)
  const { readdir } = await import('node:fs/promises')
  for (const component of build.components) {
    let files = []
    try { files = (await readdir(join(config.fixturesDir, component))).filter(file => file.endsWith('.json')).map(file => join(config.fixturesDir, component, file)) } catch { /* Report missing fixtures below. */ }
    if (!files.length) files.push(null)
    for (const file of files) {
      const page = file ?? `fixture:${component}`
      const item = { component, key: null, status: 'skipped', why: '' }
      report.pages.push({ page, islands: [item] })
      let exactProps
      try {
        if (!file) throw new Error(`Missing fixtures: ssr-fixtures/${component}/*.json`)
        const value = JSON.parse(await readFile(file, 'utf8'))
        exactProps = value.schemaVersion === 1 && Object.hasOwn(value, 'exactProps') ? value.exactProps : JSON.stringify(value)
        const result = await verify(config, { component, exactProps })
        if (!result.ok) {
          item.status = 'failed'; item.why = result.error.message
          addFailure(report, { page, component, key: null }, result.type, result.error, { exactProps, renderedHtml: result.html, mismatch: result.mismatch, width: result.width, widths: config.widths })
        } else item.why = 'SSR and client hydration verified at all widths'
      } catch (error) { item.status = 'failed'; item.why = error.message; addFailure(report, { page, component, key: null }, 'render-error', error, { exactProps }) }
    }
  }
  // Saved cases are also regression inputs, including cases copied from CI.
  let cases = []
  try { cases = (await readdir(join(config.reportDir, 'cases'))).filter(file => file.endsWith('.json')) } catch { /* First run. */ }
  for (const file of cases) {
    try {
      const saved = JSON.parse(await readFile(join(config.reportDir, 'cases', file), 'utf8'))
      if (!saved.component || typeof saved.exactProps !== 'string' || !['render-error', 'hydration-mismatch', 'too-large'].includes(saved.error?.type)) continue
      const result = await verify(config, { component: saved.component, exactProps: saved.exactProps, widths: saved.widths })
      const page = `case:${saved.id}`, item = { component: saved.component, key: saved.key, status: result.ok ? 'skipped' : 'failed', why: result.ok ? 'Saved case now passes' : result.error.message }
      report.pages.push({ page, islands: [item] })
      if (!result.ok) addFailure(report, { page: saved.page, component: saved.component, key: saved.key }, result.type, result.error, { exactProps: saved.exactProps, renderedHtml: result.html, mismatch: result.mismatch, width: result.width, widths: saved.widths })
    } catch (error) {
      const page = join(config.reportDir, 'cases', file)
      report.pages.push({ page, islands: [{ component: null, key: null, status: 'failed', why: error.message }] })
      addFailure(report, { page, component: null, key: null }, 'render-error', error)
    }
  }
  return finishReport(report, config)
}
