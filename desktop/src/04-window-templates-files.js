// ---------------------------------------------------------------- second window (G4)
// The pop-out button was removed for the plugin catalog (SDK surface only; the SDK has no window verb). What stays
// is the receiving side: a window that finds a fresh hand-off in shared plugin storage shows that flow.
const POPOUT_KEY = 'popout'
const POPOUT_TTL_MS = 20000
// A window opened for Arachne Flow shows ONLY Arachne Flow: the page covers the whole window (our own markup,
// `position: fixed`; app UI is never touched). sessionStorage on purpose (U-13): it is per window — so a second
// window can still be a normal one — and it survives a reload of that window, which is exactly what a full-window
// page needs; localStorage is shared by every window of the app and would flip them all.
const FOCUS_WINDOW_KEY = 'hermes.plugin.arachne-flow.focusWindow'
// The same reasoning gives each window an id (U-14): a hot reload re-runs register() in the window that opened
// the peer, so the hand-off below names its opener and only a *different* window takes it.
const WINDOW_ID_KEY = 'hermes.plugin.arachne-flow.windowId'
/** This window's id, created once and remembered in sessionStorage; `explicit` overrides it (tests). Null when
 *  there is no sessionStorage, which means "cannot tell" for the hand-off decision. */
function windowIdGet(explicit) {
  if (explicit) return explicit
  try {
    if (typeof sessionStorage === 'undefined') return null
    const known = sessionStorage.getItem(WINDOW_ID_KEY)
    if (known) return known
    const id = typeof sdk.randomUuid === 'function' ? sdk.randomUuid() : `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    sessionStorage.setItem(WINDOW_ID_KEY, id)
    return id
  } catch {
    return null
  }
}
const focusWindowGet = () => {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(FOCUS_WINDOW_KEY) === '1'
  } catch {
    return false
  }
}
const focusWindowSet = (on) => {
  SHARED.focusWindow = !!on
  try {
    if (on) sessionStorage.setItem(FOCUS_WINDOW_KEY, '1')
    else sessionStorage.removeItem(FOCUS_WINDOW_KEY)
  } catch {
    /* per-window memory is optional */
  }
}
/** The raw pop-out hand-off in shared plugin storage (localStorage, same origin in every Desktop window); null
 *  when missing, unreadable or malformed. Never throws, never clears. */
function peekPopout(storage) {
  if (!storage || typeof storage.get !== 'function') return null
  let entry = null
  try {
    entry = storage.get(POPOUT_KEY, null)
  } catch {
    return null
  }
  return entry && typeof entry === 'object' ? entry : null
}
/** Drop the hand-off (taken, or stale). Best effort, never throws. */
function clearPopout(storage) {
  if (!storage) return
  try {
    if (typeof storage.remove === 'function') storage.remove(POPOUT_KEY)
    else if (typeof storage.set === 'function') storage.set(POPOUT_KEY, null)
  } catch {
    /* best effort */
  }
}
/** Take the hand-off only in a window that is NOT the one that left it (U-14): a hot reload re-runs register()
 *  in the opener, which must not become the plugin-only window. Entries without an opener id come from an older
 *  build and are still honoured; without our own id we cannot tell, so we take it (as before). Pure, tested. */
function shouldConsumeHandoff(handoff, myId, now) {
  if (!popoutFlow(handoff, now)) return false
  const from = handoff.from
  return !(typeof from === 'string' && from && myId && from === myId)
}
/** Read and clear the pop-out hand-off: returns the flow id when it is fresh. Never throws. */
function takePopout(storage, now) {
  const entry = peekPopout(storage)
  if (entry === null || entry === undefined) return null
  clearPopout(storage)
  return popoutFlow(entry, now)
}
/** Retry the boot navigation only while the page has never mounted (U-14): once it did, leaving the page is the
 *  user's choice and a late retry must not navigate them back. Pure, tested. */
function shouldRetryNavigate(mounted, listeners) {
  return mounted !== true && !(listeners > 0)
}
/** The flow a just-booted window should show, from the hand-off the opening window left in shared plugin storage
 *  (localStorage, same origin in every Desktop window); null when missing, malformed or older than the TTL.
 *  Pure, tested. */
function popoutFlow(entry, now) {
  if (!entry || typeof entry !== 'object' || typeof entry.flowId !== 'string' || !entry.flowId) return null
  const age = now - Number(entry.at)
  return Number.isFinite(age) && age >= 0 && age < POPOUT_TTL_MS ? entry.flowId : null
}

// ---------------------------------------------------------------- templates (G5)
// Which param "Clear input values" empties per input node type (mirrors engine/store.py INPUT_RESETS).
const TEMPLATE_INPUT_PARAM = { 'input.text': 'value', 'input.number': 'value', 'input.file': 'path', 'input.json': 'value' }
/** Your templates and the built-in ones, each in the engine's order (yours by name). Pure, tested. */
function splitTemplates(templates) {
  const list = Array.isArray(templates) ? templates.filter((t) => t && t.id) : []
  return { own: list.filter((t) => t.source === 'user'), builtin: list.filter((t) => t.source !== 'user') }
}
/** Titles of the input nodes "Clear input values" would empty (those holding a value). Pure, tested. */
function filledInputs(flow) {
  return ((flow && flow.nodes) || []).filter((n) => {
    const key = TEMPLATE_INPUT_PARAM[n.type]
    const v = key && n.params ? n.params[key] : undefined
    if (v === undefined || v === null || v === '') return false
    return !(n.type === 'input.number' && Number(v) === 0)
  }).map((n) => n.title || n.type)
}

// ---------------------------------------------------------------- files (G3)
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024 // mirror of media.MAX_UPLOAD_BYTES; the server sends the real one
const MAX_DROP_FILES = 12
const FILE_NODE_MIN_H = 270 // world px a File node with an image preview takes (header + path + 170 px image)
const FILE_KIND_NAME = { image: 'Images', audio: 'Audio', video: 'Video', model3d: '3D models', file: 'Documents' }
const extOf = (name) => {
  const m = /\.[^./\\]+$/.exec(String(name || ''))
  return m ? m[0].toLowerCase() : ''
}
const baseName = (path) => String(path || '').replace(/^"+|"+$/g, '').split(/[\\/]/).filter(Boolean).pop() || ''
const formatBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)
/** Open-dialog filters for a File node: its kind first (auto = every known type, then one entry per kind),
 *  "All files" last so nothing is ever unreachable. Extensions without the dot. Pure, tested. */
function fileFilters(kind, extKinds = {}) {
  const byKind = {}
  for (const [ext, k] of Object.entries(extKinds || {})) (byKind[k] = byKind[k] || []).push(ext.replace(/^\./, ''))
  const all = { name: 'All files', extensions: ['*'] }
  if (kind && kind !== 'auto') {
    return byKind[kind] ? [{ name: FILE_KIND_NAME[kind] || kind, extensions: byKind[kind] }, all] : [all]
  }
  const known = Object.keys(FILE_KIND_NAME).filter((k) => byKind[k])
  if (!known.length) return [all]
  return [{ name: 'Media and documents', extensions: known.flatMap((k) => byKind[k]) },
    ...known.map((k) => ({ name: FILE_KIND_NAME[k], extensions: byKind[k] })), all]
}
/** Can this dropped file be uploaded? {ok, kind} or {ok: false, reason}. Pure, tested. */
function checkDropFile(file, extKinds = {}, maxBytes = UPLOAD_MAX_BYTES) {
  const name = String((file && file.name) || '')
  const ext = extOf(name)
  if (!ext || !extKinds[ext]) return { ok: false, reason: `${name || 'file'}: ${ext || 'no extension'} is not a supported file type` }
  const size = Number(file && file.size) || 0
  if (size > maxBytes) {
    return { ok: false, reason: `${name} is ${formatBytes(size)}; drops are limited to ${formatBytes(maxBytes)} — use Browse… in the File node instead` }
  }
  return { ok: true, kind: extKinds[ext] }
}
/** The node's picked_files after the user picked `path` (signed `token`): keeps only picks the node still names
 *  in a setting, plus the new one. Picks prove a canvas choice to the backend (engine/picks.py). Pure, tested. */
function pickedFilesWith(params, path, token) {
  const named = new Set()
  const walk = (v, depth = 0) => {
    if (depth > 4) return
    if (typeof v === 'string') {
      named.add(v.trim())
      if (v.trim().startsWith('[')) {
        try { walk(JSON.parse(v), depth + 1) } catch { /* a plain text, not a stored media list */ }
      }
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1))
  }
  const own = params || {}
  for (const [k, v] of Object.entries(own)) if (k !== PICKED_FILES) walk(v)
  const out = {}
  const old = own[PICKED_FILES] && typeof own[PICKED_FILES] === 'object' ? own[PICKED_FILES] : {}
  for (const [p, t] of Object.entries(old)) if (named.has(p) && typeof t === 'string') out[p] = t
  if (path && token) out[path] = token
  return out
}
const PICKED_FILES = 'picked_files'
/** Where dropped files land: one node per file, side by side from the drop point. Pure, tested. */
const dropSpots = (n, x, y) => range(n).map((i) => ({ x: x + i * (NODE_W + 40), y }))
/** File nodes for already stored files, placed from (x, y) without overlapping. Pure, tested. */
function fileNodes(flow, files, x, y, spec) {
  let next = flow
  const added = []
  dropSpots(files.length, x, y).forEach((pos, i) => {
    const spot = freeSpot(next, snap(pos.x), snap(pos.y))
    const { flow: grown, node } = addNode(next, {
      type: 'input.file', x: spot.x, y: spot.y, title: files[i].name || undefined,
      params: { ...defaultParams(spec), path: files[i].path }
    })
    next = grown
    added.push(node)
  })
  return added
}
const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result || ''))
  reader.onerror = () => reject(reader.error || new Error('could not read the file'))
  reader.readAsDataURL(file)
})
function countStatuses(run) {
  const counts = {}
  for (const st of Object.values((run && run.nodes) || {})) {
    const s = (st && st.status) || 'queued'
    counts[s] = (counts[s] || 0) + 1
  }
  return counts
}
const isRunActive = (run) => !!run && (run.status === 'starting' || (!!run.id && !TERMINAL.has(run.status)))

/**
 * Returns value ports for a completed or cached node state.
 * @param {Object} nodeState
 * @returns {Array<{ port: string, kind: string }>}
 */
function valuePorts(nodeState, includePrivate = false) {
  if (!nodeState || (nodeState.status !== 'done' && nodeState.status !== 'cached')) {
    return []
  }
  const outputs = nodeState.outputs
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {
    return []
  }
  const ports = []
  for (const [key, val] of Object.entries(outputs)) {
    if ((!includePrivate && key.startsWith('_')) || val === undefined) {
      continue
    }
    let kind = 'json'
    if (typeof val === 'string') {
      kind = 'text'
    } else if (isMedia(val) || (Array.isArray(val) && val.length > 0 && val.every(isMedia))) {
      kind = 'media'
    }
    ports.push({ port: key, kind })
  }
  return ports
}

const MAX_VALUE_PAGES = 4096

function valueFieldPorts(nodeState, field) {
  if (field !== 'inputs') return valuePorts(nodeState)
  if (!nodeState || !nodeState.inputs) return []
  return valuePorts({ status: 'done', outputs: nodeState.inputs }, true).map(p => p.kind === 'media' ? { ...p, kind: 'json' } : p)
}

async function loadRunValue(api, runId, nodeId, port, { limit = 65536, maxPages = 512, field = 'outputs' } = {}) {
  function codePointLength(str) {
    let count = 0
    for (let i = 0; i < str.length; i++) {
      count++
      const code = str.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
        const next = str.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          i++
        }
      }
    }
    return count
  }

  try {
    let lim = Math.floor(Number(limit))
    if (!Number.isFinite(lim) || lim < 1) lim = 1
    else if (lim > 65536) lim = 65536

    let maxP = Math.floor(Number(maxPages))
    if (!Number.isFinite(maxP) || maxP < 0) maxP = 0
    else if (maxP > MAX_VALUE_PAGES) maxP = MAX_VALUE_PAGES

    let offset = 0
    let pagesRead = 0
    const chunks = []
    let expectedKind = null
    let expectedTotalChars = null
    let expectedVersion = null
    let expectedExpanded = null

    while (true) {
      if (pagesRead >= maxP) {
        return {
          status: 'error',
          code: 0,
          reason: 'Page budget exceeded: too many pages',
        }
      }

      let page
      try {
        if (!api || typeof api.runValue !== 'function') {
          throw new Error('api.runValue is not a function')
        }
        page = field === 'inputs' ? await api.runValue(runId, nodeId, port, offset, lim, expectedVersion, field) : await api.runValue(runId, nodeId, port, offset, lim, expectedVersion)
      } catch (err) {
        const e = parseRestError(err)
        if (e.status === 409 || e.status === 413 || e.status === 422) {
          return { status: 'unavailable', code: e.status, reason: e.message }
        }
        return { status: 'error', code: e.status, reason: e.message }
      }

      pagesRead++

      if (!page || typeof page !== 'object' || Array.isArray(page)) {
        return { status: 'error', code: 0, reason: 'Page must be a non-null non-array object' }
      }

      if (typeof page.kind !== 'string' || page.kind.length === 0) {
        return { status: 'error', code: 0, reason: 'Page kind must be a non-empty string' }
      }
      if (expectedKind === null) {
        expectedKind = page.kind
      } else if (page.kind !== expectedKind) {
        return { status: 'error', code: 0, reason: `Page kind mismatch: expected ${expectedKind}, got ${page.kind}` }
      }

      if (typeof page.version !== 'string' || !/^[0-9a-f]{64}$/.test(page.version)) {
        return { status: 'error', code: 0, reason: 'Page version must be a 64-character lowercase hex string' }
      }
      if (expectedVersion === null) {
        expectedVersion = page.version
      } else if (page.version !== expectedVersion) {
        return { status: 'error', code: 0, reason: `Page version mismatch: expected ${expectedVersion}, got ${page.version}` }
      }

      if (page.expanded !== undefined && typeof page.expanded !== 'boolean') {
        return { status: 'error', code: 0, reason: 'Invalid expansion provenance' }
      }
      const expanded = page.expanded === true
      if (expectedExpanded === null) expectedExpanded = expanded
      else if (expectedExpanded !== expanded) {
        return { status: 'error', code: 0, reason: 'Page expansion provenance mismatch' }
      }

      if (typeof page.chunk !== 'string') {
        return { status: 'error', code: 0, reason: 'Page chunk must be a string' }
      }

      if (!Number.isInteger(page.offset) || page.offset !== offset) {
        return { status: 'error', code: 0, reason: `Invalid page offset: expected ${offset}, got ${page.offset}` }
      }

      if (!Number.isInteger(page.total_chars) || page.total_chars < 0) {
        return { status: 'error', code: 0, reason: 'Page total_chars must be an integer >= 0' }
      }
      if (expectedTotalChars === null) {
        expectedTotalChars = page.total_chars
      } else if (page.total_chars !== expectedTotalChars) {
        return { status: 'error', code: 0, reason: `Page total_chars mismatch: expected ${expectedTotalChars}, got ${page.total_chars}` }
      }

      const chunkLen = codePointLength(page.chunk)

      if (offset + chunkLen > page.total_chars) {
        return {
          status: 'error',
          code: 0,
          reason: `Chunk pushes past total_chars: offset ${offset} + length ${chunkLen} > total_chars ${page.total_chars}`,
        }
      }

      if (page.chunk.length > 0) {
        const first = page.chunk.charCodeAt(0)
        if (first >= 0xdc00 && first <= 0xdfff) {
          return { status: 'error', code: 0, reason: 'Chunk begins inside a UTF-16 surrogate pair' }
        }
        const last = page.chunk.charCodeAt(page.chunk.length - 1)
        if (last >= 0xd800 && last <= 0xdbff) {
          return { status: 'error', code: 0, reason: 'Chunk ends inside a UTF-16 surrogate pair' }
        }
      }

      if (page.next_offset === null) {
        if (offset + chunkLen !== page.total_chars) {
          return {
            status: 'error',
            code: 0,
            reason: `Incomplete page: next_offset is null but offset (${offset}) + chunk length (${chunkLen}) !== total_chars (${page.total_chars})`,
          }
        }
        chunks.push(page.chunk)
        return {
          status: 'ready',
          kind: expectedKind,
          text: chunks.join(''),
          totalChars: expectedTotalChars,
          pages: pagesRead,
          expanded: expectedExpanded,
        }
      }

      if (
        !Number.isInteger(page.next_offset) ||
        page.next_offset !== offset + chunkLen ||
        page.next_offset >= page.total_chars ||
        page.next_offset <= offset
      ) {
        return {
          status: 'error',
          code: 0,
          reason: `Malformed page: next_offset (${page.next_offset}) does not advance (expected ${offset + chunkLen} < total_chars ${page.total_chars})`,
        }
      }

      chunks.push(page.chunk)
      offset = page.next_offset
    }
  } catch (err) {
    const e = parseRestError(err)
    if (e.status === 409 || e.status === 413 || e.status === 422) {
      return { status: 'unavailable', code: e.status, reason: e.message }
    }
    return { status: 'error', code: e.status, reason: e.message }
  }
}

function makeApi(ctx) {
  const call = (method, path, body, timeoutMs) => {
    const opts = { method }
    if (body !== undefined) opts.body = body
    if (timeoutMs) opts.timeoutMs = timeoutMs
    return ctx.rest(`/x/${path}`, opts)
  }
  const qs = (params) =>
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
  return {
    nodeTypes: (fresh) => call('GET', fresh ? 'node-types?fresh=1' : 'node-types'),
    flows: () => call('GET', 'flows'),
    templates: () => call('GET', 'templates'),
    timings: () => call('GET', 'timings'),
    saveTemplate: (body) => call('POST', 'templates', { ...body, origin: 'ui' }),
    updateTemplate: (id, body) => call('PUT', `templates/${encodeURIComponent(id)}`, { ...body, origin: 'ui' }),
    deleteTemplate: (id) => call('DELETE', `templates/${encodeURIComponent(id)}`, { origin: 'ui' }),
    createFlow: (body) => call('POST', 'flows', { ...body, origin: 'ui' }),
    getFlow: (id) => call('GET', `flows/${encodeURIComponent(id)}`),
    saveFlow: (id, flow, base) => call('PUT', `flows/${encodeURIComponent(id)}`, { flow, base_revision: base, origin: 'ui' }),
    deleteFlow: (id) => call('DELETE', `flows/${encodeURIComponent(id)}`),
    duplicate: (id) => call('POST', `flows/${encodeURIComponent(id)}/duplicate`, { origin: 'ui' }),
    layout: (id, base, nodeSizes = {}) => call('POST', `flows/${encodeURIComponent(id)}/layout`, { base_revision: base, node_sizes: nodeSizes, origin: 'ui' }),
    messagingOptIn: (id, nodeId, enable, base, allowAttachments = false) => call('POST', `flows/${encodeURIComponent(id)}/messaging-optin`,
      { node_id: nodeId, enable: !!enable, allow_attachments: allowAttachments === true, base_revision: base, origin: 'ui' }),
    triggerStatus: (id) => call('GET', `flows/${encodeURIComponent(id)}/triggers`),
    triggerSwitch: (id, nodeId, active, base, rotate = false) => call('POST', `flows/${encodeURIComponent(id)}/trigger`,
      { node_id: nodeId, active: !!active, rotate: rotate === true, base_revision: base, origin: 'ui' }),
    validate: (flowId) => call('POST', 'validate', { flow_id: flowId }),
    generate: (body) => call('POST', 'generate', body, 420000),
    generateStart: (body) => call('POST', 'generate/jobs', body),
    // Long poll: the backend answers on the next phase change or after `wait` seconds.
    generateJob: (id) => call('GET', `generate/jobs/${encodeURIComponent(id)}?wait=${GENERATE_POLL_WAIT_S}`, undefined, (GENERATE_POLL_WAIT_S + 20) * 1000),
    generateCancel: (id) => call('DELETE', `generate/jobs/${encodeURIComponent(id)}`),
    startRun: (body) => call('POST', 'runs', body),
    runs: (flowId, limit) => call('GET', `runs?${qs({ flow_id: flowId, limit })}`),
    run: (id) => call('GET', `runs/${encodeURIComponent(id)}`),
    cancel: (id) => call('POST', `runs/${encodeURIComponent(id)}/cancel`, {}),
    options: (type, param, refresh, model) => call('GET', `options?${qs({ type, param, model, refresh: refresh ? 1 : '' })}`, undefined, 120000),
    llmInfo: (provider, model, apiUrl, name) => call('GET', `llm-info?${qs({ provider, model, api_url: apiUrl, name })}`, undefined, 120000),
    // Canvas drops (U-10): the SDK's `upload` option posts the file as multipart, bytes on the wire instead of a
    // base64 data URL (+33 % and a 25 MB string). A host that cannot send multipart at all — an OAuth remote throws
    // "File uploads are not supported…" — falls back to the JSON body the same route still accepts.
    upload: async (name, file) => {
      const bytes = file && typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : null
      if (bytes) {
        try {
          return await ctx.rest('/x/uploads', {
            method: 'POST',
            upload: { filename: name, contentType: (file && file.type) || 'application/octet-stream', bytes },
            timeoutMs: 180000
          })
        } catch (err) {
          if (parseRestError(err).status) throw err   // the route answered (413 too large…): that is final
        }
      }
      return call('POST', 'uploads', { name, data_url: await readAsDataUrl(file) }, 180000)
    },
    fileNode: (flowId, node, thumb) => call('GET', `flows/${encodeURIComponent(flowId)}/file?${qs({ node, thumb })}`, undefined, 30000),
    // A file the user just chose with Browse…: the backend signs (flow, node, path) so a run accepts it (picks.py).
    filePick: (flowId, nodeId, path, folder = false) => call('POST', `flows/${encodeURIComponent(flowId)}/file-pick`, { node_id: nodeId, path, folder: folder === true, origin: 'ui' }),
    media: (runId, node, port, thumb, index) =>
      call('GET', `runs/${encodeURIComponent(runId)}/media?${qs({ node, port, thumb, index })}`, undefined, 60000),
    runValue: (runId, node, port, offset, limit, version, field = 'outputs') => {
      const params = { node, port, offset, limit, consistent: 1 }
      if (field === 'inputs') params.field = 'inputs'
      if (version !== null && version !== undefined) params.version = version
      return call('GET', `runs/${encodeURIComponent(runId)}/value?${qs(params)}`, undefined, 60000)
    }
  }
}

