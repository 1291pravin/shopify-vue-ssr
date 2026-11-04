import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import { bundleId } from './key.mjs'

export async function readBuild(config) {
  const manifest = JSON.parse(await readFile(join(config.outDir, 'build.json'), 'utf8'))
  if (bundleId(await readFile(join(config.outDir, manifest.entry))) !== manifest.buildId) throw Object.assign(new Error('Local SSR bundle differs from build manifest; run build'), { type: 'build-mismatch' })
  return manifest
}

export async function mapStack(stack, bundle) {
  if (!stack) return ''
  let map
  try { map = new TraceMap(JSON.parse(await readFile(bundle + '.map', 'utf8'))) } catch { return stack }
  return stack.replace(/((?:file:\/\/\/)?[^\s()]*?(?:verify\.js|server-entry\.mjs)):(\d+):(\d+)/g, (match, _file, line, column) => {
    const original = originalPositionFor(map, { line: Number(line), column: Number(column) - 1 })
    if (!original.source) return match
    return `${resolve(bundle, '..', original.source)}:${original.line}:${(original.column ?? 0) + 1}`
  })
}

// Each request gets a clean process: SSR never sees browser globals and each
// viewport gets a fresh browser runtime. Timeouts become saved failures.
export function worker(request, timeout = 60000) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--enable-source-maps', fileURLToPath(new URL('./worker.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Renderer/verification timed out')) }, timeout)
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      const result = stdout.split('\nSSR_RESULT:').at(-1)
      try { accept(JSON.parse(result)) }
      catch { reject(new Error(`Worker failed (${code}): ${stderr.slice(-4000)} ${stdout.slice(-1000)}`)) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
  })
}

export async function renderAndVerify(config, { component, exactProps, widths = config.widths, renderedHtml }) {
  const props = JSON.parse(exactProps)
  if (!props || typeof props !== 'object' || Array.isArray(props)) throw new Error('Props must be a JSON object')
  const rendered = await worker({ mode: 'render', entry: join(config.outDir, 'server-entry.mjs'), component, props })
  if (!rendered.ok) return { ...rendered, type: 'render-error' }
  const html = rendered.html
  return verifyHtml(config, { component, exactProps, widths, html, renderedHtml })
}

export async function verifyHtml(config, { component, exactProps, widths = config.widths, html, renderedHtml }) {
  const props = JSON.parse(exactProps)
  const failure = (type, message) => ({ ok: false, html, type, error: { message, stack: new Error(message).stack } })
  if (!html || /<!doctype/i.test(html)) return failure('render-error', 'Renderer returned an invalid fragment')
  if (Buffer.byteLength(html, 'utf8') > 65536) return failure('too-large', `Fragment is ${Buffer.byteLength(html, 'utf8')} UTF-8 bytes; exceeds the 65,536-byte field limit`)
  {
    const result = await worker({ mode: 'verify', entry: join(config.outDir, 'verify.js'), component, props, html, widths })
    if (!result.ok) {
      const first = result.errors?.[0] ?? result.error
      const error = first ?? { message: result.warnings?.join('\n') || 'Hydration mismatch', stack: '' }
      if (result.mismatch) error.message = error.message.replace(/\s*\[object \w+\]/g, ` ${result.mismatch.path}`) +`\nFirst difference at ${result.mismatch.path} (width ${result.width}px)\n  server: ${result.mismatch.serverHtml}\n  client: ${result.mismatch.clientHtml}`
      error.stack = await mapStack(error.stack, join(config.outDir, 'verify.js'))
      // Warning-only mismatches have no thrown stack. The map still identifies
      // the component's original file so an agent can find the offending render.
      if (!error.stack) {
        const map = JSON.parse(await readFile(join(config.outDir, 'verify.js.map'), 'utf8'))
        const code = await readFile(join(config.outDir, 'verify.js'), 'utf8')
        const offset = result.renderSource ? code.indexOf(result.renderSource) : -1
        let original
        if (offset >= 0) {
          // Map the first expression in the actual client render function.
          const expression = offset + (result.renderSource.indexOf('return ') >= 0 ? result.renderSource.indexOf('return ') + 7 : 0)
          const prefix = code.slice(0, expression).split('\n')
          original = originalPositionFor(new TraceMap(map), { line: prefix.length, column: prefix.at(-1).length })
        }
        const sourceIndex = map.sources.findIndex(source => source.endsWith(`/${component}.vue`))
        const source = original?.source ?? map.sources[sourceIndex]
        const templateLine = (map.sourcesContent?.[sourceIndex]?.split('\n').findIndex(line => /<template[ >]/.test(line)) ?? -1) + 1
        error.stack = source ? `${resolve(config.outDir, source)}:${original?.line ?? (templateLine || 1)}:${(original?.column ?? 0) + 1}\n${error.message}` : error.message
      }
      const { renderSource: _renderSource, ...details } = result
      return { ...details, html, type: 'hydration-mismatch', width: result.width, error }
    }
  }
  return { ok: true, html, widths, previousHtml: renderedHtml }
}
