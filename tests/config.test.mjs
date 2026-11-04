import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'vite'
import { resolveIslands, shopifyVueSsr } from '../src/plugin.mjs'
import { loadConfig } from '../src/config.mjs'
import { initProject } from '../src/init.mjs'
import { definitions } from './helpers/admin.mjs'
import { renderAndVerify } from '../src/verify.mjs'

const exec = promisify(execFile)
const workspace = resolve(import.meta.dirname, '..')
const out = join(workspace, 'out')
const cli = join(workspace, 'src/cli.mjs')
let root
const names = list => list.map(item => item.name)
const exists = file => access(file).then(() => true, () => false)
async function put(file, text) {
  await mkdir(dirname(join(root, file)), { recursive: true })
  await writeFile(join(root, file), text)
}
before(async () => {
  await mkdir(out, { recursive: true })
  root = await mkdtemp(join(out, 'config-test-'))
  await put('src/sections/Hero.vue', '<template><h1>hero</h1></template>')
  await put('src/sections/nested/Footer.vue', '<template><footer>footer</footer></template>')
  await put('src/sections/Unused.test.vue', '<template><p>test only</p></template>')
  await put('src/components/Child.vue', '<template><span>child</span></template>')
  await put('src/other/Hero.vue', '<template><p>duplicate</p></template>')
  await put('src/invalid/bad-name.vue', '<template><p>bad</p></template>')
})
after(async () => {
  if (root && dirname(root) === out) await rm(root, { recursive: true, force: true })
})

test('map keys define island names; children require no registration', async () => {
  const result = await resolveIslands({ islands: { ProductHero: 'src/sections/Hero.vue' } }, root)
  assert.deepEqual(names(result), ['ProductHero'])
  assert.equal(result[0].file, join(root, 'src/sections/Hero.vue'))
})
test('single glob discovers nested islands and exclude applies to globs', async () => {
  assert.deepEqual(names(await resolveIslands({ islands: 'src/sections/**/*.vue', exclude: ['**/*.test.vue'] }, root)), ['Footer', 'Hero'])
})
test('array accepts multiple globs and plain paths, deduplicating repeated matches', async () => {
  assert.deepEqual(names(await resolveIslands({ islands: ['src/sections/**/Footer.vue', 'src/components/*.vue', 'src/sections/Hero.vue', 'src/sections/Hero.vue'] }, root)), ['Child', 'Footer', 'Hero'])
})
test('single plain path uses its basename and is not subject to glob exclusions', async () => {
  assert.deepEqual(names(await resolveIslands({ islands: 'src/sections/Hero.vue', exclude: ['**/*.vue'] }, root)), ['Hero'])
})
test('duplicate names list both conflicting files', async () => {
  await assert.rejects(resolveIslands({ islands: ['src/sections/Hero.vue', 'src/other/Hero.vue'] }, root), error => {
    assert.match(error.message, /Duplicate island name "Hero"/)
    assert.ok(error.message.includes(join(root, 'src/sections/Hero.vue')))
    assert.ok(error.message.includes(join(root, 'src/other/Hero.vue')))
    return true
  })
})
test('unmatched and fully excluded globs name the offending pattern', async () => {
  await assert.rejects(resolveIslands({ islands: 'src/missing/**/*.vue' }, root), /glob matched no files: src\/missing\/\*\*\/\*\.vue/)
  await assert.rejects(resolveIslands({ islands: 'src/sections/**/*.vue', exclude: ['**/*.vue'] }, root), /glob matched no files/)
})
test('invalid names fail for map keys and filenames; empty selections fail', async () => {
  for (const name of ['bad name', 'bad-name', '1Hero', '']) {
    await assert.rejects(resolveIslands({ islands: { [name]: 'src/sections/Hero.vue' } }, root), /Invalid island component name/)
  }
  await assert.rejects(resolveIslands({ islands: 'src/invalid/*.vue' }, root), /Invalid island component name "bad-name"/)
  await assert.rejects(resolveIslands({ islands: [] }, root), /No islands configured/)
})
test('missing Vite plugin gives the exact registration snippet; init mode permits it', async () => {
  await put('missing.vite.ts', 'export default { plugins: [] }')
  await assert.rejects(loadConfig(root, 'missing.vite.ts'), error => {
    assert.match(error.message, /Missing shopify-vue-ssr plugin/)
    assert.match(error.message, /import { shopifyVueSsr } from 'shopify-vue-ssr'/)
    assert.match(error.message, /islands: 'src\/sections\/\*\*\/\*\.vue'/)
    return true
  })
  assert.match((await loadConfig(root, 'missing.vite.ts', { allowMissingPlugin: true })).missingPlugin, /shopifyVueSsr/)
})
test('init preserves Vite config, workflow, guide and build ID across repeated runs; writes no separate config', async () => {
  const local = await loadConfig(root, 'missing.vite.ts', { allowMissingPlugin: true })
  const admin = async (query, _v, mutation) => { assert.equal(mutation, undefined); return definitions(query) }
  const first = await initProject(local, { admin })
  assert.ok(first.next.some(step => step.includes(local.missingPlugin)))
  await writeFile(join(root, 'theme/snippets/ssr-build-id.liquid'), 'keep-build-id')
  await writeFile(join(root, 'AGENTS.md'), 'keep-guide')
  await writeFile(join(root, '.github/workflows/ssr-sync.yml'), 'keep-workflow')
  await initProject(local, { admin })
  assert.equal(await readFile(join(root, 'missing.vite.ts'), 'utf8'), 'export default { plugins: [] }')
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'keep-guide')
  assert.equal(await readFile(join(root, '.github/workflows/ssr-sync.yml'), 'utf8'), 'keep-workflow')
  assert.equal(await readFile(join(root, 'theme/snippets/ssr-build-id.liquid'), 'utf8'), 'keep-build-id')
  assert.equal(await exists(join(root, 'ssr.config.mjs')), false)
})
test('ordinary Vite builds receive no package build overrides', async () => {
  const plugin = shopifyVueSsr({ client: false })
  const user = { build: { outDir: 'own-output', sourcemap: false }, define: { 'process.env.NODE_ENV': '"custom"' } }
  const original = JSON.stringify(user)
  plugin.config.handler(user)
  assert.equal(JSON.stringify(user), original)
})
test('CLI --config loads TS aliases, defines, extra plugins and CSS; client false skips only client; own Vite build is preserved', { timeout: 120000 }, async () => {
  await put('src/message.ts', `import { suffix } from 'virtual:extra'; export const message = __PROJECT_LABEL__ + suffix`)
  await put('src/style.css', '.alias-proof { color: rgb(1, 2, 3); }')
  await put('src/sections/Hero.vue', `<script setup>import { message } from '#src/message'; import Child from '#src/components/Child.vue'; import '#src/style.css'</script><template><h1 class="alias-proof">{{ message }}<Child /></h1></template>`)
  await put('src/own.ts', `import { mountIslands } from 'shopify-vue-ssr/client'; import { registry } from 'virtual:shopify-vue-ssr/islands'; mountIslands({ registry })`)
  await put('config/theme.vite.ts', `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import { shopifyVueSsr } from 'shopify-vue-ssr'
export default defineConfig({
  plugins: [vue({template:{compilerOptions:{comments:false}}}), shopifyVueSsr({
    islands: { ProductHero: 'src/sections/Hero.vue' }, client: false, widths: [375],
    themeDir: 'integration-theme', outDir: 'integration-ssr', reportDir: 'integration-report',
  }), {
    name: 'extra-proof',
    resolveId(id) { if (id === 'virtual:extra') return '\\0extra' },
    load(id) { if (id === '\\0extra') return 'export const suffix = "-extra-plugin"' },
  }],
  resolve: { alias: { '#src': fileURLToPath(new URL('../src', import.meta.url)) } },
  define: { __PROJECT_LABEL__: JSON.stringify('alias-define'), __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false, 'process.env.NODE_ENV': JSON.stringify('production') },
  ssr: { noExternal: [], external: ['vue'] },
  build: { outDir: 'own-output', emptyOutDir: true, sourcemap: false, cssCodeSplit: true,
    lib: { entry: 'src/own.ts', formats: ['es'], fileName: () => 'own-client.js' },
    rolldownOptions: { input: 'src/own.ts', output: [{ entryFileNames: 'own-client.js' }] },
  },
})`)
  await put('own-output/keep.txt', 'keep-own-output')
  await put('integration-theme/assets/ssr-client.js', 'keep-existing-client')
  await put('ssr-fixtures/ProductHero/default.json', '{}')
  const config = await loadConfig(root, 'config/theme.vite.ts')
  assert.equal(config.client, false)
  assert.equal(config.configFile, join(root, 'config/theme.vite.ts').replaceAll('\\', '/'))
  const listed = await exec(process.execPath, [cli, 'islands', '--root', root, '--config', 'config/theme.vite.ts'])
  assert.equal(listed.stdout.trim(), 'ProductHero -> src/sections/Hero.vue')
  const built = await exec(process.execPath, [cli, 'build', '--root', root, '--config', 'config/theme.vite.ts'])
  assert.match(built.stdout, /^Islands: 1\r?\n/)
  assert.match(built.stdout, /SSR build id: [a-f0-9]{64}/)
  assert.equal(await readFile(join(root, 'own-output/keep.txt'), 'utf8'), 'keep-own-output')
  assert.equal(await readFile(join(root, 'integration-theme/assets/ssr-client.js'), 'utf8'), 'keep-existing-client')
  assert.equal(await exists(join(config.outDir, 'client')), false)
  assert.equal(await exists(join(root, 'dist')), false)
  const result = await renderAndVerify(config, { component: 'ProductHero', exactProps: '{}' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(result.html, /alias-define-extra-plugin/)
  assert.match(result.html, /<span>child<\/span>/)
  assert.match(await readFile(join(config.outDir, 'verify.css'), 'utf8'), /alias-proof/)
  assert.ok(JSON.parse(await readFile(join(config.outDir, 'server-entry.mjs.map'), 'utf8')).sources.some(file => file.endsWith('Hero.vue')))
  const checked = await exec(process.execPath, [cli, 'check', '--root', root, '--config', 'config/theme.vite.ts'])
  assert.match(checked.stdout, /^Islands: 1\r?\n/)
  assert.match(checked.stdout, /Check: (\d+) of \1 fixture cases passed, 0 failed/)
  const checkedJson = await exec(process.execPath, [cli, 'check', '--root', root, '--config', 'config/theme.vite.ts', '--json'])
  assert.equal(JSON.parse(checkedJson.stdout.split('\n').find(line => line.startsWith('{'))).failed, 0)
  await build({ root, configFile: config.configFile, logLevel: 'silent' })
  assert.equal(await exists(join(root, 'own-output/own-client.js')), true)
  assert.equal(await exists(join(root, 'own-output/own-client.js.map')), false)
  assert.equal(await exists(join(root, 'own-output/ssr-client.js')), false)
})
test('SHOPIFY_STORE overrides plugin store and invalid widths are rejected', async () => {
  await put('env.vite.ts', `import { shopifyVueSsr } from 'shopify-vue-ssr'; export default { plugins: [[Promise.resolve(shopifyVueSsr({ islands: 'src/sections/Hero.vue', store: 'example-configured.myshopify.com' }))]] }`)
  const original = process.env.SHOPIFY_STORE
  try {
    process.env.SHOPIFY_STORE = 'example-override.myshopify.com'
    assert.equal((await loadConfig(root, 'env.vite.ts')).store, 'example-override.myshopify.com')
  } finally {
    if (original === undefined) delete process.env.SHOPIFY_STORE
    else process.env.SHOPIFY_STORE = original
  }
  await put('invalid.vite.ts', `import { shopifyVueSsr } from 'shopify-vue-ssr'; export default { plugins: [shopifyVueSsr({ widths: [0] })] }`)
  await assert.rejects(loadConfig(root, 'invalid.vite.ts'), /positive integer viewport widths/)
})
