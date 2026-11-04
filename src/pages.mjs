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
export function verifyIsland(island, buildId) {
  if (!island.name || !island.key || typeof island.exactProps !== 'string') throw new Error('Missing component, key, or exact props JSON')
  if (/[\r\n]/.test(island.exactProps)) throw new Error('Props must be a single line with escaped newlines')
  const expected = cacheKey(buildId, island.name, island.exactProps)
  if (expected !== island.key || (island.miss !== undefined && island.miss !== expected)) throw new Error(`Key mismatch: emitted ${island.key}, computed ${expected}; rebuild or capture fresh HTML`)
  const props = JSON.parse(island.exactProps)
  if (!props || typeof props !== 'object' || Array.isArray(props)) throw new Error('Props must be a JSON object')
  if (island.hit === (island.miss !== undefined)) throw new Error('Expected exactly one cache hit or cache miss marker')
  return props
}
export function deployedBuild(html, islands) {
  const ids = [...html.matchAll(/data-ssr-build="([a-f0-9]{64})"/g)].map(match => match[1])
  const meta = html.match(/<meta\s+name="ssr-build-id"\s+content="([a-f0-9]{64})"/i)
  if (meta) ids.push(meta[1])
  if (ids.length && new Set(ids).size === 1) return ids[0]
  // Old captures have no explicit marker, so they cannot prove a current build.
  return null
}

export function createPageReader({ fetcher = fetch, password = process.env.SHOPIFY_STOREFRONT_PASSWORD } = {}) {
  const jar = new CookieJar(), loggedIn = new Set()
  async function request(url, options = {}, redirects = 0) {
    if (redirects > 8) throw new Error('Too many storefront redirects')
    const cookie = await jar.getCookieString(url)
    const response = await fetcher(url, { ...options, redirect: 'manual', headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}) } })
    for (const value of response.headers.getSetCookie?.() ?? []) await jar.setCookie(value, url)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = new URL(response.headers.get('location'), url)
      if (next.origin !== new URL(url).origin) throw new Error('Refusing cross-origin storefront redirect')
      return request(next.href, response.status === 307 || response.status === 308 ? options : {}, redirects + 1)
    }
    if (!response.ok) throw new Error(`Fetch HTTP ${response.status}: ${url}`)
    return response.text()
  }
  return async input => {
    if (!/^https?:\/\//i.test(input)) return readFile(input, 'utf8')
    const url = new URL(input)
    let html = await request(input)
    if (/name=["'](?:password|storefront_password)["']/i.test(html)) {
      if (!password || loggedIn.has(url.origin)) throw new Error('Storefront password required or rejected')
      await request(new URL('/password', input).href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ form_type: 'storefront_password', utf8: '\u2713', password }).toString() })
      loggedIn.add(url.origin)
      html = await request(input)
      if (/name=["'](?:password|storefront_password)["']/i.test(html)) throw new Error('Storefront password rejected')
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
    return [...new Set(pages)]
  }
  if (!urls.length) throw new Error('Empty sitemap does not authorize a full crawl')
  return [...new Set(urls)]
}
