// 3D preview (07.11.): a dependency-free .glb reader + orbit camera for the lightbox. The WebGL part needs a
// browser; these tests pin the file parsing, scene baking and camera fit, which decide what the viewer draws.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals

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

/** One triangle (positions + u16 indices), optionally moved by a node translation. */
function triangleGlb({ translation, withNormals = false, extra = {} } = {}) {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])
  const idx = new Uint16Array([0, 1, 2, 0])          // 4th value = padding to 8 bytes
  const bin = new Uint8Array(pos.byteLength + nrm.byteLength + idx.byteLength)
  bin.set(new Uint8Array(pos.buffer), 0)
  bin.set(new Uint8Array(nrm.buffer), 36)
  bin.set(new Uint8Array(idx.buffer), 72)
  const attributes = { POSITION: 0 }
  if (withNormals) attributes.NORMAL = 1
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, ...(translation ? { translation } : {}) }],
    meshes: [{ primitives: [{ attributes, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0.5, 0.25, 1] } }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 6 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' }],
    ...extra
  }
  return buildGlb(json, bin)
}

test('parseGlb reads the JSON and binary chunks and rejects other files', () => {
  const g = I.parseGlb(triangleGlb())
  assert.equal(g.json.asset.version, '2.0')
  assert.equal(g.bin.length, 80)
  assert.throws(() => I.parseGlb(new TextEncoder().encode('glTF but not really').buffer), /binary glTF/)
  assert.throws(() => I.parseGlb(new ArrayBuffer(8)), /binary glTF/)
})

test('compressed meshes are refused with a clear reason, not drawn wrong', () => {
  const buf = triangleGlb({ extra: { extensionsUsed: ['KHR_draco_mesh_compression'], extensionsRequired: ['KHR_draco_mesh_compression'] } })
  assert.throws(() => I.parseGlb(buf), /KHR_draco_mesh_compression/)
})

test('readAccessor honours offsets and byte strides', () => {
  // two interleaved VEC2 floats per vertex: stride 16, read the second pair
  const data = new Float32Array([1, 2, 10, 20, 3, 4, 30, 40])
  const gltf = {
    json: { bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 32, byteStride: 16 }],
      accessors: [{ bufferView: 0, byteOffset: 8, componentType: 5126, count: 2, type: 'VEC2' }] },
    bin: new Uint8Array(data.buffer)
  }
  assert.deepEqual(Array.from(I.readAccessor(gltf, 0).data), [10, 20, 30, 40])
})

test('the scene is baked to world space with node transforms, colour and normals', () => {
  const m = I.collectModel(I.parseGlb(triangleGlb({ translation: [5, 0, 0] })))
  assert.equal(m.primitives.length, 1)
  assert.equal(m.triangles, 1)
  const p = m.primitives[0]
  assert.deepEqual(Array.from(p.positions), [5, 0, 0, 6, 0, 0, 5, 1, 0])
  assert.deepEqual(Array.from(p.indices), [0, 1, 2])
  assert.deepEqual(p.color, [1, 0.5, 0.25, 1])
  // no NORMAL attribute in the file: computed from the face (+Z for this winding)
  assert.deepEqual(Array.from(p.normals).map((v) => Math.round(v)), [0, 0, 1, 0, 0, 1, 0, 0, 1])
  assert.deepEqual(m.bounds, { min: [5, 0, 0], max: [6, 1, 0] })
})

test('the orbit camera frames the whole model', () => {
  const cam = I.fitOrbit({ min: [-1, -1, -1], max: [1, 1, 1] })
  assert.deepEqual(cam.target, [0, 0, 0])
  assert.ok(cam.dist > Math.sqrt(3), 'camera sits outside the bounding sphere')
  const eye = I.orbitEye(cam)
  const d = Math.hypot(eye[0], eye[1], eye[2])
  assert.ok(Math.abs(d - cam.dist) < 1e-9)
})

test('the lightbox loads 3D models and opens as an 85 % window', () => {
  const src = readFileSync(new URL('../../desktop/plugin.js', import.meta.url), 'utf8')
  assert.match(src, /kind === 'model3d'[^\n]*\n\s*body = h\(Model3DView/)
  assert.match(src, /\.fc-lb-panel\s*\{[^}]*width:\s*85vw;[^}]*height:\s*85vh/)
})

test('UI-9: ImageBitmap is closed after texImage2D on success, on dead renderer, and on texImage2D error', async () => {
  assert.equal(typeof I.uploadModelTexture, 'function', 'uploadModelTexture is exported in _internals')
  const makeBmp = () => ({ closed: 0, close() { this.closed++ } })
  const makeGl = ({ failTex = false } = {}) => {
    const deleted = []
    return {
      TEXTURE_2D: 0x0de1, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
      TEXTURE_WRAP_S: 1, TEXTURE_WRAP_T: 2, TEXTURE_MIN_FILTER: 3, TEXTURE_MAG_FILTER: 4,
      CLAMP_TO_EDGE: 5, LINEAR: 6,
      deleted,
      createTexture: () => ({ id: 'tex1' }),
      bindTexture() {},
      texImage2D() { if (failTex) throw new Error('GPU out of memory') },
      texParameteri() {},
      deleteTexture(t) { deleted.push(t) }
    }
  }

  // 1. Success path: texture is uploaded and ImageBitmap is closed immediately after texImage2D
  const bmpOk = makeBmp()
  const glOk = makeGl()
  const tex = I.uploadModelTexture(glOk, bmpOk, false)
  assert.deepEqual(tex, { id: 'tex1' })
  assert.equal(bmpOk.closed, 1, 'ImageBitmap.close() must run after a successful texImage2D')

  // 2. Dead renderer path: renderer was destroyed while createImageBitmap was in flight
  const bmpDead = makeBmp()
  const glDead = makeGl()
  const texDead = I.uploadModelTexture(glDead, bmpDead, true)
  assert.equal(texDead, null)
  assert.equal(bmpDead.closed, 1, 'ImageBitmap.close() must run when the renderer is already dead')

  // 3. Error path: texImage2D throws -> treated like a missing texture (null), texture deleted, ImageBitmap closed
  const bmpErr = makeBmp()
  const glErr = makeGl({ failTex: true })
  assert.equal(I.uploadModelTexture(glErr, bmpErr, false), null)
  assert.equal(bmpErr.closed, 1, 'ImageBitmap.close() must run when texImage2D throws')
  assert.deepEqual(glErr.deleted, [{ id: 'tex1' }], 'partially created texture is deleted on error')
})

test('createModelRenderer texture chain handles success and texImage2D error without unhandled rejection', async () => {
  const makeFakeCanvas = ({ failModelTex = false } = {}) => {
    let nextTex = 0
    const bound = []
    const hasTexCalls = []
    const deleted = []
    const gl = {
      VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
      ARRAY_BUFFER: 5, ELEMENT_ARRAY_BUFFER: 6, STATIC_DRAW: 7,
      TEXTURE_2D: 8, RGBA: 9, UNSIGNED_BYTE: 10,
      TEXTURE_WRAP_S: 11, TEXTURE_WRAP_T: 12, TEXTURE_MIN_FILTER: 13, TEXTURE_MAG_FILTER: 14,
      CLAMP_TO_EDGE: 15, LINEAR: 16,
      COLOR_BUFFER_BIT: 17, DEPTH_BUFFER_BIT: 18, DEPTH_TEST: 19, CULL_FACE: 20, BLEND: 21,
      SRC_ALPHA: 22, ONE_MINUS_SRC_ALPHA: 23, TEXTURE0: 24, FLOAT: 25, TRIANGLES: 26, UNSIGNED_SHORT: 27,
      bound, hasTexCalls, deleted,
      getExtension: (ext) => (ext === 'WEBGL_lose_context' ? { loseContext() {} } : {}),
      createShader: () => ({}),
      shaderSource() {},
      compileShader() {},
      getShaderParameter: () => true,
      createProgram: () => ({}),
      attachShader() {},
      linkProgram() {},
      getProgramParameter: () => true,
      getAttribLocation: (_p, name) => (name === 'aUv' ? 2 : 0),
      getUniformLocation: (_p, name) => name,
      createBuffer: () => ({}),
      bindBuffer() {},
      bufferData() {},
      createTexture: () => ({ id: `tex_${++nextTex}` }),
      bindTexture(_target, t) { bound.push(t) },
      texImage2D(...args) {
        // 6-arg overload is the ImageBitmap upload; 9-arg overload is the 1x1 blank fallback texture
        if (args.length === 6 && failModelTex) throw new Error('texImage2D failed')
      },
      texParameteri() {},
      deleteTexture(t) { deleted.push(t) },
      deleteBuffer() {},
      deleteProgram() {},
      viewport() {},
      clearColor() {},
      clear() {},
      enable() {},
      disable() {},
      blendFunc() {},
      useProgram() {},
      uniformMatrix4fv() {},
      uniform3fv() {},
      uniform1i() {},
      uniform1f(loc, v) { if (loc === 'uHasTex') hasTexCalls.push(v) },
      uniform4fv() {},
      activeTexture() {},
      enableVertexAttribArray() {},
      disableVertexAttribArray() {},
      vertexAttribPointer() {},
      vertexAttrib2f() {},
      drawElements() {}
    }
    return { width: 100, height: 100, gl, getContext: (kind) => (kind === 'webgl2' ? gl : null) }
  }

  const makeModel = () => ({
    primitives: [{
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      indices: new Uint16Array([0, 1, 2]),
      color: [1, 1, 1, 1],
      image: { bytes: new Uint8Array([1, 2, 3, 4]), mime: 'image/png' }
    }],
    bounds: { min: [0, 0, 0], max: [1, 1, 0] },
    triangles: 1
  })
  const cam = I.fitOrbit({ min: [0, 0, 0], max: [1, 1, 0] })
  const prevCreate = globalThis.createImageBitmap
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    // 1. Success path: texture uploads, ImageBitmap closes, model draws with texture (uHasTex = 1)
    const bmpOk = { closed: 0, close() { this.closed++ } }
    // Use a minimal thenable WITHOUT .catch on the returned object from .then if uploadModelTexture throws,
    // plus native Promise resolution, to verify uploadModelTexture itself catches errors cleanly.
    globalThis.createImageBitmap = () => ({
      then(onFulfilled) {
        return Promise.resolve(bmpOk).then(onFulfilled)
      }
    })
    const canvasOk = makeFakeCanvas({ failModelTex: false })
    let changesOk = 0
    const rendererOk = I.createModelRenderer(canvasOk, makeModel(), () => { changesOk++ })
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(bmpOk.closed, 1, 'ImageBitmap closed on success')
    assert.equal(changesOk, 1, 'onChange called when texture finishes uploading')
    rendererOk.draw(cam)
    assert.deepEqual(canvasOk.gl.hasTexCalls, [1], 'draws with uploaded texture')
    rendererOk.destroy()

    // 2. Failure path: texImage2D throws -> treated like missing texture, ImageBitmap closed, model still draws (uHasTex = 0)
    const bmpFail = { closed: 0, close() { this.closed++ } }
    globalThis.createImageBitmap = () => ({
      then(onFulfilled) {
        Promise.resolve(bmpFail).then(onFulfilled)
        return { catch() {} }
      }
    })
    const canvasFail = makeFakeCanvas({ failModelTex: true })
    let changesFail = 0
    const rendererFail = I.createModelRenderer(canvasFail, makeModel(), () => { changesFail++ })
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(bmpFail.closed, 1, 'ImageBitmap closed on texImage2D failure')
    assert.equal(changesFail, 0, 'onChange not called when texture upload fails')
    assert.deepEqual(canvasFail.gl.deleted, [{ id: 'tex_2' }], 'failed model texture is deleted')
    rendererFail.draw(cam)
    assert.deepEqual(canvasFail.gl.hasTexCalls, [0], 'model remains usable and draws with fallback blank texture')
    assert.deepEqual(unhandled, [], 'no unhandled promise rejection')
    rendererFail.destroy()
  } finally {
    process.off('unhandledRejection', onUnhandled)
    if (prevCreate === undefined) delete globalThis.createImageBitmap
    else globalThis.createImageBitmap = prevCreate
  }
})
