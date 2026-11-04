import { mkdir, copyFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDefinition, ensureBuildDefinition, createAdmin } from './admin.mjs'
import { writeSnippets } from './build.mjs'
import { loadConfig } from './config.mjs'

async function absent(file, write) {
  try { await access(file); return false } catch (error) { if (error.code !== 'ENOENT') throw error }
  await write(); return true
}
export async function initProject(config, { admin = createAdmin(config) } = {}) {
  const viteConfig = await loadConfig(config.root, config.configFile, { allowMissingPlugin: true })
  const definition = await ensureDefinition(admin)
  const buildDefinition = await ensureBuildDefinition(admin)
  await mkdir(join(config.root, '.github/workflows'), { recursive: true })
  await mkdir(config.fixturesDir, { recursive: true })
  await writeSnippets(config.themeDir)
  await absent(join(config.themeDir, 'snippets/ssr-build-id.liquid'), () => writeFile(join(config.themeDir, 'snippets/ssr-build-id.liquid'), 'BUILD_REQUIRED'))
  await absent(join(config.root, '.github/workflows/ssr-sync.yml'), () => copyFile(new URL('../templates/ssr-sync.yml', import.meta.url), join(config.root, '.github/workflows/ssr-sync.yml')))
  await absent(join(config.root, 'AGENTS.md'), () => copyFile(new URL('../templates/AGENTS.md', import.meta.url), join(config.root, 'AGENTS.md')))
  return { storeId: config.storeId ?? 'default', store: config.store, definition, buildDefinition, next: [
    ...(viteConfig.missingPlugin ? [viteConfig.missingPlugin] : []),
    'Create a Dev Dashboard app in each store owner organization (read/write metaobjects), install it on every store, then set GitHub secrets SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET. Per-store overrides use SHOPIFY_CLIENT_ID_<ID> and SHOPIFY_CLIENT_SECRET_<ID> (uppercase id or credentials suffix). For protected previews also set secret SHOPIFY_STOREFRONT_PASSWORD when available.',
    'Confirm plugin options in vite.config, then run shopify-vue-ssr islands. Call mountIslands with the virtual registry in your client entry. Add ssr_enabled checkbox (default true) to theme settings.',
    'Render vue-island from Liquid sections; load ssr-client.js and ssr-client.css in layout. Add JSON fixtures for every island; build, check, deploy the same build, then sync.',
    'Configure Shopify Flow using the package README recipe. No Flow configuration was changed by init.',
  ] }
}
