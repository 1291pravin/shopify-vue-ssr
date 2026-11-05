import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const exec = promisify(execFile)
export const operations = {
  definition: `query { metaobjectDefinitionByType(type: "ssr_fragment") { id type access { storefront } fieldDefinitions { key type { name } validations { name value } } capabilities { publishable { enabled } } } }`,
  create: `mutation Create($definition: MetaobjectDefinitionCreateInput!) { metaobjectDefinitionCreate(definition: $definition) { metaobjectDefinition { id type } userErrors { field message code } } }`,
  upsert: `mutation SsrFragmentUpsert($key: String!, $html: String!, $name: String!, $build: String!) { metaobjectUpsert(handle: {type: "ssr_fragment", handle: $key}, metaobject: {fields: [{key: "html", value: $html}, {key: "component", value: $name}, {key: "build", value: $build}]}) { metaobject { id handle } userErrors { field message code } } }`,
  updateDefinition: `mutation UpdateDefinition($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) { metaobjectDefinitionUpdate(id: $id, definition: $definition) { metaobjectDefinition { id } userErrors { field message code } } }`,
  buildDefinition: `query { metaobjectDefinitionByType(type: "ssr_build") { id type access { storefront } fieldDefinitions { key type { name } validations { name value } } capabilities { publishable { enabled } } } }`,
  build: `query Build($handle: MetaobjectHandleInput!) { metaobjectByHandle(handle: $handle) { id fields { key value } } }`,
  upsertBuild: `mutation UpsertBuild($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) { metaobjectUpsert(handle: $handle, metaobject: $metaobject) { metaobject { id handle } userErrors { field message code } } }`,
  bulkQuery: `mutation Inventory($query: String!) { bulkOperationRunQuery(query: $query) { bulkOperation { id } userErrors { field message code } } }`,
  bulkStatus: `query InventoryStatus($id: ID!) { node(id: $id) { ... on BulkOperation { id status errorCode url objectCount } } }`,
  bulkDelete: `mutation DeleteMetaobjects($where: MetaobjectBulkDeleteWhereCondition!) { metaobjectBulkDelete(where: $where) { job { id done } userErrors { field message code } } }`,
  job: `query DeleteStatus($id: ID!) { job(id: $id) { id done } }`,
  nodes: `query DeletedObjects($ids: [ID!]!) { nodes(ids: $ids) { id } }`,
}

export async function shopifyCommand() {
  if (process.platform !== 'win32') return ['shopify', []]
  const { stdout } = await exec('where.exe', ['shopify.cmd'], { windowsHide: true })
  const entry = join(dirname(stdout.trim().split(/\r?\n/)[0]), 'node_modules/@shopify/cli/bin/run.js')
  return [process.execPath, [entry]]
}
export async function shopify(args, cwd, options = {}) {
  const [command, prefix] = await shopifyCommand()
  return exec(command, [...prefix, ...args], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options })
}

// Dev Dashboard apps exchange their client ID and secret for a 24-hour token (client credentials grant).
// Works only when the app and the store belong to the same Shopify organization.
export function resolveCredentials(config, env = process.env) {
  const suffixes = new Set([config.storeId ?? 'default', ...(config.credentials ? [config.credentials] : [])].map(id => id.toUpperCase()))
  for (const suffix of suffixes) {
    const clientId = env[`SHOPIFY_CLIENT_ID_${suffix}`], clientSecret = env[`SHOPIFY_CLIENT_SECRET_${suffix}`]
    if (clientId || clientSecret) {
      if (!clientId || !clientSecret) throw new Error(`Store ${config.storeId ?? 'default'} requires both SHOPIFY_CLIENT_ID_${suffix} and SHOPIFY_CLIENT_SECRET_${suffix}`)
      return { clientId, clientSecret }
    }
  }
  return { clientId: env.SHOPIFY_CLIENT_ID, clientSecret: env.SHOPIFY_CLIENT_SECRET, adminToken: env.SHOPIFY_ADMIN_TOKEN }
}

// Scope caches to the environment and transport, then the store domain and credentials.
// Shared apps must still exchange distinct tokens for each store.
const tokenCaches = new WeakMap()
export function createTokenSource(store, { fetcher = fetch, now = () => Date.now(), env = process.env, storeId, credentials, signal } = {}) {
  const selected = resolveCredentials({ storeId, credentials }, env)
  if (selected.adminToken) return async () => selected.adminToken
  if (!selected.clientId || !selected.clientSecret) return null
  let transports = tokenCaches.get(env)
  if (!transports) tokenCaches.set(env, transports = new WeakMap())
  let cache = transports.get(fetcher)
  if (!cache) transports.set(fetcher, cache = new Map())
  const key = JSON.stringify([store, selected.clientId, selected.clientSecret])
  let entry = cache.get(key)
  if (!entry) cache.set(key, entry = { token: null, expiresAt: 0, pending: null })
  return async () => {
    if (entry.token && now() < entry.expiresAt - 60_000) return entry.token
    if (entry.pending) return entry.pending
    entry.pending = (async () => {
      const response = await fetcher(`https://${store}/admin/oauth/access_token`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: selected.clientId, client_secret: selected.clientSecret }),
      })
      if (!response.ok) {
        throw Object.assign(new Error(`Token request failed: HTTP ${response.status}. The app and the store must be in the same Shopify organization, and the app must be installed on the store.`), { status: response.status })
      }
      const body = await response.json()
      if (!body.access_token) throw new Error(`Token request for ${store} returned no access token`)
      entry.token = body.access_token
      entry.expiresAt = now() + (body.expires_in ?? 86399) * 1000
      return entry.token
    })()
    try { return await entry.pending } finally { entry.pending = null }
  }
}

export function createAdmin(config, { fetcher = fetch, sleep = ms => new Promise(accept => setTimeout(accept, ms)), cli = shopify, env = process.env } = {}) {
  const store = config.store
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(store ?? '')) throw new Error('Set SHOPIFY_STORE to your .myshopify.com domain')
  const getToken = createTokenSource(store, { fetcher, env, storeId: config.storeId, credentials: config.credentials })
  return async (query, variables = {}, mutation = false) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      let result, response
      if (getToken) {
        response = await fetcher(`https://${store}/admin/api/${config.apiVersion ?? '2026-07'}/graphql.json`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getToken() }, body: JSON.stringify({ query, variables }),
        })
        if (response.status === 429 || response.status >= 500) {
          if (attempt === 5) throw new Error(`Admin API HTTP ${response.status}; retries exhausted`)
          const retryAfter = Number(response.headers.get('retry-after'))
          await sleep(Math.max(retryAfter * 1000 || 0, 500 * 2 ** attempt)); continue
        }
        if (!response.ok) throw new Error(`Admin API HTTP ${response.status}`)
        result = await response.json()
      } else {
        const parent = resolve(config.root, '.ssr-tmp')
        await mkdir(parent, { recursive: true })
        const temp = await mkdtemp(join(parent, 'admin-'))
        try {
          await writeFile(join(temp, 'query.graphql'), query)
          await writeFile(join(temp, 'variables.json'), JSON.stringify(variables))
          const args = ['store', 'execute', '--store', store, '--version', config.apiVersion ?? '2026-07', '--json', '--query-file', join(temp, 'query.graphql'), '--variable-file', join(temp, 'variables.json')]
          if (mutation) args.push('--allow-mutations')
          try {
            const { stdout } = await cli(args, config.root)
            result = JSON.parse(stdout)
          } catch (error) {
            if (/THROTTLED|throttl/i.test((error.stdout ?? '') + (error.stderr ?? '') + error.message) && attempt < 5) { await sleep(500 * 2 ** attempt); continue }
            throw error
          }
        } finally {
          if (dirname(resolve(temp)) !== parent) throw new Error('Invalid cleanup target')
          await rm(temp, { recursive: true, force: true })
        }
      }
      if (result.errors?.some(error => error.extensions?.code === 'THROTTLED')) {
        if (attempt === 5) throw new Error('Admin API throttling retries exhausted')
        const cost = result.extensions?.cost
        const wait = cost?.throttleStatus?.restoreRate ? Math.max(0, (cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable) / cost.throttleStatus.restoreRate * 1000) : 0
        await sleep(Math.max(wait, 500 * 2 ** attempt)); continue
      }
      if (result.errors?.length) throw new Error(JSON.stringify(result.errors))
      return result.data ?? result
    }
  }
}

export async function ensureDefinition(admin) {
  const existing = (await admin(operations.definition)).metaobjectDefinitionByType
  if (existing) {
    const fields = Object.fromEntries(existing.fieldDefinitions.map(field => [field.key, field]))
    if (existing.access.storefront !== 'PUBLIC_READ' || fields.html?.type.name !== 'multi_line_text_field' || fields.component?.type.name !== 'single_line_text_field' ||
      fields.html?.validations?.length || fields.component?.validations?.length || (fields.build && (fields.build.type.name !== 'single_line_text_field' || fields.build.validations?.length)) || existing.capabilities?.publishable?.enabled) throw new Error(`Existing ssr_fragment definition is incompatible; expected PUBLIC_READ, html: multi_line_text_field, component/build: single_line_text_field, no validations or publishable capability. Received: ${JSON.stringify(existing)}; left unchanged`)
    if (!fields.build) {
      const payload = (await admin(operations.updateDefinition, { id: existing.id, definition: { fieldDefinitions: [{ create: { name: 'Build', key: 'build', type: 'single_line_text_field' } }] } }, true)).metaobjectDefinitionUpdate
      if (!payload?.metaobjectDefinition?.id || payload.userErrors?.length) throw new Error(JSON.stringify(payload?.userErrors ?? payload))
    }
    return { created: false, updated: !fields.build, id: existing.id }
  }
  const definition = { name: 'SSR fragment', type: 'ssr_fragment', access: { storefront: 'PUBLIC_READ' }, fieldDefinitions: [
    { name: 'HTML', key: 'html', type: 'multi_line_text_field' }, { name: 'Component', key: 'component', type: 'single_line_text_field' },
    { name: 'Build', key: 'build', type: 'single_line_text_field' },
  ] }
  const payload = (await admin(operations.create, { definition }, true)).metaobjectDefinitionCreate
  if (payload.userErrors.length) throw new Error(JSON.stringify(payload.userErrors))
  return { created: true, id: payload.metaobjectDefinition.id }
}

// A store set up by an older version lacks newer fields; say how to upgrade instead of surfacing a raw Admin API error.
function upsertError(payload, type) {
  const errors = payload?.userErrors ?? []
  if (errors.some(error => ['UNDEFINED_OBJECT_FIELD', 'UNDEFINED_OBJECT_TYPE', 'OBJECT_FIELD_REQUIRED'].includes(error.code))) {
    const detail = errors.map(error => error.message).join('; ')
    return new Error(`The ${type} definition on this store is missing or outdated (${detail}). Run "npx shopify-vue-ssr setup --skip-app" once (add --store <id> for multi-store configs) to upgrade the definitions, then rerun prerender.`)
  }
  return new Error(JSON.stringify(errors.length ? errors : payload))
}

export async function upsertFragment(admin, { key, name, html, build }) {
  if (!build) throw new Error('Fragment requires a build id')
  const payload = (await admin(operations.upsert, { key, name, html, build }, true)).metaobjectUpsert
  if (!payload?.metaobject?.id || payload.userErrors?.length) throw upsertError(payload, 'ssr_fragment')
  return payload.metaobject
}

export async function ensureBuildDefinition(admin) {
  const existing = (await admin(operations.buildDefinition)).metaobjectDefinitionByType
  if (existing) {
    const fields = Object.fromEntries(existing.fieldDefinitions.map(field => [field.key, field]))
    if (existing.access.storefront !== 'NONE' || existing.capabilities?.publishable?.enabled || ['first_seen', 'last_seen'].some(key => fields[key]?.type.name !== 'date_time' || fields[key]?.validations?.length) || (fields.themes && (fields.themes.type.name !== 'json' || fields.themes.validations?.length))) throw new Error(`Existing ssr_build definition is incompatible; expected NONE access, date_time first_seen/last_seen and json themes, no validations or publishable capability. Received: ${JSON.stringify(existing)}; left unchanged`)
    if (!fields.themes) {
      const payload = (await admin(operations.updateDefinition, { id: existing.id, definition: { fieldDefinitions: [{ create: { name: 'Themes', key: 'themes', type: 'json' } }] } }, true)).metaobjectDefinitionUpdate
      if (!payload?.metaobjectDefinition?.id || payload.userErrors?.length) throw new Error(JSON.stringify(payload?.userErrors ?? payload))
    }
    return { created: false, updated: !fields.themes, id: existing.id }
  }
  const definition = { name: 'SSR build', type: 'ssr_build', access: { storefront: 'NONE' }, fieldDefinitions: [...['first_seen', 'last_seen'].map(key => ({ name: key, key, type: 'date_time' })), { name: 'Themes', key: 'themes', type: 'json' }] }
  const payload = (await admin(operations.create, { definition }, true)).metaobjectDefinitionCreate
  if (!payload?.metaobjectDefinition?.id || payload.userErrors?.length) throw new Error(JSON.stringify(payload?.userErrors ?? payload))
  return { created: true, id: payload.metaobjectDefinition.id }
}

export async function touchBuild(admin, buildId, now = Date.now(), themeId) {
  const handle = { type: 'ssr_build', handle: buildId }
  const existing = (await admin(operations.build, { handle })).metaobjectByHandle
  const fields = [{ key: 'last_seen', value: new Date(now).toISOString() }]
  if (!existing?.fields?.find(field => field.key === 'first_seen')?.value) fields.push({ key: 'first_seen', value: new Date(now).toISOString() })
  if (themeId != null) {
    const value = existing?.fields?.find(field => field.key === 'themes')?.value
    const themes = value ? JSON.parse(value) : {}
    if (!themes || Array.isArray(themes) || typeof themes !== 'object') throw new Error('Invalid ssr_build themes history; rerun setup or repair the history record')
    themes[String(themeId)] = new Date(now).toISOString()
    fields.push({ key: 'themes', value: JSON.stringify(themes) })
  }
  const payload = (await admin(operations.upsertBuild, { handle, metaobject: { fields } }, true)).metaobjectUpsert
  if (!payload?.metaobject?.id || payload.userErrors?.length) throw upsertError(payload, 'ssr_build')
  return payload.metaobject
}
