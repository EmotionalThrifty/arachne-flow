// ---------------------------------------------------------------- lightbox (G1)
const LIGHTBOX_PX = 2048
const mediaKey = (runId, nodeId, port, index, thumb) => `${runId}|${nodeId}|${port}|${index}|${thumb}`

/** PNG blob of an image data URL (clipboard images must be PNG). */
async function dataUrlToPng(dataUrl) {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  canvas.getContext('2d').drawImage(img, 0, 0)
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png'))
}

// ---------------------------------------------------------------- 3D viewer (.glb, no dependencies)
// The app ships no 3D library, so the lightbox reads binary glTF itself: meshes are baked to world space once,
// then drawn with one small WebGL shader (base colour × texture, head light). Compressed meshes (Draco, meshopt)
// are refused with a clear message instead of being drawn wrong.
const GLB_MAGIC = 0x46546c67
const GLB_JSON = 0x4e4f534a
const GLB_BIN = 0x004e4942
const GLTF_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }
const GLTF_ARRAYS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }
const GLTF_GETTERS = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }
const GLTF_NORM_MAX = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }
const GLTF_HARMLESS_EXT = new Set(['KHR_materials_unlit', 'KHR_texture_transform', 'KHR_materials_emissive_strength'])
const MODEL_MAX_NODES = 5000
const MODEL_MAX_VERTICES = 1000000
const MODEL_MAX_TRIANGLES = 1000000
const MODEL_MAX_ACCESSOR_BYTES = 32 * 1024 * 1024

function parseGlb(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 20) throw new Error('not a binary glTF (.glb) file')
  const dv = new DataView(buffer)
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a binary glTF (.glb) file')
  const version = dv.getUint32(4, true)
  if (version !== 2) throw new Error(`glTF version ${version} is not supported`)
  const total = Math.min(dv.getUint32(8, true), buffer.byteLength)
  let off = 12
  let json = null
  let bin = null
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true)
    const type = dv.getUint32(off + 4, true)
    const start = off + 8
    if (start + len > total) throw new Error('the .glb file is truncated')
    if (type === GLB_JSON) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, len)))
    else if (type === GLB_BIN && !bin) bin = new Uint8Array(buffer, start, len)
    off = start + len
  }
  if (!json) throw new Error('the .glb file has no JSON chunk')
  const unsupported = (json.extensionsRequired || []).filter((x) => !GLTF_HARMLESS_EXT.has(x))
  if (unsupported.length) throw new Error(`needs ${unsupported.join(', ')} (compressed meshes are not supported here)`)
  return { json, bin }
}

function readAccessor(gltf, index) {
  const { json, bin } = gltf
  const acc = (json.accessors || [])[index]
  if (!acc) throw new Error(`missing accessor ${index}`)
  const Arr = GLTF_ARRAYS[acc.componentType]
  const comps = GLTF_COMPONENTS[acc.type]
  if (!Arr || !comps) throw new Error('unsupported accessor type')
  if (acc.sparse) throw new Error('sparse accessors are not supported')
  const elem = Arr.BYTES_PER_ELEMENT
  const countLimit = comps === 1 ? MODEL_MAX_TRIANGLES * 3 : MODEL_MAX_VERTICES
  if (!Number.isSafeInteger(acc.count) || acc.count < 0 || acc.count > countLimit) throw new Error('invalid accessor count or preview limit exceeded')
  const length = acc.count * comps
  if (length * elem > MODEL_MAX_ACCESSOR_BYTES) throw new Error('accessor exceeds the preview byte limit')
  const offset = acc.byteOffset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % elem !== 0) throw new Error('invalid accessor byte offset')
  let base = 0
  let stride = comps * elem
  if (acc.bufferView !== undefined) {
    const view = Number.isSafeInteger(acc.bufferView) && (json.bufferViews || [])[acc.bufferView]
    if (!view || !bin || (view.buffer ?? 0) !== 0) throw new Error('external buffers are not supported (.glb only)')
    const start = view.byteOffset ?? 0
    stride = view.byteStride ?? comps * elem
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(view.byteLength) || view.byteLength < 0 || start + view.byteLength > bin.byteLength) throw new Error('invalid bufferView bounds')
    if (!Number.isSafeInteger(stride) || stride < comps * elem || stride % elem !== 0) throw new Error('invalid accessor stride')
    const end = offset + (acc.count ? (acc.count - 1) * stride + comps * elem : 0)
    if (!Number.isSafeInteger(end) || end > view.byteLength) throw new Error('accessor reads past its bufferView')
    base = bin.byteOffset + start + offset
    if (base % elem !== 0) throw new Error('invalid accessor offset alignment')
  } else if (offset) throw new Error('accessor offset needs a bufferView')
  // Allocate only after counts, strides and the declared view's own bounds have been checked.
  const out = new Arr(length)
  if (acc.bufferView !== undefined && acc.count) {
    if (stride === comps * elem) out.set(new Arr(bin.buffer, base, length))
    else {
      const dv = new DataView(bin.buffer)
      const get = GLTF_GETTERS[acc.componentType]
      for (let i = 0; i < acc.count; i += 1) {
        for (let c = 0; c < comps; c += 1) out[i * comps + c] = dv[get](base + i * stride + c * elem, true)
      }
    }
  }
  return { data: out, comps, componentType: acc.componentType, normalized: !!acc.normalized }
}

function accessorFloats(acc) {
  if (acc.data instanceof Float32Array) return acc.data
  const max = acc.normalized ? GLTF_NORM_MAX[acc.componentType] || 1 : 1
  const out = new Float32Array(acc.data.length)
  for (let i = 0; i < out.length; i += 1) out[i] = acc.normalized ? Math.max(acc.data[i] / max, -1) : acc.data[i]
  return out
}

// column-major 4×4 matrices, as glTF stores them
const mat4Identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
function mat4Multiply(a, b) {
  const o = new Array(16)
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    }
  }
  return o
}
function mat4FromNode(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice()
  const [tx, ty, tz] = node.translation || [0, 0, 0]
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1]
  const [sx, sy, sz] = node.scale || [1, 1, 1]
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1]
}
/** Normal matrix (inverse transpose of the upper 3×3), row-major 3×3. */
function normalMatrix(m) {
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], hh = m[6], i = m[10]
  const A = e * i - f * hh, B = -(d * i - f * g), C = d * hh - e * g
  const det = a * A + b * B + c * C || 1
  return [A / det, B / det, C / det,
    -(b * i - c * hh) / det, (a * i - c * g) / det, -(a * hh - b * g) / det,
    (b * f - c * e) / det, -(a * f - c * d) / det, (a * e - b * d) / det]
}

function computeNormals(positions, indices) {
  const n = new Float32Array(positions.length)
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const [i0, i1, i2] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3]
    const ux = positions[i1] - positions[i0], uy = positions[i1 + 1] - positions[i0 + 1], uz = positions[i1 + 2] - positions[i0 + 2]
    const vx = positions[i2] - positions[i0], vy = positions[i2 + 1] - positions[i0 + 1], vz = positions[i2 + 2] - positions[i0 + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    for (const i of [i0, i1, i2]) {
      n[i] += nx
      n[i + 1] += ny
      n[i + 2] += nz
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1
    n[i] /= l
    n[i + 1] /= l
    n[i + 2] /= l
  }
  return n
}

function materialImage(gltf, material) {
  const tex = material && material.pbrMetallicRoughness && material.pbrMetallicRoughness.baseColorTexture
  if (!tex) return null
  const texture = (gltf.json.textures || [])[tex.index]
  const image = texture && (gltf.json.images || [])[texture.source]
  if (!image || image.bufferView === undefined || !gltf.bin) return null
  const view = (gltf.json.bufferViews || [])[image.bufferView]
  if (!view || (view.buffer ?? 0) !== 0) return null
  const offset = view.byteOffset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(view.byteLength) || view.byteLength <= 0 || offset + view.byteLength > gltf.bin.byteLength) return null
  const bytes = new Uint8Array(gltf.bin.buffer, gltf.bin.byteOffset + offset, view.byteLength)
  return { bytes, mime: image.mimeType || 'image/png' }
}

/** Every triangle primitive of the default scene, baked to world space, plus bounds and triangle count. */
function collectModel(gltf) {
  const { json } = gltf
  const nodes = json.nodes || []
  const scene = (json.scenes || [])[json.scene || 0]
  const roots = scene && Array.isArray(scene.nodes) ? scene.nodes : nodes.map((_, i) => i)
  const primitives = []
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  let triangles = 0
  let vertices = 0
  let visited = 0
  const walk = (index, parent, path) => {
    const node = nodes[index]
    if (!node || path.has(index) || (visited += 1) > MODEL_MAX_NODES) return
    const world = mat4Multiply(parent, mat4FromNode(node))
    if (!world.every(Number.isFinite)) throw new Error('invalid non-finite model transform')
    const mesh = node.mesh !== undefined ? (json.meshes || [])[node.mesh] : null
    for (const prim of (mesh && mesh.primitives) || []) {
      if ((prim.mode !== undefined && prim.mode !== 4) || !prim.attributes || prim.attributes.POSITION === undefined) continue
      const positionAcc = readAccessor(gltf, prim.attributes.POSITION)
      if (positionAcc.comps !== 3) throw new Error('invalid position accessor: needs VEC3')
      const local = accessorFloats(positionAcc)
      if (!local.every(Number.isFinite)) throw new Error('non-finite vertex position')
      const count = local.length / 3
      if (vertices + count > MODEL_MAX_VERTICES) throw new Error('model exceeds the preview vertex limit')
      vertices += count
      const indexAcc = prim.indices !== undefined ? readAccessor(gltf, prim.indices) : null
      if (indexAcc && (indexAcc.comps !== 1 || ![5121, 5123, 5125].includes(indexAcc.componentType))) throw new Error('invalid triangle indices')
      const indexCount = indexAcc ? indexAcc.data.length : count
      if (indexCount % 3 || triangles + indexCount / 3 > MODEL_MAX_TRIANGLES) throw new Error('invalid triangle count or preview limit exceeded')
      if (indexAcc && !indexAcc.data.every((i) => i < count)) throw new Error('triangle index outside the vertex bounds')
      const indices = indexAcc ? Uint32Array.from(indexAcc.data) : Uint32Array.from({ length: count }, (_, i) => i)
      const positions = new Float32Array(local.length)
      for (let i = 0; i < local.length; i += 3) {
        const [x, y, z] = [local[i], local[i + 1], local[i + 2]]
        for (let r = 0; r < 3; r += 1) {
          const v = world[r] * x + world[4 + r] * y + world[8 + r] * z + world[12 + r]
          positions[i + r] = v
          if (!Number.isFinite(positions[i + r])) throw new Error('model transform produced a non-finite vertex')
          if (v < min[r]) min[r] = v
          if (v > max[r]) max[r] = v
        }
      }
      let normals
      if (prim.attributes.NORMAL !== undefined) {
        const normalAcc = readAccessor(gltf, prim.attributes.NORMAL)
        const src = accessorFloats(normalAcc)
        if (normalAcc.comps !== 3 || src.length !== local.length || !src.every(Number.isFinite)) throw new Error('invalid or non-finite vertex normals')
        const nm = normalMatrix(world)
        if (!nm.every(Number.isFinite)) throw new Error('model transform produced non-finite normals')
        normals = new Float32Array(src.length)
        for (let i = 0; i < src.length; i += 3) {
          const [x, y, z] = [src[i], src[i + 1], src[i + 2]]
          const nx = nm[0] * x + nm[1] * y + nm[2] * z, ny = nm[3] * x + nm[4] * y + nm[5] * z, nz = nm[6] * x + nm[7] * y + nm[8] * z
          const l = Math.hypot(nx, ny, nz) || 1
          normals[i] = nx / l
          normals[i + 1] = ny / l
          normals[i + 2] = nz / l
        }
      } else normals = computeNormals(positions, indices)
      if (!normals.every(Number.isFinite)) throw new Error('non-finite vertex normals')
      const material = prim.material !== undefined ? (json.materials || [])[prim.material] : null
      const pbr = (material && material.pbrMetallicRoughness) || {}
      const image = materialImage(gltf, material)
      const uvs = image && prim.attributes.TEXCOORD_0 !== undefined ? accessorFloats(readAccessor(gltf, prim.attributes.TEXCOORD_0)) : null
      primitives.push({ positions, normals, uvs, indices, color: (pbr.baseColorFactor || [1, 1, 1, 1]).slice(0, 4), image: uvs ? image : null })
      triangles += Math.floor(indices.length / 3)
    }
    const next = new Set(path).add(index)
    for (const child of node.children || []) walk(child, world, next)
  }
  for (const r of roots) walk(r, mat4Identity(), new Set())
  const bounds = primitives.length ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] }
  return { primitives, bounds, triangles }
}

const ORBIT_FOV = Math.PI / 4
function fitOrbit(bounds) {
  if (!bounds || !Array.isArray(bounds.min) || !Array.isArray(bounds.max) || bounds.min.length !== 3 || bounds.max.length !== 3 || ![...bounds.min, ...bounds.max].every(Number.isFinite) || bounds.min.some((v, i) => v > bounds.max[i])) throw new Error('invalid non-finite model bounds')
  const target = [0, 1, 2].map((i) => bounds.min[i] / 2 + bounds.max[i] / 2)
  const radius = Math.max(Math.hypot(...[0, 1, 2].map((i) => bounds.max[i] / 2 - bounds.min[i] / 2)), 1e-3)
  const dist = (radius / Math.sin(ORBIT_FOV / 2)) * 1.05
  if (![...target, radius, dist].every(Number.isFinite)) throw new Error('model bounds exceed the camera range')
  return { target, radius, dist, yaw: Math.PI / 5, pitch: 0.35 }
}
function orbitEye(cam) {
  const cp = Math.cos(cam.pitch)
  return [cam.target[0] + cam.dist * cp * Math.sin(cam.yaw), cam.target[1] + cam.dist * Math.sin(cam.pitch),
    cam.target[2] + cam.dist * cp * Math.cos(cam.yaw)]
}
function orbitMatrix(cam, aspect) {
  const eye = orbitEye(cam)
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1
    return [a[0] / l, a[1] / l, a[2] / l]
  }
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const zf = norm(sub(eye, cam.target))
  const xs = norm(cross([0, 1, 0], zf))
  const ys = cross(zf, xs)
  const view = [xs[0], ys[0], zf[0], 0, xs[1], ys[1], zf[1], 0, xs[2], ys[2], zf[2], 0, -dot(xs, eye), -dot(ys, eye), -dot(zf, eye), 1]
  const near = Math.max(cam.dist - cam.radius * 2, cam.dist / 1000)
  const far = cam.dist + cam.radius * 4
  const f = 1 / Math.tan(ORBIT_FOV / 2)
  const proj = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]
  return { mvp: mat4Multiply(proj, view), eye, right: xs, up: ys }
}

function dataUrlBytes(url) {
  const comma = url.indexOf(',')
  const bin = atob(url.slice(comma + 1))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out.buffer
}

const MODEL_VS = `attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUv;
uniform mat4 uMvp; varying vec3 vN; varying vec2 vUv;
void main() { vN = aNrm; vUv = aUv; gl_Position = uMvp * vec4(aPos, 1.0); }`
const MODEL_FS = `precision mediump float;
varying vec3 vN; varying vec2 vUv;
uniform vec4 uColor; uniform sampler2D uTex; uniform float uHasTex; uniform vec3 uLight;
void main() {
  vec4 base = uColor * mix(vec4(1.0), texture2D(uTex, vUv), uHasTex);
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float key = max(dot(n, normalize(uLight)), 0.0);
  float rim = max(dot(n, vec3(0.0, 1.0, 0.0)), 0.0) * 0.15;
  gl_FragColor = vec4(base.rgb * (0.32 + 0.68 * key + rim), base.a);
}`

/** UI-9: upload a decoded ImageBitmap into a WebGL 2D texture, always closing the bitmap on success, error or
 *  after renderer teardown so GPU/decoded image memory does not leak. */
function uploadModelTexture(gl, bmp, isDead = false) {
  let tex = null
  try {
    if (isDead) return null
    tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    return tex
  } catch {
    if (tex && typeof gl.deleteTexture === 'function') gl.deleteTexture(tex)
    return null
  } finally {
    if (bmp && typeof bmp.close === 'function') {
      try {
        bmp.close()
      } catch {
        /* closing a bitmap is best-effort cleanup */
      }
    }
  }
}

function createModelRenderer(canvas, model, onChange) {
  const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: false }) || canvas.getContext('webgl', { antialias: true })
  if (!gl) throw new Error('WebGL is not available')
  const big = model.primitives.some((p) => p.positions.length / 3 > 65535)
  const uint = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? true : !!gl.getExtension('OES_element_index_uint')
  if (big && !uint) throw new Error('this GPU cannot draw a mesh this large')
  const shader = (type, src) => {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader error')
    return s
  }
  const prog = gl.createProgram()
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, MODEL_VS))
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, MODEL_FS))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link error')
  const loc = {
    pos: gl.getAttribLocation(prog, 'aPos'), nrm: gl.getAttribLocation(prog, 'aNrm'), uv: gl.getAttribLocation(prog, 'aUv'),
    mvp: gl.getUniformLocation(prog, 'uMvp'), color: gl.getUniformLocation(prog, 'uColor'), tex: gl.getUniformLocation(prog, 'uTex'),
    hasTex: gl.getUniformLocation(prog, 'uHasTex'), light: gl.getUniformLocation(prog, 'uLight')
  }
  const owned = { buffers: [], textures: [] }
  const buffer = (target, data) => {
    const b = gl.createBuffer()
    gl.bindBuffer(target, b)
    gl.bufferData(target, data, gl.STATIC_DRAW)
    owned.buffers.push(b)
    return b
  }
  let dead = false
  const textureJobs = []
  const parts = model.primitives.map((p) => {
    const part = {
      pos: buffer(gl.ARRAY_BUFFER, p.positions), nrm: buffer(gl.ARRAY_BUFFER, p.normals),
      uv: p.uvs ? buffer(gl.ARRAY_BUFFER, p.uvs) : null,
      idx: buffer(gl.ELEMENT_ARRAY_BUFFER, uint ? p.indices : Uint16Array.from(p.indices)),
      count: p.indices.length, color: p.color, tex: null
    }
    if (p.image && typeof createImageBitmap === 'function') {
      textureJobs.push(Promise.resolve().then(() => createImageBitmap(new Blob([p.image.bytes], { type: p.image.mime }))).then((bmp) => {
        const t = uploadModelTexture(gl, bmp, dead)
        if (!t) return
        owned.textures.push(t)
        part.tex = t
        onChange()
      }).catch(() => { /* unsupported textures fall back to the material colour */ }))
    }
    return part
  })
  const blank = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, blank)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
  owned.textures.push(blank)
  return {
    ready: Promise.all(textureJobs),
    draw(cam) {
      if (dead) return
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.enable(gl.DEPTH_TEST)
      gl.disable(gl.CULL_FACE)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      gl.useProgram(prog)
      const m = orbitMatrix(cam, canvas.width / Math.max(canvas.height, 1))
      gl.uniformMatrix4fv(loc.mvp, false, new Float32Array(m.mvp))
      const l = [m.eye[0] - cam.target[0] + m.up[0] * cam.dist * 0.5, m.eye[1] - cam.target[1] + m.up[1] * cam.dist * 0.5, m.eye[2] - cam.target[2] + m.up[2] * cam.dist * 0.5]
      gl.uniform3fv(loc.light, new Float32Array(l))
      gl.uniform1i(loc.tex, 0)
      gl.activeTexture(gl.TEXTURE0)
      for (const p of parts) {
        gl.bindBuffer(gl.ARRAY_BUFFER, p.pos)
        gl.enableVertexAttribArray(loc.pos)
        gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 0, 0)
        gl.bindBuffer(gl.ARRAY_BUFFER, p.nrm)
        gl.enableVertexAttribArray(loc.nrm)
        gl.vertexAttribPointer(loc.nrm, 3, gl.FLOAT, false, 0, 0)
        if (p.uv && p.tex && loc.uv >= 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, p.uv)
          gl.enableVertexAttribArray(loc.uv)
          gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 0, 0)
        } else if (loc.uv >= 0) {
          gl.disableVertexAttribArray(loc.uv)
          gl.vertexAttrib2f(loc.uv, 0, 0)
        }
        gl.bindTexture(gl.TEXTURE_2D, p.tex || blank)
        gl.uniform1f(loc.hasTex, p.tex ? 1 : 0)
        gl.uniform4fv(loc.color, new Float32Array(p.color))
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, p.idx)
        gl.drawElements(gl.TRIANGLES, p.count, uint ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0)
      }
    },
    destroy() {
      dead = true
      owned.buffers.forEach((b) => gl.deleteBuffer(b))
      owned.textures.forEach((t) => gl.deleteTexture(t))
      gl.deleteProgram(prog)
      const lose = gl.getExtension('WEBGL_lose_context')
      if (lose) lose.loseContext()
    }
  }
}

/** Serial, bounded thumbnail cache: a canvas full of meshes must not create one persistent WebGL context
 *  per node. A rejected thumbnail is retryable and never poisons the queue. clear() invalidates queued work. */
function createModelThumbnailCache(render, maxEntries = 32) {
  const entries = new Map()
  let tail = Promise.resolve()
  let generation = 0
  return {
    get(key, input) {
      if (entries.has(key)) return entries.get(key)
      const epoch = generation
      const task = tail.then(() => {
        if (epoch !== generation) throw new Error('Thumbnail cancelled')
        return render(input)
      })
      tail = task.catch(() => undefined)
      entries.set(key, task)
      task.catch(() => { if (entries.get(key) === task) entries.delete(key) })
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
      return task
    },
    clear() { generation++; entries.clear() },
    size: () => entries.size,
  }
}

async function renderModelThumbnail(dataUrl) {
  const model = collectModel(parseGlb(dataUrlBytes(dataUrl)))
  if (!model.primitives.length) throw new Error('The file has no triangle meshes')
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 200
  let renderer
  try {
    renderer = createModelRenderer(canvas, model, () => {})
    await renderer.ready
    renderer.draw(fitOrbit(model.bounds))
    // Read in the same task as draw(), before the non-preserved drawing buffer can be cleared.
    return canvas.toDataURL('image/png')
  } finally {
    if (renderer) renderer.destroy()
    canvas.width = canvas.height = 1
  }
}
const MODEL_THUMBNAILS = createModelThumbnailCache(renderModelThumbnail)

function ModelThumbnail({ cacheKey, dataUrl, name }) {
  const [state, setState] = useState(null)
  useEffect(() => {
    let alive = true
    MODEL_THUMBNAILS.get(cacheKey, dataUrl).then(
      (image) => alive && setState({ key: cacheKey, image }),
      (err) => alive && setState({ key: cacheKey, error: err.message || String(err) })
    )
    return () => { alive = false }
  }, [cacheKey, dataUrl])
  const result = state && state.key === cacheKey ? state : null
  if (result && result.image) return h('img', {
    className: 'fc-model-thumb', 'data-fc-model-thumbnail': 'ready', src: result.image,
    alt: name || '3D model', draggable: false, title: 'Click to open the interactive 3D viewer'
  })
  return h('div', { className: 'fc-mini-unavailable', 'data-fc-model-thumbnail': result ? 'error' : 'loading' },
    result ? `Cannot preview this mesh: ${result.error}` : 'Rendering 3D preview…')
}

/** The lightbox body for a .glb: drag to orbit, right-drag or Shift+drag to pan, scroll to zoom, double-click resets. */
function Model3DView({ dataUrl }) {
  const ref = useRef(null)
  const [state, setState] = useState({ status: 'loading' })
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !dataUrl) return undefined
    let renderer = null
    let cam = null
    let home = null
    let raf = 0
    let dead = false
    const frame = () => {
      raf = 0
      if (dead || !renderer) return
      const r = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(1, Math.round(r.width * dpr))
      const hh = Math.max(1, Math.round(r.height * dpr))
      if (canvas.width !== w || canvas.height !== hh) {
        canvas.width = w
        canvas.height = hh
      }
      renderer.draw(cam)
    }
    const redraw = () => {
      if (!raf && !dead) raf = requestAnimationFrame(frame)
    }
    try {
      const model = collectModel(parseGlb(dataUrlBytes(dataUrl)))
      if (!model.primitives.length) throw new Error('the file has no triangle meshes')
      renderer = createModelRenderer(canvas, model, redraw)
      cam = fitOrbit(model.bounds)
      home = { ...cam, target: cam.target.slice() }
      setState({ status: 'ready', triangles: model.triangles })
    } catch (err) {
      setState({ status: 'error', error: (err && err.message) || String(err) })
      return undefined
    }
    let drag = null
    const down = (e) => {
      e.preventDefault()
      e.stopPropagation()
      drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.button === 1 || e.shiftKey }
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        /* capture is a nicety */
      }
    }
    const move = (e) => {
      if (!drag) return
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      drag.x = e.clientX
      drag.y = e.clientY
      if (drag.pan) {
        const m = orbitMatrix(cam, 1)
        const k = (cam.dist * 2 * Math.tan(ORBIT_FOV / 2)) / Math.max(canvas.clientHeight, 1)
        cam.target = cam.target.map((v, i) => v - m.right[i] * dx * k + m.up[i] * dy * k)
      } else {
        cam.yaw -= dx * 0.008
        cam.pitch = clamp(cam.pitch + dy * 0.008, -1.5, 1.5)
      }
      redraw()
    }
    const up = () => {
      drag = null
    }
    const wheel = (e) => {
      e.preventDefault()
      e.stopPropagation()
      cam.dist = clamp(cam.dist * Math.exp(clamp(e.deltaY, -300, 300) * 0.0012), cam.radius * 0.05, cam.radius * 60)
      redraw()
    }
    const reset = () => {
      cam = { ...home, target: home.target.slice() }
      redraw()
    }
    const menu = (e) => e.preventDefault()
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)
    canvas.addEventListener('wheel', wheel, { passive: false })
    canvas.addEventListener('dblclick', reset)
    canvas.addEventListener('contextmenu', menu)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(redraw) : null
    if (ro) ro.observe(canvas)
    redraw()
    return () => {
      dead = true
      cancelAnimationFrame(raf)
      if (ro) ro.disconnect()
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
      canvas.removeEventListener('wheel', wheel)
      canvas.removeEventListener('dblclick', reset)
      canvas.removeEventListener('contextmenu', menu)
      renderer.destroy()
    }
  }, [dataUrl])
  return h('div', { className: 'fc-3d', 'data-fc-3d': state.status },
    h('canvas', { ref, className: 'fc-3d-canvas' }),
    state.status === 'error' ? h('div', { className: 'fc-3d-msg' }, `Cannot show this model: ${state.error}`)
      : state.status === 'ready' ? h('div', { className: 'fc-3d-info' }, `${state.triangles.toLocaleString('en-US')} triangles`)
        : h('div', { className: 'fc-3d-msg' }, 'Loading model…'))
}

function LightboxThumb({ api, runId, item, active, onClick }) {
  const data = useMedia(api, runId, item.nodeId, item.port, 320, item.kind === 'image', item.index)
  return h('button', {
    className: `fc-lb-thumb${active ? ' active' : ''}`,
    title: `${item.title} · ${item.media.file || item.kind}`,
    'data-fc-lb-thumb': item.key,
    onClick
  }, data && data.data_url ? h('img', { src: data.data_url, alt: '', draggable: false }) : h(Icon, { name: MEDIA_ICON[item.kind] || 'file' }))
}

/** UI-7: attach window pointermove/pointerup/pointercancel for one lightbox pan gesture and return an idempotent
 *  cleanup function so both pointer-up and component unmount remove the listeners. */
function bindLightboxPan(target, { onMove, onEnd } = {}) {
  if (!target || typeof target.addEventListener !== 'function') return () => {}
  let done = false
  const stop = () => {
    if (done) return
    done = true
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', end)
    target.removeEventListener('pointercancel', end)
  }
  const end = () => {
    if (done) return
    stop()
    if (onEnd) onEnd()
  }
  const move = (ev) => {
    if (!done && onMove) onMove(ev)
  }
  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', end)
  target.addEventListener('pointercancel', end)
  return stop
}

function Lightbox({ api, ctx, runId, items, at, onMove, onClose }) {
  const item = items[at]
  const n = items.length
  const kind = item.kind
  const wants = kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'model3d'
  const data = useMedia(api, runId, item.nodeId, item.port, kind === 'image' ? LIGHTBOX_PX : 0, wants, item.index)
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  const [flash, setFlash] = useState(null)
  const rootRef = useRef(null)
  const stageRef = useRef(null)
  const flashTimer = useRef(null)
  const panStopRef = useRef(null)
  const kindRef = useRef(kind)
  kindRef.current = kind

  useEffect(() => setView({ zoom: 1, x: 0, y: 0 }), [item.key])
  useEffect(() => {
    const before = document.activeElement
    if (rootRef.current) rootRef.current.focus({ preventScroll: true })
    return () => {
      if (panStopRef.current) panStopRef.current()
      clearTimeout(flashTimer.current)
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {})
      if (before && typeof before.focus === 'function' && document.contains(before)) before.focus({ preventScroll: true })
    }
  }, [])
  // warm the neighbours so ← → feels instant
  useEffect(() => {
    for (const d of [1, -1]) {
      const nb = items[(at + d + n) % n]
      if (nb && nb.key !== item.key && nb.kind === 'image') {
        fetchMedia(api, mediaKey(runId, nb.nodeId, nb.port, nb.index, LIGHTBOX_PX), runId, nb.nodeId, nb.port, LIGHTBOX_PX, nb.index).catch(() => {})
      }
    }
  }, [item.key])
  useEffect(() => {
    const el = stageRef.current
    if (!el) return undefined
    const onWheel = (e) => {
      if (kindRef.current !== 'image') return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const pt = { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }
      setView((v) => lightboxZoom(v, Math.exp(-clamp(e.deltaY, -300, 300) * 0.0015), pt))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const say = (text) => {
    clearTimeout(flashTimer.current)
    setFlash(text)
    flashTimer.current = setTimeout(() => setFlash(null), 2200)
  }
  const step = (d) => n > 1 && onMove((at + d + n) % n)
  const zoomBy = (factor) => kind === 'image' && setView((v) => lightboxZoom(v, factor))
  const copyText = async (text) => {
    try {
      if (typeof sdk.writeClipboardText === 'function') {
        await sdk.writeClipboardText(text)
        return true
      }
      return !!(ctx && ctx.os && typeof ctx.os.writeClipboard === 'function' && await ctx.os.writeClipboard(text))
    } catch {
      return false
    }
  }
  const copyPath = async () => say(await copyText(item.media.path || '') ? 'File path copied.' : 'Could not copy the path.')
  const copyImage = async () => {
    if (kind !== 'image' || !data || !data.data_url) return copyPath()
    try {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) throw new Error('no clipboard')
      const blob = await dataUrlToPng(data.data_url)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      say(data.thumb ? 'Image copied (scaled to 2048 px).' : 'Image copied.')
    } catch {
      say(await copyText(item.media.path || '') ? 'Copying the image is not available here — file path copied instead.' : 'Could not copy.')
    }
  }
  const reveal = async () => {
    let ok = false
    try {
      ok = !!(ctx && ctx.os && typeof ctx.os.revealPath === 'function' && await ctx.os.revealPath(item.media.path))
    } catch {
      ok = false
    }
    if (!ok) say(await copyText(item.media.path || '') ? 'Could not open the folder here — file path copied instead.' : 'Could not open the folder.')
  }
  const toggleFullscreen = () => {
    const el = rootRef.current
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else if (el && el.requestFullscreen) el.requestFullscreen().catch(() => say('Full screen is not available here.'))
  }

  const onKeyDown = (e) => {
    e.stopPropagation()   // the canvas must not see Delete, Ctrl+Z, … while the lightbox is open
    const mod = e.ctrlKey || e.metaKey
    const inPlayer = e.target && (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')
    let handled = true
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowRight' && !inPlayer) step(1)
    else if (e.key === 'ArrowLeft' && !inPlayer) step(-1)
    else if (e.key === 'Home' && !inPlayer) onMove(0)
    else if (e.key === 'End' && !inPlayer) onMove(n - 1)
    else if (!mod && (e.key === '+' || e.key === '=')) zoomBy(1.25)
    else if (!mod && e.key === '-') zoomBy(0.8)
    else if (!mod && e.key === '0') setView({ zoom: 1, x: 0, y: 0 })
    else if (!mod && (e.key === 'f' || e.key === 'F')) toggleFullscreen()
    else if (mod && e.key.toLowerCase() === 'c' && !String(window.getSelection ? window.getSelection() : '')) copyImage()
    else handled = false
    if (handled) e.preventDefault()
  }
  const onStageDown = (e) => {
    if (e.button !== 0 || kind !== 'image' || view.zoom <= 1) return
    e.preventDefault()
    if (panStopRef.current) panStopRef.current()
    const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
    setPanning(true)
    panStopRef.current = bindLightboxPan(window, {
      onMove: (ev) => setView((v) => ({ ...v, x: start.vx + ev.clientX - start.x, y: start.vy + ev.clientY - start.y })),
      onEnd: () => {
        panStopRef.current = null
        setPanning(false)
      }
    })
  }
  const onImageDoubleClick = (e) => {
    const r = stageRef.current.getBoundingClientRect()
    const pt = { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }
    setView((v) => (v.zoom > 1 ? { zoom: 1, x: 0, y: 0 } : lightboxZoom(v, 2.5, pt)))
  }

  const file = item.media.file || (item.media.path || '').split(/[\\/]/).pop() || item.kind
  const card = (msg, extra = null) => h('div', { className: 'fc-lb-card' },
    h(Icon, { name: MEDIA_ICON[kind] || 'file' }),
    h('b', null, file),
    extra,
    msg ? h('div', { className: 'fc-lb-msg' }, msg) : null,
    item.media.path ? h('button', { className: 'fc-lb-btn', onClick: reveal }, h(Icon, { name: 'folder-opened' }), 'Show in folder') : null)
  let body
  if (kind === 'image' && data && data.data_url) {
    body = h('img', {
      key: item.key, className: 'fc-lb-img', src: data.data_url, alt: file, draggable: false,
      style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` },
      onDoubleClick: onImageDoubleClick
    })
  } else if (kind === 'video' && data && data.data_url) {
    body = h('video', { key: item.key, controls: true, autoPlay: true, src: data.data_url })
  } else if (kind === 'audio' && data && data.data_url) {
    body = card(null, h('audio', { key: item.key, controls: true, autoPlay: true, src: data.data_url }))
  } else if (kind === 'model3d' && data && data.data_url && /\.glb$/i.test(file)) {
    body = h(Model3DView, { key: item.key, dataUrl: data.data_url })
  } else if (kind === 'model3d' && data && !data.error) {
    body = card(data.data_url ? 'Only .glb models can be shown here — open it in Blender or a 3D viewer.'
      : 'Too large to preview here — open it from its folder.')
  } else if (wants) {
    body = card(!data ? 'Loading…' : data.error ? `Preview unavailable: ${data.error}` : 'Too large to preview here — open it from its folder.')
  } else {
    body = card(kind === 'model3d' ? '3D model — open it in a 3D viewer or Blender.' : 'No preview for this file type.')
  }

  const isImage = kind === 'image' && data && data.data_url
  return h('div', {
    ref: rootRef, className: 'fc-lb', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${item.title}: ${file}`,
    tabIndex: -1, 'data-fc-lightbox': item.key, onKeyDown,
    onClick: (e) => {
      if (e.target === e.currentTarget) onClose()   // click on the dimmed margin around the 85 % window
    }
  },
  h('div', { className: 'fc-lb-panel' },
  h('div', { className: 'fc-lb-bar' },
    h('div', { className: 'fc-lb-title' },
      h(Icon, { name: MEDIA_ICON[kind] || 'file' }),
      h('b', null, item.title),
      h('span', { className: 'fc-lb-file', title: item.media.path || file }, `${item.portLabel} · ${file}`)),
    n > 1 ? h('span', { className: 'fc-lb-count', 'data-fc-lb-count': '1' }, `${at + 1} / ${n}`) : null,
    isImage ? [
      h('button', { key: 'zo', className: 'fc-lb-btn', title: 'Zoom out (−)', disabled: view.zoom <= 1, onClick: () => zoomBy(0.8) }, h(Icon, { name: 'zoom-out' })),
      h('button', { key: 'zr', className: 'fc-lb-btn fc-lb-zoom', title: 'Fit to window (0)', onClick: () => setView({ zoom: 1, x: 0, y: 0 }) }, view.zoom <= 1 ? 'Fit' : `${Math.round(view.zoom * 100)}%`),
      h('button', { key: 'zi', className: 'fc-lb-btn', title: 'Zoom in (+)', disabled: view.zoom >= 8, onClick: () => zoomBy(1.25) }, h(Icon, { name: 'zoom-in' })),
      h('span', { key: 'sep', className: 'fc-lb-sep' }),
      h('button', { key: 'ci', className: 'fc-lb-btn', title: 'Copy image (Ctrl+C)', onClick: copyImage }, h(Icon, { name: 'copy' }), 'Copy image')
    ] : null,
    item.media.path ? h('button', { className: 'fc-lb-btn', title: 'Copy file path', onClick: copyPath }, h(Icon, { name: 'clippy' }), 'Copy path') : null,
    item.media.path ? h('button', { className: 'fc-lb-btn', title: 'Show the file in Explorer / Finder', onClick: reveal }, h(Icon, { name: 'folder-opened' }), 'Show in folder') : null,
    h('span', { className: 'fc-lb-sep' }),
    h('button', { className: 'fc-lb-btn', title: 'Full screen (F)', onClick: toggleFullscreen }, h(Icon, { name: 'screen-full' })),
    h('button', { className: 'fc-lb-btn', title: 'Close (Esc)', 'data-fc-lb-close': '1', onClick: onClose }, h(Icon, { name: 'close' }))),
  h('div', {
    ref: stageRef,
    className: `fc-lb-stage${view.zoom > 1 ? ' zoomed' : ''}${panning ? ' panning' : ''}`,
    onPointerDown: onStageDown,
    onClick: (e) => {
      if (e.target === e.currentTarget && view.zoom <= 1) onClose()
    }
  },
  body,
  n > 1 ? h('button', { className: 'fc-lb-nav prev', title: 'Previous (←)', onClick: () => step(-1) }, h(Icon, { name: 'chevron-left' })) : null,
  n > 1 ? h('button', { className: 'fc-lb-nav next', title: 'Next (→)', onClick: () => step(1) }, h(Icon, { name: 'chevron-right' })) : null,
  flash ? h('div', { className: 'fc-lb-flash' }, flash) : null,
  h('div', { className: 'fc-lb-hint' }, `${n > 1 ? '← → browse · ' : ''}${kind === 'image' ? 'scroll to zoom · drag to pan · ' : kind === 'model3d' ? 'drag to rotate · right-drag to pan · scroll to zoom · double-click resets · ' : ''}Esc close`)),
  n > 1 ? h('div', { className: 'fc-lb-strip' },
    items.slice(0, 60).map((it, i) => h(LightboxThumb, { key: it.key, api, runId, item: it, active: i === at, onClick: () => onMove(i) }))) : null))
}

function NodeResult({ state, node, spec, runId, api, onOpenMedia }) {
  const outputs = state.outputs || {}
  const order = ['media', 'value', 'file', 'text', 'number']
  const rank = (k) => (order.includes(k) ? order.indexOf(k) : 50)
  const entries = Object.entries(outputs)
    .filter(([k, v]) => !k.startsWith('_') && k !== 'result' && v !== null && v !== undefined && v !== '')
    .sort((a, b) => rank(a[0]) - rank(b[0]))
  const outSpec = new Map(((spec && spec.outputs) || []).map((o) => [o.name, o]))
  const raw = outputs.result
  return h('div', { className: 'fc-result', 'data-fc-result': state.status },
    state.error ? h('div', { className: 'fc-pre-wrap fc-insp-error' },
      h('div', { className: 'fc-node-error', style: { margin: '4px 0 0', maxHeight: 'none', paddingRight: 30 } }, state.error),
      h(CopyBtn, { text: state.error, title: 'Copy error' })) : null,
    entries.length === 0 && !state.error && raw === undefined ? h('div', { className: 'fc-help' }, state.status === 'running' ? 'Running…' : 'No output yet.') : null,
    entries.map(([port, value]) => {
      const rows = itemRows(state, port)
      return h('div', { key: port, className: 'fc-out' },
        h('div', { className: 'fc-out-port' }, (outSpec.get(port) && outSpec.get(port).label) || port),
        rows ? h('div', { className: 'fc-iters', 'data-fc-iters': rows.length }, rows.map((r) =>
          h('div', { key: r.n, className: 'fc-iter', 'data-fc-iter': r.kind },
            h('span', { className: 'fc-iter-n' }, `#${r.n}`),
            r.kind === 'value' ? h(OutputValue, { api, runId, nodeId: node.id, port, value: r.value, onOpenMedia })
              : h('span', { className: `fc-iter-msg${r.kind === 'error' ? ' bad' : ''}` }, r.text))))
          : h(OutputValue, { api, runId, nodeId: node.id, port, value, onOpenMedia }))
    }),
    raw !== undefined && raw !== null ? h('details', { className: 'fc-raw' },
      h('summary', null, 'Raw tool result'),
      h(OutputValue, { api, runId, nodeId: node.id, port: 'result', value: raw, onOpenMedia })) : null)
}

/** One inspector section of layout B: a header button that folds it, with a short summary while folded. The body
 *  stays mounted (only hidden), so typing state and lookups survive folding. */
function Fold({ id, icon, title, summary, open, onToggle, children }) {
  return h('div', { className: `fc-fold${open ? ' open' : ''}`, 'data-fc-fold': id },
    h('button', { type: 'button', className: 'fc-fold-head', 'aria-expanded': open ? 'true' : 'false', onClick: onToggle },
      h(Icon, { name: open ? 'chevron-down' : 'chevron-right' }),
      h(Icon, { name: icon }),
      h('span', { className: 'fc-fold-title' }, title),
      !open && summary ? h('span', { className: 'fc-fold-sum', title: summary }, summary) : null),
    h('div', { className: 'fc-fold-body', hidden: !open }, children))
}
// Which inspector sections are open, shared by every node of this window (the result section follows the run).
const INSPECTOR_FOLDS = { model: true, inputs: true, settings: true, advanced: false }

/** Inspector "Run" section: live time while running, your measured runs, the typical text (G9). */
function TimingInfo({ exp, state }) {
  const running = !!state && state.status === 'running'
  const now = useNow(running)
  const elapsed = running ? sinceMs(state.started_at, now) : null
  const lines = [...(elapsed !== null ? [`Running for ${formatClock(elapsed)}`] : []),
    ...(running && state.progress ? [oneLine(state.progress, 200)] : []), ...timingLines(exp)]
  if (!lines.length) return null
  return h('div', { className: 'fc-timing', 'data-fc-timing': '1' }, lines.map((l, i) => h('div', { key: i }, l)))
}

/** Send message: only an explicit opt-in for exactly this recipient lets a run send. */
function MessagingGuard({ node, onOptIn, busy }) {
  const params = node.params || {}
  const target = String(params.target || '').trim()
  const scope = messagingScope(node)
  const armed = scope !== 'off'
  return h('div', { className: 'fc-section', 'data-fc-messaging': armed ? 'armed' : 'off' },
    h('h4', null, 'Sending'),
    h('div', { className: 'fc-field' },
      h('div', { className: armed ? 'fc-insp-issues' : 'fc-help', 'data-fc-messaging-state': armed ? 'armed' : 'off' },
        h('span', null, scope === 'files'
          ? `Runs may send real text and upload connected files to ${target}. Changing the recipient turns this off.`
          : scope === 'text'
            ? `Runs may send real text to ${target}. File uploads are disabled until explicitly enabled below.`
            : target
              ? 'Sending is off. Select a permission below for exactly this recipient.'
              : 'Choose a recipient first, then enable sending.')),
      h('div', { className: 'fc-row', style: { marginTop: 8 } },
        h('button', {
          className: 'fc-btn', disabled: !target || !!busy,
          'data-fc-messaging-toggle': armed ? 'disable' : 'enable',
          title: armed ? 'Stop this node from sending' : `Allow runs to send text to ${target}`,
          onClick: () => onOptIn(node.id, !armed, false)
        }, armed ? 'Disable sending' : 'Enable sending to this recipient')),
      scope !== 'files' ? h('div', { className: 'fc-row', style: { marginTop: 8 } },
        h('button', {
          className: 'fc-btn', disabled: !target || !!busy,
          'data-fc-messaging-attachments': 'enable',
          title: `Allow runs to upload connected files to ${target}`,
          onClick: () => onOptIn(node.id, true, true)
        }, 'Enable text and file sending')) : null,
      h('div', { className: 'fc-help' }, 'Connect media to Attachment. A timeout cannot prove delivery; check the recipient before retrying.')))
}

const isTriggerType = (type) => typeof type === 'string' && type.startsWith('trigger.')
/** "in 5 min" / "Tue 08:00" for a trigger's next or last fire (epoch seconds). Pure, tested. */
function triggerWhen(epoch, now = Date.now()) {
  if (!epoch) return ''
  const ms = epoch * 1000
  const diff = ms - now
  if (Math.abs(diff) < 45000) return diff >= 0 ? 'now' : 'just now'
  if (diff > 0 && diff < 3600000) return `in ${Math.round(diff / 60000)} min`
  if (diff < 0 && -diff < 3600000) return `${Math.round(-diff / 60000)} min ago`
  const d = new Date(ms)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? `today ${hm}` : `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${hm}`
}
/** The lines the trigger section shows, from GET flows/<id>/triggers. Pure, tested. */
function triggerLines(node, info, runnerPid, now = Date.now()) {
  if (!info) return ['Loading status…']
  const lines = []
  if (!info.active) {
    lines.push(node.type === 'trigger.webhook'
      ? 'Off. Activate it to get a local URL that starts this flow.'
      : 'Off. Activate it to start this flow automatically while Hermes runs.')
    return lines
  }
  if (!runnerPid) lines.push('Waiting for Hermes to pick it up (the gateway or Desktop backend fires triggers, within about a minute).')
  if (info.schedule) lines.push(`Schedule: ${info.schedule}`)
  if (info.watching) lines.push(`Watching: ${info.watching}`)
  if (info.source) lines.push(`After: ${info.source}`)
  if (info.next) lines.push(`Next: ${triggerWhen(info.next, now)}`)
  else if (node.type === 'trigger.webhook') lines.push('Runs on every POST to its URL.')
  else if (node.type === 'trigger.folder') lines.push('Checks every 15 s; a file starts the flow once it is fully written.')
  if (info.last_fire) lines.push(`Last start: ${triggerWhen(info.last_fire, now)} · ${info.fires || 1} run${info.fires === 1 ? '' : 's'} so far`)
  if (info.last_event_at) lines.push(`Last request: ${info.last_event_at.replace('T', ' ').slice(0, 16)}`)
  if (info.note) lines.push(info.note)
  return lines
}

/** Trigger nodes: switch on/off, see when it fires next, copy the webhook URL. */
function TriggerGuard({ node, flow, api, busy, onSwitch }) {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const flowId = flow && flow.id
  const params = node.params || {}
  useEffect(() => {
    let alive = true
    if (!api || !flowId || typeof api.triggerStatus !== 'function') return undefined
    api.triggerStatus(flowId).then((s) => alive && (setStatus(s), setError('')),
      (err) => alive && setError(parseRestError(err).message))
    const timer = setTimeout(() => alive && setTick((n) => n + 1), 15000)
    return () => { alive = false; clearTimeout(timer) }
  }, [flowId, node.id, params.active, params.schedule, params.url, params.hook_id, tick])
  const info = status && status.nodes ? status.nodes[node.id] : null
  const active = info ? info.active : params.active === true
  const lines = triggerLines(node, info || (status ? { active: params.active === true } : null), status && status.runner_pid)
  const problem = error || (info && info.error) || (status && node.type === 'trigger.webhook' && active && status.server_error) || ''
  const toggle = async (next, rotate = false) => {
    const res = await onSwitch(node.id, next, rotate)
    if (res && res.status) setStatus(res.status)
  }
  return h('div', { className: 'fc-section', 'data-fc-trigger': active ? 'on' : 'off' },
    h('h4', null, 'Trigger'),
    h('div', { className: 'fc-field' },
      h('div', { className: 'fc-help', style: active ? { color: 'var(--ui-green)' } : undefined,
        'data-fc-trigger-state': active ? 'on' : 'off' }, lines.map((l, i) => h('div', { key: i }, l))),
      problem ? h('div', { className: 'fc-node-error', style: { margin: '6px 0 0' }, 'data-fc-trigger-error': '1' }, problem) : null,
      info && info.url ? h('div', { className: 'fc-field', style: { marginTop: 8 } },
        h('label', null, 'Webhook URL', h(InfoTip, { lines: ['POST JSON or text here to start the flow; Body and Raw text carry it.',
          'Only reachable from this computer (127.0.0.1). For outside services use a tunnel you trust.',
          'The URL contains a secret: anyone with it can start the flow. New URL makes the old one stop working.'] })),
        h('div', { className: 'fc-row' },
          h('input', { className: 'fc-input', readOnly: true, value: info.url, 'data-fc-webhook-url': '1', onFocus: (e) => e.target.select() }),
          h('button', { type: 'button', className: 'fc-btn', title: 'Copy the URL',
            onClick: async () => { if (typeof sdk.writeClipboardText === 'function') await sdk.writeClipboardText(info.url) } },
          h(Icon, { name: 'copy' })))) : null,
      h('div', { className: 'fc-row', style: { marginTop: 8 } },
        h('button', {
          className: active ? 'fc-btn' : 'fc-btn primary', disabled: !!busy, 'data-fc-trigger-toggle': active ? 'off' : 'on',
          title: active ? 'Stop starting this flow automatically' : 'Start this flow automatically while Hermes runs',
          onClick: () => toggle(!active)
        }, h(Icon, { name: active ? 'debug-pause' : 'play' }), active ? 'Deactivate' : 'Activate'),
        active && node.type === 'trigger.webhook' ? h('button', { className: 'fc-btn', disabled: !!busy,
          title: 'Make a new secret URL; the old one stops working', onClick: () => toggle(true, true) }, 'New URL') : null),
      h('div', { className: 'fc-help' }, 'Triggers start the flow directly: no chat turn, so no extra model cost beyond the flow\'s own nodes. ' +
        'They run only while Hermes (gateway or Desktop) is running; a schedule missed by more than 30 min is skipped.')))
}

function NodePanel(p) {
  const { node, spec, flow, types, run, api } = p
  const state = run && run.nodes ? run.nodes[node.id] : null
  const exp = node.type === 'note' ? null : expectedTime(spec, node, p.timings)
  const params = node.params || {}
  const sources = {}
  for (const e of flow.edges) {
    if (e.to.node !== node.id) continue
    const src = flow.nodes.find((n) => n.id === e.from.node)
    const sspec = src ? types.byName[src.type] : null
    const outP = sspec ? (sspec.outputs || []).find((o) => o.name === e.from.port) : null
    sources[e.to.port] = sources[e.to.port]
      ? `${sources[e.to.port]} + ${nodeTitle(src, types.byName) || e.from.node} › ${outP ? outP.label || outP.name : e.from.port}`
      : `${nodeTitle(src, types.byName) || e.from.node} › ${outP ? outP.label || outP.name : e.from.port}`
  }
  const fields = (spec && spec.params) || []
  const inputPorts = nodePorts(node, spec).inputs
  const dynamic = inputPorts.filter((q) => q.dynamic)
  const portNames = new Set(inputPorts.filter((q) => !q.dynamic).map((q) => q.name))
  const isNote = node.type === 'note'
  const [moreOpen, setMoreOpen] = useState(false)
  const mi = useModelInfo(api, node.type, spec, params)
  const modelInfo = mi && mi.data && mi.data.found ? mi.data : null
  const llm = useLlmInfo(api, params, node.type === 'llm.complete')
  const modelFields = { ...((modelInfo && modelInfo.fields) || {}) }
  if (llm && llm.max_output_tokens) {
    modelFields.max_tokens = { ...(modelFields.max_tokens || {}), max: llm.max_output_tokens,
      description: `The provider allows at most ${llm.max_output_tokens} output tokens for ${llm.model}.` }
  }
  const llmRows = llm ? llmInfoRows(llm) : []
  const llmCost = llm ? estimateLlmCost(llm, params) : null
  const modelName = modelInfo ? modelInfo.label || mi.model : mi ? mi.model : ''
  const ms = modelSetting(spec, params)
  const modelNote = !mi ? null
    : mi.error ? { bad: true, text: `Could not load this model's settings: ${mi.error}` }
      : mi.data && !mi.data.found ? { bad: false, text: `“${mi.model}” is not in the model list, so its settings cannot be checked.` } : null
  const cost = modelInfo ? estimateCost(modelInfo.cost, effectiveValues(spec, params, modelFields)) : llmCost
  const extras = (modelInfo && Array.isArray(modelInfo.params)) ? modelInfo.params : []
  const extrasShown = extras.filter((x) => extraVisible(x, extraValues(extras, params)))
  const imageLimits = {}
  for (const f of fields) {
    if (f.kind !== 'media_list') continue
    const wired = ((p.flow && p.flow.edges) || []).filter((e) => e.to.node === node.id && e.to.port === f.name)
    const wiredCount = wired.reduce((n, e) => n + wiredItemCount(p.run, e), 0)
    imageLimits[f.name] = fitImageLimit(f, modelInfo ? modelInfo.max_images : null, modelName, mediaValues(params[f.name]).length + wiredCount)
  }
  const shownFields = fields.map((f) => (imageLimits[f.name] ? imageLimits[f.name].field : f))
  const split = splitFields(shownFields, { spec, params, connected: new Set(Object.keys(sources)), modelFields })
  const isTool = (spec && spec.kind === 'tool') || (!spec && String(node.type).startsWith('tool:'))
  const nodeIssues = (p.issues || []).filter((i) => i.node === node.id)
    .sort((a, b) => (a.level === 'error' ? 0 : 1) - (b.level === 'error' ? 0 : 1))
  // Layout B (18.11.2026): Run bar on top, then foldable sections in working order.
  const autoField = ms ? (fields.find((f) => f.name === ms.param) || {}).auto : null
  const modelNames = new Set([ms && ms.param, autoField].filter(Boolean))
  const field = (f) => h(ParamField, {
    key: f.name,
    spec: f,
    value: params[f.name],
    params,
    port: portNames.has(f.name),
    api: p.api,
    nodeType: node.type,
    source: sources[f.name],
    types,
    onChange: (v) => p.onUpdateNode(node.id, { params: { [f.name]: v } }, `p:${node.id}:${f.name}`),
    onChangeMany: (patch) => p.onUpdateNode(node.id, { params: patch }),
    onBrowse: p.onPickFile ? (kind) => p.onPickFile(kind, node.id) : null,
    flowId: flow && flow.id,
    modelField: modelFields[f.name],
    modelName,
    note: ms && f.name === ms.param ? modelNote : imageLimits[f.name] ? imageLimits[f.name].note : null
  })
  const groups = inspectorGroups(split.main, { modelNames, portNames })
  const providerPick = spec && Array.isArray(spec.providers) && spec.providers.length ? spec.providers : null
  const providerLabel = providerPick
    ? ((providerPick.find((c) => c.type === node.type) || providerPick[0]).label || '').replace(' (best available)', '')
    : isTool ? toolProvider(node.type, spec && spec.description) : ''
  const modelLabel = ms ? (ms.auto ? `Auto (${ms.mode})` : ms.model) : params.model ? String(params.model) : ''
  const wiredInputs = groups.inputs.filter((f) => sources[f.name]).length + dynamic.filter((q) => sources[q.name]).length
  const summary = inspectorSummaries({
    provider: providerLabel, model: modelLabel, inputs: groups.inputs.length + dynamic.length, wired: wiredInputs,
    settings: groups.settings.length, more: split.more.length,
    status: state ? (STATUS[state.status] || STATUS.queued).label : '', cache: cacheOn(params, spec), recorded: node.record_inputs === true
  })
  const [folds, setFolds] = useState(() => ({ ...INSPECTOR_FOLDS }))
  const fold = (id) => ({ open: folds[id] !== undefined ? !!folds[id] : !!state, onToggle: () => {
    const open = !(folds[id] !== undefined ? folds[id] : !!state)
    if (id !== 'result') INSPECTOR_FOLDS[id] = open
    setFolds((f) => ({ ...f, [id]: open }))
  } })
  const finished = state && ['done', 'cached', 'error'].includes(state.status) ? `${run.id}:${state.status}` : ''
  useEffect(() => { if (finished) setFolds((f) => ({ ...f, result: true })) }, [finished])
  const hasModel = isTool || !!providerPick || groups.model.length > 0 || !!(llm && llm.model) || extrasShown.length > 0
  return h('div', { className: 'fc-side fc-inspector', 'data-fc-inspector': node.id },
    h('div', { className: 'fc-section fc-insp-top' },
      h('div', { className: 'fc-insp-head', style: { '--fc-cat': spec ? categoryColor(spec.category) : 'var(--ui-red)' } },
        h(Icon, { name: (spec && spec.icon) || 'question' }),
        h('input', {
          className: 'fc-input fc-insp-title',
          value: node.title || '',
          placeholder: (spec && spec.title) || node.type,
          onChange: (e) => p.onUpdateNode(node.id, { title: e.target.value }, `title:${node.id}`)
        })),
      spec && spec.description ? h('div', { className: 'fc-help fc-insp-desc' }, spec.description) : null,
      !spec && !isNote ? h('div', { className: 'fc-node-error', style: { margin: '6px 0 0' } },
        isTool ? 'This tool is not available (missing, blocked or its MCP server is off). Pick another tool or remove the node.'
          : `Unknown node type “${node.type}”.`) : null),
    !isNote ? h('div', { className: 'fc-runbar', 'data-fc-runbar': node.id },
      h('div', { className: 'fc-runbar-row' },
        h('button', { className: 'fc-btn primary', disabled: p.running, title: 'Run this node and everything it depends on', onClick: () => p.onRunTo(node.id) },
          h(Icon, { name: 'debug-continue' }), 'Run up to here'),
        state ? h(StatusBadge, { state }) : null,
        cost ? h('span', { className: 'fc-cost', 'data-fc-cost': cost.label },
          h(Icon, { name: 'credit-card' }), h('b', null, cost.label), h(InfoTip, { lines: cost.lines })) : null),
      h(TimingInfo, { exp, state })) : null,
    nodeIssues.length ? h('div', { className: 'fc-section fc-insp-issues' }, nodeIssues.map((i, k) => h('div', { key: k, className: `fc-issue ${i.level}` },
      h(Icon, { name: i.level === 'error' ? 'error' : 'warning' }), h('span', null, i.message)))) : null,
    isTriggerType(node.type) ? h(TriggerGuard, {
      node, flow, api, busy: !!p.running, onSwitch: (id, active, rotate) => p.onTriggerSwitch && p.onTriggerSwitch(id, active, rotate)
    }) : null,
    node.type === 'output.send_message' ? h(MessagingGuard, {
      node, busy: !!p.running, onOptIn: (id, enable, allowAttachments) => p.onMessagingOptIn && p.onMessagingOptIn(id, enable, allowAttachments)
    }) : null,
    hasModel ? h(Fold, { id: 'model', icon: 'server-process', title: isTool && !providerPick && !groups.model.length ? 'Tool' : 'Provider & model',
      summary: summary.model || (isTool ? String(node.type).replace(/^tool:/, '') : ''), ...fold('model') },
      isTool ? h('div', { className: 'fc-field fc-tool-pick' },
        h('label', null, 'Tool', h(InfoTip, { lines: ['Which Hermes or MCP tool this node calls.', 'Swapping keeps settings and wires whose names still match.'] })),
        h(ToolSelect, {
          types,
          value: node.type,
          missing: String(node.type).replace(/^tool:/, ''),
          title: 'Swap the tool; matching settings and wires are kept',
          onChange: (t) => t && t !== node.type && p.onChangeType(node.id, t)
        })) : null,
      providerPick ? h('div', { className: 'fc-field fc-provider-pick' },
        h('label', null, 'Provider', h(InfoTip, { lines: ['Which service runs this step. Every provider found in your Hermes setup is listed.', 'Switching keeps wires and text; the model is picked again from the new provider.'] })),
        providerPick.length > 1 ? h('select', {
          className: 'fc-input',
          value: providerPick.some((c) => c.type === node.type) ? node.type : spec.type,
          onChange: (e) => e.target.value && e.target.value !== node.type && p.onChangeType(node.id, e.target.value)
        }, providerPick.map((c) => h('option', { key: c.type, value: c.type }, c.label)))
          : h('div', { className: 'fc-help' }, providerLabel)) : null,
      groups.model.map(field),
      llm && llm.model ? h('div', { className: 'fc-extra', 'data-fc-llm-info': llm.model },
        h('div', { className: 'fc-subhead' }, h(Icon, { name: 'info' }), h('span', null, `Model info · ${llm.model}`)),
        llmRows.map(([k, v]) => h('div', { key: k, className: 'fc-info-row' },
          h('span', { className: 'fc-info-k' }, k), h('span', { className: 'fc-info-v', title: String(v) }, v))),
        llm.description ? h('div', { className: 'fc-help' }, llm.description) : null,
        llm.error ? h('div', { className: 'fc-help' }, `No catalog info: ${llm.error}`) : null,
        llm.found === false && !llm.hermesPricing ? h('div', { className: 'fc-help' },
          'This provider publishes no catalog through its tools; only Hermes\' picker data is shown.') : null) : null,
      extrasShown.length ? h('div', { className: 'fc-extra', 'data-fc-extras': String(extrasShown.length) },
        h('div', { className: 'fc-subhead' }, h(Icon, { name: 'settings' }), h('span', null, `Model settings · ${modelName}`),
          h(InfoTip, { lines: [`Settings ${modelName} offers, with its choices and defaults (from the model list).`,
            'Empty = the model default. Only settings of the chosen model are sent.'] })),
        extrasShown.map((x) => {
          const [xs, xf] = extraSpec(x)
          return h(ParamField, {
            key: `x:${x.name}`, spec: xs, value: params[x.name], params, api: p.api, nodeType: node.type, types,
            onChange: (v) => p.onUpdateNode(node.id, { params: { [x.name]: v } }, `p:${node.id}:${x.name}`),
            onBrowse: p.onPickFile ? (kind) => p.onPickFile(kind, node.id) : null,
            modelField: xf, modelName
          })
        })) : null) : null,
    groups.inputs.length || dynamic.length ? h(Fold, { id: 'inputs', icon: 'plug', title: 'Inputs', summary: summary.inputs, ...fold('inputs') },
      dynamic.map((q) => h('div', { key: `dyn-${q.name}`, className: 'fc-field' },
        h('label', null, `{{${q.name}}}`, h(InfoTip, { lines: [`Input created by {{${q.name}}} in the template.`, 'Its value comes from the wire connected to this input on the canvas.'] })),
        sources[q.name] ? h('div', { className: 'fc-linked' }, h(Icon, { name: 'link' }), 'from', h('b', null, sources[q.name]))
          : h('div', { className: 'fc-help' }, 'Not connected — drag a wire into this input, or the text stays empty.'))),
      groups.inputs.map(field)) : null,
    groups.settings.length || split.more.length || node.type === 'input.file' ? h(Fold, { id: 'settings', icon: isNote ? 'note' : 'settings',
      title: isNote ? 'Note' : 'Settings', summary: summary.settings, ...fold('settings') },
      (moreOpen ? [...groups.settings, ...split.more] : groups.settings).map(field),
      node.type === 'input.file' && p.onPickFile && p.onAddFileBelow ? h('button', {
        type: 'button', className: 'fc-btn ghost fc-add-file', 'data-fc-add-file': '1',
        title: 'Pick one more file; it becomes its own File node below this one',
        onClick: async () => {
          const picked = await p.onPickFile(params.kind)
          if (picked) p.onAddFileBelow(node.id, [{ path: picked, name: baseName(picked) }])
        }
      }, h(Icon, { name: 'add' }), 'Add another file') : null,
      split.more.length ? h('button', { type: 'button', className: 'fc-more-btn', onClick: () => setMoreOpen(!moreOpen) },
        h(Icon, { name: moreOpen ? 'chevron-up' : 'chevron-down' }),
        moreOpen ? 'Fewer settings' : `More settings (${split.more.length})`,
        h('span', { className: 'fc-muted' }, moreOpen ? '' : split.more.slice(0, 3).map((f) => f.label || f.name).join(', ') + (split.more.length > 3 ? '…' : ''))) : null) : null,
    !isNote ? h(Fold, { id: 'result', icon: 'output', title: 'Result', summary: summary.result, ...fold('result') },
      state ? h(NodeResult, { state, node, spec, runId: run.id, api, onOpenMedia: p.onOpenMedia })
        : h('div', { className: 'fc-help' }, 'Not run yet. Run the node to see its result here.')) : null,
    h(Fold, { id: 'advanced', icon: 'tools', title: 'Advanced', summary: isNote ? '' : summary.advanced, ...fold('advanced') },
      !isNote ? h('div', { className: 'fc-row' },
        h('label', { className: 'fc-check', title: 'Reuse the previous result when nothing upstream changed' },
          h('input', { type: 'checkbox', checked: cacheOn(params, spec), disabled: !!spec && spec.cacheable === false, onChange: (e) => p.onUpdateNode(node.id, { params: cachePatch(e.target.checked, spec) }) }),
          'Use cache'),
        h(InfoTip, { lines: ['Run up to here: runs this node plus everything it depends on, nothing after it.',
          'Use cache: when the settings and inputs are unchanged, the last result is reused instead of calling the tool again. Turn off for things that should change every run (news, random).',
          'Off by default for tools that may change something (write, send, post); on for tools that only read.'] })) : null,
      !isNote ? h('label', { className: 'fc-check', title: 'Off by default. Stores wired inputs after conversion in local run history. Best-effort redaction is not guaranteed to find every secret.' },
        h('input', { type: 'checkbox', 'data-fc-record-inputs': node.id, checked: node.record_inputs === true, onChange: e => p.onUpdateNode(node.id, { record_inputs: e.target.checked }) }), 'Record wired inputs (may contain sensitive data)') : null,
      state && !isNote ? h('div', { className: 'fc-row' },
        p.onOpenValue ? h('button', { type: 'button', className: 'fc-btn', 'data-fc-view-inputs': node.id, onClick: () => p.onOpenValue({ nodeId: node.id, field: 'inputs' }) }, 'View recorded inputs') : null,
        h('span', { className: 'fc-help' }, state.input_history ? ('Input history: ' + state.input_history.status) : 'Inputs not recorded')) : null,
      state && state.input_history && state.input_history.reason ? h('div', { className: 'fc-help' }, state.input_history.reason) : null,
      h('div', { className: 'fc-insp-type' }, spec ? `${spec.category} · ${spec.type}` : `${node.type} (unknown)`),
      h('button', { className: 'fc-btn danger', onClick: p.onDelete }, h(Icon, { name: 'trash' }), 'Delete node')))
}

function FlowPanel({ flow, issues, types, onUpdateFlow, onSelect }) {
  const sorted = [...issues].sort((a, b) => (a.level === 'error' ? 0 : 1) - (b.level === 'error' ? 0 : 1))
  let checks
  if (flow.nodes.length === 0) checks = h('div', { className: 'fc-help' }, 'Add nodes to get started.')
  else if (sorted.length === 0) checks = h('div', { className: 'fc-ok' }, h(Icon, { name: 'pass' }), 'Ready to run')
  else {
    checks = sorted.slice(0, 14).map((i, k) => h('div', { key: k, className: `fc-issue ${i.level}`, onClick: () => i.node && onSelect([i.node], 'replace') },
      h(Icon, { name: i.level === 'error' ? 'error' : 'warning' }),
      h('span', null, i.node ? `${nodeTitle(flow.nodes.find((n) => n.id === i.node), types.byName) || i.node}: ${i.message}` : i.message)))
  }
  return h('div', { className: 'fc-side fc-inspector' },
    h('div', { className: 'fc-section' },
      h('h4', null, 'Flow'),
      h('div', { className: 'fc-field' },
        h('label', null, 'Description', h(InfoTip, { lines: ['What the flow is for. Shown in the flow list; Hermes reads it when you ask it about this flow.'] })),
        h('textarea', {
          className: 'fc-input',
          rows: 3,
          value: flow.description || '',
          placeholder: 'What does this flow do? Hermes reads this too.',
          onChange: (e) => onUpdateFlow({ description: e.target.value }, 'meta:description')
        })),
      h('div', { className: 'fc-stats' }, `${flow.nodes.length} nodes · ${flow.edges.length} connections`)),
    h('div', { className: 'fc-section' }, h('h4', null, 'Checks'), checks),
    h('div', { className: 'fc-section' },
      h('h4', null, 'Shortcuts'),
      SHORTCUTS.map(([k, d]) => h('div', { key: k, className: 'fc-shortcut' }, h('span', null, d), h('kbd', null, k)))))
}

function Inspector(p) {
  if (p.selection.length > 1) {
    return h('div', { className: 'fc-side fc-inspector' },
      h('div', { className: 'fc-section' },
        h('h4', null, 'Selection'),
        h('div', null, `${p.selection.length} nodes selected`),
        h('div', { className: 'fc-row', style: { marginTop: 10 } },
          h('button', { className: 'fc-btn', onClick: p.onDuplicate }, h(Icon, { name: 'copy' }), 'Duplicate'),
          h('button', { className: 'fc-btn danger', onClick: p.onDelete }, h(Icon, { name: 'trash' }), 'Delete'))))
  }
  const node = p.selection.length === 1 ? p.flow.nodes.find((n) => n.id === p.selection[0]) : null
  if (!node) return h(FlowPanel, { flow: p.flow, issues: p.issues, types: p.types, onUpdateFlow: p.onUpdateFlow, onSelect: p.onSelect })
  return h(NodePanel, { ...p, node, spec: p.types.byName[node.type] })
}

