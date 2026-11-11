import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

test('plugin module loads and exposes id + internals', async () => {
  const plugin = await loadPlugin()
  assert.equal(plugin.id, 'flowcanvas')
  assert.equal(typeof plugin.register, 'function')
  assert.equal(typeof plugin._internals, 'object')
})
