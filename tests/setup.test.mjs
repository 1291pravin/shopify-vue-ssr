import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { parseEnv } from 'node:util'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { setupProject, waitForInstallation, loadEnv, scopes } from '../src/setup.mjs'
import { normalizeOptions } from '../src/config.mjs'
import { definitions } from './helpers/admin.mjs'
import { fragmentDefinition, buildDefinition } from './helpers/admin.mjs'

const out = resolve(import.meta.dirname, '../out')
const exists = file => access(file).then(() => true, () => false)
async function temp(fn) {
  await mkdir(out, { recursive: true })
  const root = await mkdtemp(join(out, 'setup-test-'))
  try { return await fn(root, normalizeOptions({ store: 'your-store.myshopify.com' }, root)) }
  finally { assert.equal(dirname(root), out); await rm(root, { recursive: true, force: true }) }
}
const admin = async query => definitions(query)
const token = async () => Response.json({ access_token: 'mock-token', expires_in: 86399 })
const envOutput = { stdout: 'SHOPIFY_API_KEY=app-id\nSHOPIFY_API_SECRET=mock-secret\nSCOPES=read_metaobjects\n' }
const quiet = () => {}

test('setup writes valid non-embedded TOML, links/deploys interactively, waits, installs snippets and ignored credentials', () => temp(async (root, config) => {
  const calls = [], messages = []
  let exchanges = 0, clock = 0
  const interactive = async (args, cwd, options) => {
    calls.push(args); assert.equal(cwd, root); assert.ok(options.signal)
    const file = join(root, 'shopify.app.toml'), app = parse(await readFile(file, 'utf8'))
    assert.equal(app.name, 'renderer-test'); assert.equal(app.embedded, false)
    assert.equal(app.application_url, 'https://example.com'); assert.deepEqual(app.auth.redirect_urls, [])
    assert.equal(app.webhooks.api_version, '2026-07')
    if (args[1] === 'config') {
      assert.equal(app.client_id, ''); assert.equal(app.access_scopes.scopes, scopes)
      app.client_id = 'app-id'; app.access_scopes.scopes = 'read_products'
      await writeFile(file, stringify(app))
    } else {
      for (const scope of scopes.split(',')) assert.ok(app.access_scopes.scopes.split(',').includes(scope))
      assert.ok(app.access_scopes.scopes.includes('read_products'))
      assert.equal(app.access_scopes.use_legacy_install_flow, false)
    }
  }
  const result = await setupProject(config, { env: {}, admin, interactive, appName: 'renderer-test', signal: new AbortController().signal,
    cli: async args => { calls.push(args); return envOutput }, log: message => messages.push(message), now: () => clock,
    pause: async ms => { clock += ms }, fetcher: async (_url, options) => {
      assert.equal(new URLSearchParams(options.body).get('grant_type'), 'client_credentials')
      return ++exchanges < 3 ? new Response('mock not installed', { status: 400 }) : token()
    } })
  assert.equal(result.storeId, 'default'); assert.equal(exchanges, 3)
  assert.deepEqual(calls.map(args => args.slice(0, 3)), [['app', 'config', 'link'], ['app', 'deploy', '--config'], ['app', 'env', 'show']])
  const saved = parseEnv(await readFile(join(root, '.env'), 'utf8'))
  assert.deepEqual(saved, { SHOPIFY_STORE: config.store, SHOPIFY_CLIENT_ID: 'app-id', SHOPIFY_CLIENT_SECRET: 'mock-secret' })
  assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /^\.env$/m)
  assert.match(await readFile(join(root, 'theme/snippets/vue-island.liquid'), 'utf8'), /data-props/)
  assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /prerender/)
  assert.equal(await exists(join(root, '.github')), false)
  assert.ok(messages.some(message => /Waiting for installation/.test(message)))
  assert.ok(messages.some(message => /same Shopify organization/.test(message)))
  assert.ok(messages.some(message => /install link/.test(message)))
  assert.doesNotMatch(messages.join('\n'), /mock-secret|mock-token/)
}))

test('setup rerun keeps linked app identity, guide, build marker and unrelated env/config; adds no duplicate ignore lines', () => temp(async (root, config) => {
  await writeFile(join(root, 'shopify.app.toml'), stringify({ client_id: 'app-id', name: 'keep-name', embedded: false, application_url: 'https://example.com', auth: { redirect_urls: [] }, webhooks: { api_version: '2026-07' }, custom: { keep: 'yes' } }))
  await writeFile(join(root, '.env'), '# keep comment\nOTHER=value\nSHOPIFY_CLIENT_ID=old\nSHOPIFY_CLIENT_SECRET=old-secret\n')
  await writeFile(join(root, '.gitignore'), 'out/\n.env\n')
  await writeFile(join(root, 'AGENTS.md'), 'keep-guide')
  await mkdir(join(config.themeDir, 'snippets'), { recursive: true })
  await writeFile(join(config.themeDir, 'snippets/ssr-build-id.liquid'), 'keep-build')
  const run = () => setupProject(config, { env: {}, admin, log: quiet, fetcher: token, cli: async () => envOutput, interactive: async args => assert.equal(args[1], 'deploy') })
  await run(); const first = await readFile(join(root, '.env'), 'utf8'); await run()
  assert.equal(await readFile(join(root, '.env'), 'utf8'), first)
  assert.match(first, /# keep comment\nOTHER=value/)
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'keep-guide')
  assert.equal(await readFile(join(config.themeDir, 'snippets/ssr-build-id.liquid'), 'utf8'), 'keep-build')
  assert.equal((await readFile(join(root, '.gitignore'), 'utf8')).match(/^\.env$/gm).length, 1)
  const app = parse(await readFile(join(root, 'shopify.app.toml'), 'utf8'))
  assert.equal(app.name, 'keep-name'); assert.equal(app.custom.keep, 'yes')
}))

test('installation timeout bounds polling and failed setup writes no secrets or definitions', () => temp(async (root, config) => {
  let clock = 0, requests = 0
  await assert.rejects(waitForInstallation(config.store, { clientId: 'mock-id', clientSecret: 'mock-secret' }, {
    timeout: 10, now: () => clock, pause: async ms => { clock += ms }, log: quiet,
    fetcher: async () => { requests++; return new Response('secret response suppressed', { status: 403 }) },
  }), /timed out after 10s.*same Shopify organization/)
  // Polling backs off from 15s, so a 10s window allows exactly one request.
  assert.equal(requests, 1); assert.equal(clock, 10000)
  await assert.rejects(setupProject(config, { env: {}, skipApp: true, timeout: 0, admin, log: quiet }), /positive integer/)
  assert.equal(await exists(join(root, '.env')), false)
}))

test('installation polling cancels in-flight token requests and sleep without logging secrets', async () => {
  const controller = new AbortController()
  const pending = waitForInstallation('your-store.myshopify.com', { clientId: 'mock-id', clientSecret: 'mock-secret' }, { log: quiet, signal: controller.signal,
    fetcher: async (_url, { signal }) => new Promise((_accept, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  })
  controller.abort(new Error('mock cancelled'))
  await assert.rejects(pending, /mock cancelled/)
})

test('skip-app verifies env credentials once without CLI app commands and stores escaped secrets', () => temp(async (root, config) => {
  let requests = 0
  const secret = 'mock # " quoted secret'
  await setupProject(config, { env: { SHOPIFY_CLIENT_ID: 'mock-id', SHOPIFY_CLIENT_SECRET: secret }, skipApp: true, admin, log: quiet,
    cli: async () => { throw new Error('unexpected CLI') }, fetcher: async () => { requests++; return token() } })
  assert.equal(requests, 1)
  assert.equal(await exists(join(root, 'shopify.app.toml')), false)
  const env = await loadEnv(root, { OTHER: 'keep' })
  assert.equal(env.SHOPIFY_CLIENT_SECRET, secret); assert.equal(env.OTHER, 'keep')
  assert.equal((await loadEnv(root, { SHOPIFY_CLIENT_ID: 'shell-wins' })).SHOPIFY_CLIENT_ID, 'shell-wins')
}))

test('skip-app rejects partial or invalid credentials before definition mutations', () => temp(async (root, config) => {
  let calls = 0
  const options = { skipApp: true, log: quiet, admin: async () => { calls++; throw new Error('unexpected') } }
  await assert.rejects(setupProject(config, { ...options, env: { SHOPIFY_CLIENT_ID: 'mock-id' } }), /complete client ID/)
  await assert.rejects(setupProject(config, { ...options, env: { SHOPIFY_CLIENT_ID: 'mock-id', SHOPIFY_CLIENT_SECRET: 'mock-secret' }, fetcher: async () => new Response('denied', { status: 401 }) }), /Token request failed/)
  assert.equal(calls, 0); assert.equal(await exists(join(root, '.env')), false)
}))

test('skip-app without credentials uses mocked Shopify store execute for both definitions', () => temp(async (root, config) => {
  const calls = []
  await setupProject(config, { skipApp: true, env: {}, log: quiet, cli: async args => {
    calls.push(args)
    assert.deepEqual(args.slice(0, 2), ['store', 'execute'])
    const query = await readFile(args[args.indexOf('--query-file') + 1], 'utf8')
    return { stdout: JSON.stringify({ data: definitions(query) }) }
  } })
  assert.equal(calls.length, 2)
  assert.deepEqual(parseEnv(await readFile(join(root, '.env'), 'utf8')), { SHOPIFY_STORE: config.store })
  assert.equal(await exists(join(root, 'shopify.app.toml')), false)
}))

test('named-store setup writes a complete isolated suffix pair and protects .env even with only .env.* ignored', () => temp(async (root, config) => {
  await writeFile(join(root, '.gitignore'), '.env.*\n')
  await setupProject({ ...config, storeId: 'fr' }, { skipApp: true, env: { SHOPIFY_CLIENT_ID_FR: 'fr-id', SHOPIFY_CLIENT_SECRET_FR: 'fr-secret' }, admin, fetcher: token, log: quiet })
  const env = parseEnv(await readFile(join(root, '.env'), 'utf8'))
  assert.equal(env.SHOPIFY_CLIENT_ID_FR, 'fr-id'); assert.equal(env.SHOPIFY_CLIENT_SECRET_FR, 'fr-secret')
  assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /^\.env$/m)
}))

test('CLI credential errors suppress captured stdout/stderr, and fail before definition writes', () => temp(async (root, config) => {
  await writeFile(join(root, 'shopify.app.toml'), stringify({ client_id: 'app-id', name: 'renderer' }))
  await assert.rejects(setupProject(config, { env: {}, log: quiet, interactive: async () => {}, cli: async () => { throw Object.assign(new Error('mock-secret'), { stdout: 'mock-secret', stderr: 'mock-secret' }) } }), error => {
    assert.match(error.message, /Secret output was suppressed/); assert.doesNotMatch(error.message, /mock-secret/); return true
  })
  assert.equal(await exists(join(root, '.env')), false)
}))

test('actual setup CLI launches a mocked interactive Shopify CLI and mocked Admin API without exposing secrets', () => temp(async (root, config) => {
  const bin = join(root, 'bin'), runner = join(bin, 'node_modules/@shopify/cli/bin/run.js')
  await mkdir(dirname(runner), { recursive: true })
  const script = `
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2), root = process.cwd();
    fs.appendFileSync(path.join(root, 'cli-calls.jsonl'), JSON.stringify(args) + '\\n');
    if (args.slice(0,3).join(' ') === 'app config link') {
      const file = path.join(root, 'shopify.app.toml');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('client_id = ""', 'client_id = "mock-app"'));
    } else if (args.slice(0,3).join(' ') === 'app env show') {
      console.log('SHOPIFY_API_KEY=mock-app\\nSHOPIFY_API_SECRET=mock-cli-secret');
    } else if (args.slice(0,2).join(' ') !== 'app deploy') throw new Error('Unexpected mock CLI command');
  `
  if (process.platform === 'win32') {
    await writeFile(join(bin, 'shopify.cmd'), '@echo off\r\n')
    await writeFile(runner, script)
  } else await writeFile(join(bin, 'shopify'), '#!/usr/bin/env node\n' + script, { mode: 0o755 })
  await writeFile(join(root, 'vite.config.ts'), "import { shopifyVueSsr } from 'shopify-vue-ssr'; export default { plugins: [shopifyVueSsr({store:'your-store.myshopify.com'})] }")
  const bootstrap = join(root, 'mock-network.mjs')
  await writeFile(bootstrap, `globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/admin/oauth/access_token')) return Response.json({ access_token: 'mock-token' });
    if (url.endsWith('/graphql.json')) return Response.json({ data: { metaobjectDefinitionByType: options.body.includes('ssr_build') ? ${JSON.stringify(buildDefinition)} : ${JSON.stringify(fragmentDefinition)} } });
    throw new Error('Unexpected network: ' + url);
  }`)
  const env = { ...process.env, PATH: bin + (process.platform === 'win32' ? ';' : ':') + process.env.PATH, SHOPIFY_STORE: '', SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: '', SHOPIFY_ADMIN_TOKEN: '', SHOPIFY_CLIENT_ID_DEFAULT: '', SHOPIFY_CLIENT_SECRET_DEFAULT: '' }
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', pathToFileURL(bootstrap).href, resolve(import.meta.dirname, '../src/cli.mjs'), 'setup', '--root', root, '--store', config.store], { env })
  assert.match(stdout, /App installation verified/); assert.match(stdout, /Setup complete/)
  assert.doesNotMatch(stdout + stderr, /mock-cli-secret|mock-token/)
  const calls = (await readFile(join(root, 'cli-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(calls.length, 3)
  assert.equal(parseEnv(await readFile(join(root, '.env'), 'utf8')).SHOPIFY_CLIENT_SECRET, 'mock-cli-secret')
}))

test('installation polling stops at once on shop_not_permitted and backs off on 429', async () => {
  let requests = 0
  await assert.rejects(waitForInstallation('your-store.myshopify.com', { clientId: 'mock-id', clientSecret: 'mock-secret' }, {
    log: quiet, pause: async () => {}, fetcher: async () => { requests++; return Response.json({ error: 'shop_not_permitted' }, { status: 400 }) },
  }), /different Shopify organizations/)
  assert.equal(requests, 1)

  let clock = 0, calls = 0
  const waits = []
  await waitForInstallation('your-store.myshopify.com', { clientId: 'mock-id', clientSecret: 'mock-secret' }, {
    timeout: 600, log: quiet, now: () => clock, pause: async ms => { waits.push(ms); clock += ms },
    fetcher: async () => ++calls < 3 ? new Response('', { status: 429, headers: { 'retry-after': '40' } }) : Response.json({ access_token: 'mock-token', expires_in: 86399 }),
  })
  assert.deepEqual(waits, [40000, 40000])
})
