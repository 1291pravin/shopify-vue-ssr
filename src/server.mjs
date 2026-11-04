import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'

export function createRenderer(registry) {
  return async (name, props) => {
    if (!Object.hasOwn(registry, name)) throw new Error(`Unknown island component: ${name}`)
    const app = createSSRApp(registry[name], props)
    let failure
    app.config.warnHandler = message => { failure ??= new Error(`SSR ${name}: ${message}`) }
    app.config.errorHandler = error => { failure ??= error }
    const html = await renderToString(app)
    // Vue's production renderer can swallow setup/render errors and return a
    // comment node. Inspect its error handler before accepting the fragment.
    if (failure) throw failure
    return html
  }
}
