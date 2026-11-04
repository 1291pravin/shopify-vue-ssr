import { createHash } from 'node:crypto'

export const cacheKey = (buildId, component, exactProps) => createHash('md5').update(`${buildId}|${component}|${exactProps}`, 'utf8').digest('hex')
export const scriptSafeJson = value => JSON.stringify(value).replaceAll('<', '\\u003c')
export const bundleId = bytes => createHash('sha256').update(bytes).digest('hex')
