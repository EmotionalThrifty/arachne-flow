// ---------------------------------------------------------------- G9: durations + tooltip contents (pure, tested)
/** Live elapsed time on a running node: whole seconds, then m:ss, then h:mm:ss. */
function formatClock(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return ''
  const s = Math.floor(Math.max(0, ms) / 1000)
  const pad = (v) => String(v).padStart(2, '0')
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)}:${pad(s % 60)}`
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}
/** "minutes: waits for a background job …" → "minutes" (the spec `typical` headline). */
const typicalShort = (typical) => String(typical || '').split(/[:;]/)[0].trim()
const oneLine = (text, max) => {
  const s = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
/** The node's model as GET /x/timings groups durations — same rule as engine/timings.py model_key. */
function timingModel(spec, node) {
  const fields = (spec && Array.isArray(spec.params)) ? spec.params : []
  const f = fields.find((p) => p && (p.options_source || p.kind === 'model'))
  if (!f) return ''
  const value = ((node && node.params) || {})[f.name]
  const pick = !isBlank(value) ? value : f.default
  return isBlank(pick) ? '' : String(pick).trim()
}
/** GET /x/timings → { window, nodes: {type: {model: stat}}, types: {type: stat} }; malformed rows dropped. */
function indexTimings(payload) {
  const out = { window: 0, nodes: {}, types: {} }
  if (!payload || typeof payload !== 'object') return out
  out.window = Number(payload.window) || 0
  const ok = (r) => r && typeof r === 'object' && typeof r.type === 'string' && r.type && Number.isFinite(r.avg_ms) && r.n > 0
  for (const r of Array.isArray(payload.nodes) ? payload.nodes : []) {
    if (!ok(r)) continue
    const byModel = out.nodes[r.type] || (out.nodes[r.type] = {})
    byModel[String(r.model || '')] = { n: r.n, avg_ms: r.avg_ms, min_ms: r.min_ms, max_ms: r.max_ms }
  }
  for (const r of Array.isArray(payload.types) ? payload.types : []) {
    if (ok(r)) out.types[r.type] = { n: r.n, avg_ms: r.avg_ms, min_ms: r.min_ms, max_ms: r.max_ms }
  }
  return out
}
/** What a node usually takes: the measured average of the last runs with this type and model (never another
 *  model's), plus the spec's typical text. null when neither exists (notes, plain built-ins without hints). */
/** "mcp__fal-ai__x" -> "Fal Ai"; built-in tools -> "Hermes". Display only (engine: presets.provider_label). */
function toolProvider(type, description = '') {
  const name = String(type || '').replace(/^tool:/, '')
  if (!name.startsWith('mcp__')) return 'Hermes'
  const server = name.split('__')[1] || ''
  // the tool's own description spells the provider best ("… NanoGPT 3D models" -> "NanoGPT")
  const esc = server.replace(/_/g, '-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = server.length >= 3 ? new RegExp(`\\b(${esc})\\b`, 'i').exec(String(description || '')) : null
  if (found && found[1] !== found[1].toLowerCase()) return found[1]
  return server.split(/[-_ ]+/).filter(Boolean).map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ') || server
}

/** Second line of a node card: who runs it and with which model ("NanoGPT · Tripo H3.0", "Hermes · current
 *  model"); for plain steps the category ("Logic", "Inputs"). `model` = label or id in effect. Pure, tested. */
function nodeSubline(node, spec, model = '', auto = false) {
  if (!spec || !node || node.type === 'note') return ''
  const params = node.params || {}
  if (node.type === 'llm.complete') {
    const who = !isBlank(params.provider) ? String(params.provider) : 'Hermes'
    return `${who} · ${!isBlank(params.model) ? String(params.model) : 'current model'}`
  }
  const who = spec.provider || (spec.kind === 'tool' ? toolProvider(node.type, spec.description) : '')
  const what = model ? `${auto ? 'Auto · ' : ''}${model}` : auto ? 'Auto model' : ''
  if (who) return what ? `${who} · ${what}` : who
  return what || String(spec.category || '')
}

/** Footer of a node card: `{ cost, time }` — the cost estimate and how long it usually takes. Pure, tested. */
function nodeFooter(cost, exp) {
  const time = !exp ? '' : exp.n > 0 && exp.avg_ms !== null ? `≈ ${formatMs(exp.avg_ms)}` : typicalShort(exp.typical)
  return { cost: cost && cost.label ? cost.label : '', time }
}

function expectedTime(spec, node, timings) {
  const type = (node && node.type) || (spec && spec.type) || ''
  const model = timingModel(spec, node)
  const stat = timings && timings.nodes && timings.nodes[type] ? timings.nodes[type][model] : null
  const typical = spec && spec.typical ? String(spec.typical) : ''
  if (!stat && !typical) return null
  return { model, n: stat ? stat.n : 0, avg_ms: stat ? stat.avg_ms : null, min_ms: stat ? stat.min_ms : null,
    max_ms: stat ? stat.max_ms : null, typical }
}
const runsPhrase = (exp) => `your last ${exp.n === 1 ? 'run' : `${exp.n} runs`}${exp.model ? ` with ${exp.model}` : ''}`
/** Inspector lines: measured runs (average and range), the typical text, or "no runs yet". */
function timingLines(exp) {
  if (!exp) return []
  const lines = []
  if (exp.n > 0) {
    const span = exp.n > 1 ? ` (${formatMs(exp.min_ms)} – ${formatMs(exp.max_ms)})` : ''
    const phrase = runsPhrase(exp)
    lines.push(`${phrase[0].toUpperCase()}${phrase.slice(1)}: ${exp.n > 1 ? '~' : ''}${formatMs(exp.avg_ms)}${span}`)
  }
  if (exp.typical) lines.push(`Typical: ${exp.typical}`)
  if (exp.n === 0) lines.push(exp.model ? `No runs of ${exp.model} yet` : 'No runs yet')
  return lines
}
/** Palette entries: the measured average over every model of the type (only when it ran more than once). */
function typeTiming(type, timings) {
  const stat = timings && timings.types ? timings.types[type] : null
  return stat && stat.n > 1 ? `your last ${stat.n} runs: ~${formatMs(stat.avg_ms)}` : ''
}
const usualLine = (exp) => !exp ? null
  : exp.n > 0 ? `Usually ${exp.n > 1 ? '~' : ''}${formatMs(exp.avg_ms)} (${runsPhrase(exp)})`
    : exp.typical ? `Typically ${typicalShort(exp.typical)}` : null
const elapsedSince = (iso, now) => {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? Math.max(0, now - t) : null
}
/** Tooltip of a node's status badge. `nameOf(id)` turns node ids in "upstream failed" into titles. */
function statusTip(state, exp, now = Date.now(), nameOf = () => '', branchName = '') {
  const st = (state && state.status) || 'queued'
  const s = STATUS[st] || STATUS.queued
  const known = STATUS[st] ? st : 'queued'
  const tip = { id: `status-${known}`, title: s.label, tone: '', lines: [] }
  const took = Number.isFinite(state && state.ms) ? formatMs(state.ms) : ''
  const items = state && state.items && Number.isFinite(state.items.total) ? state.items : null
  if (items && known !== 'queued') {           // G11: a For each body node — one line for all its items
    if (known === 'running') {
      const elapsed = elapsedSince(state.started_at, now)
      if (elapsed !== null) tip.lines.push(`Running for ${formatClock(elapsed)}`)
      tip.lines.push(`${itemsFinished(items)} of ${plural(items.total, 'item')} finished`)
      return tip
    }
    tip.lines.push(itemsLine(items))
    if (known === 'error') {
      tip.tone = 'bad'
      if (state.error) tip.lines.push(oneLine(state.error, 280))
      tip.foot = 'Select the node: the inspector shows the full error with a copy button.'
    } else if (known === 'skipped') {
      const why = state.reason || state.error
      if (why && items.total) tip.lines.push(oneLine(why, 280))
    } else if (took && known !== 'cached') tip.lines.push(`Took ${took} in total`)
    return tip
  }
  if (known === 'running') {
    const elapsed = elapsedSince(state.started_at, now)
    if (elapsed !== null) tip.lines.push(`Running for ${formatClock(elapsed)}`)
    if (state.progress) tip.lines.push(oneLine(state.progress, 200))   // a job's live status line (E-1)
    const usual = usualLine(exp)
    if (usual) tip.lines.push(usual)
  } else if (known === 'done') {
    if (took) tip.lines.push(`Took ${took}`)
    if (state.branch) tip.lines.push(`Took the “${branchName || state.branch}” output`)
    if (Number.isFinite(state.count)) tip.lines.push(`Ran ${plural(state.count, 'item')}`)
    if (state.note) tip.lines.push(oneLine(state.note, 200))
    const usual = usualLine(exp)
    if (usual) tip.lines.push(usual)
  } else if (known === 'cached') {
    tip.lines.push('Reused the last result: settings and inputs were unchanged, no tool call.',
      'Fresh, or “Use cache” off in the inspector, runs it again.')
    if (state.branch) tip.lines.push(`Took the “${branchName || state.branch}” output`)
  } else if (known === 'error') {
    tip.tone = 'bad'
    if (took) tip.lines.push(`After ${took}`)
    if (state.error) tip.lines.push(oneLine(state.error, 280))
    tip.foot = 'Select the node: the inspector shows the full error with a copy button.'
  } else if (known === 'skipped' && state.skip === 'branch') {
    tip.lines.push('Not on the branch this run took.')
    if (state.reason) tip.lines.push(oneLine(state.reason, 280))
  } else if (known === 'skipped') {
    const err = String((state && state.error) || '')
    const m = err.match(/^upstream failed: (.+)$/)
    tip.lines.push(m ? `An earlier step failed: ${m[1].split(/,\s*/).map((id) => nameOf(id) || id).join(', ')}`
      : err || 'Not run in this run.')
  } else if (known === 'cancelled') {
    tip.lines.push(took ? `Stopped after ${took}.` : 'The run was stopped before this step finished.')
  } else if (known === 'interrupted') {
    tip.lines.push('Hermes stopped while this step was running. Run again to finish it.')
  } else {
    tip.lines.push('Waits for its inputs or a free slot (max parallel steps).')
  }
  return tip
}
/** Tooltip of the run chip in the run log: live total, finished steps, the run's error. */
function runTip(run, now = Date.now()) {
  const s = RUN_STATUS[run && run.status] || RUN_STATUS.queued
  const tip = { id: 'run', title: s.label, tone: run && (run.status === 'error' || run.status === 'invalid') ? 'bad' : '', lines: [] }
  if (!run) return tip
  if (isRunActive(run)) {
    const elapsed = elapsedSince(run.started_at, now)
    if (elapsed !== null) tip.lines.push(`Running for ${formatClock(elapsed)}`)
  } else if (Number.isFinite(run.ms)) tip.lines.push(`Took ${formatMs(run.ms)}`)
  const counts = countStatuses(run)
  const total = (run.order && run.order.length) || Object.keys(run.nodes || {}).length
  if (total > 0) {
    tip.lines.push(`${(counts.done || 0) + (counts.cached || 0)} of ${total} steps finished${counts.cached ? ` · ${counts.cached} cached` : ''}`)
  }
  if (run.error) tip.lines.push(oneLine(run.error, 280))
  return tip
}
/** Tooltip of a port: type (with colour), required state, wires, description. */
function portTip(pt, side, info = {}) {
  const wires = Number(info.wires) || 0
  const title = String(pt.label || pt.name)
  const kind = typeLabel(pt.type || 'any', info.portTypes)
  // the type pill is left out when it only repeats the port name ("Text · Text"), like the palette tip
  const tip = { id: `port-${side}`, title, kind: kind.toLowerCase() === title.toLowerCase() ? '' : kind,
    color: portColor(pt.type, info.portTypes), tone: '', lines: [] }
  if (pt.description) tip.lines.push(oneLine(pt.description, 200))
  if (side === 'out') {
    tip.lines.push(wires ? `Feeds ${plural(wires, 'input')}` : 'Drag from here to an input to connect')
    if (info.branch === 'taken') tip.lines.push('Taken in this run')
    else if (info.branch === 'untaken') tip.lines.push('Not taken in this run: the steps after it were skipped')
    return tip
  }
  if (pt.required && !wires) {
    if (info.hasValue) tip.lines.push('Required · set in the inspector')
    else {
      tip.lines.push('Required — wire something in or set it in the inspector')
      tip.tone = 'warn'
    }
  } else tip.lines.push(pt.required ? 'Required' : 'Optional')
  if (wires) tip.lines.push(`${plural(wires, 'wire')} connected${pt.multiple ? ' · takes several, in wiring order' : ''}`)
  else if (pt.multiple) tip.lines.push('Takes several wires, in wiring order')
  return tip
}
function errorTip(error) {
  return { id: 'error', title: 'Error', tone: 'bad', lines: [oneLine(error, 600)],
    foot: 'Double-click the node: the inspector shows the full error with a copy button.' }
}
/** Plain-text form of a tip for native `title` (no app tooltip available). */
function tipText(tip) {
  if (!tip) return ''
  return [`${tip.title || ''}${tip.keys && tip.keys.length ? ` (${tip.keys.join('+')})` : ''}`, ...(tip.lines || []), tip.foot]
    .filter(Boolean).join('\n')
}
const headerTip = (id, title, lines, keys) => ({ id: `header-${id}`, title, lines, ...(keys ? { keys } : {}) })
const HEADER_TIPS = {
  flows: headerTip('flows', 'Your flows', ['Open, create, duplicate or delete flows.', 'Start from a template or save this flow as one.']),
  palette: headerTip('palette', 'Node palette', ['Show or hide the list of steps you can add.', 'Drag an entry onto the canvas, or double-click the canvas to search.']),
  inspector: headerTip('inspector', 'Inspector', ['Show or hide the settings and results of the selected node.']),
  undo: headerTip('undo', 'Undo', ['Takes back the last edit.'], ['Ctrl', 'Z']),
  redo: headerTip('redo', 'Redo', ['Restores what Undo took back.', 'Also Ctrl+Shift+Z.'], ['Ctrl', 'Y']),
  tidy: headerTip('tidy', 'Tidy', ['Arranges all nodes left to right by their wiring.', 'Undo puts them back.']),
  generate: headerTip('generate', 'Build with Hermes', ['Describe a new flow or a change in your words.', 'Hermes builds and validates it without running anything.']),
  ask: headerTip('ask', 'Discuss in chat', ['Starts a message about this flow in your chat composer; you finish and send it.', 'Nothing is changed or run.']),
  unfocus: headerTip('unfocus', 'Show Hermes', ['Shows the rest of Hermes in this window (sidebar, chats).']),
  stop: headerTip('stop', 'Stop', ['Stops the run. Running steps are cancelled; finished results stay.']),
  fresh: headerTip('fresh', 'Fresh run', ['Runs every step again and ignores cached results.'], ['Ctrl', 'Shift', 'Enter']),
  run: headerTip('run', 'Run', ['Runs the flow. Unchanged steps reuse their cached result.', 'Shift+click ignores the cache.'], ['Ctrl', 'Enter'])
}

/** model.options payload → [{slug, name, current, models}] for the model picker; skips MoA, unauthenticated
 *  providers and models the provider reports as unavailable. Pure, tested. */
function modelGroups(payload) {
  const rows = (payload && Array.isArray(payload.providers)) ? payload.providers : []
  const out = []
  for (const r of rows) {
    if (!r || !r.slug || r.slug === 'moa' || r.authenticated === false) continue
    const bad = new Set(Array.isArray(r.unavailable_models) ? r.unavailable_models : [])
    const models = (Array.isArray(r.models) ? r.models : [])
      .map((m) => (typeof m === 'string' ? m : m && (m.id || m.name)))
      .filter((m) => typeof m === 'string' && m && !bad.has(m))
    if (!models.length) continue
    out.push({ slug: String(r.slug), name: String(r.name || r.slug), current: !!r.is_current, models: [...new Set(models)],
      prices: (r.pricing && typeof r.pricing === 'object') ? r.pricing : {},
      caps: (r.capabilities && typeof r.capabilities === 'object') ? r.capabilities : {},
      apiUrl: r.api_url || '', pricingPending: !!r.pricing_pending })
  }
  out.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0))
  return out
}

/** Filter picker groups by a space-separated query (all words must match model or provider); caps the total. */
function filterModelGroups(groups, query, limit = 250) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  let left = limit
  let hidden = 0
  const out = []
  for (const g of groups) {
    const hay = `${g.name} ${g.slug}`.toLowerCase()
    const hits = g.models.filter((m) => words.every((w) => m.toLowerCase().includes(w) || hay.includes(w)))
    if (!hits.length) continue
    const shown = hits.slice(0, Math.max(0, left))
    hidden += hits.length - shown.length
    left -= shown.length
    if (shown.length) out.push({ ...g, models: shown })
  }
  return { groups: out, hidden }
}

/** Number field text -> stored value. The field shows String(value), so while typing (final=false) only text
 *  that prints back unchanged becomes a number; "0.0", "-0" or "1.50" stay text, else the next keystroke is
 *  lost ("0.05" became 5, review U-1). On blur (final=true) numeric text becomes a number. The engine parses
 *  numeric text of number params at run time too. */
function parseNumberInput(raw, final = false) {
  const v = String(raw)
  const t = v.trim()
  if (t === '') return null
  if (!/^-?\d+(\.\d+)?$/.test(t)) return v
  const n = Number(t) + 0                           // + 0 turns -0 into 0
  return final || String(n) === t ? n : v
}
function isJson(text) {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}
function categoryColor(category = '') {
  if (category.startsWith('MCP')) return 'var(--ui-orange)'
  if (category.startsWith('Tools')) return 'var(--ui-blue)'
  const map = {
    Triggers: 'var(--ui-green)', Inputs: 'var(--ui-cyan)', AI: 'var(--ui-purple)', Text: 'var(--ui-green)', Data: 'var(--ui-yellow)',
    Media: 'var(--ui-red)', Web: 'var(--ui-blue)', Output: 'var(--ui-accent)', Presets: 'var(--ui-warm)',
    Logic: 'color-mix(in srgb, var(--ui-purple) 55%, var(--ui-red))',
    Utility: 'var(--ui-text-tertiary)'
  }
  return map[category] || 'var(--ui-text-tertiary)'
}
const portColor = (type, portTypes) => {
  const c = portTypes && portTypes[type] ? portTypes[type].color : null
  return c ? `var(${c})` : 'var(--ui-text-tertiary)'
}
const typeLabel = (type, portTypes) => (portTypes && portTypes[type] && portTypes[type].label) || type
const nodeTitle = (node, typesByName) => {
  if (!node) return ''
  const spec = typesByName[node.type]
  return node.title || (spec && spec.title) || node.type
}
/** A ready-made node pinned to a provider this setup lacks (`preset.x~server`) resolves to the same step on the
 *  best available provider, so shared flows and templates open and run anywhere (engine: nodes.TypeIndex). */
function providerFallback(byName) {
  return new Proxy(byName, {
    get: (target, key) => {
      if (typeof key !== 'string' || key in target) return target[key]
      return key.startsWith('preset.') && key.includes('~') ? target[key.split('~')[0]] : undefined
    }
  })
}

function indexTypes(payload) {
  const list = (payload && payload.types) || []
  const byName = {}
  for (const t of list) byName[t.type] = t
  return {
    list,
    byName: providerFallback(byName),
    compat: (payload && payload.compat) || {},
    portTypes: (payload && payload.port_types) || {},
    categories: (payload && payload.categories) || [],
    extKinds: (payload && payload.ext_kinds) || {},
    uploadMax: (payload && payload.upload_max_bytes) || UPLOAD_MAX_BYTES
  }
}

