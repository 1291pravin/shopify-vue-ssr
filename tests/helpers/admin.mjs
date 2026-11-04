import { operations } from '../../src/admin.mjs'
export const fragmentDefinition = { id: 'fragment-definition', access: { storefront: 'PUBLIC_READ' }, fieldDefinitions: [
  { key: 'html', type: { name: 'multi_line_text_field' }, validations: [] },
  { key: 'component', type: { name: 'single_line_text_field' }, validations: [] },
  { key: 'build', type: { name: 'single_line_text_field' }, validations: [] },
], capabilities: { publishable: { enabled: false } } }
export const buildDefinition = { id: 'build-definition', access: { storefront: 'NONE' }, fieldDefinitions: ['first_seen', 'last_seen'].map(key => ({ key, type: { name: 'date_time' }, validations: [] })), capabilities: { publishable: { enabled: false } } }
export function withHistory(fragmentAdmin) {
  return async (query, vars, mutation) => {
    if (query === operations.build) return { metaobjectByHandle: null }
    if (query === operations.upsertBuild) return { metaobjectUpsert: { metaobject: { id: 'history' }, userErrors: [] } }
    return fragmentAdmin(query, vars, mutation)
  }
}
export function definitions(query) {
  return { metaobjectDefinitionByType: query === operations.buildDefinition ? buildDefinition : fragmentDefinition }
}
