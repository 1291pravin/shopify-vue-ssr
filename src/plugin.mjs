import { stat } from 'node:fs/promises'
import { resolve, basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { glob, isDynamicPattern } from 'tinyglobby'

const here = fileURLToPath(new URL('.', import.meta.url))

export async function resolveIslands(options, root = process.cwd()) {
  const selection = options.islands ?? 'src/islands/**/*.vue'
  const entries = new Map()
  async function add(name, file) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error(`Invalid island component name "${name}" in ${file}: use a letter followed by letters or digits`)
    if (extname(file) !== '.vue' || !(await stat(file)).isFile()) throw new Error(`Island must be a .vue file: ${file}`)
    const previous = entries.get(name)
    if (previous && previous !== file) throw new Error(`Duplicate island name "${name}":\n${previous}\n${file}`)
    entries.set(name, file)
  }
  if (typeof selection === 'string' || Array.isArray(selection)) {
    for (const pattern of typeof selection === 'string' ? [selection] : selection) {
      if (typeof pattern !== 'string' || !pattern) throw new Error('islands must contain nonempty paths or globs')
      const files = isDynamicPattern(pattern)
        ? await glob(pattern, { cwd: root, absolute: true, onlyFiles: true, ignore: options.exclude ?? [] })
        : [resolve(root, pattern)]
      if (!files.length) throw new Error(`Island glob matched no files: ${pattern}`)
      for (const file of files.sort()) await add(basename(file, '.vue'), resolve(file))
    }
  } else if (selection && typeof selection === 'object') {
    for (const [name, file] of Object.entries(selection)) {
      if (typeof file !== 'string' || !file) throw new Error(`Island ${name} needs a file path`)
      await add(name, resolve(root, file))
    }
  } else throw new Error('islands must be a path, glob, array of paths/globs, or name-to-path map')
  if (!entries.size) throw new Error('No islands configured')
  return [...entries].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, file]) => ({ name, file }))
}

export function shopifyVueSsr(options = {}) {
  let root
  return {
    name: 'shopify-vue-ssr',
    enforce: 'post',
    api: { shopifyVueSsrOptions: options },
    config: {
      order: 'post',
      handler(config) {
        const target = config.shopifyVueSsrBuild
        if (!target) return
        const server = target.kind === 'server'
        const verify = target.kind === 'verify'
        const entry = server ? join(here, 'entries/server.mjs') : verify ? join(here, 'entries/verify.mjs') : target.entry
        // Replace conflicting inputs/output arrays and lib mode for package builds.
        config.build = {
          ...config.build, outDir: target.outDir, emptyOutDir: false,
          ssr: server ? entry : false, sourcemap: true, minify: !server && !verify,
          cssCodeSplit: false, manifest: false, ssrManifest: false,
          lib: server ? false : { entry, ...(verify ? { name: 'ShopifySsrVerify' } : {}), formats: [verify ? 'iife' : 'es'], fileName: () => verify ? 'verify.js' : 'ssr-client.js', cssFileName: verify ? 'verify' : 'ssr-client' },
          rollupOptions: undefined,
          rolldownOptions: { ...config.build?.rolldownOptions, input: entry, external: [], output: { entryFileNames: server ? 'server-entry.mjs' : verify ? 'verify.js' : 'ssr-client.js', codeSplitting: false } },
        }
        config.define = { ...config.define, __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: true, 'process.env.NODE_ENV': JSON.stringify(verify ? 'development' : 'production') }
        config.resolve = { ...config.resolve, dedupe: [...new Set([...(config.resolve?.dedupe ?? []), 'vue'])] }
        if (server) config.ssr = { ...config.ssr, external: [], noExternal: true }
      },
    },
    configResolved(config) {
      root = config.root
      if (config.shopifyVueSsrBuild?.kind !== 'verify') return
      const vue = config.plugins.find(plugin => plugin.name === 'vite:vue')
      // Only warn for an explicit, inspectable option. Custom compilers and
      // defaults can vary; the shared-config recommendation also covers them.
      if (vue?.api?.options?.template?.compilerOptions?.comments === true) config.logger.warn('SSR: Vue template comments are enabled. Use vue({ template: { compilerOptions: { comments: false } } }) in the shared Vite config for server/client parity.')
    },
    resolveId(id) { if (id === 'virtual:shopify-vue-ssr/islands') return '\0' + id },
    async load(id) {
      if (id !== '\0virtual:shopify-vue-ssr/islands') return
      const islands = await resolveIslands(options, root)
      for (const { file } of islands) this.addWatchFile(file)
      return islands.map(({ file }, i) => `import c${i} from ${JSON.stringify(file.replaceAll('\\', '/'))}`).join('\n') +
        `\nexport const registry = Object.freeze({${islands.map(({ name }, i) => `${JSON.stringify(name)}:c${i}`).join(',')}});` +
        '\nexport function getComponent(name) { if (!Object.hasOwn(registry, name)) throw new Error(`Unknown island component: ${name}`); return registry[name] }'
    },
    configureServer(server) {
      const invalidate = file => { if (file.endsWith('.vue')) { const mod = server.moduleGraph.getModuleById('\0virtual:shopify-vue-ssr/islands'); if (mod) { server.moduleGraph.invalidateModule(mod); server.ws.send({ type: 'full-reload' }) } } }
      server.watcher.on('add', invalidate).on('unlink', invalidate)
    },
  }
}
