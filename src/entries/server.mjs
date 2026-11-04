import { registry } from 'virtual:shopify-vue-ssr/islands'
import { createRenderer } from '../server.mjs'
export const render = createRenderer(registry)
