import { build, loadConfigFromFile, mergeConfig } from 'vite'
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveIslands } from './plugin.mjs'
import { bundleId } from './key.mjs'
import MagicString from 'magic-string'
import remapping from '@jridgewell/remapping'

const here = fileURLToPath(new URL('.', import.meta.url))

// Skip plugins that write into the theme during nested builds: vite-plugin-shopify 5's -html
// (rewrites snippets/vite-tag.liquid) and its dev-only ":" helpers, plus clean plugins
// (@driver-digital/vite-plugin-shopify-clean deletes theme assets). Keep vite-plugin-shopify-config:
// it provides the "~" and "@" aliases components import with; this package overrides its output dir.
const themePlugins = [/^vite-plugin-shopify-html$/, /^vite-plugin-shopify:/, /^vite-plugin-shopify-clean$/, /^shopify[-:]clean(?:$|[-:])/]
async function nestedPlugins(plugins = [], exclusions, kind) {
  const kept = []
  for (const item of plugins) {
    const plugin = await item
    if (Array.isArray(plugin)) kept.push(...await nestedPlugins(plugin, exclusions, kind))
    else if (plugin) {
      if (exclusions.some(rule => typeof rule === 'string' ? plugin.name === rule : new RegExp(rule.source, rule.flags).test(plugin.name))) console.log(`SSR ${kind}: skipped plugin "${plugin.name}"`)
      else kept.push(plugin)
    }
  }
  return kept
}
export async function writeSnippets(themeDir, buildId) {
  await mkdir(join(themeDir, 'snippets'), { recursive: true })
  await copyFile(new URL('../templates/vue-island.liquid', import.meta.url), join(themeDir, 'snippets/vue-island.liquid'))
  if (buildId) await writeFile(join(themeDir, 'snippets/ssr-build-id.liquid'), buildId)
}

export async function buildProject(config) {
  const { root, outDir, themeDir } = config
  if (!config.configFile) throw new Error('Build requires a Vite config with shopifyVueSsr registered')
  const islands = await resolveIslands(config, root)
  console.log(`Islands: ${islands.length}`)
  for (const island of islands) console.log(`  ${island.name} -> ${island.file.slice(root.length + 1).replaceAll('\\', '/')}`)
  const base = {
    configFile: config.configFile, root, logLevel: 'warn',
    plugins: [{
      name: 'escape-disallowed-punctuation',
      generateBundle(_options, bundle) {
        // Minifiers can turn escapes back into Unicode, so run after codegen.
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== 'chunk' || !chunk.code.includes(String.fromCodePoint(0x2014))) continue
          const s = new MagicString(chunk.code)
          for (let i = 0; i < chunk.code.length; i++) if (chunk.code.charCodeAt(i) === 0x2014) s.overwrite(i, i + 1, '\\u2014')
          const mapAsset = bundle[chunk.fileName + '.map']
          const original = chunk.map ?? (mapAsset ? JSON.parse(String(mapAsset.source)) : null)
          const edits = s.generateMap({ source: chunk.fileName, hires: true })
          if (original) {
            chunk.map = remapping([edits, original], () => null)
            if (mapAsset) mapAsset.source = JSON.stringify(chunk.map)
          }
          chunk.code = s.toString()
        }
      },
    }],
  }
  const runBuild = async (kind, dir, entry) => {
    const target = { ...base,
      shopifyVueSsrBuild: { kind, outDir: dir, entry },
      // Also expose the server target to function-style project configs.
      build: { ssr: kind === 'server' ? join(here, 'entries/server.mjs') : false },
    }
    if (kind === 'client') return build(target)
    // Vite resolves its plugin list before config hooks. Load the project fresh
    // per target, then filter before Vite can invoke apply/config or write hooks.
    const loaded = await loadConfigFromFile({ command: 'build', mode: 'production', isSsrBuild: kind === 'server', isPreview: false }, config.configFile, root, 'warn')
    if (!loaded) throw new Error('Could not load the Vite config for the nested build')
    const project = { ...loaded.config, plugins: await nestedPlugins(loaded.config.plugins, [...themePlugins, ...(config.nestedBuild?.excludePlugins ?? [])], kind) }
    return build(mergeConfig(project, { ...target, configFile: false }))
  }
  await mkdir(outDir, { recursive: true })
  await runBuild('server', outDir)
  const serverPath = join(outDir, 'server-entry.mjs')
  // Hash the exact delivered bytes after source-map-preserving transforms.
  const buildId = bundleId(await readFile(serverPath))
  const clientDir = join(outDir, 'client')
  if (config.client !== false) await runBuild('client', clientDir, resolve(root, config.client.entry))
  // Independent browser compilation with a DEV runtime for mismatch details.
  await runBuild('verify', outDir)
  // JSON Unicode escapes preserve decoded source content and all map offsets.
  for (const dir of config.client === false ? [outDir] : [outDir, clientDir]) for (const name of await readdir(dir)) if (name.endsWith('.map')) {
    const file = join(dir, name)
    await writeFile(file, (await readFile(file, 'utf8')).replaceAll(String.fromCodePoint(0x2014), '\\u2014'))
  }
  if (config.client !== false) {
    await mkdir(join(themeDir, 'assets'), { recursive: true })
    for (const name of ['ssr-client.js', 'ssr-client.css']) {
      try { await copyFile(join(clientDir, name), join(themeDir, 'assets', name)) }
      catch (error) { if (name.endsWith('.js') || error.code !== 'ENOENT') throw error }
    }
  }
  await writeSnippets(themeDir, buildId)
  const manifest = { buildId, entry: 'server-entry.mjs', verify: 'verify.js', widths: config.widths, components: islands.map(({ name }) => name) }
  await writeFile(join(outDir, 'build.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`SSR build id: ${buildId}`)
  return manifest
}
