import test from 'node:test'
import assert from 'node:assert/strict'
import { upsertFragment, touchBuild } from '../src/admin.mjs'

// Seen live: a store set up by an older version lacked the ssr_build "themes" field,
// and prerender surfaced a raw Admin API error instead of saying how to upgrade.
const outdated = { metaobjectUpsert: { metaobject: null, userErrors: [{ field: ['metaobject', 'fields', '2'], message: 'Field definition "themes" does not exist', code: 'UNDEFINED_OBJECT_FIELD' }] } }

test('outdated definitions explain how to upgrade', async () => {
  const admin = async query => query.includes('metaobjectByHandle') ? { metaobjectByHandle: null } : outdated
  await assert.rejects(touchBuild(admin, 'b'.repeat(64), Date.now(), 123), /ssr_build definition on this store is missing or outdated.*setup --skip-app/s)
  await assert.rejects(upsertFragment(admin, { key: 'a'.repeat(32), name: 'Hero', html: '<p>x</p>', build: 'b'.repeat(64) }), /ssr_fragment definition on this store is missing or outdated.*setup --skip-app/s)
})

test('other upsert errors are reported unchanged', async () => {
  const admin = async () => ({ metaobjectUpsert: { metaobject: null, userErrors: [{ field: ['handle'], message: 'Handle is invalid', code: 'INVALID' }] } })
  await assert.rejects(upsertFragment(admin, { key: 'bad', name: 'Hero', html: '<p>x</p>', build: 'b'.repeat(64) }), /Handle is invalid/)
})
