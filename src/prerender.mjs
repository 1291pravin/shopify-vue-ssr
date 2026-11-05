import { join, resolve } from 'node:path'
import { readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readBuild, renderAndVerify } from './verify.mjs'
import { createAdmin, upsertFragment, touchBuild } from './admin.mjs'
import { findIslands, verifyIsland, deployedBuild, pageThemeId, previewUrl, createPageReader, sitemapUrls } from './pages.mjs'
import { startReport, addFailure, finishReport } from './report.mjs'
import { prune } from './prune.mjs'
export { findIslands, verifyIsland } from './pages.mjs'

async function jsonFiles(dir) {
  try { return (await readdir(dir)).filter(file => file.endsWith('.json')).sort().map(file => join(dir, file)) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

async function captureProps(config, captured) {
  for (const [component, values] of captured) {
    const dir = join(config.reportDir, 'props', component)
    await mkdir(dir, { recursive: true })
    // Prefer this run's real samples, then retain older samples up to the cap.
    // Only package-owned hash filenames are rotated out of the report directory.
    const existing = new Set((await jsonFiles(dir)).map(file => file.split(/[\\/]/).at(-1)))
    const retained = new Set()
    for (const exactProps of values) {
      const name = createHash('sha256').update(exactProps).digest('hex') + '.json'
      if (retained.size >= 20) break
      retained.add(name)
      if (!existing.has(name)) await writeFile(join(dir, name), JSON.stringify({ schemaVersion: 1, component, exactProps }, null, 2) + '\n')
    }
    for (const name of existing) if (retained.size < 20) retained.add(name)
    for (const name of existing) if (!retained.has(name) && /^[a-f0-9]{64}\.json$/.test(name)) await rm(join(dir, name))
  }
}

export async function prerender(inputs, config, { dryRun = false, cleanup = false, theme, limit, concurrency = 4,
  passwordEnv = 'SHOPIFY_STOREFRONT_PASSWORD', env = process.env, reader = createPageReader({ password: env[passwordEnv] ?? '' }), verify = renderAndVerify,
  admin, cleanupCache = prune, log = console.log } = {}) {
  if (!inputs.length) throw new Error('prerender needs a site URL or saved .html files')
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer')
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('--limit must be a positive integer')
  if (theme !== undefined && !/^\d+$/.test(String(theme))) throw new Error('--theme must be a numeric theme id')
  const online = /^https?:\/\//i.test(inputs[0])
  if (online && (inputs.length !== 1 || !URL.canParse(inputs[0]) || new URL(inputs[0]).protocol !== 'https:' || new URL(inputs[0]).username || new URL(inputs[0]).password)) throw new Error('Use one HTTPS site URL without credentials, or saved .html files')
  if (!online && inputs.some(input => !/\.html?$/i.test(input))) throw new Error('Saved inputs must be .html files; use one HTTPS site URL for a sitemap crawl')
  const sitemap = online ? new URL('/sitemap.xml', inputs[0]).href : null
  const report = startReport('prerender', config, null)
  Object.assign(report, { dryRun, sitemap, theme: theme ? String(theme) : null, warnings: [] })
  if (sitemap) {
    await mkdir(config.reportDir, { recursive: true })
    await writeFile(join(config.reportDir, 'latest-sitemap-run.json'), JSON.stringify(report, null, 2) + '\n')
  }
  let build
  try { build = await readBuild(config) }
  catch (error) { addFailure(report, { page: inputs[0], component: null, key: null }, 'build-mismatch', error); return finishReport(report, config) }
  report.buildId = build.buildId
  const registered = new Set(build.components)
  log(`Islands: ${build.components.length}\n${build.components.map(name => `  ${name}`).join('\n')}`)
  let pages = inputs.map(input => resolve(config.root, input))
  if (sitemap) {
    try {
      pages = await sitemapUrls(sitemap, reader)
      report.fullCrawl = !limit || pages.length <= limit
    } catch (error) { addFailure(report, { page: sitemap, component: null, key: null }, 'fetch-error', error); return finishReport(report, config) }
  }
  if (limit) pages = pages.slice(0, limit)
  const captured = new Map(), tasks = new Map(), history = new Set()
  let historyQueue = Promise.resolve()
  const getAdmin = () => admin ??= createAdmin(config)
  const recordHistory = themeId => {
    const key = themeId ?? 'unknown'
    const task = historyQueue.then(async () => {
      if (!history.has(key)) { await touchBuild(getAdmin(), build.buildId, Date.now(), themeId); history.add(key) }
    })
    historyQueue = task.catch(() => {})
    return task
  }
  report.pages = pages.map(page => ({ page: previewUrl(page, theme), islands: [] }))
  let cursor = 0
  async function runPage(coverage) {
    const { page } = coverage
    let html
    try { html = await reader(page) }
    catch (error) { addFailure(report, { page, component: null, key: null }, 'fetch-error', error); return }
    const islands = findIslands(html), deployed = deployedBuild(html, islands)
    coverage.themeId = pageThemeId(html) ?? (theme ? String(theme) : null)
    if (theme && coverage.themeId && coverage.themeId !== String(theme)) {
      addFailure(report, { page, component: null, key: null }, 'build-mismatch', new Error(`Requested theme ${theme}, but page serves theme ${coverage.themeId}. Check preview access before prerendering.`)); return
    }
    // Validate every marker before the first write for this page, including hits.
    if ((islands.length || deployed) && (deployed !== build.buildId || islands.some(island => island.buildId !== build.buildId))) {
      const error = new Error('Theme build differs from the local build. Deploy the matching build or build the matching commit, then rerun prerender. Nothing stored for this page.')
      const targets = islands.length ? islands : [{ name: null, key: null }]
      for (const island of targets) {
        coverage.islands.push({ component: island.name, key: island.key, status: 'failed', why: error.message })
        addFailure(report, { page, component: island.name, key: island.key }, 'build-mismatch', error, { exactProps: island.exactProps, deployedBuildId: deployed })
      }
      return
    }
    if (!islands.length) {
      coverage.reason = 'No islands on page'
      if (!deployed && sitemap) {
        addFailure(report, { page, component: null, key: null }, 'build-mismatch', new Error('No build marker. Add the ssr-build-id meta tag to the layout and deploy the matching build before a full crawl.'))
      } else if (deployed && !dryRun) {
        try { await recordHistory(coverage.themeId) } catch (error) { addFailure(report, { page, component: null, key: null }, 'upsert-error', error) }
      }
      return
    }
    const unique = new Set(islands.filter(island => registered.has(island.name)).map(island => island.key))
    if (unique.size > 20) {
      const message = `${page}: ${unique.size} unique cache islands exceed Shopify's 20 handle lookups per metaobject type per page. Extra islands fall back to client rendering.`
      report.warnings.push(message); log(`Warning: ${message}`)
    }
    const eligible = new Set([...unique].slice(0, 20))
    for (const island of islands) {
      const context = { page, component: island.name ?? null, key: island.key ?? null }
      const item = { component: context.component, key: context.key, status: 'skipped', miss: !island.hit, why: '' }
      coverage.islands.push(item)
      const fail = (type, error, extra = {}) => {
        item.status = 'failed'; item.why = error.message
        addFailure(report, context, type, error, { exactProps: island.exactProps ?? null, widths: config.widths,
          transport: { name: island.name, key: island.key, miss: island.miss, hit: island.hit, buildId: island.buildId }, ...extra })
      }
      if (!registered.has(island.name)) { item.why = 'Component not registered in plugin options; client rendering'; continue }
      try { verifyIsland(island, build.buildId) }
      catch (error) { fail('key-mismatch', error); continue }
      if (!captured.has(island.name)) captured.set(island.name, new Set())
      if (captured.get(island.name).size < 20) captured.get(island.name).add(island.exactProps)
      if (!eligible.has(island.key)) { item.why = 'Over the 20 unique cache lookup limit; client rendering'; continue }
      if (!dryRun) {
        try { await recordHistory(coverage.themeId) }
        catch (error) { fail('upsert-error', error); continue }
      }
      if (island.hit) { item.status = 'hit'; item.why = 'Cached fragment served'; continue }
      if (tasks.has(island.key)) {
        const result = await tasks.get(island.key)
        if (!result.ok) fail(result.type, result.error, result.details)
        else item.why = 'Duplicate miss already verified in this run'
        continue
      }
      const task = (async () => {
        let result
        try { result = await verify(config, { component: island.name, exactProps: island.exactProps }) }
        catch (error) { return { ok: false, type: 'render-error', error } }
        if (!result.ok) return { ok: false, type: result.type, error: result.error, details: { renderedHtml: result.html ?? null, mismatch: result.mismatch ?? null, width: result.width, clientHtml: result.clientHtml } }
        if (!dryRun) {
          try { await upsertFragment(getAdmin(), { key: island.key, name: island.name, html: result.html, build: build.buildId }) }
          catch (error) { return { ok: false, type: 'upsert-error', error, details: { renderedHtml: result.html } } }
        }
        return { ok: true }
      })()
      tasks.set(island.key, task)
      const result = await task
      if (!result.ok) fail(result.type, result.error, result.details)
      else if (dryRun) item.why = 'Rendered and verified; dry run, nothing stored'
      else { item.status = 'filled'; item.why = 'Rendered, verified and stored' }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
    while (cursor < report.pages.length) await runPage(report.pages[cursor++])
  }))
  await captureProps(config, captured)
  await finishReport(report, config)
  if (cleanup) {
    if (report.failures.length) report.cleanup = { blocked: true, skipped: ['Prerender failed; cleanup requires a successful run'] }
    else report.cleanup = await cleanupCache({ ...config, sitemap: sitemap ?? config.sitemap }, { yes: !dryRun, reader, admin, probe: online ? previewUrl(new URL('/', inputs[0]).href, theme) : undefined, expectedBuildId: build.buildId, themeId: theme })
    for (const failure of report.cleanup.failures ?? []) addFailure(report, { page: '', component: null, key: null }, failure.type, new Error(failure.message))
    if (report.cleanup.blocked) addFailure(report, { page: '', component: null, key: null }, 'cleanup-blocked', new Error(report.cleanup.skipped.join('; ')))
    // Re-render summary, then append the cleanup detail after it.
    await finishReport(report, config)
    if (report.cleanup.counts) {
      const { appendFile } = await import('node:fs/promises')
      await appendFile(join(config.reportDir, 'summary.md'), `\n## Cache cleanup\n\n${JSON.stringify({ dryRun: report.cleanup.dryRun, counts: report.cleanup.counts, deleted: report.cleanup.deleted, skipped: report.cleanup.skipped })}\n`)
    }
  }
  return report
}

export async function runCheck(config, { verify = renderAndVerify } = {}) {
  const report = startReport('check', config, null)
  const sources = []
  for (const base of [join(config.reportDir, 'props'), config.fixturesDir]) {
    let components
    try { components = await readdir(base, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    for (const component of components.filter(entry => entry.isDirectory())) {
      for (const file of await jsonFiles(join(base, component.name))) sources.push({ file, component: component.name })
    }
  }
  const cases = await jsonFiles(join(config.reportDir, 'cases'))
  if (!sources.length && !cases.length) {
    report.hint = 'No saved props yet. Run prerender after deploying to capture real props, or add optional ssr-fixtures/<Component>/*.json files.'
    return finishReport(report, config)
  }
  let build
  try { build = await readBuild(config); report.buildId = build.buildId }
  catch (error) { addFailure(report, { page: '', component: null, key: null }, 'build-mismatch', error); return finishReport(report, config) }
  for (const file of cases) sources.push({ file, savedCase: true })
  const seen = new Set()
  for (const { file, component: folderComponent, savedCase } of sources) {
    let exactProps, component = folderComponent
    const item = { component, key: null, status: 'skipped', why: '' }
    try {
      const value = JSON.parse(await readFile(file, 'utf8'))
      if (savedCase && (!value.component || typeof value.exactProps !== 'string' || !['render-error', 'hydration-mismatch', 'too-large'].includes(value.error?.type))) continue
      if (savedCase) component = value.component
      if (!build.components.includes(component)) continue
      exactProps = value.schemaVersion === 1 && Object.hasOwn(value, 'exactProps') ? value.exactProps : JSON.stringify(value)
      const key = JSON.stringify([component, exactProps])
      if (seen.has(key)) continue
      seen.add(key); item.component = component
      report.pages.push({ page: savedCase ? `case:${value.id}` : file, islands: [item] })
      const result = await verify(config, { component, exactProps })
      if (!result.ok) {
        item.status = 'failed'; item.why = result.error.message
        addFailure(report, { page: file, component, key: null }, result.type, result.error, { exactProps, renderedHtml: result.html, mismatch: result.mismatch, width: result.width, widths: config.widths })
      } else item.why = 'SSR and client hydration verified at all configured widths'
    } catch (error) {
      item.status = 'failed'; item.why = error.message
      if (!report.pages.some(page => page.islands.includes(item))) report.pages.push({ page: file, islands: [item] })
      addFailure(report, { page: file, component, key: null }, 'render-error', error, { exactProps })
    }
  }
  if (!report.pages.length) report.hint = 'No saved props for the current components. Run prerender after deploying to capture them.'
  return finishReport(report, config)
}
