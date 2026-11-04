/// <reference path="./islands.d.ts" />
import type { Plugin } from 'vite'
export interface ShopifyVueSsrOptions {
  islands?: string | string[] | Record<string, string>
  exclude?: string[]
  store?: string
  sitemap?: string
  stores?: Record<string, { domain: string; sitemap: string; credentials?: string }>
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
