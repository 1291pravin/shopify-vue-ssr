declare module 'virtual:shopify-vue-ssr/islands' {
  import type { Component } from 'vue'
  export const registry: Readonly<Record<string, Component>>
  export function getComponent(name: string): Component
}
