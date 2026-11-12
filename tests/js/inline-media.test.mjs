// Every producer node shows playable media and a mesh thumbnail itself, without output.preview.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'
const I = (await loadPlugin())._internals
const walk = (el, fn) => {
  if (!el || typeof el !== 'object') return
  if (Array.isArray(el)) return el.forEach((child) => walk(child, fn))
  fn(el)
  walk(el.props?.children, fn)
}
const find = (tree, type) => {
  const found = []
  walk(tree, (el) => { if (el.type === type) found.push(el) })
  return found
}
const text = (el) => {
  if (el == null || el === false) return ''
  if (typeof el !== 'object') return String(el)
  return Array.isArray(el) ? el.map(text).join('') : text(el.props?.children)
}
const cached = (kind, payload) => {
  const key = `r_inline|n_inline|result|0|0`
  I.caches.media.set(key, { promise: Promise.resolve(payload), value: payload })
  try {
    return I.MiniMedia({ api: null, runId: 'r_inline', nodeId: 'n_inline', port: 'result',
      index: 0, kind, name: `sample.${kind === 'model3d' ? 'glb' : 'mp4'}` })
  } finally { I.caches.media.delete(key) }
}

test('every producer card uses MiniMedia for video, audio and meshes, not only Preview nodes', () => {
  const spec = { type: 'tool:producer', title: 'Producer', category: 'Tools', inputs: [],
    outputs: ['clip', 'mesh', 'sound'].map((name) => ({ name, type: 'any' })), params: [] }
  const node = { id: 'n_inline', type: spec.type, params: {}, x: 0, y: 0 }
  const media = (kind, file) => ({ $media: { kind, file, path: `C:/fixture/${file}` } })
  const tree = I.NodeCard({ node, spec, types: I.indexTypes({ types: [spec] }),
    layout: I.nodeLayout(node, spec, new Set(), false), api: null, runId: 'r_inline',
    state: { status: 'done', outputs: { clip: media('video', 'a.mp4'), mesh: media('model3d', 'a.glb'),
      sound: media('audio', 'a.wav') } }, connectedIn: new Set(), connectedOut: new Set(),
    onDown() {}, onPortDown() {}, onToggleExpand() {}, onOpenInspector() {}, nameOf: (id) => id })
  assert.deepEqual(find(tree, I.MiniMedia).map((el) => el.props.kind), ['video', 'model3d', 'audio'])
})

test('inline video has native controls and does not autoplay or bubble to the canvas/lightbox', () => {
  const tree = cached('video', { name: 'a.mp4', data_url: 'data:video/mp4;base64,AAAA' })
  const video = find(tree, 'video')[0]
  assert.ok(video)
  assert.equal(video.props.controls, true)
  assert.equal(video.props.preload, 'metadata')
  assert.notEqual(video.props.autoPlay, true)
  assert.equal(video.props.src, 'data:video/mp4;base64,AAAA')
  let stopped = 0
  for (const event of ['onPointerDown', 'onClick', 'onDoubleClick', 'onKeyDown', 'onWheel']) {
    tree.props[event]({ stopPropagation() { stopped++ } })
  }
  assert.equal(stopped, 5)
})

test('inline audio plays in its node; inline GLB delegates to the built-in thumbnail renderer', () => {
  assert.equal(find(cached('audio', { data_url: 'data:audio/wav;base64,AAAA' }), 'audio')[0].props.controls, true)
  const mesh = cached('model3d', { name: 'mesh.glb', data_url: 'data:model/gltf-binary;base64,AAAA' })
  assert.equal(find(mesh, I.ModelThumbnail).length, 1)
})

test('large, unsupported and failed media have readable fallbacks, never broken players', () => {
  const big = cached('video', { name: 'large.mp4', data_url: null })
  assert.match(text(big), /too large/i)
  assert.equal(find(big, 'video').length, 0)
  const other = cached('model3d', { name: 'mesh.fbx', data_url: 'data:application/octet-stream;base64,AAAA' })
  assert.match(text(other), /GLB/)
  const err = cached('video', { error: 'file not found' })
  assert.match(text(err), /file not found/)
})

test('mesh thumbnail queue serializes GPU work, deduplicates keys and recovers after failures', async () => {
  assert.equal(typeof I.createModelThumbnailCache, 'function')
  let busy = 0, max = 0, calls = 0
  const queue = I.createModelThumbnailCache(async (input) => {
    calls++; busy++; max = Math.max(max, busy)
    await new Promise((r) => setTimeout(r, 5))
    busy--
    if (input === 'bad') throw new Error('invalid GLB')
    return `data:image/png;base64,${input}`
  }, 2)
  const first = queue.get('a', 'one')
  assert.equal(queue.get('a', 'one'), first)
  const bad = queue.get('b', 'bad').catch((err) => err.message)
  const third = queue.get('c', 'three')
  assert.equal(await first, 'data:image/png;base64,one')
  assert.equal(await bad, 'invalid GLB')
  assert.equal(await third, 'data:image/png;base64,three')
  assert.equal(max, 1)
  assert.equal(calls, 3)
  assert.ok(queue.size() <= 2)
  queue.clear()
  assert.equal(queue.size(), 0)
})
