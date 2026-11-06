#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { loadConfig, selectStore, storeList } from './config.mjs'
import { buildProject } from './build.mjs'
import { prerender, runCheck } from './prerender.mjs'
import { setupProject, loadEnv } from './setup.mjs'
import { repro } from './repro.mjs'

const common = {
  '--root': ['DIR', '.', 'Project directory.'],
  '--config': ['PATH', 'Vite discovery', 'Vite config path relative to root.'],
  '--help': [null, 'false', 'Show command help without loading a project.'],
}
export const commands = {
  setup: { usage: '', description: 'Create/link and release the app, wait for installation, and install definitions and snippets.', flags: {
    '--store': ['DOMAIN_OR_ID', 'sole configured store', 'Store domain or configured id. Required when several stores exist.'],
    '--app-name': ['NAME', 'ssr-renderer', 'Name used when writing a new app config.'],
    '--skip-app': [null, 'false', 'Verify environment credentials, or use the existing store auth CLI session; skip app creation/deployment.'],
    '--timeout': ['SECONDS', '600', 'Maximum time to wait for app installation.'],
  } },
  build: { usage: '', description: 'List islands, build client/server/verification bundles, and copy assets and build id into the theme.', flags: {} },
  prerender: { usage: '<site-url | saved.html...>', description: 'Crawl a same-host sitemap or read saved HTML; render and verify cache misses before storing.', flags: {
    '--store': ['ID', 'sole configured store', 'Select the store for credentials and reports.'],
    '--theme': ['ID', 'published theme', 'Add preview_theme_id to page requests for this numeric theme id.'],
    '--password-env': ['NAME', 'SHOPIFY_STOREFRONT_PASSWORD', 'Environment variable containing the storefront password.'],
    '--dry-run': [null, 'false', 'Render, verify and write local reports/props; do not change cache data.'],
    '--no-delete': [null, 'false', 'Skip cache cleanup. By default a live-theme crawl deletes other builds\' cache entries first, and a successful crawl then deletes every entry except the deployed build\'s current keys.'],
    '--keep-recent': [null, 'false', 'Clean up with the prune retention policy (recent builds and observed themes) instead of purging.'],
    '--limit': ['N', 'all pages', 'Positive maximum number of pages; partial crawls cannot authorize stale-content deletion.'],
    '--concurrency': ['N', '2', 'Pages fetched at once. Failed requests with HTTP 429 are retried with backoff; use 1 if Shopify still rate-limits.'],
  } },
  check: { usage: '', description: 'Re-render and hydrate saved real props plus optional fixtures. No props is a successful first run.', flags: {
    '--store': ['ID', 'all configured stores', 'Narrow the offline checks and report namespace to one store.'],
    '--json': [null, 'false', 'Print machine-readable check counts.'],
  } },
  repro: { usage: '<case-id | case.json>', description: 'Replay a saved failure against the current local build.', flags: {
    '--store': ['ID', 'sole configured store for ids', 'Select the report namespace when using a case id; file paths need no store.'],
    '--json': [null, 'false', 'Print full reproduction details as JSON.'],
  } },
}

export function help(command) {
  if (!command) return ['shopify-vue-ssr <setup|build|prerender|check|repro>', '', ...Object.entries(commands).map(([name, spec]) => `${name} ${spec.usage}\n  ${spec.description}`), '', 'Run shopify-vue-ssr <command> --help for every supported flag.'].join('\n')
  const spec = commands[command]
  if (!Object.hasOwn(commands, command)) throw new Error(`Unknown command: ${command}`)
  return [`shopify-vue-ssr ${command} ${spec.usage}`.trim(), '', spec.description, '', ...Object.entries({ ...spec.flags, ...common }).map(([flag, [value, fallback, description]]) => `${flag}${value ? ` <${value}>` : ''} (default: ${fallback})\n  ${description}`)].join('\n')
}

export function parseArgs(command, args) {
  if (!Object.hasOwn(commands, command)) throw new Error(`Unknown command: ${command}. Run --help for supported commands.`)
  const supported = { ...commands[command].flags, ...common }, flags = new Map(), inputs = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (Object.hasOwn(supported, arg)) {
      if (!supported[arg][0]) flags.set(arg, true)
      else {
        if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error(`Missing value for ${arg}`)
        flags.set(arg, args[++i])
      }
    } else if (arg.startsWith('-')) throw new Error(`Unknown option for ${command}: ${arg}`)
    else inputs.push(arg)
  }
  return { flags, inputs }
}

export async function runCli(argv = process.argv.slice(2)) {
  const [command, ...args] = argv
  if (!command || command === '--help') { console.log(help()); return }
  const { flags, inputs } = parseArgs(command, args)
  if (flags.has('--help')) { console.log(help(command)); return }
  if (!['prerender', 'repro'].includes(command) && inputs.length) throw new Error(`${command} does not accept positional inputs`)
  const root = resolve(flags.get('--root') ?? process.cwd())
  await loadEnv(root)
  const project = await loadConfig(root, flags.get('--config'))
  const selection = flags.get('--store')
  let configs
  if (command === 'setup' && selection?.endsWith('.myshopify.com')) {
    const id = storeList(project).find(id => project.stores[id].domain === selection)
    if (id) configs = [selectStore(project, id)]
    else if (storeList(project).length === 1 && project.stores.default) configs = [{ ...selectStore(project), store: selection }]
    else throw new Error('Domain is not a configured store. Use a configured id or add this store to plugin options.')
  } else if (command === 'check' && !selection) configs = storeList(project).map(id => selectStore(project, id))
  else if (['setup', 'prerender', 'check'].includes(command) || selection || (command === 'repro' && /^[a-f0-9]{16}$/.test(inputs[0] ?? ''))) configs = [selectStore(project, selection)]
  else configs = [project]
  const number = flag => {
    if (!flags.has(flag)) return undefined
    const value = Number(flags.get(flag))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer`)
    return value
  }
  for (const config of configs) {
    try {
      if (command === 'setup') {
        const controller = new AbortController()
        const cancel = () => controller.abort(new Error('Setup cancelled. Rerun setup safely when ready.'))
        process.once('SIGINT', cancel)
        try { await setupProject(config, { appName: flags.get('--app-name'), skipApp: flags.has('--skip-app'), timeout: number('--timeout'), signal: controller.signal }) }
        finally { process.removeListener('SIGINT', cancel) }
      } else if (command === 'build') await buildProject(config)
      else if (command === 'prerender') {
        if (flags.has('--no-delete') && flags.has('--keep-recent')) throw new Error('Use either --no-delete or --keep-recent, not both')
        const cleanup = flags.has('--no-delete') ? 'none' : flags.has('--keep-recent') ? 'recent' : undefined
        const result = await prerender(inputs, config, { dryRun: flags.has('--dry-run'), cleanup, theme: flags.get('--theme'), passwordEnv: flags.get('--password-env'), limit: number('--limit'), concurrency: number('--concurrency') })
        console.log(JSON.stringify({ storeId: config.storeId, store: config.store, ...result.counts }))
        if (result.failures.length) process.exitCode = 1
      } else if (command === 'check') {
        const result = await runCheck(config)
        const { islands: cases, skipped: passed, failed } = result.counts
        console.log(flags.has('--json') ? JSON.stringify({ storeId: config.storeId, cases, passed, failed, hint: result.hint }) : result.hint ?? `Check [${config.storeId}]: ${passed} of ${cases} props cases passed, ${failed} failed`)
        if (result.failures.length) process.exitCode = 1
      } else if (command === 'repro') {
        if (inputs.length !== 1) throw new Error('repro needs one case id or file')
        const input = /^[a-f0-9]{16}$/.test(inputs[0]) ? inputs[0] : resolve(root, inputs[0])
        const result = await repro(input, config)
        console.log(flags.has('--json') ? JSON.stringify(result, null, 2) : result.ok ? 'Not reproduced: this case now renders and hydrates cleanly.' : [`Reproduced: ${result.type}${result.width ? ` at ${result.width}px` : ''}`, result.error?.message, result.error?.stack?.split('\n')[0], result.message, 'Full detail: add --json'].filter(Boolean).join('\n'))
        if (!result.ok) process.exitCode = 1
      }
    } catch (error) {
      if (configs.length === 1) throw error
      console.error(`[${config.storeId}] ${error.message}`); process.exitCode = 1
    }
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  runCli().catch(error => { console.error(error.message); process.exitCode = 1 })
}
