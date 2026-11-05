import { spawn } from 'node:child_process'
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { parseEnv } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { shopify, shopifyCommand, resolveCredentials, createTokenSource, createAdmin, ensureDefinition, ensureBuildDefinition } from './admin.mjs'
import { writeSnippets } from './build.mjs'

export const scopes = 'read_metaobjects,write_metaobjects,read_metaobject_definitions,write_metaobject_definitions'
const optional = async file => readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })

export async function loadEnv(root, env = process.env) {
  const values = parseEnv(await optional(join(root, '.env')))
  for (const [key, value] of Object.entries(values)) if (env[key] === undefined) env[key] = value
  return env
}

export async function interactiveShopify(args, cwd, { signal } = {}) {
  const [command, prefix] = await shopifyCommand()
  return new Promise((accept, reject) => {
    const child = spawn(command, [...prefix, ...args], { cwd, stdio: 'inherit', signal, windowsHide: true })
    child.on('error', reject)
    child.on('exit', (code, stopped) => code === 0 ? accept() : reject(new Error(`Shopify CLI stopped (${stopped ?? code}); setup can be rerun safely`)))
  })
}

async function saveEnv(config, credentials) {
  const file = join(config.root, '.env')
  // Ignore secrets before writing them, including when a later operation fails.
  const ignore = join(config.root, '.gitignore'), ignored = await optional(ignore)
  if (!ignored.split(/\r?\n/).some(line => ['.env', '/.env', '.env*', '.env.*'].includes(line.trim()) && line.trim() !== '.env.*')) {
    await writeFile(ignore, ignored + (ignored && !ignored.endsWith('\n') ? '\n' : '') + '.env\n')
  }
  const values = { SHOPIFY_STORE: config.store }
  if (credentials.clientId && credentials.clientSecret) {
    Object.assign(values, { SHOPIFY_CLIENT_ID: credentials.clientId, SHOPIFY_CLIENT_SECRET: credentials.clientSecret })
    if (config.storeId && config.storeId !== 'default') {
      values[`SHOPIFY_CLIENT_ID_${config.storeId.toUpperCase()}`] = credentials.clientId
      values[`SHOPIFY_CLIENT_SECRET_${config.storeId.toUpperCase()}`] = credentials.clientSecret
    }
  }
  let text = await optional(file)
  for (const [key, value] of Object.entries(values)) {
    const quote = ["'", '"', '`'].find(mark => !value.includes(mark))
    if (!quote || /[\r\n]/.test(value)) throw new Error(`Cannot safely serialize ${key} in .env; use an environment secret manager`)
    const line = `${key}=${quote}${value}${quote}`
    const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'gm')
    text = pattern.test(text) ? text.replace(pattern, () => line) : text + (text && !text.endsWith('\n') ? '\n' : '') + line + '\n'
  }
  await writeFile(file, text, { mode: 0o600 })
}

export async function waitForInstallation(store, credentials, { timeout = 600, fetcher = fetch, signal, log = console.log, pause = (ms, options) => delay(ms, undefined, options), now = Date.now } = {}) {
  const deadline = now() + timeout * 1000
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout * 1000)])
  const token = createTokenSource(store, { fetcher, env: { SHOPIFY_CLIENT_ID: credentials.clientId, SHOPIFY_CLIENT_SECRET: credentials.clientSecret }, signal: bounded })
  let attempt = 0, interval = 15_000
  while (now() < deadline) {
    bounded.throwIfAborted()
    try { await token(); log('App installation verified.'); return }
    catch (error) {
      if (bounded.aborted) { if (signal?.aborted) signal.throwIfAborted(); break }
      // Retrying cannot fix these: stop at once and say what to change.
      if (error.code === 'shop_not_permitted') throw new Error(`Shopify refused the token for ${store} (shop_not_permitted): the app and the store are in different Shopify organizations. Create the app from the Dev Dashboard of the organization that owns the store, install it there, then rerun setup.`)
      if (error.code === 'invalid_client') throw new Error(`Shopify rejected the app credentials for ${store} (invalid_client). Check that the client ID and secret belong to this app (shopify app env show), then rerun setup.`)
      if (error.status && ![400, 401, 403, 429].includes(error.status) && error.status < 500) throw error
      const reason = error.status === 429 ? 'rate limited by Shopify' : error.status ? `HTTP ${error.status}${error.code ? ` ${error.code}` : ''}` : 'network error'
      // Back off so polling never triggers Shopify's rate limit; honour Retry-After when given.
      const wait = Math.min(Math.max(interval, (error.retryAfter || 0) * 1000), Math.max(1, deadline - now()))
      log(`Waiting for installation on ${store}: ${reason} (attempt ${++attempt}, next try in ${Math.ceil(wait / 1000)}s, ${Math.max(0, Math.ceil((deadline - now()) / 1000))}s remaining). Ctrl+C stops safely.`)
      interval = Math.min(interval * 2, 120_000)
      try { await pause(wait, { signal: bounded }) }
      catch (error) { if (signal?.aborted) signal.throwIfAborted(); if (bounded.aborted) break; throw error }
    }
  }
  throw new Error(`Installation timed out after ${timeout}s. Install the released app on ${store} in the same Shopify organization, then rerun setup or increase --timeout.`)
}

export async function setupProject(config, { appName = 'ssr-renderer', skipApp = false, timeout = 600, cli = shopify, interactive = interactiveShopify, fetcher = fetch, env = process.env, admin, signal, log = console.log, ...pollOptions } = {}) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(config.store ?? '')) throw new Error('setup needs --store your-store.myshopify.com or a configured store id')
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('--timeout must be a positive integer in seconds')
  log('The app and store must belong to the same Shopify organization for the client credentials grant.')
  let credentials = resolveCredentials(config, env)
  if (!skipApp) {
    const file = join(config.root, 'shopify.app.toml')
    if (!(await optional(file))) await writeFile(file, stringify({ name: appName, client_id: '', application_url: 'https://example.com', embedded: false,
      access_scopes: { scopes }, auth: { redirect_urls: [] }, webhooks: { api_version: '2026-07' } }), { flag: 'wx' })
    let app = parse(await readFile(file, 'utf8'))
    if (!app.client_id) {
      log('Select the store owner organization, then create or link the renderer app in Shopify CLI.')
      await interactive(['app', 'config', 'link', '--config', 'shopify.app.toml', '--path', config.root], config.root, { signal })
      app = parse(await readFile(file, 'utf8'))
    }
    if (!app.client_id) throw new Error('Shopify CLI did not link shopify.app.toml to an app; rerun setup')
    // Linking can replace local scopes with remote scopes. Preserve unrelated config.
    app.access_scopes = { ...app.access_scopes, scopes: [...new Set([...(app.access_scopes?.scopes ?? '').split(',').filter(Boolean), ...scopes.split(',')])].join(','), use_legacy_install_flow: false }
    await writeFile(file, stringify(app))
    await interactive(['app', 'deploy', '--config', 'shopify.app.toml', '--path', config.root], config.root, { signal })
    let output
    try { output = await cli(['app', 'env', 'show', '--config', 'shopify.app.toml', '--path', config.root, '--no-color'], config.root, { signal }) }
    catch { throw new Error('Shopify app env show failed. Check Shopify CLI authentication and rerun setup. Secret output was suppressed.') }
    const vars = parseEnv(output.stdout)
    credentials = { clientId: vars.SHOPIFY_API_KEY, clientSecret: vars.SHOPIFY_API_SECRET }
    if (!credentials.clientId || !credentials.clientSecret || credentials.clientId !== app.client_id) throw new Error('Shopify CLI did not return matching app credentials. Upgrade Shopify CLI and rerun setup.')
    log(`In the Dev Dashboard, open the linked app, choose its distribution/install link, and install it on ${config.store}. Approve the released scopes. Setup waits for installation.`)
    await waitForInstallation(config.store, credentials, { timeout, fetcher, signal, log, ...pollOptions })
  } else if (credentials.clientId || credentials.clientSecret) {
    if (!credentials.clientId || !credentials.clientSecret) throw new Error('--skip-app requires a complete client ID/secret pair, or no pair for Shopify CLI store auth')
    await createTokenSource(config.store, { env, fetcher, storeId: config.storeId, credentials: config.credentials, signal })()
  } else log('Using the local Shopify CLI store auth session to verify/create definitions. No client secrets are needed.')
  const selectedEnv = { ...env }
  if (credentials.clientId && credentials.clientSecret) {
    // Select exactly the credentials just verified, even if the shell has overrides.
    const suffix = (config.storeId ?? 'default').toUpperCase()
    selectedEnv[`SHOPIFY_CLIENT_ID_${suffix}`] = credentials.clientId
    selectedEnv[`SHOPIFY_CLIENT_SECRET_${suffix}`] = credentials.clientSecret
  }
  admin ??= createAdmin(config, { env: selectedEnv, fetcher, cli })
  signal?.throwIfAborted()
  const definition = await ensureDefinition(admin), buildDefinition = await ensureBuildDefinition(admin)
  signal?.throwIfAborted()
  await writeSnippets(config.themeDir)
  try { await writeFile(join(config.themeDir, 'snippets/ssr-build-id.liquid'), 'BUILD_REQUIRED', { flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  try { await copyFile(new URL('../templates/AGENTS.md', import.meta.url), join(config.root, 'AGENTS.md'), 1) } catch (error) { if (error.code !== 'EEXIST') throw error }
  await saveEnv(config, credentials)
  log('Setup complete. Wire the client and Liquid sections as in README, then build, deploy the theme, and prerender.')
  return { storeId: config.storeId ?? 'default', store: config.store, definition, buildDefinition }
}
