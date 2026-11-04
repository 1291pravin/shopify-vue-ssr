import { selectStore } from './config.mjs'

export function workflowMatrix(config, ids, selected) {
  if (selected !== undefined && selected !== null && (typeof selected !== 'string' || !ids.includes(selected))) throw new Error('Dispatch store must be a configured store id')
  return { store: ids.filter(id => selected == null || id === selected).map(id => {
    const store = selectStore(config, id)
    return { id, suffix: id.toUpperCase(), credentials: (store.credentials ?? id).toUpperCase() }
  }) }
}

export function workflowSyncArgs(config, urls) {
  if (urls == null) {
    if (!config.sitemap) throw new Error(`Store ${config.storeId} needs a configured sitemap for a full crawl`)
    return ['sync', '--store', config.storeId, '--sitemap', config.sitemap]
  }
  const origins = new Set([`https://${config.store}`, ...(config.sitemap ? [new URL(config.sitemap).origin] : [])])
  if (!Array.isArray(urls) || !urls.length || urls.some(value => {
    if (typeof value !== 'string' || !URL.canParse(value)) return true
    const url = new URL(value)
    return url.protocol !== 'https:' || url.username || url.password || !origins.has(url.origin)
  })) throw new Error(`Dispatch urls must be a nonempty array of HTTPS URLs on store ${config.storeId} or its configured sitemap host`)
  return ['sync', '--store', config.storeId, ...urls]
}
