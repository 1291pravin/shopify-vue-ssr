/// <reference path="./islands.d.ts" />
import type { Plugin } from 'vite'
declare module 'vite' {
  interface UserConfig {
    shopifyVueSsrBuild?: { kind: 'server' | 'verify' | 'client'; outDir: string; entry?: string }
  }
}
export interface ShopifyVueSsrOptions {
  islands?: string | string[] | Record<string, string>
  exclude?: string[]
  nestedBuild?: { excludePlugins?: (string | RegExp)[] }
  store?: string
  sitemap?: string
  stores?: Record<string, { domain: string; sitemap?: string; credentials?: string }>
  themeDir?: string
  widths?: number[]
  client?: false | { entry: string }
  outDir?: string
  reportDir?: string
  fixturesDir?: string
  prune?: { keepBuilds?: number; graceDays?: number; maxDelete?: number }
}
export function shopifyVueSsr(options?: ShopifyVueSsrOptions): Plugin
export function resolveIslands(options: ShopifyVueSsrOptions, root?: string): Promise<{ name: string; file: string }[]>
