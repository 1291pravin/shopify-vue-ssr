#!/usr/bin/env node
import { resolve, relative } from 'node:path'
import { loadConfig, selectStore, storeList } from './config.mjs'
import { buildProject } from './build.mjs'
import { resolveIslands } from './plugin.mjs'
import { runPages, runCheck } from './sync.mjs'
import { initProject } from './init.mjs'
import { repro } from './repro.mjs'
import { prune } from './prune.mjs'

const [command, ...args] = process.argv.slice(2)
function parseArgs() {
  const flags = new Map(), inputs = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (['--dry-run', '--yes', '--json', '--all-stores'].includes(arg)) flags.set(arg, true)
    else if (['--sitemap', '--older-than', '--keep-builds', '--grace-days', '--max-delete', '--root', '--store', '--config'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`)
      flags.set(arg, args[++i])
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    else inputs.push(arg)
  }
  return { flags, inputs }
}
try {
  if (!command || command === '--help') {
    console.log('shopify-vue-ssr <init|stores|islands|build|check|sync|doctor|repro|prune|health-issue> [inputs] [--sitemap URL] [--dry-run] [--root DIR] [--config PATH] [--store ID] [--all-stores (init/doctor)] [--keep-builds 3] [--grace-days 14] [--max-delete 20000] [--yes] [--json]')
  } else {
    const { flags, inputs } = parseArgs()
    const root = resolve(flags.get('--root') ?? process.cwd())
    const project = await loadConfig(root, flags.get('--config'), { allowMissingPlugin: command === 'init' })
    if (flags.has('--all-stores') && flags.has('--store')) throw new Error('Choose --store <id> or --all-stores, not both')
    if (flags.has('--all-stores') && !['init', 'doctor'].includes(command)) throw new Error('--all-stores is supported only for init and doctor')
    if (flags.has('--all-stores') && flags.has('--sitemap')) throw new Error('--all-stores uses each configured sitemap; select --store to override --sitemap')
    const needsStore = ['init', 'sync', 'doctor', 'prune', 'check', 'health-issue'].includes(command) || (command === 'repro' && /^[a-f0-9]{16}$/.test(inputs[0] ?? ''))
    const allStores = flags.has('--all-stores') || (command === 'check' && !flags.has('--store'))
    const configs = allStores ? storeList(project).map(id => selectStore(project, id))
      : [flags.has('--store') || needsStore ? selectStore(project, flags.get('--store')) : project]
    for (const config of configs) {
      try {
        if (command === 'init') { if (config.missingPlugin) console.log(config.missingPlugin); const result = await initProject(config); console.log(JSON.stringify(result, null, 2)) }
        else if (command === 'stores') console.log(flags.has('--json') ? JSON.stringify(storeList(project)) : storeList(project).map(id => `${id} -> ${project.stores[id].domain ?? 'unconfigured'}`).join('\n'))
        else if (command === 'islands') {
          for (const { name, file } of await resolveIslands(config, root)) console.log(`${name} -> ${relative(root, file).replaceAll('\\', '/')}`)
        }
        else if (command === 'build') await buildProject(config)
        else if (command === 'check') { console.log(`Islands: ${(await resolveIslands(config, root)).length}`); const result = await runCheck(config)
          // In check, a case that renders and hydrates cleanly is counted as "skipped" (nothing to store); report it as passed.
          const { islands: cases, skipped: passed, failed } = result.counts
          console.log(flags.has('--json') ? JSON.stringify({ storeId: config.storeId, cases, passed, failed }) : `Check${config.storeId && config.storeId !== 'default' ? ` [${config.storeId}]` : ''}: ${passed} of ${cases} fixture cases passed, ${failed} failed${failed ? ' (see ssr-report/ and run repro <id>)' : ''}`)
          if (result.failures.length) process.exitCode = 1 }
        else if (command === 'sync' || command === 'doctor') {
          const sitemap = flags.get('--sitemap') ?? (!inputs.length ? config.sitemap : undefined)
          if (!inputs.length && !sitemap) throw new Error(`${command} needs URLs, HTML files, or --sitemap URL`)
          if (inputs.length && sitemap) throw new Error('Choose explicit inputs or --sitemap, not both')
          const result = await runPages(command, inputs, config, { dryRun: flags.has('--dry-run'), sitemap })
          console.log(JSON.stringify({ storeId: config.storeId, store: config.store, ...result.counts })); if (result.failures.length) process.exitCode = 1
        } else if (command === 'repro') {
          if (inputs.length !== 1) throw new Error('repro needs one case id or file')
          const result = await repro(inputs[0], config)
          if (args.includes('--json')) console.log(JSON.stringify(result, null, 2))
          else console.log(result.ok
            ? 'Not reproduced: this case now renders and hydrates cleanly.'
            : [`Reproduced: ${result.type}${result.width ? ` at ${result.width}px` : ''}`, result.error?.message, result.error?.stack?.split('\n')[0], result.message, 'Full detail: add --json'].filter(Boolean).join('\n'))
          if (!result.ok) process.exitCode = 1
        } else if (command === 'health-issue') {
          const { updateHealthIssue, includePruneHealth } = await import('./health-issue.mjs')
          const { readFile } = await import('node:fs/promises')
          let report = JSON.parse(await readFile(resolve(config.reportDir, 'report.json'), 'utf8'))
          if (report.storeId !== config.storeId || report.store !== config.store) throw new Error('Health report belongs to a different store')
          try {
            const cleanup = JSON.parse(await readFile(resolve(config.reportDir, 'prune.json'), 'utf8'))
            report = includePruneHealth(report, cleanup)
          } catch (error) { if (error.code !== 'ENOENT') throw error }
          console.log(await updateHealthIssue(report, resolve(config.reportDir, 'summary.md')))
        } else if (command === 'prune') {
          if (flags.has('--yes') && flags.has('--dry-run')) throw new Error('Choose --yes or --dry-run, not both')
          const options = { yes: flags.has('--yes') }
          for (const [flag, key] of [['--keep-builds', 'keepBuilds'], ['--grace-days', 'graceDays'], ['--max-delete', 'maxDelete']]) if (flags.has(flag)) options[key] = Number(flags.get(flag))
          if (flags.has('--older-than')) {
            if (flags.has('--grace-days') || !/^\d+d$/.test(flags.get('--older-than'))) throw new Error('Use --grace-days N or --older-than Nd')
            options.graceDays = Number(flags.get('--older-than').slice(0, -1))
          }
          const result = await prune(config, options)
          console.log(JSON.stringify(result, null, 2))
          if (result.failures.length || (options.yes && result.blocked)) process.exitCode = 1
        }
        else throw new Error(`Unknown command: ${command}`)
      } catch (error) {
        if (!allStores) throw error
        console.error(`[${config.storeId} ${config.store}] ${error.stack ?? error.message}`); process.exitCode = 1
      }
    }
  }
} catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1 }
