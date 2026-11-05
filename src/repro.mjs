import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderAndVerify } from './verify.mjs'

export async function repro(input, config) {
  const file = /^[a-f0-9]{16}$/.test(input) ? join(config.reportDir, 'cases', input + '.json') : input
  const saved = JSON.parse(await readFile(file, 'utf8'))
  const result = await replay(saved, config)
  return { storeId: saved.storeId ?? 'default', store: saved.store ?? null, ...result }
}

async function replay(saved, config) {
  if (!saved.component || typeof saved.exactProps !== 'string') return { ok: false, reproduced: true, type: saved.error.type, error: saved.error, message: 'This page/fetch failure has no renderable island. Original evidence is saved in this case.' }
  const local = async () => {
    try { return await renderAndVerify(config, { component: saved.component, exactProps: saved.exactProps, widths: saved.widths, renderedHtml: saved.renderedHtml }) }
    catch (error) { return { ok: false, type: 'render-error', error: { message: error.message, stack: error.stack } } }
  }
  // Transport and deployment failures are observable offline from captured bytes.
  if (saved.error.type === 'build-mismatch') return { ok: false, reproduced: true, type: 'build-mismatch', error: saved.error, verification: await local(), message: 'Captured theme was not deployed with the recorded build. Fresh capture required after deployment.' }
  if (['key-mismatch', 'invalid-props'].includes(saved.error.type)) {
    const { verifyIsland } = await import('./pages.mjs')
    let error
    try { verifyIsland({ ...saved.transport, name: saved.component, key: saved.key, exactProps: saved.exactProps }, saved.buildId, saved.page) }
    catch (caught) { error = { message: caught.message, stack: caught.stack } }
    return { ok: !error, reproduced: !!error, type: saved.error.type, error, verification: await local() }
  }
  const result = await local()
  return { ...result, reproduced: !result.ok && result.type === saved.error.type, originalType: saved.error.type, originalBuildId: saved.buildId }
}
