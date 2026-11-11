// G8 media inputs — RED tests for multi-wire connect and media list parameters.
// Contract: a port spec with `multiple: true` collects several wires (edge order), single ports
// still replace; mediaValues() normalises a scalar/array/JSON list to string[]; addMediaPath()
// appends without duplicates and caps at maxItems (a non-multiple field stays a string).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals

const TYPES = I.indexTypes({
  types: [
    { type: 'input.file', title: 'File', inputs: [], outputs: [{ name: 'file', type: 'any' }], params: [] },
    { type: 'tool:multi', kind: 'tool', title: 'Multi',
      inputs: [{ name: 'images', type: 'image', multiple: true, min: 1, max: 4 },
        { name: 'imageUrl', type: 'image' }],
      outputs: [{ name: 'media', type: 'any' }], params: [] }
  ],
  compat: { any: ['any', 'image'], image: ['image', 'any'], text: ['text', 'any'] }
})

const flow0 = () => ({
  id: 'f', name: 'F', nodes: [
    { id: 'a', type: 'input.file', x: 0, y: 0, params: {} },
    { id: 'b', type: 'input.file', x: 0, y: 100, params: {} },
    { id: 'm', type: 'tool:multi', x: 300, y: 0, params: {} }
  ], edges: []
})

test('connect appends wires into a multiple input and replaces on a single input (G8)', () => {
  let f = flow0()
  f = I.connect(f, { node: 'a', port: 'file' }, { node: 'm', port: 'images' }, TYPES)
  f = I.connect(f, { node: 'b', port: 'file' }, { node: 'm', port: 'images' }, TYPES)
  const many = f.edges.filter((e) => e.to.node === 'm' && e.to.port === 'images')
  assert.equal(many.length, 2, 'both wires survive on a multiple input')
  assert.deepEqual(many.map((e) => e.from.node), ['a', 'b'])

  f = I.connect(f, { node: 'a', port: 'file' }, { node: 'm', port: 'imageUrl' }, TYPES)
  f = I.connect(f, { node: 'b', port: 'file' }, { node: 'm', port: 'imageUrl' }, TYPES)
  const single = f.edges.filter((e) => e.to.node === 'm' && e.to.port === 'imageUrl')
  assert.equal(single.length, 1, 'a single input still replaces its wire')
  assert.equal(single[0].from.node, 'b')

  // Without type information the old one-wire-per-input behaviour is kept.
  let g = flow0()
  g = I.connect(g, { node: 'a', port: 'file' }, { node: 'm', port: 'images' })
  g = I.connect(g, { node: 'b', port: 'file' }, { node: 'm', port: 'images' })
  assert.equal(g.edges.length, 1)
})

test('mediaValues normalises scalars, arrays and JSON lists (G8)', () => {
  assert.deepEqual(I.mediaValues(null), [])
  assert.deepEqual(I.mediaValues(undefined), [])
  assert.deepEqual(I.mediaValues('  C:/pics/a.png '), ['C:/pics/a.png'])
  assert.deepEqual(I.mediaValues([' a.png ', '', 'b.png', null]), ['a.png', 'b.png'])
  assert.deepEqual(I.mediaValues('["a.png", " b.png "]'), ['a.png', 'b.png'])
})

test('addMediaPath appends without duplicates and caps at maxItems (G8)', () => {
  assert.equal(I.addMediaPath('', 'a.png', { multiple: false }), 'a.png')
  assert.equal(I.addMediaPath('a.png', 'b.png', {}), 'b.png', 'a single field replaces its value')
  assert.deepEqual(I.addMediaPath('', 'a.png', { multiple: true }), ['a.png'])
  assert.deepEqual(I.addMediaPath(['a.png'], 'b.png', { multiple: true, maxItems: 4 }), ['a.png', 'b.png'])
  assert.deepEqual(I.addMediaPath(['a.png', 'b.png'], 'a.png', { multiple: true, maxItems: 4 }), ['a.png', 'b.png'])
  assert.deepEqual(I.addMediaPath(['a.png', 'b.png'], 'c.png', { multiple: true, maxItems: 2 }), ['a.png', 'b.png'],
    'maxItems caps the list')
  assert.deepEqual(I.addMediaPath('a.png', 'b.png', { multiple: true, maxItems: 2 }), ['a.png', 'b.png'])
})
