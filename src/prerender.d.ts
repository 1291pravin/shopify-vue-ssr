export interface ProjectConfig {
  root: string
  outDir: string
  reportDir: string
  fixturesDir: string
  widths: number[]
  store?: string
  storeId?: string
  credentials?: string
  sitemap?: string
  apiVersion?: string
  prune?: { keepBuilds?: number; graceDays?: number; maxDelete?: number }
}
export interface Island {
  name?: string
  key?: string
  buildId?: string
  miss?: string
  hit: boolean
  exactProps?: string
}
export type Verification = { ok: true; html: string } | {
  ok: false
  html?: string
  type: string
  error: { message: string; stack?: string }
  mismatch?: unknown
  width?: number
  clientHtml?: string
}
export interface Report {
  schemaVersion: number
  runId: string
  command: string
  storeId: string
  store: string | null
  buildId: string | null
  fullCrawl: boolean
  sitemap: string | null
  pages: { page: string; themeId?: string | null; islands: { component: string | null; key: string | null; status: string; why: string }[] }[]
  failures: { id: string; type: string; message: string; component: string | null; page: string; exactProps?: string }[]
  counts: Record<string, number>
  hint?: string
  warnings?: string[]
  /** Old-build cleanup that a live-theme purge runs before the crawl. */
  precleanup?: unknown
  cleanup?: unknown
}
export interface PrerenderOptions {
  dryRun?: boolean
  /** Cache cleanup. Default: 'purge' for sitemap crawls, 'none' for saved HTML. A purge without
   * `theme` deletes old builds before the crawl and the deployed build's unseen keys after a successful run. */
  cleanup?: 'purge' | 'recent' | 'none'
  theme?: string | number
  limit?: number
  concurrency?: number
  passwordEnv?: string
  env?: Record<string, string | undefined>
  reader?: (input: string) => Promise<string>
  verify?: (config: ProjectConfig, input: { component: string; exactProps: string }) => Promise<Verification>
  admin?: (query: string, variables?: Record<string, unknown>, mutation?: boolean) => Promise<any>
  log?: (message: string) => void
}
export function prerender(inputs: string[], config: ProjectConfig, options?: PrerenderOptions): Promise<Report>
export function runCheck(config: ProjectConfig, options?: Pick<PrerenderOptions, 'verify'>): Promise<Report>
export function findIslands(html: string): Island[]
export function verifyIsland(island: Island, buildId: string, page?: string): Record<string, unknown>
