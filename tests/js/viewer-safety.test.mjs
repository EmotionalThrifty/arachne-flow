// UI-2/3/4: hostile 3D files must fail closed. These regressions pin that accessor counts are bounded
// before any TypedArray exists, a broken texture view only drops the texture, and non-finite geometry
// never reaches the orbit camera or WebGL. The fixtures are real (small) .glb binaries.
import { test } from 'node:test'
import assert from 'node:assert/strict'

// The plugin captures its accessor constructors when it is imported, so a guarded Float32Array has to be
// in place first. Only allocations above 1 MiB are recorded and refused; everything else is the real class.
const REAL_FLOAT32 = globalThis.Float32Array
const ALLOCATION_LIMIT = 1024 * 1024
const allocations = []
class BlockedAllocation extends Error {}

globalThis.Float32Array = new Proxy(REAL_FLOAT32, {
  construct(target, args, newTarget) {
    const length = typeof args[0] === 'number' ? args[0] : args[0] instanceof ArrayBuffer ? args[2] : 0
    const bytes = typeof length === 'number' ? Math.abs(length) * REAL_FLOAT32.BYTES_PER_ELEMENT : 0
    if (bytes > ALLOCATION_LIMIT) {
      allocations.push({ bytes, length })
      throw new BlockedAllocation(`refused a ${bytes}-byte Float32Array allocation`)
    }
    return Reflect.construct(target, args, newTarget)
  }
})
let I
try {
  const { loadPlugin } = await import('./load.mjs')
  I = (await loadPlugin())._internals
} finally {
  globalThis.Float32Array = REAL_FLOAT32
}

/** A .glb from a glTF JSON object and binary chunk bytes (both padded to 4 bytes as the spec requires). */
function buildGlb(json, bin = new Uint8Array(0)) {
  let text = new TextEncoder().encode(JSON.stringify(json))
  const pad = (b, fill) => {
    const out = new Uint8Array(Math.ceil(b.length / 4) * 4).fill(fill)
    out.set(b)
    return out
  }
  text = pad(text, 0x20)
  const body = pad(bin, 0)
  const total = 12 + 8 + text.length + (body.length ? 8 + body.length : 0)
  const buf = new ArrayBuffer(total)
  const dv = new DataView(buf)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, text.length, true)
  dv.setUint32(16, 0x4e4f534a, true)
  new Uint8Array(buf, 20, text.length).set(text)
  if (body.length) {
    dv.setUint32(20 + text.length, body.length, true)
    dv.setUint32(24 + text.length, 0x004e4942, true)
    new Uint8Array(buf, 28 + text.length, body.length).set(body)
  }
  return buf
}

/** One indexed triangle (POSITION plus optional NORMAL/TEXCOORD_0), optionally with a colour texture view. */
function modelGlb({ positions = [0, 0, 0, 1, 0, 0, 0, 1, 0], normals = null, uvs = null, indices = [0, 1, 2], node = {}, image = null } = {}) {
  const pos = new Float32Array(positions)
  const nrm = normals && new Float32Array(normals)
  const uv = uvs && new Float32Array(uvs)
  const idx = new Uint16Array(indices)
  const chunks = []
  let byteLength = 0
  const view = (bytes) => {
    const byteOffset = Math.ceil(byteLength / 4) * 4
    if (byteOffset > byteLength) chunks.push(new Uint8Array(byteOffset - byteLength))
    chunks.push(bytes)
    byteLength = byteOffset + bytes.length
    return { buffer: 0, byteOffset, byteLength: bytes.length }
  }
  const views = [view(new Uint8Array(pos.buffer))]
  const accessors = [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3' }]
  const attributes = { POSITION: 0 }
  if (nrm) {
    views.push(view(new Uint8Array(nrm.buffer)))
    accessors.push({ bufferView: views.length - 1, componentType: 5126, count: nrm.length / 3, type: 'VEC3' })
    attributes.NORMAL = views.length - 1
  }
  if (uv) {
    views.push(view(new Uint8Array(uv.buffer)))
    accessors.push({ bufferView: views.length - 1, componentType: 5126, count: uv.length / 2, type: 'VEC2' })
    attributes.TEXCOORD_0 = views.length - 1
  }
  views.push(view(new Uint8Array(idx.buffer)))
  accessors.push({ bufferView: views.length - 1, componentType: 5123, count: idx.length, type: 'SCALAR' })
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, ...node }],
    meshes: [{ primitives: [{ attributes, indices: views.length - 1 }] }],
    buffers: [{ byteLength }],
    bufferViews: views,
    accessors
  }
  if (image) {
    json.bufferViews.push({ buffer: image.buffer ?? 0, byteOffset: image.byteOffset ?? 0, byteLength: image.byteLength })
    json.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }]
    json.textures = [{ source: 0 }]
    json.images = [{ bufferView: json.bufferViews.length - 1, mimeType: 'image/png' }]
    json.meshes[0].primitives[0].material = 0
  }
  const bin = new Uint8Array(byteLength)
  let at = 0
  for (const chunk of chunks) {
    bin.set(chunk, at)
    at += chunk.length
  }
  return buildGlb(json, bin)
}

/** Message of the error from fn, or ACCEPTED when it does not throw. */
function outcome(fn) {
  try {
    fn()
    return 'ACCEPTED'
  } catch (err) {
    return (err && err.message) || String(err)
  }
}

test('UI-2: a huge accessor count is refused before any TypedArray allocation', () => {
  assert.deepEqual(allocations, [])
  const buf = buildGlb({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: 48 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 0, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4_000_000, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }]
  }, new Uint8Array(48))
  assert.throws(() => I.readAccessor(I.parseGlb(buf), 0), (err) => {
    assert.ok(!(err instanceof BlockedAllocation), `must reject before the allocation: ${(err && err.message) || err}`)
    assert.match((err && err.message) || String(err), /limit|too (large|many)|exceed|bounds|past the buffer|count/i)
    return true
  })
  assert.deepEqual(allocations, [], 'a malformed accessor count must not materialise a giant allocation')
})

test('UI-2: an accessor may not read past its bufferView even when the whole BIN is larger', () => {
  const buf = buildGlb({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: 96 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 24 }, { buffer: 0, byteOffset: 24, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }]
  }, new Uint8Array(96))
  assert.throws(() => I.readAccessor(I.parseGlb(buf), 0),
    /bufferView|view|byteLength|past the buffer|bounds|count/i)
})

test('UI-2: negative or fractional counts, offsets and strides are rejected as invalid accessors', () => {
  const gltf = {
    json: { bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 64 }], accessors: [] },
    bin: new Uint8Array(64)
  }
  // a negative accessor offset that still lands inside the GLB ArrayBuffer would read the header/JSON bytes
  const parsed = I.parseGlb(modelGlb())
  const negativeOffset = parsed.json.accessors.length
  parsed.json.accessors.push({ bufferView: 0, byteOffset: -parsed.bin.byteOffset, componentType: 5126, count: 1, type: 'VEC3' })
  const cases = [
    ['negative count', gltf, { bufferView: 0, componentType: 5126, count: -1, type: 'VEC3' }, /count|integer|negative/i],
    ['fractional count', gltf, { bufferView: 0, componentType: 5126, count: 2.5, type: 'VEC3' }, /count|integer/i],
    ['fractional offset', gltf, { bufferView: 0, byteOffset: 2.5, componentType: 5126, count: 2, type: 'VEC3' }, /offset|integer|align/i],
    ['fractional stride', { json: { bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 64, byteStride: 7.5 }], accessors: [] }, bin: new Uint8Array(64) },
      { bufferView: 0, componentType: 5126, count: 2, type: 'VEC3' }, /stride|integer/i],
    ['negative stride', { json: { bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 64, byteStride: -16 }], accessors: [] }, bin: new Uint8Array(64) },
      { bufferView: 0, componentType: 5126, count: 2, type: 'VEC3' }, /stride|integer/i],
    ['negative offset', parsed, negativeOffset, /offset|bounds|buffer|outside/i]
  ]
  const bad = cases.map(([name, g, accessor, expected]) => {
    if (typeof accessor === 'number') return [name, outcome(() => I.readAccessor(g, accessor)), expected]
    g.json.accessors = [accessor]
    return [name, outcome(() => I.readAccessor(g, 0)), expected]
  }).filter(([, message, expected]) => !expected.test(message))
    .map(([name, message]) => `${name}: ${message}`)
  assert.deepEqual(bad, [])
})

test('UI-2: a valid strided accessor still reads the requested interleaved values', () => {
  const data = new Float32Array([1, 2, 10, 20, 3, 4, 30, 40])
  const gltf = {
    json: { bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 32, byteStride: 16 }],
      accessors: [{ bufferView: 0, byteOffset: 8, componentType: 5126, count: 2, type: 'VEC2' }] },
    bin: new Uint8Array(data.buffer)
  }
  const acc = I.readAccessor(gltf, 0)
  assert.ok(acc.data instanceof REAL_FLOAT32)
  assert.deepEqual(Array.from(acc.data), [10, 20, 30, 40])
})

test('UI-3: a texture view past the BIN drops the texture but keeps the triangle', () => {
  const buf = modelGlb({ uvs: [0, 0, 1, 0, 0, 1], image: { byteLength: 4000 } })
  let result
  try {
    const model = I.collectModel(I.parseGlb(buf))
    result = { triangles: model.triangles, primitives: model.primitives.length, image: model.primitives[0].image === null ? null : 'bytes' }
  } catch (err) {
    result = { error: (err && err.message) || String(err) }
  }
  assert.deepEqual(result, { triangles: 1, primitives: 1, image: null })
})

test('UI-3: an external or negative texture view is skipped, never read from another buffer', () => {
  const render = (image) => {
    try {
      const model = I.collectModel(I.parseGlb(modelGlb({ uvs: [0, 0, 1, 0, 0, 1], image })))
      return { triangles: model.triangles, image: model.primitives[0].image === null ? null : 'bytes' }
    } catch (err) {
      return { error: (err && err.message) || String(err) }
    }
  }
  assert.deepEqual([render({ buffer: 1, byteLength: 6 }), render({ byteOffset: -1000, byteLength: 6 })],
    [{ triangles: 1, image: null }, { triangles: 1, image: null }])
})

test('UI-4: one NaN vertex rejects the geometry instead of baking NaN bounds', () => {
  const message = outcome(() => I.collectModel(I.parseGlb(modelGlb({ positions: [0, 0, 0, NaN, 0, 0, 0, 1, 0] }))))
  assert.match(message, /finite|invalid|geometry|vertex|position|NaN/i)
})

test('UI-4: all-NaN positions and infinite normals are rejected as non-finite geometry', () => {
  const messages = [
    outcome(() => I.collectModel(I.parseGlb(modelGlb({ positions: [NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN] })))),
    outcome(() => I.collectModel(I.parseGlb(modelGlb({ normals: [0, 0, Infinity, 0, 0, 1, 0, 0, 1] }))))
  ]
  assert.ok(messages.every((m) => /finite|invalid|geometry|vertex|normal/i.test(m)), JSON.stringify(messages))
})

test('UI-4: a finite transform that bakes to non-finite vertices is rejected', () => {
  // 1e308 is valid JSON, but the bake overflows to Infinity for the (1,1,0) vertex
  const huge = 1e308
  const matrix = [huge, 0, 0, 0, huge, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const message = outcome(() => I.collectModel(I.parseGlb(modelGlb({
    positions: [0, 0, 0, 1, 1, 0, 0, 1, 0], node: { matrix }
  }))))
  assert.match(message, /finite|invalid|geometry|vertex|transform/i)
})

test('UI-4: non-finite bounds never reach the camera, and valid geometry still fits', () => {
  const safe = (bounds) => {
    let cam
    try {
      cam = I.fitOrbit(bounds)
    } catch (err) {
      assert.match((err && err.message) || String(err), /finite|bounds|invalid|number/i)
      return
    }
    const values = [...cam.target, cam.radius, cam.dist, cam.yaw, cam.pitch]
    assert.ok(values.every(Number.isFinite), `camera values must stay finite: ${JSON.stringify(values)}`)
  }
  safe({ min: [NaN, 0, 0], max: [1, 1, 1] })
  safe({ min: [0, 0, 0], max: [Infinity, 1, 1] })
  safe({ min: [-Infinity, -Infinity, -Infinity], max: [Infinity, Infinity, Infinity] })

  const model = I.collectModel(I.parseGlb(modelGlb({ normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] })))
  assert.equal(model.triangles, 1)
  assert.ok(model.primitives[0].normals.every(Number.isFinite))
  assert.ok([...model.bounds.min, ...model.bounds.max].every(Number.isFinite))
  const cam = I.fitOrbit(model.bounds)
  assert.ok([...cam.target, cam.radius, cam.dist].every(Number.isFinite))
})
