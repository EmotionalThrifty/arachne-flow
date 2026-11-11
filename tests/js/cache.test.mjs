// Review E-8: the inspector's "Use cache" switch follows the node type's default and can override it both ways.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals
const writer = { type: 'tool:write_note', cache_default: false }
const reader = { type: 'tool:web_search', cache_default: true }
const llm = { type: 'llm.complete' }

test('cacheOn: the switch shows the type default until the user picks', () => {
  assert.equal(I.cacheOn({}, writer), false)
  assert.equal(I.cacheOn({}, reader), true)
  assert.equal(I.cacheOn({}, llm), true)
  assert.equal(I.cacheOn({ cache: true }, writer), true)
  assert.equal(I.cacheOn({ cache: false }, reader), false)
  assert.equal(I.cacheOn({ cache: true }, { cacheable: false }), false)
})

test('cachePatch: choosing the default clears the override, anything else stores it', () => {
  assert.deepEqual(I.cachePatch(true, writer), { cache: true })
  assert.deepEqual(I.cachePatch(false, writer), { cache: null })
  assert.deepEqual(I.cachePatch(false, reader), { cache: false })
  assert.deepEqual(I.cachePatch(true, reader), { cache: null })
})
