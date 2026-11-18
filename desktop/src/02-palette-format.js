// ---- palette
/** Searchable text of a node type with a weight per field: title, then id/tool/category, then description and ports. */
function typeSearchFields(t) {
  const ports = [...(t.inputs || []), ...(t.outputs || [])].map((p) => `${p.name} ${p.label || ''} ${p.type || ''}`).join(' ')
  return [
    [String(t.title || '').toLowerCase(), 4],
    [`${t.type} ${t.tool || ''} ${t.category || ''}`.toLowerCase(), 2],
    [String(t.description || '').toLowerCase(), 1],
    [ports.toLowerCase(), 1]
  ]
}
/** Palette and quick-search filter. Every word must appear in the title, id, tool, category, description or a port
 *  (name, label, type). Best match first: title hits outrank id/category hits, which outrank description/port hits;
 *  ties keep registry order. Pure, tested. */
function filterTypes(types, query) {
  // Other providers of a ready-made step are not separate entries: the node's Provider setting switches them.
  types = (types || []).filter((t) => t && t.palette !== false)
  const q = (query || '').trim().toLowerCase()
  if (!q) return types
  const words = q.split(/\s+/)
  const scored = []
  types.forEach((t, i) => {
    const fields = typeSearchFields(t)
    let score = 0
    for (const w of words) {
      let best = 0
      for (const [text, weight] of fields) if (weight > best && text.includes(w)) best = weight
      if (!best) return
      score += best
    }
    const title = fields[0][0]
    if (title === q) score += 10
    else if (title.startsWith(q)) score += 5
    scored.push({ t, i, score })
  })
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  return scored.map((s) => s.t)
}
function groupByCategory(types) {
  const groups = []
  const index = new Map()
  for (const t of types) {
    const c = t.category || 'Other'
    if (!index.has(c)) {
      index.set(c, groups.length)
      groups.push({ category: c, items: [] })
    }
    groups[index.get(c)].items.push(t)
  }
  return groups
}

/** Most-recently-used node ids: unique, valid strings only, newest first, capped at eight. */
function rememberType(recent, type) {
  const old = Array.isArray(recent) ? recent : []
  const clean = old.filter((id) => typeof id === 'string' && id.trim() && id !== type)
  if (typeof type !== 'string' || !type.trim()) return clean.slice(0, 8)
  return [type, ...clean].slice(0, 8)
}

/** Resolve persisted ids against the current registry, dropping duplicates and unavailable tools. */
function resolveRecentTypes(types, recent) {
  if (!Array.isArray(recent)) return []
  const byName = new Map((types || []).map((t) => [t.type, t]))
  const seen = new Set()
  const out = []
  for (const id of recent) {
    if (seen.has(id) || !byName.has(id)) continue
    seen.add(id)
    out.push(byName.get(id))
  }
  return out
}

// ---- formatting and parsing
function formatMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`
  const m = Math.floor(ms / 60000)
  return `${m} min ${Math.round((ms % 60000) / 1000)} s`
}
function ago(iso, now = Date.now()) {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}
/** Desktop's bridge throws "Error invoking remote method 'hermes:api': Error: 409: {json}". */
function parseRestError(err) {
  const message = String((err && err.message) || err || 'request failed')
  const m = message.match(/\b(\d{3}):\s*([\s\S]*)$/)
  if (!m) return { status: 0, detail: null, message }
  const body = m[2].trim()
  let detail = body
  try {
    const parsed = JSON.parse(body)
    detail = parsed && typeof parsed === 'object' && 'detail' in parsed ? parsed.detail : parsed
  } catch {
    detail = body
  }
  let text = detail
  if (detail && typeof detail === 'object') text = detail.message || detail.code || JSON.stringify(detail)
  return { status: Number(m[1]), detail, message: String(text || `HTTP ${m[1]}`) }
}
/** First media value among a node's outputs: {port, index, kind, media} or null. */
function findMedia(outputs) {
  const all = outputs || {}
  for (const [port, v] of Object.entries(all)) {
    if (port.startsWith('_')) continue
    if (isMedia(v)) return { port, index: 0, kind: v.$media.kind || 'file', media: v.$media }
    if (Array.isArray(v) && v.length && isMedia(v[0])) return { port, index: 0, kind: v[0].$media.kind || 'file', media: v[0].$media }
  }
  const extra = Array.isArray(all._media) ? all._media.find(isMedia) : null
  return extra ? { port: '_media', index: 0, kind: extra.$media.kind || 'file', media: extra.$media } : null
}
/** Every media file of a run in run order, for the lightbox: [{key, nodeId, port, index, kind, media, title, portLabel}].
 *  `index` counts media within the port the same way the media route does; a file seen twice (a preview node
 *  passing it on) is listed once, at its first producer. */
function runMediaList(run, flow, typesByName = {}) {
  if (!run || !run.nodes) return []
  const nodes = new Map(((flow && flow.nodes) || []).map((n) => [n.id, n]))
  const order = run.order && run.order.length ? [...run.order] : []
  for (const id of Object.keys(run.nodes)) if (!order.includes(id)) order.push(id)
  const seen = new Set()
  const out = []
  for (const nodeId of order) {
    const state = run.nodes[nodeId]
    if (!state || (state.status !== 'done' && state.status !== 'cached')) continue
    const node = nodes.get(nodeId)
    const spec = node ? typesByName[node.type] : null
    const title = node ? nodeTitle(node, typesByName) : nodeId
    const outputs = state.outputs || {}
    const ports = Object.keys(outputs).filter((k) => !k.startsWith('_'))
    if (Array.isArray(outputs._media)) ports.push('_media')
    for (const port of ports) {
      const v = outputs[port]
      const list = isMedia(v) ? [v] : Array.isArray(v) ? v.filter(isMedia) : []
      const outSpec = spec && spec.outputs ? spec.outputs.find((o) => o.name === port) : null
      list.forEach((m, index) => {
        const id = m.$media.path || m.$media.file || `${nodeId}|${port}|${index}`
        if (seen.has(id)) return
        seen.add(id)
        out.push({
          key: `${nodeId}|${port}|${index}`, nodeId, port, index, kind: m.$media.kind || 'file', media: m.$media, title,
          portLabel: port === '_media' ? 'Files' : (outSpec && outSpec.label) || port
        })
      })
    }
  }
  return out
}
/** Mini entries of a node card: one per output value (one per file for a media list), in output order, as
 *  {items: [{key, port, label, kind, badge, detail, media?, index?, link?}], more, total}; at most `max` items,
 *  `more` is the rest. Media comes from runMediaList (same keys, indexes and de-duplication as the lightbox) plus
 *  media nested one or two levels inside a plain object, which the lightbox cannot address (`link: false`).
 *  A medium without a file or with an unknown type is kind 'broken'. Text/JSON gets one collapsed line. Pure, no I/O. */
const MINI_MAX = 4
const MINI_BADGE = { image: 'Image', audio: 'Audio', video: 'Video', model3d: '3D', file: 'File', text: 'Text', json: 'JSON', broken: 'Missing' }
const MINI_KINDS = new Set(Object.keys(MINI_BADGE).filter((k) => k !== 'broken'))
const MEDIA_EXT = { image: 'IMG', audio: 'AUDIO', video: 'VIDEO', model3d: '3D', file: 'FILE' }
const EXT_BY_MIME = {
  'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/webp': 'WEBP', 'image/gif': 'GIF', 'image/svg+xml': 'SVG',
  'video/mp4': 'MP4', 'video/webm': 'WEBM', 'video/quicktime': 'MOV',
  'audio/mpeg': 'MP3', 'audio/wav': 'WAV', 'audio/ogg': 'OGG', 'audio/mp4': 'M4A',
  'model/gltf-binary': 'GLB', 'model/gltf+json': 'GLTF'
}
/** `EXT` of a medium: the mime subtype's short form, else the file extension, else the kind. */
function mediaExt(info) {
  const mime = String((info && info.mime) || '').toLowerCase()
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime]
  const name = String((info && (info.file || info.path)) || '')
  const ext = (name.match(/\.([a-z0-9]{1,6})$/i) || [])[1]
  return ext ? ext.toUpperCase() : MEDIA_EXT[(info && info.kind) || 'file'] || 'FILE'
}
/** Generated names (`n_5d0a5f-1-0.png`, `job0.glb`) tell a reader nothing; uploaded names do. */
const AUTO_NAME = /^[a-z]+_[0-9a-f]{4,}(-|\.|$)|^[\w-]*job\d+\./i
function mediaDetail(info) {
  const name = String((info && (info.file || info.path)) || '').split(/[\\/]/).pop() || ''
  return !name || AUTO_NAME.test(name) ? mediaExt(info) : name
}
/** Media values inside an output, including arrays and one level of wrapping objects (`{images: [...]}`). */
function collectMedia(v, out, depth = 0) {
  if (isMedia(v)) { out.push(v); return out }
  if (Array.isArray(v)) {
    for (const e of v) if (isMedia(e)) out.push(e)
    return out
  }
  if (v && typeof v === 'object' && depth < 2) {
    for (const key of Object.keys(v)) {
      if (key.startsWith('_') || key.startsWith('$')) continue
      const e = v[key]
      if (isMedia(e)) out.push(e)
      else if (Array.isArray(e)) for (const x of e) isMedia(x) && out.push(x)
      else if (e && typeof e === 'object' && depth < 1) collectMedia(e, out, depth + 1)
    }
  }
  return out
}
function nodeOutputItems(node, state, typesByName = {}, max = MINI_MAX) {
  const none = { items: [], more: 0, total: 0 }
  if (!node || !state || (state.status !== 'done' && state.status !== 'cached')) return none
  const outputs = state.outputs
  if (!outputs || typeof outputs !== 'object') return none
  const listed = new Map()
  for (const m of runMediaList({ nodes: { [node.id]: state } }, { nodes: [node] }, typesByName)) listed.set(m.key, m)
  const linked = new Set([...listed.values()].map((m) => m.media && (m.media.path || m.media.file)).filter(Boolean))
  const spec = typesByName[node.type]
  const label = (port) => {
    const o = spec && spec.outputs ? spec.outputs.find((x) => x.name === port) : null
    const raw = (o && o.label) || (port === '_media' ? 'Files' : port)
    return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw
  }
  const all = []
  const ports = Object.keys(outputs).filter((k) => !k.startsWith('_'))
  if (Array.isArray(outputs._media)) ports.push('_media')
  for (const port of ports) {
    const v = outputs[port]
    if (v === undefined) continue
    const found = collectMedia(v, [])
    if (found.length) {
      found.forEach((m, index) => {
        const info = (m && m.$media) || {}
        const hit = listed.get(`${node.id}|${port}|${index}`)
        const kind = String(info.kind || 'file')
        const ok = MINI_KINDS.has(kind) && !!(info.path || info.file)
        // a medium that lives inside a wrapper object is not addressable by the media route: show it, no lightbox
        const link = !!hit && ok && linked.has(info.path || info.file)
        all.push({
          key: hit ? hit.key : `${node.id}|${port}|x${index}`,
          port, index, media: info, link,
          label: found.length > 1 ? `${label(port)} ${index + 1}` : label(port),
          kind: ok ? kind : 'broken',
          badge: MINI_BADGE[ok ? kind : 'broken'],
          detail: ok ? mediaDetail(info) : 'Unavailable'
        })
      })
      if (isMedia(v) || (Array.isArray(v) && v.length > 0 && v.every(isMedia))) continue
    }
    let raw = ''
    try {
      if (v === null) raw = 'null'
      else if (typeof v === 'boolean' || typeof v === 'number') raw = String(v)
      else if (v === '') raw = 'Empty string'
      else if (typeof v === 'string') raw = v
      else if (v && typeof v === 'object' && v.$large) raw = String(v.$large.preview || '').trim()
      else raw = String(previewString(v) || '')
    } catch {
      raw = 'Value'
    }
    if (!raw) raw = 'Value'
    const kind = v && typeof v === 'object' && !v.$large ? 'json' : 'text'
    const detail = kind === 'json' ? raw.replace(/\s+/g, ' ') : raw
    all.push({
      key: `${node.id}|${port}`,
      port,
      label: label(port),
      kind,
      badge: MINI_BADGE[kind],
      detail: detail.length > 240 ? `${detail.slice(0, 240)}…` : detail
    })
  }
  return { items: all.slice(0, max), more: Math.max(0, all.length - max), total: all.length }
}
/** Zoom the lightbox image by `factor` around point `p` (relative to the stage centre); zoom 1 = fit, re-centred. */
function lightboxZoom(view, factor, p = { x: 0, y: 0 }, min = 1, max = 8) {
  const zoom = clamp(view.zoom * factor, min, max)
  if (zoom <= min + 1e-6) return { zoom: min, x: 0, y: 0 }
  const k = zoom / view.zoom
  return { zoom, x: p.x - (p.x - view.x) * k, y: p.y - (p.y - view.y) * k }
}
function previewString(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (isMedia(v)) return v.$media.file || v.$media.kind || ''
  if (typeof v === 'object' && v.$large) return v.$large.preview || ''
  return JSON.stringify(v)
}
function paramSummary(node, spec, connected, max = 3) {
  const out = []
  const params = node.params || {}
  const labels = new Map(((spec && spec.params) || []).map((p) => [p.name, p.label || p.name]))
  const hidden = new Set(((spec && spec.params) || []).filter((p) => p.hidden).map((p) => p.name))
  const defaults = new Map(((spec && spec.params) || []).map((p) => [p.name, p.default]))
  for (const [name, value] of Object.entries(params)) {
    if (out.length >= max) break
    if (name === 'cache' || name === 'timeout_s' || hidden.has(name) || (connected && connected.has(name)) || isBlank(value)) continue
    if (defaults.has(name) && JSON.stringify(defaults.get(name)) === JSON.stringify(value)) continue
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    out.push([labels.get(name) || name, text.replace(/\s+/g, ' ').slice(0, 140)])
  }
  return out
}
const KIND_HINT = {
  text: 'Text.', textarea: 'Text; can span several lines.', number: 'A number, e.g. 3 or 0.5.',
  boolean: 'On or off.', select: 'Pick one of the listed values.', json: 'JSON: an object {…}, a list […] or a plain value.',
  media: 'A public URL, data URL or local file. Browse… chooses a file. A connected list supplies its first item.',
  media_list: 'Several public URLs, data URLs or local files. Add files with Browse… or connect several wires.',
  tool: 'A Hermes tool name.', model: 'A model from your configured Hermes providers.'
}

/** Lines for a setting's info tip: description (or a type hint), required/default, wire hint. Pure, tested. */
function paramInfo(spec, { port = false } = {}) {
  const lines = []
  if (spec.description) lines.push(String(spec.description))
  else lines.push(KIND_HINT[spec.kind] || 'A value for this setting.')
  if (spec.required) lines.push('Required.')
  const d = spec.default
  if (d !== null && d !== undefined && d !== '' && !(Array.isArray(d) && !d.length)) {
    lines.push(`Default: ${typeof d === 'string' ? d : JSON.stringify(d)}`)
  } else if (!spec.required && spec.kind !== 'boolean') lines.push('Optional — leave empty to use the default.')
  if (port) lines.push('Can also come from a wire: connect another node into this input on the canvas.')
  return lines
}

/**
 * Inspector fields → {main, more}. Built-in nodes show everything. Tool/preset nodes show required settings,
 * model pickers, connected or edited settings, and the preset's own inputs; the rest folds under "More settings".
 */
function splitFields(fields, { spec, params = {}, connected = new Set(), modelFields = {} } = {}) {
  const visible = (fields || []).filter((f) => !f.hidden)
  // Small tools stay flat; folding pays off from six settings on.
  if (!spec || spec.kind === 'builtin' || !spec.kind || visible.length <= 5) return { main: visible, more: [] }
  const inputs = new Set((spec.inputs || []).map((q) => q.name))
  const main = []
  const more = []
  for (const f of visible) {
    const value = params[f.name]
    const edited = !isBlank(value) && JSON.stringify(value) !== JSON.stringify(f.default)
    // G7: a setting the chosen model describes (size, duration, …) is worth seeing.
    const core = f.required || f.options_source || f.kind === 'model' || connected.has(f.name) || edited ||
      (spec.kind === 'preset' && inputs.has(f.name)) || !!(modelFields && modelFields[f.name])
    ;(core ? main : more).push(f)
  }
  return { main, more }
}

/** Inspector layout B (18.11.2026): the visible settings sorted into the sections a user works through —
 *  Provider & model (the model and its auto mode, an LLM model field), Inputs (settings that are also input ports)
 *  and Settings (the rest). Folded "more" settings always stay under Settings. Pure, tested. */
function inspectorGroups(fields, { modelNames = new Set(), portNames = new Set() } = {}) {
  const out = { model: [], inputs: [], settings: [] }
  for (const f of fields || []) {
    if (modelNames.has(f.name) || f.kind === 'model') out.model.push(f)
    else if (portNames.has(f.name)) out.inputs.push(f)
    else out.settings.push(f)
  }
  return out
}

/** One-line summaries a folded inspector section shows on the right. Pure, tested. */
function inspectorSummaries({ provider = '', model = '', inputs = 0, wired = 0, settings = 0, more = 0, status = '',
  cache = true, recorded = false } = {}) {
  return {
    model: [provider, model].filter(Boolean).join(' · '),
    inputs: inputs ? `${wired} of ${inputs} connected` : '',
    settings: settings || more ? `${settings} setting${settings === 1 ? '' : 's'}${more ? ` · ${more} more` : ''}` : '',
    result: status || 'not run yet',
    advanced: `cache ${cache ? 'on' : 'off'}${recorded ? ' · inputs recorded' : ''}`
  }
}

/** Palette groups → sections: Ready-made presets first, built-ins, then Hermes tools and MCP servers. Each section
 *  has an icon and a colour; `flat` = items render without category sub-headers. Pure, tested. */
// Sub-groups of "Ready-made" (engine: presets.PRESET_GROUP_ORDER); unknown groups follow alphabetically.
const PRESET_GROUP_ORDER = ['General', 'Image', 'Video', '3D', 'Audio']
const READY_PREFIX = 'Ready · '

/** The Presets category split by each node's `group` ("Ready · Image", …), in PRESET_GROUP_ORDER. Pure, tested. */
function presetGroups(groups) {
  const by = new Map()
  for (const t of groups.flatMap((g) => g.items)) {
    const name = String(t.group || 'General')
    if (!by.has(name)) by.set(name, [])
    by.get(name).push(t)
  }
  const rank = (g) => { const i = PRESET_GROUP_ORDER.indexOf(g); return i < 0 ? PRESET_GROUP_ORDER.length : i }
  return [...by.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((g) => ({ category: READY_PREFIX + g, items: by.get(g) }))
}

function paletteSections(groups, recents = []) {
  const presetRaw = groups.filter((g) => g.category === 'Presets')
  const preset = presetGroups(presetRaw)
  const tools = groups.filter((g) => g.category.startsWith('Tools'))
  const mcp = groups.filter((g) => g.category.startsWith('MCP'))
  const builtin = groups.filter((g) => !presetRaw.includes(g) && !tools.includes(g) && !mcp.includes(g))
  const count = (list) => list.reduce((n, g) => n + g.items.length, 0)
  const sec = (id, label, counted, hint, groups, open, icon, color) =>
    ({ id, label, title: counted ? `${label} · ${count(groups)}` : label, count: count(groups), hint, groups, open, icon, color,
      flat: (id === 'ready' || id === 'recent') && groups.length === 1 })
  return [
    sec('recent', 'Recently used', false, 'Your most recently added nodes.',
      recents.length ? [{ category: 'Recently used', items: recents }] : [], true, 'history', 'var(--ui-accent)'),
    sec('ready', 'Ready-made', false, 'Curated nodes with good defaults — start here.', preset, true, 'star-full', categoryColor('Presets')),
    sec('basic', 'Basics', false, 'Inputs, LLM, text and data helpers, outputs.', builtin, true, 'layers', 'var(--ui-cyan)'),
    sec('tools', 'Hermes tools', true, 'Every tool Hermes has, one node each.', tools, false, 'tools', categoryColor('Tools')),
    sec('mcp', 'MCP servers', true, 'Tools from your connected MCP servers.', mcp, false, 'plug', categoryColor('MCP'))
  ].filter((s) => s.groups.length)
}

/** Every fold of the palette with its default state: one per section (key "§id") and one per category inside a
 *  non-flat section (key = category; open by default only in Basics). Pure, tested. */
function paletteFolds(sections) {
  const out = []
  for (const sec of sections || []) {
    out.push({ key: `§${sec.id}`, def: !!sec.open })
    if (sec.flat) continue
    for (const g of sec.groups) out.push({ key: g.category, def: sec.id === 'basic' || sec.id === 'ready' })
  }
  return out
}
const foldOpen = (open, key, def) => (open && typeof open[key] === 'boolean' ? open[key] : def)
const allFoldsOpen = (sections, open) => paletteFolds(sections).every((f) => foldOpen(open, f.key, f.def))
/** Fold map with every section and category set to `value` (the "expand all / collapse all" button). */
function setAllFolds(sections, value) {
  const out = {}
  for (const f of paletteFolds(sections)) out[f.key] = !!value
  return out
}

const KIND_LABEL = { preset: 'Ready-made', tool: 'Hermes tool' }
/** Facts for a palette entry's tooltip: kind, description, ports (max six each), typical duration, cost, tool.
 *  Pure, tested. */
function typeTip(spec, portTypes = {}, maxPorts = 6, timings = null) {
  const t = spec || {}
  const cat = String(t.category || '')
  const kind = cat.startsWith('MCP') ? cat : KIND_LABEL[t.kind] || 'Built-in'
  // type is left empty when it only repeats the port name ("Image · Image"); outputs are never optional
  const port = (input) => (p) => {
    const name = String(p.label || p.name)
    const type = typeLabel(p.type || 'any', portTypes)
    return { name, type: type.toLowerCase() === name.toLowerCase() ? '' : type, color: portColor(p.type, portTypes),
      optional: input && !p.required }
  }
  const inputs = (t.inputs || []).map(port(true))
  const outputs = (t.outputs || []).map(port(false))
  let description = String(t.description || '').replace(/\s+/g, ' ').trim()
  if (description.length > 240) description = `${description.slice(0, 237).trimEnd()}…`
  return {
    title: t.title || t.type || '',
    kind,
    description,
    inputs: inputs.slice(0, maxPorts),
    moreInputs: Math.max(0, inputs.length - maxPorts),
    dynamic: t.dynamic_inputs === 'template' ? 'one text input per {{placeholder}} in the template' : '',
    outputs: outputs.slice(0, maxPorts),
    moreOutputs: Math.max(0, outputs.length - maxPorts),
    moreOutputsText: t.dynamic_outputs ? 'one output per case line, then Default' : '',
    typical: t.typical ? String(t.typical) : '',
    measured: typeTiming(t.type, timings),
    cost: t.cost ? String(t.cost) : '',
    tool: (t.kind === 'tool' || t.kind === 'preset') && t.tool ? String(t.tool) : ''
  }
}
/** The same facts as plain lines, for native `title` tooltips (quick search, no app tooltip). */
function typeTipText(tip) {
  const ports = (list, more) => [...list.map((p) => {
    const extra = [p.type, p.optional ? 'optional' : ''].filter(Boolean).join(', ')
    return extra ? `${p.name} (${extra})` : p.name
  }),
    ...(more ? [`+${more} more`] : [])].join(', ')
  const lines = [`${tip.title} · ${tip.kind}`]
  if (tip.description) lines.push(tip.description)
  if (tip.inputs.length || tip.dynamic) lines.push(`In: ${[ports(tip.inputs, tip.moreInputs), tip.dynamic].filter(Boolean).join(', ')}`)
  if (tip.outputs.length) lines.push(`Out: ${[ports(tip.outputs, tip.moreOutputs), tip.moreOutputsText].filter(Boolean).join(', ')}`)
  if (tip.typical || tip.measured) lines.push(`Takes: ${[tip.typical, tip.measured].filter(Boolean).join(' · ')}`)
  if (tip.cost) lines.push(`Cost: ${tip.cost}`)
  return lines.join('\n')
}

