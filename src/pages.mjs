import { readFile } from 'node:fs/promises'
import { parse } from 'parse5'
import { CookieJar } from 'jsdom'
import { cacheKey } from './key.mjs'

export const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value
export function findIslands(html) {
  const islands = []
  const visit = node => {
    if (node.tagName === 'vue-island') {
      const script = node.childNodes.find(child => child.tagName === 'script' && attr(child, 'data-props') !== undefined)
      const content = node.childNodes.find(child => attr(child, 'data-ssr-root') !== undefined)
      islands.push({ name: attr(node, 'data-component'), key: attr(node, 'data-ssr-key'), buildId: attr(node, 'data-ssr-build'),
        miss: content ? attr(content, 'data-ssr-miss') : undefined, hit: content ? attr(content, 'data-ssr') === '1' : false,
        exactProps: script?.childNodes.map(child => child.value ?? '').join('') })
    }
    node.childNodes?.forEach(visit)
  }
  visit(parse(html))
  return islands
}
export function verifyIsland(island, buildId, page = 'storefront') {
  if (!island.name || !island.key || typeof island.exactProps !== 'string') throw new Error('Missing component, key, or exact props JSON')
  if (/[\r\n]/.test(island.exactProps)) throw new Error('Props must be a single line with escaped newlines')
  const expected = cacheKey(buildId, island.name, island.exactProps)
  if (expected !== island.key || (island.miss !== undefined && island.miss !== expected)) throw new Error(`Key mismatch: emitted ${island.key}, computed ${expected}; rebuild or capture fresh HTML`)
  let props
  try { props = JSON.parse(island.exactProps) }
  catch (error) { throw Object.assign(new Error(`Invalid props JSON for island "${island.name}" on ${page}: ${error.message}`), { type: 'invalid-props' }) }
  if (!props || typeof props !== 'object' || Array.isArray(props)) throw new Error('Props must be a JSON object')
  if (island.hit === (island.miss !== undefined)) throw new Error('Expected exactly one cache hit or cache miss marker')
  return props
}
export function deployedBuild(html, islands) {
  const ids = []
  const visit = node => {
    const id = attr(node, 'data-ssr-build') ?? (node.tagName === 'meta' && attr(node, 'name') === 'ssr-build-id' ? attr(node, 'content') : null)
    if (id != null) ids.push(id)
    node.childNodes?.forEach(visit)
  }
  visit(parse(html))
  if (ids.some(id => !/^[a-f0-9]{64}$/.test(id))) return null
  if (ids.length && new Set(ids).size === 1) return ids[0]
  // Old captures have no explicit marker, so they cannot prove a current build.
  return null
}

export function pageThemeId(html) {
  const match = html.match(/(?:Shopify\.theme\s*=\s*\{[^}]*?["']?id["']?\s*:\s*["']?(\d+)|<meta\b[^>]*name=["']ssr-theme-id["'][^>]*content=["'](\d+))/i)
  return match ? match[1] ?? match[2] : null
}

export function previewUrl(input, theme) {
  if (!theme || !/^https?:\/\//i.test(input)) return input
  const url = new URL(input)
  url.searchParams.set('preview_theme_id', String(theme))
  return url.href
}

function passwordForm(html) {
  let form
  const visit = node => {
    if (node.tagName === 'form') {
      let password = false, storefront = false
      const inputs = child => {
        if (child.tagName === 'input') {
          password ||= ['password', 'storefront_password'].includes(attr(child, 'name'))
          storefront ||= attr(child, 'name') === 'form_type' && attr(child, 'value') === 'storefront_password'
        }
        child.childNodes?.forEach(inputs)
      }
      inputs(node)
      if (storefront || (password && /\/password(?:[?#]|$)/.test(attr(node, 'action') ?? ''))) form ??= node
    }
    node.childNodes?.forEach(visit)
  }
  visit(parse(html))
  return form
}
const passwordPage = html => Boolean(passwordForm(html))
const challengePage = html => /<title[^>]*>[^<]*(?:challenge|just a moment)|id=["'](?:challenge-form|captcha_form)|action=["'][^"']*\/challenge/i.test(html)
const gateError = reason => new Error(`${reason}. Set SHOPIFY_STOREFRONT_PASSWORD (or --password-env NAME). If login is blocked by a challenge, use saved .html files with prerender.`)

const USER_AGENT = 'shopify-vue-ssr (+https://github.com/1291pravin/shopify-vue-ssr)'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function createPageReader({ fetcher = fetch, password = process.env.SHOPIFY_STOREFRONT_PASSWORD, pause = sleep, retries = 6 } = {}) {
  const jar = new CookieJar(), logins = new Map()
  async function request(url, options = {}, redirects = 0, attempt = 0) {
    if (redirects > 8) throw new Error('Too many storefront redirects')
    const cookie = await jar.getCookieString(url)
    const response = await fetcher(url, { ...options, redirect: 'manual', headers: { 'User-Agent': USER_AGENT, ...options.headers, ...(cookie ? { Cookie: cookie } : {}) } })
    // Shopify rate-limits fast crawls: wait (Retry-After or exponential backoff) and try again before giving up.
    if ([429, 503].includes(response.status) && attempt < retries) {
      await response.body?.cancel?.()
      const retryAfter = Number(response.headers.get('retry-after')) || 0
      await pause(Math.min(60_000, Math.max(retryAfter * 1000, 2000 * 2 ** attempt)))
      return request(url, options, redirects, attempt + 1)
    }
    for (const value of response.headers.getSetCookie?.() ?? []) await jar.setCookie(value, url)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = new URL(response.headers.get('location'), url)
      if (next.origin !== new URL(url).origin) throw new Error('Refusing cross-origin storefront redirect')
      return request(next.href, response.status === 307 || response.status === 308 ? options : {}, redirects + 1)
    }
    const html = await response.text()
    if (challengePage(html)) throw gateError('Storefront challenge page cannot be authenticated automatically')
    if (response.status === 429) throw new Error(`Storefront rate limited (HTTP 429) after ${retries} retries: ${url}. Lower --concurrency (for example 1) or run again later.`)
    if (response.status === 403) throw gateError(`Storefront access blocked (HTTP ${response.status})`)
    if (!response.ok) throw new Error(`Fetch HTTP ${response.status}: ${url}`)
    return html
  }
  return async input => {
    if (!/^https?:\/\//i.test(input)) return readFile(input, 'utf8')
    const url = new URL(input)
    let html = await request(input)
    if (passwordPage(html)) {
      if (!password) throw gateError('Storefront password required')
      if (!logins.has(url.origin)) logins.set(url.origin, (async () => {
        const form = passwordForm(html)
        const action = new URL(form ? attr(form, 'action') || '/password' : '/password', input)
        if (action.origin !== url.origin || action.protocol !== url.protocol) throw gateError('Refusing cross-origin password form')
        const fields = new URLSearchParams({ form_type: 'storefront_password', utf8: '\u2713' })
        const collect = node => {
          if (node.tagName === 'input' && attr(node, 'name') && attr(node, 'type') === 'hidden') fields.set(attr(node, 'name'), attr(node, 'value') ?? '')
          node.childNodes?.forEach(collect)
        }
        if (form) collect(form)
        fields.set('password', password)
        await request(action.href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: fields.toString() })
      })())
      await logins.get(url.origin)
      html = await request(input)
      if (passwordPage(html)) throw gateError('Storefront password rejected')
    }
    return html
  }
}

export async function sitemapUrls(url, reader, visited = new Set(), origin = new URL(url).origin) {
  if (visited.has(url)) return []
  if (new URL(url).origin !== origin) throw new Error('Refusing cross-origin sitemap')
  visited.add(url)
  const xml = await reader(url)
  if (!/<(?:sitemapindex|urlset)\b/.test(xml)) throw new Error('Expected sitemap XML')
  const urls = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map(match => match[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'"))
  for (const entry of urls) if (new URL(entry).origin !== origin) throw new Error('Refusing cross-origin sitemap URL')
  if (/<sitemapindex\b/.test(xml)) {
    const pages = []
    for (const child of urls) pages.push(...await sitemapUrls(child, reader, visited, origin))
    if (!pages.length) throw new Error('Empty or cyclic sitemap index does not authorize a full crawl')
    return [...new Set(pages)]
  }
  if (!urls.length) throw new Error('Empty sitemap does not authorize a full crawl')
  return [...new Set(urls)]
}
