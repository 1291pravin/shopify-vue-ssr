import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

let input = ''
for await (const chunk of process.stdin) input += chunk
const request = JSON.parse(input)
let result, dom
try {
  if (request.mode === 'render') {
    if (typeof window !== 'undefined') throw new Error('SSR cannot have browser globals')
    const { render } = await import(pathToFileURL(request.entry).href)
    result = { ok: true, html: await render(request.component, request.props) }
  } else {
    const { JSDOM, VirtualConsole } = await import('jsdom')
    for (const width of request.widths ?? [request.width]) {
      const runtimeErrors = []
      const virtualConsole = new VirtualConsole()
      virtualConsole.on('jsdomError', error => { if (error.type !== 'not-implemented') runtimeErrors.push({ message: error.message, stack: error.stack }) })
      dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://ssr.invalid/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole })
      const win = dom.window
      Object.defineProperty(win, 'innerWidth', { value: width, configurable: true })
      Object.defineProperty(win.document.documentElement, 'clientWidth', { value: width, configurable: true })
      win.matchMedia = query => ({ media: query, get matches() {
        const min = query.match(/min-width:\s*(\d+)px/), max = query.match(/max-width:\s*(\d+)px/)
        return (!min || win.innerWidth >= Number(min[1])) && (!max || win.innerWidth <= Number(max[1]))
      }, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true } })
      win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
      win.addEventListener('error', event => { runtimeErrors.push({ message: event.error?.message ?? event.message, stack: event.error?.stack ?? '' }); event.preventDefault() })
      win.eval(await readFile(request.entry, 'utf8') + '\n//# sourceURL=' + pathToFileURL(request.entry).href)
      result = await win.ShopifySsrVerify.verify(request)
      if (runtimeErrors.length) { result.ok = false; result.errors.push(...runtimeErrors) }
      result.width = width
      dom.window.close()
      dom = undefined
      if (!result.ok) break
    }
  }
} catch (error) { result = { ok: false, error: { message: error.message, stack: error.stack } } }
finally { dom?.window.close() }
process.stdout.write('\nSSR_RESULT:' + JSON.stringify(result))
