// Live 07.11.: the Images field of Image to 3D said "0 / 4 files" for MoGe 2, which takes one image, and the
// three extra side views were paid for nothing. The field follows the chosen model's limit and says so.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals
const field = { name: 'image', kind: 'media_list', max_items: 4 }

test('a one-image model caps the list and explains it', () => {
  const r = I.fitImageLimit(field, 1, 'MoGe 2', 4)
  assert.equal(r.field.max_items, 1)
  assert.match(r.note.text, /MoGe 2 takes 1 image/)
  assert.match(r.note.text, /4/)
  assert.equal(r.note.bad, true, 'more images than the model takes is a warning')
})

test('within the limit there is no warning, only the cap', () => {
  const r = I.fitImageLimit(field, 1, 'MoGe 2', 1)
  assert.equal(r.field.max_items, 1)
  assert.equal(r.note.bad, false)
})

test('a model that takes as many as the tool keeps the field as is', () => {
  assert.deepEqual(I.fitImageLimit(field, 4, 'Meshy', 4), { field, note: null })
  assert.deepEqual(I.fitImageLimit(field, null, '', 3), { field, note: null })
  const other = { name: 'prompt', kind: 'text' }
  assert.deepEqual(I.fitImageLimit(other, 1, 'MoGe 2', 0), { field: other, note: null })
})

test('a wired Collect list counts as its items from the last run', () => {
  const edge = { from: { node: 'n_c', port: 'list' }, to: { node: 'n_3d', port: 'image' } }
  assert.equal(I.wiredItemCount({ nodes: { n_c: { outputs: { list: [1, 2, 3, 4] } } } }, edge), 4)
  assert.equal(I.wiredItemCount(null, edge), 1)
})
