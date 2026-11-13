// ---------------------------------------------------------------- pure helpers (unit-tested)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const snap = (v, grid = GRID) => Math.round(v / grid) * grid
const range = (n) => Array.from({ length: Math.max(0, n) }, (_, i) => i)
const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
const isMedia = (v) => !!(v && typeof v === 'object' && v.$media && typeof v.$media === 'object')
const isEditableTarget = (t) =>
  !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable === true)

/** Review U-2: Space pans only when pressed on the canvas (or the focused plugin root holding it), never on a
 *  button, link or field, and never elsewhere in the app (sidebar, a chat tile next to the canvas). */
const PRESSABLE = 'button,a[href],summary,[role=button],[role=menuitem],[role=tab]'
function inCanvasArea(target, canvasEl) {
  return !!(target && canvasEl && (canvasEl.contains(target) || (target.contains && target.contains(canvasEl))))
}
function spacePans(target, canvasEl) {
  if (!inCanvasArea(target, canvasEl) || isEditableTarget(target)) return false
  return !(target.closest && target.closest(PRESSABLE))
}
/** Review U-3: does Ctrl+<k> (c, x, a) act on nodes? Selected text always goes to the browser; copy/cut need a
 *  node selection; select-all only on the canvas, so the inspector and run log keep text select-all. */
function canvasClipboardKey(k, { textSelected, nodesSelected, inCanvas }) {
  if (textSelected) return false
  if (k === 'a') return !!inCanvas
  return nodesSelected > 0
}

/** Review U-8: the key a menu takes. `index` is the focused row (-1: nothing focused yet), `count` the number of
 *  selectable rows. Returns the row to focus, 'activate', 'close' (Escape/Tab: the menu is not a trap) or null when
 *  the key is none of the menu's. Wrapping at both ends keeps a long Flows menu reachable without looking. */
function menuKeyNav(index, count, key) {
  if (key === 'Escape' || key === 'Tab') return 'close'
  const n = Number.isInteger(count) && count > 0 ? count : 0
  if (!n) return null
  const at = Number.isInteger(index) && index >= 0 && index < n ? index : -1
  switch (key) {
    case 'ArrowDown': return at < 0 || at === n - 1 ? 0 : at + 1
    case 'ArrowUp': return at <= 0 ? n - 1 : at - 1
    case 'Home': return 0
    case 'End': return n - 1
    case 'Enter':
    case ' ':
    case 'Spacebar': return at < 0 ? null : 'activate'
    default: return null
  }
}

/** Review U-8: Tab inside a dialog. Returns the element to focus when the keystroke would leave the dialog, else
 *  null (middle of the dialog: the browser's own order is right). `active` null means focus is not inside yet, so
 *  the first Tab lands on the first field and Shift+Tab on the last. */
function trapFocus(first, last, active, shift) {
  if (!first || !last) return null
  if (shift) return !active || active === first ? last : null
  return !active || active === last ? first : null
}

/** Review U-8: Enter and Space press whatever has focus; nothing else does. */
const activatesOn = (key) => key === 'Enter' || key === ' ' || key === 'Spacebar'

// Focus plumbing for U-8. Everything below stays inside the plugin's own markup (`.fc-root`, dialogs, menus).
const FOCUSABLE_SEL = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
function focusablesIn(el) {
  if (!el || typeof el.querySelectorAll !== 'function') return []
  return Array.from(el.querySelectorAll(FOCUSABLE_SEL)).filter((n) => n.getAttribute('aria-hidden') !== 'true')
}
/** The selectable rows of a menu (a disabled row is announced, but skipped by the arrow keys). */
function menuRowsIn(el) {
  if (!el || typeof el.querySelectorAll !== 'function') return []
  return Array.from(el.querySelectorAll('[role="menuitem"], .fc-mini')).filter((n) => n.getAttribute('aria-disabled') !== 'true' && !n.disabled)
}
const focusEl = (el) => {
  if (el && typeof el.focus === 'function') el.focus({ preventScroll: true })
  return el
}
/** Hand focus back to the page root, so the canvas shortcuts keep working after a menu/dialog closes. */
function focusPluginRoot(from) {
  return focusEl(from && from.closest ? from.closest('.fc-root') : null)
}
/** Review U-8: a clickable row behaves like a button — Enter/Space press it. */
const rowPress = (fn) => (e) => {
  if (!activatesOn(e.key)) return
  e.preventDefault()
  e.stopPropagation()
  fn()
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

function templatePlaceholders(text) {
  if (typeof text !== 'string') return []
  const out = []
  for (const m of text.matchAll(PLACEHOLDER_RE)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/** Input/output ports of a node, including `{{placeholder}}` inputs (mirrors engine/graph.node_ports). */
function nodePorts(node, spec) {
  if (!spec) return { inputs: [], outputs: [] }
  const inputs = (spec.inputs || []).map((p) => ({ ...p }))
  const outputs = (spec.outputs || []).map((p) => ({ ...p }))
  const dyn = spec.dynamic_inputs
  if (dyn) {
    const params = node.params || {}
    let source = params[dyn]
    if (source === undefined || source === null) {
      const def = (spec.params || []).find((p) => p.name === dyn)
      source = def ? def.default : undefined
    }
    const names = new Set(inputs.map((p) => p.name))
    for (const name of templatePlaceholders(source)) {
      if (!names.has(name)) {
        names.add(name)
        inputs.push({ name, type: spec.dynamic_input_type || 'text', required: false, label: name, dynamic: true })
      }
    }
  }
  const dynOut = spec.dynamic_outputs
  if (dynOut) {
    let source = (node.params || {})[dynOut]
    if (source === undefined || source === null) {
      const def = (spec.params || []).find((p) => p.name === dynOut)
      source = def ? def.default : undefined
    }
    const cases = switchCases(source).map((c, i) => ({ name: `case${i + 1}`, type: 'any', label: c, dynamic: true }))
    return { inputs, outputs: [...cases, ...outputs] }
  }
  return { inputs, outputs }
}

const MAX_CASES = 20
/** Switch cases: one per non-empty trimmed line (or list item), at most MAX_CASES — engine/graph.py switch_cases. */
function switchCases(source) {
  const items = Array.isArray(source) ? source.map((v) => String(v === null || v === undefined ? '' : v))
    : String(source === null || source === undefined ? '' : source).split(/\r\n|\r|\n/)
  return items.map((c) => c.trim()).filter(Boolean).slice(0, MAX_CASES)
}
/** 'taken' / 'untaken' for an output port of an If/Switch that finished this run, '' otherwise. */
function branchPort(state, port) {
  if (!state || !state.branch || (state.status !== 'done' && state.status !== 'cached')) return ''
  return state.branch === port ? 'taken' : 'untaken'
}
/** A wire is drawn faded when its source failed or was skipped, its target was skipped, or it hangs off an
 *  untaken branch: no value travelled along it in this run. */
function edgeDead(src, dst, port) {
  return !!((src && (src.status === 'error' || src.status === 'skipped')) || (dst && dst.status === 'skipped') || branchPort(src, port) === 'untaken')
}
/** For each body owners: node id -> For each id, for every node after a For each and before its Collects —
 *  the same rule as engine/graph.py loops (G11). Cycle-safe; the engine reports invalid shapes. */
function loopBodies(flow) {
  const nodes = (flow && flow.nodes) || []
  const kind = {}
  const children = {}
  for (const n of nodes) {
    kind[n.id] = n.type
    children[n.id] = []
  }
  for (const e of (flow && flow.edges) || []) {
    if (children[e.from.node] && kind[e.to.node] !== undefined) children[e.from.node].push(e.to.node)
  }
  const reach = (start) => {
    const seen = new Set()
    const todo = [...children[start]]
    while (todo.length) {
      const n = todo.pop()
      if (seen.has(n)) continue
      seen.add(n)
      todo.push(...children[n])
    }
    seen.delete(start)
    return seen
  }
  const owner = {}
  for (const f of nodes) {
    if (f.type !== 'logic.foreach') continue
    const after = reach(f.id)
    const later = new Set()
    for (const c of after) if (kind[c] === 'logic.collect') for (const x of reach(c)) later.add(x)
    for (const n of after) if (kind[n] !== 'logic.collect' && !later.has(n) && !(n in owner)) owner[n] = f.id
  }
  return owner
}
const itemsFinished = (it) => (it.done || 0) + (it.cached || 0) + (it.skipped || 0) + (it.error || 0)
/** "5 items: 2 done · 1 cached · 1 skipped" for a loop body node's item results. */
function itemsLine(items) {
  if (!items || !Number.isFinite(items.total)) return ''
  if (items.total === 0) return 'The list was empty: nothing ran'
  const parts = [['done', 'done'], ['cached', 'cached'], ['skipped', 'skipped'], ['error', 'failed']]
    .filter(([k]) => items[k] > 0).map(([k, word]) => `${items[k]} ${word}`)
  return `${plural(items.total, 'item')}: ${parts.join(' · ')}`
}
/** Text of a status badge: item progress / count for loop body nodes, else the duration or the live clock. */
function badgeLabel(state, clock) {
  const st = state && state.status
  const it = state && state.items
  if (it && Number.isFinite(it.total)) {
    if (st === 'running') return `${itemsFinished(it)}/${it.total}${clock ? ` · ${clock}` : ''}`
    if (st === 'cached') return `${it.total}× cached`
    if ((st === 'done' || st === 'error') && Number.isFinite(state.ms)) return `${it.total}× · ${formatMs(state.ms)}`
  }
  if (st === 'cached') return 'cached'
  if (st === 'running') return clock || ''
  if ((st === 'done' || st === 'error') && Number.isFinite(state && state.ms)) return formatMs(state.ms)
  return ''
}

/** Inspector rows for one output of a For each body node: one per item; skipped and failed items show why
 *  instead of a bare null. null when the port holds media (the media list view shows those) or no item list. */
function itemRows(state, port) {
  const values = state && state.items && state.outputs ? state.outputs[port] : null
  if (!Array.isArray(values) || values.some(isMedia)) return null
  const iters = Array.isArray(state.iterations) ? state.iterations : []
  return values.map((value, i) => {
    const it = iters[i] || {}
    if (it.status === 'error') return { n: i + 1, kind: 'error', text: oneLine(it.error || 'failed', 200) }
    if (it.status === 'skipped') {
      const why = it.reason || it.error
      return { n: i + 1, kind: 'skipped', text: why ? `skipped: ${oneLine(why, 160)}` : 'skipped' }
    }
    return { n: i + 1, kind: 'value', value }
  })
}

/** Label of the output an If/Switch took ("True", a case line, "Default"). */
function branchLabel(node, spec, state) {
  if (!state || !state.branch || !node || !spec) return ''
  const p = nodePorts(node, spec).outputs.find((o) => o.name === state.branch)
  return p ? String(p.label || p.name) : String(state.branch)
}

/** Long input lists collapse: required, connected and template inputs always show, plus a few optional ones. */
function visibleInputs(inputs, connected, expanded) {
  if (expanded || inputs.length <= COLLAPSE_AFTER) return { shown: inputs, hidden: 0 }
  let optional = 0
  const shown = inputs.filter((p) => {
    if (p.required || p.dynamic || (connected && connected.has(p.name))) return true
    if (optional < VISIBLE_OPTIONAL) {
      optional += 1
      return true
    }
    return false
  })
  return { shown, hidden: inputs.length - shown.length }
}

function nodeLayout(node, spec, connected, expanded) {
  const ports = nodePorts(node, spec)
  const vis = visibleInputs(ports.inputs, connected || EMPTY_SET, expanded)
  return {
    inputs: vis.shown,
    outputs: ports.outputs,
    hidden: vis.hidden,
    allInputs: ports.inputs,
    collapsible: ports.inputs.length > COLLAPSE_AFTER
  }
}

/** World position of a port dot. Unknown or hidden ports fall back to the header edge. */
function portPosition(node, layout, side, portName) {
  const list = side === 'in' ? layout.inputs : layout.outputs
  const i = list.findIndex((p) => p.name === portName)
  const x = node.x + (side === 'in' ? 0 : NODE_W)
  if (i < 0) return { x, y: node.y + HEAD_H / 2 }
  return { x, y: node.y + HEAD_H + PORTS_TOP + i * ROW_H + ROW_H / 2 }
}

function edgePath(a, b, zoom = 1) {
  const dx = Math.max(36 * zoom, Math.abs(b.x - a.x) * 0.5)
  const f = (n) => n.toFixed(1)
  return `M ${f(a.x)} ${f(a.y)} C ${f(a.x + dx)} ${f(a.y)}, ${f(b.x - dx)} ${f(b.y)}, ${f(b.x)} ${f(b.y)}`
}

/** U-4: the same curve in world coordinates, drawn under the view transform — panning and zooming move the
 *  layer instead of rewriting every path. Identical to `edgePath` once the view is applied (unit-tested). */
function edgePathWorld(a, b) {
  return edgePath(a, b, 1)
}

const worldToScreen = (view, p) => ({ x: p.x * view.zoom + view.x, y: p.y * view.zoom + view.y })
const screenToWorld = (view, p) => ({ x: (p.x - view.x) / view.zoom, y: (p.y - view.y) / view.zoom })

/** Zoom by `factor`, keeping the screen point `p` fixed. */
function zoomAt(view, factor, p) {
  const zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM)
  const k = zoom / view.zoom
  return { zoom, x: p.x - (p.x - view.x) * k, y: p.y - (p.y - view.y) * k }
}

function fitView(rects, width, height, pad = 64) {
  if (!rects.length || width <= 0 || height <= 0) return { x: 48, y: 48, zoom: 1 }
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.w)
    y1 = Math.max(y1, r.y + r.h)
  }
  const bw = Math.max(1, x1 - x0)
  const bh = Math.max(1, y1 - y0)
  const zoom = clamp(Math.min((width - 2 * pad) / bw, (height - 2 * pad) / bh), MIN_ZOOM, 1.2)
  return { zoom, x: (width - bw * zoom) / 2 - x0 * zoom, y: (height - bh * zoom) / 2 - y0 * zoom }
}

function rectSelect(rects, box) {
  return rects.filter((r) => r.x < box.x1 && r.x + r.w > box.x0 && r.y < box.y1 && r.y + r.h > box.y0).map((r) => r.id)
}

/** U-4: coalesce a burst of calls (one per pointermove) into one per animation frame, with the last arguments.
 *  `flush` applies a pending call immediately — a drag ending must not lose its final position — and `cancel`
 *  drops it. The frame functions are injectable so the behaviour is unit-tested without a DOM. */
function rafThrottle(fn, raf, caf) {
  const schedule = raf || ((cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 16)))
  const stop = caf || ((id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id)))
  let id = null
  let pending = null
  const run = () => {
    id = null
    const args = pending
    pending = null
    if (args) fn(...args)
  }
  const wrapped = (...args) => {
    pending = args
    if (id === null) id = schedule(run)
  }
  wrapped.flush = () => {
    if (id !== null) stop(id)
    run()
  }
  wrapped.cancel = () => {
    if (id !== null) stop(id)
    id = null
    pending = null
  }
  return wrapped
}

function compatible(compat, src, dst) {
  if (!src || !dst) return false
  const list = compat ? compat[src] : null
  if (Array.isArray(list)) return list.includes(dst)
  return src === dst || dst === 'any' || src === 'any'
}

// ---- graph edits: every function returns a NEW flow (or the same object when nothing changed)
function newId(prefix, taken) {
  for (let i = 0; i < 2000; i += 1) {
    const id = prefix + Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0')
    if (!taken.has(id)) return id
  }
  throw new Error('no free id')
}
const nodeIdSet = (flow) => new Set(flow.nodes.map((n) => n.id))
const edgeIdSet = (flow) => new Set(flow.edges.map((e) => e.id))

function addNode(flow, { type, title, x, y, params }) {
  const node = { id: newId('n_', nodeIdSet(flow)), type, x: Math.round(x), y: Math.round(y), params: { ...(params || {}) } }
  if (title) node.title = title
  return { flow: { ...flow, nodes: [...flow.nodes, node] }, node }
}

function removeNodes(flow, ids) {
  const set = new Set(ids)
  if (!flow.nodes.some((n) => set.has(n.id))) return flow
  return {
    ...flow,
    nodes: flow.nodes.filter((n) => !set.has(n.id)),
    edges: flow.edges.filter((e) => !set.has(e.from.node) && !set.has(e.to.node))
  }
}

function moveNodes(flow, positions) {
  let changed = false
  const nodes = flow.nodes.map((n) => {
    const p = positions[n.id]
    if (!p || (p.x === n.x && p.y === n.y)) return n
    changed = true
    return { ...n, x: p.x, y: p.y }
  })
  return changed ? { ...flow, nodes } : flow
}

function walk(flow, start, forward) {
  const seen = new Set()
  const stack = [start]
  while (stack.length) {
    const cur = stack.pop()
    for (const e of flow.edges) {
      const a = forward ? e.from.node : e.to.node
      const b = forward ? e.to.node : e.from.node
      if (a === cur && !seen.has(b)) {
        seen.add(b)
        stack.push(b)
      }
    }
  }
  return seen
}
const descendants = (flow, id) => walk(flow, id, true)
const ancestors = (flow, id) => walk(flow, id, false)
const reaches = (flow, from, to) => from === to || descendants(flow, from).has(to)

function canConnect(flow, typesInfo, from, to) {
  if (!flow || !from || !to) return { ok: false, reason: 'Nothing to connect.' }
  if (from.node === to.node) return { ok: false, reason: 'A node cannot feed itself.' }
  const a = flow.nodes.find((n) => n.id === from.node)
  const b = flow.nodes.find((n) => n.id === to.node)
  if (!a || !b) return { ok: false, reason: 'Node not found.' }
  const out = nodePorts(a, typesInfo.byName[a.type]).outputs.find((p) => p.name === from.port)
  const inp = nodePorts(b, typesInfo.byName[b.type]).inputs.find((p) => p.name === to.port)
  if (!out || !inp) return { ok: false, reason: 'Port not found.' }
  if (!compatible(typesInfo.compat, out.type, inp.type)) {
    return { ok: false, reason: `A ${out.type} output cannot feed a ${inp.type} input.` }
  }
  if (reaches(flow, to.node, from.node)) return { ok: false, reason: 'That connection would create a loop.' }
  return { ok: true }
}

/** Connect output → input. Multiple ports append in edge order; single ports replace (G8). */
function connect(flow, from, to, typesInfo = null) {
  const into = flow.edges.filter((e) => e.to.node === to.node && e.to.port === to.port)
  if (into.some((e) => e.from.node === from.node && e.from.port === from.port)) return flow
  const target = flow.nodes.find((n) => n.id === to.node)
  const spec = target && typesInfo ? typesInfo.byName[target.type] : null
  const input = spec ? nodePorts(target, spec).inputs.find((p) => p.name === to.port) : null
  const edges = input && input.multiple ? [...flow.edges] : flow.edges.filter((e) => !into.includes(e))
  edges.push({ id: newId('e_', edgeIdSet(flow)), from: { node: from.node, port: from.port }, to: { node: to.node, port: to.port } })
  return { ...flow, edges }
}

function disconnect(flow, edgeId) {
  if (!flow.edges.some((e) => e.id === edgeId)) return flow
  return { ...flow, edges: flow.edges.filter((e) => e.id !== edgeId) }
}

/** Patch title and params (null deletes a param); drops edges into template inputs that disappeared. */
function updateNode(flow, id, patch, typesByName) {
  let target = null
  const nodes = flow.nodes.map((n) => {
    if (n.id !== id) return n
    const next = { ...n }
    if (patch && typeof patch.record_inputs === 'boolean') next.record_inputs = patch.record_inputs
    if (patch && 'title' in patch) {
      if (patch.title) next.title = String(patch.title)
      else delete next.title
    }
    if (patch && patch.params) {
      const params = { ...(n.params || {}) }
      for (const [k, v] of Object.entries(patch.params)) {
        if (v === null || v === undefined) delete params[k]
        else params[k] = v
      }
      next.params = params
    }
    target = next
    return next
  })
  if (!target) return flow
  let out = { ...flow, nodes }
  const spec = typesByName ? typesByName[target.type] : null
  if (spec && (spec.dynamic_inputs || spec.dynamic_outputs)) {
    const ports = nodePorts(target, spec)
    const ins = new Set(ports.inputs.map((p) => p.name))
    const outs = new Set(ports.outputs.map((p) => p.name))
    const edges = out.edges.filter((e) => (e.to.node !== id || !spec.dynamic_inputs || ins.has(e.to.port)) &&
      (e.from.node !== id || !spec.dynamic_outputs || outs.has(e.from.port)))
    if (edges.length !== out.edges.length) out = { ...out, edges }
  }
  return out
}

/** Bounding box (world units) of a node list; height per node is an estimate unless `heights` says otherwise. */
function nodesBox(nodes, heights = {}) {
  if (!nodes || !nodes.length) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const n of nodes) {
    x0 = Math.min(x0, n.x)
    y0 = Math.min(y0, n.y)
    x1 = Math.max(x1, n.x + NODE_W)
    y1 = Math.max(y1, n.y + (heights[n.id] || 110))
  }
  return { x0, y0, x1, y1 }
}

/** Move a pasted subgraph so its top-left corner sits at `at` (snapped); ids and edges stay as they are. */
function placeSubgraph(sub, at) {
  const box = nodesBox(sub.nodes)
  if (!box || !at) return sub
  const dx = snap(at.x) - box.x0
  const dy = snap(at.y) - box.y0
  if (!dx && !dy) return sub
  return { ...sub, nodes: sub.nodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy })) }
}

/** Keyboard paste: keep the +40 offset when the copy is on screen, otherwise centre it in the viewport. */
function placeInView(sub, view, size) {
  const box = nodesBox(sub.nodes)
  if (!box || !view || !size) return sub
  const a = screenToWorld(view, { x: 0, y: 0 })
  const b = screenToWorld(view, { x: size.w, y: size.h })
  const visible = box.x0 < b.x && box.x1 > a.x && box.y0 < b.y && box.y1 > a.y
  if (visible) return sub
  const c = screenToWorld(view, { x: size.w / 2, y: size.h / 2 })
  return placeSubgraph(sub, { x: c.x - (box.x1 - box.x0) / 2, y: c.y - (box.y1 - box.y0) / 2 })
}

/** Drop ids of nodes that no longer exist (after undo/redo or an agent edit); same array when unchanged. */
function pruneSelection(selection, flow) {
  if (!flow || !Array.isArray(selection) || !selection.length) return selection
  const ids = nodeIdSet(flow)
  const kept = selection.filter((id) => ids.has(id))
  return kept.length === selection.length ? selection : kept
}

/** "Discuss in chat" draft: names the open flow (id included, so the agent can call flow_get). */
function askPrompt(flow) {
  return flow
    ? `In Arachne Flow, look at my flow "${flow.name || 'Untitled flow'}" (id ${flow.id}) and `
    : 'Build me a flow in Arachne Flow that '
}

/**
 * Put text into a chat composer: the focused session first, then whichever composer is active (`null`).
 * Appends as a paragraph (`insertText`, mode 'block') so whatever you were typing stays (review U-7); only
 * hosts without insertText fall back to setDraft. Both resolve false when no mounted composer answers.
 * Returns 'session' | 'active' | null.
 */
async function draftToComposer(hostApi, sid, text) {
  const c = hostApi && hostApi.composer
  if (!c) return null
  let put
  if (typeof c.insertText === 'function') put = (id) => c.insertText(id, text, { mode: 'block' })
  else if (typeof c.setDraft === 'function') put = (id) => c.setDraft(id, text)
  else return null
  if (sid && (await put(sid)) !== false) return 'session'
  if ((await put(null)) !== false) return 'active'
  return null
}

/** Why a flow that was just persisted must not run: a save conflict, or the save failed. */
function saveBlocker(conflict, flow, loaded) {
  if (conflict) return 'Resolve the save conflict first.'
  if (flow !== loaded) return 'The flow could not be saved, so it cannot run yet.'
  return null
}

/** Serialize a document-changing action behind a successful save; a blocked save runs no action at all. */
async function persistForFlowChange(persist, getBlocker, change, onBlocked) {
  await persist()
  const reason = getBlocker()
  if (reason) {
    if (onBlocked) onBlocked(reason)
    return { ok: false, reason }
  }
  return { ok: true, value: await change() }
}

/** Connection bookkeeping for the fallback run poll (U-5). `prev` is the previous state (or null),
 *  `ok` says whether the last backend call worked. Returns the next state; `recovered` is true exactly
 *  once — on the first success after the page had admitted the loss — so the caller reloads flow + run. */
function connectionState(prev, ok) {
  const fails = prev && Number.isFinite(prev.fails) ? prev.fails : 0
  const wasLost = !!(prev && prev.lost)
  if (ok) return { fails: 0, lost: false, recovered: wasLost }
  const next = fails + 1
  return { fails: next, lost: next >= LOST_CONTACT_AFTER, recovered: false }
}

/** What to do when the backend answers again: reload the open flow and its last run, but never over local
 *  edits the lost connection kept from saving — those are saved instead (then the normal save path applies). */
function recoveryPlan(flow, loaded) {
  if (!flow) return 'boot'
  return flow === loaded ? 'reload' : 'save'
}

// node.status event fields copied into the node state; a new start clears what the last run left behind
const STATUS_FIELDS = ['ms', 'error', 'preview', 'started_at', 'branch', 'skip', 'reason', 'items', 'count', 'note', 'progress']
const RUN_RESET_FIELDS = ['error', 'branch', 'skip', 'reason', 'items', 'count', 'note', 'progress', 'iterations']
/** One live node.status event applied to the node's state. Pure, tested. */
function applyNodeStatus(prev, pl, now = () => new Date().toISOString()) {
  const next = { ...(prev || {}), status: pl.status }
  if (pl.status === 'running') {
    for (const k of RUN_RESET_FIELDS) delete next[k]
    if (pl.started_at === undefined) next.started_at = now()   // an engine without started_at: start the clock now
  }
  for (const k of STATUS_FIELDS) if (pl[k] !== undefined) next[k] = pl[k]
  return next
}

// ---- run state: a REST fetch is as old as the moment it was sent, live node.status events are not (U-16)
const NODE_TERMINAL = new Set(['done', 'cached', 'error', 'skipped', 'cancelled', 'interrupted'])
/** How far along a state is: a node (and the run) only ever moves this way inside one run. */
const statusRank = (status) => (NODE_TERMINAL.has(status) ? 2 : status === 'running' ? 1 : 0)
const nodeStart = (state) => {
  const t = state && state.started_at ? Date.parse(state.started_at) : NaN
  return Number.isFinite(t) ? t : null
}
/** One node's state merged between the live events and a fetched record: never backwards, the event wins a tie. */
function mergeNodeState(live, fetched) {
  if (!live) return fetched
  if (!fetched) return live
  const lt = nodeStart(live)
  const ft = nodeStart(fetched)
  // a node that started again (loop iteration, retry) is described by the later start, not by the finished run
  if (lt !== null && ft !== null && lt !== ft) return lt > ft ? live : fetched
  if (live.status !== fetched.status) {
    const rank = statusRank(live.status) - statusRank(fetched.status)
    return rank > 0 ? live : rank < 0 ? fetched : live
  }
  return { ...fetched, ...live }   // same state: the record also carries outputs the event omits
}
/** The whole run: per-node merge, and a run that already ended here does not go back to running (U-16). */
function mergeRun(current, fetched) {
  if (!fetched || typeof fetched !== 'object' || !fetched.id) return current
  if (!current || !current.id || current.id !== fetched.id) return fetched
  const nodes = { ...(fetched.nodes || {}) }
  for (const [id, live] of Object.entries(current.nodes || {})) nodes[id] = mergeNodeState(live, nodes[id])
  const ahead = statusRank(current.status) > statusRank(fetched.status)
  return { ...(ahead ? current : fetched), nodes }
}

/** "Use cache" switch (review E-8): the node type's default (`cache_default`; only read-only tools, presets, LLM
 *  and logic are on) until the user picks; `cacheable: false` types never cache. Pure, tested. */
function cacheOn(params, spec) {
  if (spec && spec.cacheable === false) return false
  const choice = params ? params.cache : undefined
  if (choice === true || choice === false) return choice
  return !(spec && spec.cache_default === false)
}
/** Params patch for the switch: picking the default clears the override, so a later default change applies. */
function cachePatch(checked, spec) {
  return { cache: checked === cacheOn({}, spec) ? null : !!checked }
}

/** Media list edit: set item `index` (index === length appends); blank text leaves the list alone — the row
 *  keeps its own draft, and an emptied row is removed when it loses focus. Pure, tested. */
function setMediaItem(items, index, text) {
  const clean = String(text || '').trim()
  if (!clean) return items
  const next = [...items]
  if (index < next.length) next[index] = clean
  else next.push(clean)
  return next
}

/** Tool node types for pickers: `[{category, items}]`, sorted by category then title. */
function toolChoices(types) {
  const tools = ((types && types.list) || []).filter((t) => t.kind === 'tool')
  const sorted = [...tools].sort((a, b) => (a.category || '').localeCompare(b.category || '') || (a.title || a.type).localeCompare(b.title || b.type))
  return groupByCategory(sorted)
}

/**
 * Swap a node to another type (C5 tool picker). Keeps params the new type knows (plus cache/timeout_s),
 * drops an auto title and every edge whose port vanished or no longer type-checks.
 */
function changeNodeType(flow, id, type, typesInfo) {
  const byName = (typesInfo && typesInfo.byName) || {}
  const node = flow.nodes.find((n) => n.id === id)
  const spec = byName[type]
  if (!node || !spec || node.type === type) return flow
  const old = byName[node.type]
  const known = new Set([...(spec.params || []).map((p) => p.name), 'cache', 'timeout_s'])
  // Same step on another provider: its model list (and the settings that model offered) belong to the old one.
  const sameStep = !!(spec.provider_group && old && old.provider_group === spec.provider_group)
  const providerOwned = new Set(sameStep ? (old.params || []).filter((p) => p.options_source || p.from_model).map((p) => p.name) : [])
  const params = {}
  for (const [k, v] of Object.entries(node.params || {})) if (known.has(k) && !providerOwned.has(k)) params[k] = v
  const next = { ...node, type, params }
  if (next.title && (!old || next.title === old.title)) delete next.title
  const ports = nodePorts(next, spec)
  const ins = new Map(ports.inputs.map((p) => [p.name, p]))
  const outs = new Map(ports.outputs.map((p) => [p.name, p]))
  const portOf = (nid, side, name) => {
    const n = flow.nodes.find((x) => x.id === nid)
    return n ? nodePorts(n, byName[n.type])[side].find((p) => p.name === name) : null
  }
  const edges = flow.edges.filter((e) => {
    if (e.to.node === id) {
      const dst = ins.get(e.to.port)
      const src = e.from.node === id ? outs.get(e.from.port) : portOf(e.from.node, 'outputs', e.from.port)
      return !!dst && !!src && compatible(typesInfo.compat, src.type, dst.type)
    }
    if (e.from.node === id) {
      const src = outs.get(e.from.port)
      const dst = portOf(e.to.node, 'inputs', e.to.port)
      return !!src && !!dst && compatible(typesInfo.compat, src.type, dst.type)
    }
    return true
  })
  return { ...flow, nodes: flow.nodes.map((n) => (n.id === id ? next : n)), edges }
}

/** Copies of `ids` (plus the edges between them) with fresh ids, offset by dx/dy. */
/** Egress opt-in (Send message): every copy path starts disarmed, never carrying the old authorization. */
function disarmCopiedNode(node) {
  if (!node || node.type !== 'output.send_message') return node
  const params = { ...((node && node.params) || {}) }
  params.send_enabled = false
  delete params.authorized_target
  delete params.optin_token
  delete params.allow_attachments
  return { ...node, params }
}

/** True only for a Send message node whose stored authorization matches its stored recipient. */
function messagingArmed(node) {
  const p = (node && node.params) || {}
  return !!node && node.type === 'output.send_message' && p.send_enabled === true && !!p.optin_token &&
    String(p.target || '').trim() === String(p.authorized_target || '')
}

function messagingScope(node) {
  if (!messagingArmed(node)) return 'off'
  return node.params.allow_attachments === true ? 'files' : 'text'
}

function cloneSubgraph(source, ids, dx = 40, dy = 40, takenNodes = null, takenEdges = null) {
  const set = new Set(ids)
  const taken = new Set([...(takenNodes || nodeIdSet(source))])
  const takenE = new Set([...(takenEdges || edgeIdSet(source))])
  const map = {}
  const nodes = source.nodes
    .filter((n) => set.has(n.id))
    .map((n) => {
      const id = newId('n_', taken)
      taken.add(id)
      map[n.id] = id
      return disarmCopiedNode({ ...JSON.parse(JSON.stringify(n)), id, x: n.x + dx, y: n.y + dy })
    })
  const edges = source.edges
    .filter((e) => set.has(e.from.node) && set.has(e.to.node))
    .map((e) => {
      const id = newId('e_', takenE)
      takenE.add(id)
      return { id, from: { node: map[e.from.node], port: e.from.port }, to: { node: map[e.to.node], port: e.to.port } }
    })
  return { nodes, edges, map }
}

const insertSubgraph = (flow, sub) => ({ ...flow, nodes: [...flow.nodes, ...sub.nodes], edges: [...flow.edges, ...sub.edges] })

function defaultParams(spec) {
  const out = {}
  if (!spec || spec.kind === 'tool') return out
  for (const p of spec.params || []) if (p.default !== null && p.default !== undefined && p.default !== '') out[p.name] = p.default
  return out
}

function freeSpot(flow, x, y) {
  let px = x
  let py = y
  for (let i = 0; i < 12; i += 1) {
    if (!flow.nodes.some((n) => Math.abs(n.x - px) < 24 && Math.abs(n.y - py) < 24)) break
    px += 30
    py += 30
  }
  return { x: px, y: py }
}

// ---- undo history over immutable flows
function applyEdit(doc, nextFlow, opts = {}) {
  if (!doc.flow || nextFlow === doc.flow) return doc
  const now = opts.now !== undefined ? opts.now : Date.now()
  const coalesce = !!opts.key && doc.key === opts.key && now - (doc.at || 0) < 1200
  return {
    flow: nextFlow,
    undo: coalesce ? doc.undo : [...doc.undo, doc.flow].slice(-UNDO_LIMIT),
    redo: [],
    key: opts.key || null,
    at: now
  }
}
function undoDoc(doc) {
  if (!doc.undo.length) return doc
  return { flow: doc.undo[doc.undo.length - 1], undo: doc.undo.slice(0, -1), redo: [...doc.redo, doc.flow], key: null, at: 0 }
}
function redoDoc(doc) {
  if (!doc.redo.length) return doc
  return { flow: doc.redo[doc.redo.length - 1], undo: [...doc.undo, doc.flow], redo: doc.redo.slice(0, -1), key: null, at: 0 }
}
/**
 * A revision that came from outside this window (Hermes, another window, "Load latest") replaces the flow and drops
 * the undo history: Ctrl+Z must never quietly revert someone else's change and save it back (review U-15).
 * An edit the user asked for in this window ("Build with Hermes") stays undoable, so it goes through applyEdit.
 */
function applyRemote(doc, flow) {
  if (!doc || !doc.flow || !flow || flow === doc.flow) return doc
  return { flow, undo: [], redo: [], key: null, at: 0 }
}

// ---- Build with Hermes (G6): controlled draft, so an error never discards the prompt or model.
const generateInitial = () => ({ open: false, busy: false, error: '', draft: { prompt: '', model: null, provider: null },
  jobId: null, phase: '', elapsed: 0, startedAt: null })
function generateReducer(state, action) {
  switch (action.type) {
    case 'open': return { ...state, open: true, error: '' }
    case 'close': return { ...state, open: false, busy: false, error: '', jobId: null, phase: '', elapsed: 0, startedAt: null }
    case 'edit': return { ...state, draft: { ...state.draft, ...action.patch }, error: '' }
    case 'start': return { ...state, busy: true, error: '', jobId: null, phase: 'starting', elapsed: 0, startedAt: Number.isFinite(action.at) ? action.at : null }
    case 'progress': return state.busy
      ? { ...state, jobId: action.jobId || state.jobId, phase: action.phase || state.phase, elapsed: Number(action.elapsed) || 0 }
      : state
    case 'fail': return { ...state, busy: false, jobId: null, phase: '', elapsed: 0, startedAt: null, error: action.error || 'Could not build the flow.' }
    case 'success': return generateInitial()
    default: return state
  }
}
/** Empty model/provider means Hermes' current model: do not turn it into an explicit override. */
/** Hermes' providers/models (gateway `model.options`) in the compact shape the build's MODEL GUIDE reads. */
function llmModelsHint(payload) {
  return modelGroups(payload).map((g) => ({
    provider: g.slug, name: g.name, current: g.current,
    current_model: g.current && payload && typeof payload.model === 'string' ? payload.model : '',
    models: g.models.slice(0, 600).map((m) => {
      const price = g.prices[m] || {}
      const caps = g.caps[m] || {}
      const row = { id: m }
      if (typeof caps.reasoning === 'boolean') row.reasoning = caps.reasoning
      if (price.input !== undefined && price.input !== null) row.input = String(price.input)
      if (price.output !== undefined && price.output !== null) row.output = String(price.output)
      return row
    }),
  }))
}
function generationBody({ prompt, flow = null, baseRevision = null, model = null, provider = null, llmModels = null }) {
  const body = { prompt: String(prompt || '').trim(), origin: 'ui' }
  if (Array.isArray(llmModels) && llmModels.length) body.llm_models = llmModels
  if (flow && flow.id) {
    body.flow_id = flow.id
    if (baseRevision !== null && baseRevision !== undefined) body.base_revision = baseRevision
  }
  if (!isBlank(model)) body.model = model
  if (!isBlank(provider)) body.provider = provider
  return body
}
// A build runs as a background job (POST generate/jobs) that the UI polls, so no request has to stay open for as long
// as the model thinks; there is no overall time limit, only Cancel.
const GENERATE_POLL_MS = [200, 400, 700, 1000]
const GENERATE_POLL_WAIT_S = 4
const GENERATE_POLL_MISSES = 5
const GENERATE_PHASES = {
  starting: 'Starting…', models: 'Reading the available models', thinking: 'Hermes is designing the flow', repairing: 'Fixing a validation error (one repair)',
  saving: 'Saving the validated flow',
}
// The user's wait starts at Submit, not at a backend poll; wall time also catches up after a suspended window.
function generationElapsed(generation, now) {
  return generation.busy && Number.isFinite(generation.startedAt) && Number.isFinite(now)
    ? Math.max(0, (now - generation.startedAt) / 1000)
    : Math.max(0, Number(generation.elapsed) || 0)
}
function generationStatus(phase, elapsed) {
  const secs = Math.max(0, Math.floor(Number(elapsed) || 0))
  const time = secs >= 60 ? `${Math.floor(secs / 60)} min ${String(secs % 60).padStart(2, '0')} s` : `${secs} s`
  return `${GENERATE_PHASES[phase] || 'Working'} · ${time}`
}
/** A failed job as the Error shape parseRestError reads ("<status>: {detail}"), so 409 conflicts keep working. */
function generationJobError(e) {
  const err = e && typeof e === 'object' ? e : {}
  const message = String(err.message || 'Could not build the flow.')
  if (!err.status) return new Error(message)
  const detail = err.code === 'conflict'
    ? { code: 'conflict', message, current_revision: err.current_revision ?? null }
    : message
  return new Error(`${err.status}: ${JSON.stringify({ detail })}`)
}
/** Start a build job and poll it to the end. Resolves with the generate result, rejects with a REST-shaped error.
 *  A few failed polls in a row are tolerated (a gateway blip must not lose a build that is still running). Pure
 *  apart from `api`, tested. */
async function runGenerationJob(api, body, { onProgress, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let job = await api.generateStart(body)
  let polls = 0
  let misses = 0
  while (job && job.status === 'running') {
    if (onProgress) onProgress(job)
    await sleep(GENERATE_POLL_MS[Math.min(polls++, GENERATE_POLL_MS.length - 1)])
    try {
      job = await api.generateJob(job.id)
      misses = 0
    } catch (err) {
      if (parseRestError(err).status === 404 || ++misses >= GENERATE_POLL_MISSES) throw err
    }
  }
  if (job && job.status === 'done') return job.result
  if (job && job.status === 'cancelled') throw new Error('Build cancelled. Nothing was saved; your prompt is preserved.')
  throw generationJobError(job && job.error)
}
function generationSummary(result) {
  const summary = result.summary || {}
  const nodes = Number(summary.nodes) || 0
  const connections = Number(summary.connections) || 0
  return `${result.created ? 'Created' : 'Updated'} flow · ${nodes} ${nodes === 1 ? 'node' : 'nodes'} · ` +
    `${connections} ${connections === 1 ? 'connection' : 'connections'}${result.repaired ? ' · repaired once' : ''}`
}

