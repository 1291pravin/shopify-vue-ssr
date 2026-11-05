import { resolve } from 'node:path'
import { loadConfigFromFile } from 'vite'

export const pluginSnippet = `import { shopifyVueSsr } from 'shopify-vue-ssr'

// Add to your existing Vite plugins (keep Vue and CSS plugins):
shopifyVueSsr({
  islands: 'src/sections/**/*.vue',
  themeDir: 'theme',
  client: { entry: 'src/client.ts' }, // or false for your own client build
  widths: [375, 1440],
  store: 'example.myshopify.com',
})`

export function normalizeOptions(options, root) {
  const config = { islands: 'src/islands/**/*.vue', widths: [375, 1440], themeDir: 'theme', fixturesDir: 'ssr-fixtures', reportDir: 'ssr-report', outDir: 'dist-ssr', client: { entry: 'src/client.ts' }, ...options, root }
  for (const key of ['themeDir', 'fixturesDir', 'reportDir', 'outDir']) config[key] = resolve(root, config[key])
  config.prune = pruneOptions(options.prune)
  if (!Array.isArray(config.widths) || !config.widths.length || config.widths.some(w => !Number.isInteger(w) || w < 1)) throw new Error('widths must be positive integer viewport widths')
  if (config.client !== false && (!config.client || typeof config.client.entry !== 'string' || !config.client.entry)) throw new Error('client must be false or { entry: "src/client.ts" }')
  config.reportBaseDir = config.reportDir
  if (options.stores !== undefined) {
    if (!options.stores || Array.isArray(options.stores) || typeof options.stores !== 'object' || !Object.keys(options.stores).length) throw new Error('stores must be a nonempty map of store ids to { domain, sitemap, credentials? }')
    if (options.store !== undefined || options.sitemap !== undefined) throw new Error('Choose stores or the single store/sitemap options, not both')
    config.stores = { ...options.stores }
  } else config.stores = { default: { domain: options.store, sitemap: options.sitemap } }
  const suffixes = new Set()
  for (const [id, store] of Object.entries(config.stores)) {
    if (!/^[a-z][a-z0-9_]*$/i.test(id) || suffixes.has(id.toUpperCase())) throw new Error(`Invalid or duplicate store id "${id}": use a letter followed by letters, digits or underscores; ids must be unique ignoring case`)
    suffixes.add(id.toUpperCase())
    if (!store || typeof store !== 'object' || Array.isArray(store)) throw new Error(`Store ${id} needs { domain, sitemap, credentials? }`)
    if (options.stores !== undefined && (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(store.domain ?? '') || (store.sitemap !== undefined && (!URL.canParse(store.sitemap) || new URL(store.sitemap).protocol !== 'https:')))) throw new Error(`Store ${id} needs a .myshopify.com domain and optional HTTPS sitemap URL`)
    if (store.credentials !== undefined && !/^[a-z][a-z0-9_]*$/i.test(store.credentials)) throw new Error(`Invalid credentials suffix for store ${id}`)
    config.stores[id] = { ...store, ...(options.stores === undefined && process.env.SHOPIFY_STORE ? { domain: process.env.SHOPIFY_STORE } : {}) }
  }
  return Object.keys(config.stores).length === 1 ? selectStore(config) : config
}

// Builds are shared. Only store operations select a domain and report directory.
export function selectStore(config, id) {
  const ids = Object.keys(config.stores)
  if (!id && ids.length !== 1) throw new Error(`Several stores configured (${ids.join(', ')}). Select --store <id>`)
  id ??= ids[0]
  if (!Object.hasOwn(config.stores, id)) throw new Error(`Unknown store "${id}". Configured stores: ${ids.join(', ')}`)
  const store = config.stores[id]
  return { ...config, storeId: id, store: store.domain, sitemap: store.sitemap, credentials: store.credentials,
    reportDir: resolve(config.reportBaseDir, id) }
}

export function pruneOptions(options = {}) {
  const result = { keepBuilds: 3, graceDays: 14, maxDelete: 20000, ...options }
  for (const [key, value] of Object.entries(result)) {
    if (!['keepBuilds', 'graceDays', 'maxDelete'].includes(key) || !Number.isSafeInteger(value) || value < (key === 'keepBuilds' ? 1 : 0)) throw new Error(`Invalid prune.${key}: expected ${key === 'keepBuilds' ? 'positive' : 'nonnegative'} integer`)
  }
  return result
}

export function storeList(config) {
  return Object.keys(config.stores)
}

async function flatten(plugins = []) {
  const result = []
  for (const item of plugins) {
    const plugin = await item
    if (Array.isArray(plugin)) result.push(...await flatten(plugin))
    else if (plugin) result.push(plugin)
  }
  return result
}

export async function loadConfig(root = process.cwd(), configFile) {
  root = resolve(root)
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production', isSsrBuild: false }, configFile ? resolve(root, configFile) : undefined, root)
  const plugins = (await flatten(loaded?.config.plugins)).filter(plugin => plugin.name === 'shopify-vue-ssr')
  if (plugins.length > 1) throw new Error('Register shopifyVueSsr only once in your Vite config')
  const plugin = plugins[0]
  const missingPlugin = !plugin ? `Missing shopify-vue-ssr plugin in ${loaded?.path ?? configFile ?? 'vite.config.ts'}. Add:\n\n${pluginSnippet}` : undefined
  if (missingPlugin) throw new Error(missingPlugin)
  const config = normalizeOptions(plugin?.api?.shopifyVueSsrOptions ?? {}, root)
  return { ...config, configFile: loaded?.path }
}
