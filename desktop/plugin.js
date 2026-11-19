// Arachne Flow — the Hermes Desktop page of the arachne-flow plugin.
//
// GENERATED: desktop/plugin.js is built from desktop/src/NN-*.js by `node scripts/build_desktop.mjs`; edit the
// sources, never plugin.js (check.sh refuses a stale build). One shipped file on purpose: Desktop evaluates it
// from a blob: URL, so it cannot import siblings. The parts share one module scope; imports are limited to the
// plugin SDK and React and live in 00-core.js. Pure logic (geometry, graph edits, undo, parsing) lives in plain
// functions exported through `_internals` and is unit-tested in tests/js without the app.
import * as sdk from '@hermes/plugin-sdk'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const host = sdk.host || {}
const PLUGIN_ID = 'arachne-flow'
const ROUTE = '/arachne-flow'
const evt = (name) => `plugin.${PLUGIN_ID}.${name}`

const NODE_W = 240
const HEAD_H = 48  // Clean card: title line + "provider · model" line (ports and wires are placed below it)
const PORTS_TOP = 6
const ROW_H = 22
const GRID = 10
const MIN_ZOOM = 0.2
const MAX_ZOOM = 2.5
const COLLAPSE_AFTER = 6
const VISIBLE_OPTIONAL = 4
const UNDO_LIMIT = 50
const SAVE_DELAY = 600
const POLL_MS = 2000
// Consecutive failed fallback polls after which the page admits it lost the backend (U-5).
const LOST_CONTACT_AFTER = 3
const DND_TYPE = 'application/x-arachne-flow-node'
const TERMINAL = new Set(['done', 'error', 'cancelled', 'invalid', 'interrupted'])
const EMPTY_SET = new Set()
const EMPTY_DOC = { flow: null, undo: [], redo: [], key: null, at: 0 }
const EMPTY_TYPES = { list: [], byName: {}, compat: {}, portTypes: {}, categories: [] }
// Survives navigating away from the page (the module stays loaded; the component does not).
const SHARED = { pendingOpen: null, pendingRun: false, session: null, runCurrent: null, listeners: new Set(), pageMounted: false }
let CLIPBOARD = null

// ---------------------------------------------------------------- element helper (no JSX)
// Children keep their positions (false/null holes included), exactly like JSX, so toggling one
// conditional child never remounts its siblings.
function h(type, props, ...children) {
  const { key, ...rest } = props || {}
  if (children.length === 1) rest.children = children[0]
  else if (children.length > 1) rest.children = children
  return children.length > 1 ? jsxs(type, rest, key) : jsx(type, rest, key)
}

function Icon({ name, spin, className, style, title }) {
  const cls = `codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}${className ? ` ${className}` : ''}`
  return h('i', { className: cls, style, title, 'aria-hidden': title ? undefined : 'true' })
}

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

/** Edge layout A (18.11.2026): a wire whose input is not clearly right of its output (backwards, or stacked in one
 *  column) runs around below both cards — right, down, left, up — instead of cutting behind them, as n8n does.
 *  Forward wires keep the curve. `boxA`/`boxB` are the cards' world rects {x, y, w, h}. Pure, tested. */
const BACK_GAP = 24
function edgeRouteWorld(a, b, boxA, boxB) {
  if (!boxA || !boxB || b.x >= a.x + 2 * BACK_GAP) return edgePathWorld(a, b)
  const below = Math.max(boxA.y + boxA.h, boxB.y + boxB.h) + BACK_GAP
  return roundedPath([a, { x: a.x + BACK_GAP, y: a.y }, { x: a.x + BACK_GAP, y: below }, { x: b.x - BACK_GAP, y: below },
    { x: b.x - BACK_GAP, y: b.y }, b], 12)
}

/** Polyline with rounded corners (quadratic bends of radius ≤ r, never longer than half a segment). */
function roundedPath(pts, r) {
  const f = (n) => n.toFixed(1)
  let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1]
    const c = pts[i]
    const n = pts[i + 1]
    const l1 = Math.hypot(c.x - p.x, c.y - p.y)
    const l2 = Math.hypot(n.x - c.x, n.y - c.y)
    if (!l1 || !l2) continue
    const rr = Math.min(r, l1 / 2, l2 / 2)
    d += ` L ${f(c.x + (p.x - c.x) / l1 * rr)} ${f(c.y + (p.y - c.y) / l1 * rr)}` +
      ` Q ${f(c.x)} ${f(c.y)} ${f(c.x + (n.x - c.x) / l2 * rr)} ${f(c.y + (n.y - c.y) / l2 * rr)}`
  }
  const z = pts[pts.length - 1]
  return `${d} L ${f(z.x)} ${f(z.y)}`
}

/** Which wires to light up: those of the hovered node, else of the one selected node, plus a selected wire.
 *  Returns null when nothing is in focus (all wires look normal) or while a wire is being dragged. Pure, tested. */
function edgeFocus(edges, { hover = null, selection = [], selectedEdge = null, dragging = false } = {}) {
  if (dragging) return null
  const node = hover || (selection.length === 1 ? selection[0] : null)
  if (!node && !selectedEdge) return null
  return new Set(edges.filter((e) => e.id === selectedEdge || (node && (e.from.node === node || e.to.node === node))).map((e) => e.id))
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

// ---------------------------------------------------------------- status vocab
const STATUS = {
  queued: { icon: 'circle-large-outline', color: 'var(--ui-text-tertiary)', label: 'Queued' },
  running: { icon: 'loading', spin: true, color: 'var(--ui-accent)', label: 'Running' },
  done: { icon: 'pass-filled', color: 'var(--ui-green)', label: 'Done' },
  cached: { icon: 'zap', color: 'var(--ui-cyan)', label: 'Cached' },
  error: { icon: 'error', color: 'var(--ui-red)', label: 'Failed' },
  skipped: { icon: 'debug-step-over', color: 'var(--ui-text-tertiary)', label: 'Skipped' },
  cancelled: { icon: 'circle-slash', color: 'var(--ui-text-tertiary)', label: 'Stopped' },
  interrupted: { icon: 'debug-disconnect', color: 'var(--ui-yellow)', label: 'Interrupted' }
}
const RUN_STATUS = {
  starting: { icon: 'loading', spin: true, color: 'var(--ui-accent)', label: 'Starting' },
  queued: { icon: 'loading', spin: true, color: 'var(--ui-accent)', label: 'Queued' },
  running: { icon: 'loading', spin: true, color: 'var(--ui-accent)', label: 'Running' },
  done: { icon: 'pass-filled', color: 'var(--ui-green)', label: 'Done' },
  error: { icon: 'error', color: 'var(--ui-red)', label: 'Failed' },
  cancelled: { icon: 'circle-slash', color: 'var(--ui-text-tertiary)', label: 'Stopped' },
  invalid: { icon: 'warning', color: 'var(--ui-yellow)', label: 'Not runnable' },
  interrupted: { icon: 'debug-disconnect', color: 'var(--ui-yellow)', label: 'Interrupted' }
}
const MEDIA_ICON = { image: 'file-media', audio: 'unmute', video: 'device-camera-video', model3d: 'package', file: 'file' }
const NOTICE_ICON = { ok: 'pass-filled', error: 'error', warn: 'warning', info: 'info' }
const SHORTCUTS = [
  ['Ctrl+Enter', 'Run the flow'],
  ['Shift+Run', 'Run without cache'],
  ['Del', 'Delete selection'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
  ['Ctrl+C / X / V', 'Copy / cut / paste nodes'],
  ['Ctrl+D', 'Duplicate'],
  ['Ctrl+A', 'Select all'],
  ['F', 'Fit to screen'],
  ['Shift+drag', 'Box select'],
  ['Space+drag', 'Pan'],
  ['Wheel', 'Zoom'],
  ['Right-click', 'More actions']
]

// ---------------------------------------------------------------- styles
const CSS = `
.fc-root { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; overflow: hidden;
  color: var(--ui-text-primary); background: var(--ui-bg-editor); outline: none; user-select: none; -webkit-user-select: none;
  font-size: 12.5px; line-height: 1.35; }
.fc-root *, .fc-root *::before, .fc-root *::after { box-sizing: border-box; }
/* The Arachne Flow window (G4): our page covers the whole window. z 75 keeps it above the app's titlebar tools
   (z 70) and BELOW the native window buttons the Desktop/WSLg shell draws (z 80): at z 100 this page covered
   them, so a full-window Arachne Flow window could not be closed, maximized or restored (U-6). App dialogs,
   toasts and tooltips (z 120+) still sit above it. The header is the window's drag area and keeps clear of the
   same window buttons on the right (--titlebar-tools-right / --titlebar-controls-* come from the app shell). */
.fc-root.fc-focus { position: fixed; inset: 0; z-index: 75; width: 100vw; height: 100vh; }
.fc-focus .fc-header { -webkit-app-region: drag; height: max(46px, var(--titlebar-control-size, 0px));
  padding-right: calc(var(--titlebar-tools-right, 0px) + 12px);
  padding-left: max(12px, var(--titlebar-content-inset, 0px)); }
.fc-focus .fc-header button, .fc-focus .fc-header input, .fc-focus .fc-header select, .fc-focus .fc-header a,
.fc-focus .fc-menu-wrap, .fc-focus .fc-header [role="button"] { -webkit-app-region: no-drag; }
.fc-root input, .fc-root textarea, .fc-root select, .fc-root pre, .fc-md, .fc-log-body { user-select: text; -webkit-user-select: text; }
.fc-grow { flex: 1; min-width: 0; }
.fc-muted { color: var(--ui-text-tertiary); }
.fc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fc-row.center { justify-content: center; }
.fc-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 7px;
  border: 1px solid var(--ui-stroke-secondary); background: var(--ui-bg-elevated); color: var(--ui-text-primary); font: inherit;
  font-size: 12.5px; cursor: pointer; white-space: nowrap; transition: background-color .12s, border-color .12s, opacity .12s; }
.fc-btn:hover:not(:disabled) { background: var(--ui-control-hover-background); border-color: var(--ui-stroke-primary); }
.fc-btn:disabled { opacity: .45; cursor: default; }
.fc-btn .codicon { font-size: 14px; }
.fc-btn.primary { background: var(--ui-accent); border-color: transparent; color: var(--ui-bg-editor); font-weight: 600; }
.fc-btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--ui-accent) 90%, transparent); border-color: transparent; }
.fc-btn.ghost { background: transparent; border-color: transparent; }
.fc-btn.ghost:hover:not(:disabled) { background: var(--ui-control-hover-background); border-color: transparent; }
.fc-btn.icon { width: 28px; padding: 0; }
.fc-btn.danger { color: var(--ui-red); }
.fc-btn.active { background: var(--ui-selection-background); }
.fc-header { flex: none; position: relative; z-index: 5; display: flex; align-items: center; gap: 8px; height: 46px; padding: 0 12px;
  border-bottom: 1px solid var(--ui-stroke-tertiary); }
.fc-header-title { font-size: 14px; font-weight: 600; }
.fc-title-input { font: inherit; font-size: 14px; font-weight: 600; color: var(--ui-text-primary); background: transparent;
  border: 1px solid transparent; border-radius: 6px; padding: 3px 6px; max-width: 380px; outline: none; }
.fc-title-input:hover { border-color: var(--ui-stroke-tertiary); }
.fc-title-input:focus { border-color: var(--ui-accent); background: var(--ui-bg-elevated); }
.fc-save { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--ui-text-tertiary); white-space: nowrap; }
.fc-save .codicon { font-size: 13px; }
.fc-save.bad { color: var(--ui-red); }
.fc-sep { width: 1px; height: 20px; background: var(--ui-stroke-tertiary); margin: 0 2px; }
.fc-menu-wrap { position: relative; }
.fc-menu { position: absolute; top: 34px; left: 0; width: 330px; max-height: 70vh; overflow-y: auto; padding: 6px; border-radius: 10px;
  background: var(--ui-bg-elevated); box-shadow: var(--shadow-md, 0 0 0 1px var(--ui-stroke-secondary), 0 14px 40px rgba(0,0,0,.35)); z-index: 30; }
.fc-menu.fc-ctx { width: 230px; }
.fc-menu.fc-flows-menu { display: flex; flex-direction: column; width: 360px; max-height: min(72vh, 600px); overflow: hidden; padding: 0; }
.fc-menu-top { flex: none; padding: 6px 6px 4px; border-bottom: 1px solid var(--ui-stroke-tertiary); }
.fc-menu-search { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 7px; color: var(--ui-text-tertiary);
  background: var(--ui-bg-tertiary, transparent); border: 1px solid var(--ui-stroke-tertiary); }
.fc-menu-search:focus-within { border-color: var(--ui-accent); }
.fc-menu-search input { flex: 1; min-width: 0; font: inherit; font-size: 12.5px; color: var(--ui-text-primary); background: none; border: 0; outline: none; }
.fc-menu-tabs { display: flex; gap: 4px; margin-top: 6px; }
.fc-menu-tab { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 5px 8px; border-radius: 6px; cursor: pointer;
  font-size: 12px; color: var(--ui-text-secondary); }
.fc-menu-tab:hover, .fc-menu-tab:focus { outline: none; background: var(--ui-row-hover-background); color: var(--ui-text-primary); }
.fc-menu-tab:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
.fc-menu-tab.on { background: var(--ui-selection-background); color: var(--ui-text-primary); font-weight: 600; }
.fc-menu-count { font-size: 10.5px; font-weight: 400; color: var(--ui-text-tertiary); }
.fc-menu-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 6px 6px; }
.fc-menu-more { color: var(--ui-text-tertiary); font-size: 12px; }
.fc-menu-foot { flex: none; display: flex; gap: 2px; padding: 4px 6px; border-top: 1px solid var(--ui-stroke-tertiary); }
.fc-menu-foot .fc-menu-item { flex: 1; justify-content: center; gap: 6px; padding: 6px 4px; font-size: 12px; }
.fc-menu-foot .fc-menu-item .fc-menu-name { flex: none; }
.fc-menu-label { padding: 8px 8px 4px; font-size: 10.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--ui-text-tertiary); }
.fc-menu-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer; color: var(--ui-text-secondary); }
.fc-menu-item:hover { background: var(--ui-row-hover-background); color: var(--ui-text-primary); }
.fc-menu-item.active { background: var(--ui-selection-background); color: var(--ui-text-primary); }
.fc-menu-item.disabled { opacity: .45; cursor: default; }
.fc-menu-item.disabled:hover { background: transparent; color: var(--ui-text-secondary); }
.fc-menu-item.danger { color: var(--ui-red); }
/* U-8: the keyboard-focused row looks focused (arrows move it), and a dialog scrim never shows a ring of its own. */
.fc-menu:focus { outline: none; }
.fc-menu-item:focus { outline: none; background: var(--ui-row-hover-background); color: var(--ui-text-primary); }
.fc-menu-item:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
.fc-menu-item.disabled:focus-visible { outline: 1px dashed var(--ui-stroke-secondary); }
.fc-modal-scrim:focus { outline: none; }
.fc-value-modal {
  display: flex;
  flex-direction: column;
  width: 85vw;
  max-width: 850px;
  height: 85vh;
  max-height: 700px;
  background: var(--ui-bg-elevated);
  color: var(--ui-text-primary);
  border: 1px solid var(--ui-stroke-tertiary);
  border-radius: 8px;
  overflow: hidden;
}
.fc-value-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--ui-stroke-tertiary);
  gap: 8px;
}
.fc-value-modal-title {
  font-weight: 600;
  font-size: 14px;
  color: var(--ui-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fc-value-modal-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.fc-value-modal-selectors {
  width: 200px;
  flex-shrink: 0;
  border-right: 1px solid var(--ui-stroke-tertiary);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}
.fc-value-modal-selectors button {
  text-align: left;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fc-value-modal-selectors button[aria-pressed="true"] {
  background: var(--ui-accent);
  color: var(--ui-text-primary);
}
.fc-value-warning{font-size:12px;line-height:1.45;color:var(--ui-text-secondary);overflow-wrap:anywhere;padding:6px 0}
.fc-value-modal-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-y: auto;
  padding: 12px 16px;
  gap: 12px;
}
.fc-value-modal-content .fc-pre { max-height: none; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere; }
.fc-value-modal-content .fc-value-toolbar { position: sticky; top: 0; z-index: 1; background: var(--ui-bg-elevated); padding: 4px 0; }
@media (max-width: 600px) { .fc-value-modal { width: 95vw; } .fc-value-modal-selectors { width: 110px; } }
.fc-value-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.fc-value-btn-group {
  display: flex;
  gap: 4px;
}
.fc-value-btn-group button.active {
  background: var(--ui-accent);
  color: var(--ui-text-primary);
}
.fc-json-tree {
  font-family: monospace;
  font-size: 12px;
  line-height: 1.5;
}
.fc-json-tree-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.fc-json-branch {
  margin-left: 12px;
}
.fc-json-summary {
  cursor: pointer;
  color: var(--ui-text-primary);
}
.fc-json-children {
  margin-left: 12px;
}
.fc-json-leaf {
  margin-left: 12px;
}
.fc-json-key {
  color: var(--ui-text-tertiary);
}
.fc-json-string {
  color: var(--ui-text-primary);
}
.fc-json-number, .fc-json-boolean {
  color: var(--ui-accent);
}
.fc-json-null {
  color: var(--ui-text-tertiary);
  font-style: italic;
}
.fc-json-truncated {
  color: var(--ui-text-tertiary);
  font-style: italic;
  margin-left: 12px;
}
.fc-value-empty {
  color: var(--ui-text-tertiary);
  font-style: italic;
  padding: 8px 0;
}
.fc-value-status {
  color: var(--ui-text-tertiary);
  padding: 8px 0;
}
.fc-value-error {
  color: var(--ui-text-primary);
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-stroke-tertiary);
  padding: 8px 12px;
  border-radius: 4px;
}
.fc-raw-collapse {
  margin-top: 8px;
  color: var(--ui-text-tertiary);
  font-size: 12px;
}
.fc-raw-collapse summary {
  cursor: pointer;
  margin-bottom: 4px;
}
.fc-menu-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-menu-meta { font-size: 11px; color: var(--ui-text-quaternary); white-space: nowrap; }
.fc-menu-sep { height: 1px; margin: 6px 4px; background: var(--ui-stroke-tertiary); }
.fc-menu-empty { padding: 6px 8px; color: var(--ui-text-tertiary); }
.fc-mini { flex: none; display: none; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0;
  border-radius: 5px; background: transparent; color: var(--ui-text-tertiary); cursor: pointer; }
.fc-mini .codicon { font-size: 13px; }
.fc-menu-item:hover .fc-mini, .fc-menu-item:focus .fc-mini, .fc-menu-item:focus-within .fc-mini, .fc-mini.armed, .fc-mini:focus, .fc-mini:focus-visible { display: inline-flex; }
.fc-mini:hover, .fc-mini:focus { background: var(--ui-control-hover-background); color: var(--ui-text-primary); outline: none; }
.fc-mini:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -1px; }
.fc-mini.armed { color: var(--ui-red); background: color-mix(in srgb, var(--ui-red) 14%, transparent); }
.fc-tag { flex: none; display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 999px; font-size: 10px; font-weight: 600;
  vertical-align: 1px; letter-spacing: .02em; color: var(--ui-accent); background: color-mix(in srgb, var(--ui-accent) 16%, transparent); }
/* Template dialog (G5): opaque card over a scrim, inside our page. */
.fc-modal-scrim { position: absolute; inset: 0; z-index: 60; display: flex; align-items: flex-start; justify-content: center;
  padding-top: 12vh; background: color-mix(in srgb, #000 22%, transparent); }
.fc-modal { width: min(440px, calc(100% - 32px)); padding: 16px 16px 14px; border-radius: 12px; background: var(--ui-bg-elevated);
  box-shadow: var(--shadow-lg, 0 0 0 1px var(--ui-stroke-secondary), 0 18px 50px rgba(0, 0, 0, .45)); }
.fc-modal-title { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 14px; font-weight: 600; color: var(--ui-text-primary); }
.fc-modal-title .codicon { color: var(--ui-accent); }
.fc-modal .fc-help { margin: 0 0 12px; }
.fc-modal .fc-check { margin-top: 4px; }
.fc-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
/* Build with Hermes (G6): the same controlled composer on the welcome/blank canvas and in the header dialog. */
.fc-generate-card { width: 100%; padding: 14px; border: 1px solid var(--ui-stroke-secondary); border-radius: 12px;
  background: var(--ui-bg-elevated); color: var(--ui-text-primary); text-align: left;
  box-shadow: var(--shadow-sm, 0 10px 28px rgba(0,0,0,.16)); }
.fc-generate-head { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; font-size: 13.5px; font-weight: 600; }
.fc-generate-head .codicon { color: var(--ui-accent); }
.fc-generate-card > .fc-help { margin: 0 0 10px; }
.fc-generate-card textarea { min-height: 86px; max-height: 220px; }
.fc-generate-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 10px; margin-top: 10px; }
.fc-generate-controls > .fc-row { padding-top: 17px; }
.fc-generate-model > label { display: block; margin-bottom: 4px; color: var(--ui-text-tertiary); font-size: 11px; }
.fc-generate-model .fc-model-btn { width: 100%; }
/* The composer's model list floats over the dialog (fixed, placed by ModelPicker): it never grows the card. */
.fc-generate-card .fc-model-pop { position: fixed; z-index: 90; right: auto; }
.fc-generate-error { margin-top: 9px; padding: 7px 9px; border-radius: 7px; color: var(--ui-red); white-space: pre-wrap;
  background: color-mix(in srgb, var(--ui-red) 11%, transparent); font-size: 11.5px; user-select: text; }
.fc-generate-busy { margin-top: 8px; color: var(--ui-text-tertiary); font-size: 11px; }
[data-fc-generate-dialog] { padding: clamp(12px, 6vh, 56px) 16px; }
.fc-generate-modal { width: min(620px, 100%); max-height: 100%; overflow-y: auto; overscroll-behavior: contain; border-radius: 12px; }
.fc-generate-hint { max-height: calc(100% - 32px); overflow-y: auto; }
@media (max-width: 600px) {
  .fc-generate-controls { grid-template-columns: minmax(0, 1fr); }
  .fc-generate-controls > .fc-row { padding-top: 0; justify-content: flex-end; }
}
.fc-hint.fc-generate-hint { width: min(540px, calc(100% - 32px)); pointer-events: auto;
  inset: 0; margin: auto; height: fit-content; transform: none; }  /* no transform: the floating model list stays unclipped */
.fc-generate-hint .fc-hint-title { margin: 0 0 8px; }
.fc-welcome .fc-generate-card { margin: 18px auto 8px; max-width: 580px; }
.fc-check.disabled { opacity: .55; cursor: default; }
.fc-template .fc-tag { font-size: 10px; color: var(--ui-accent); }
.fc-banner { flex: none; display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--ui-stroke-tertiary); }
.fc-banner.warn { background: color-mix(in srgb, var(--ui-yellow) 13%, transparent); }
.fc-banner.bad { background: color-mix(in srgb, var(--ui-red) 12%, transparent); }
.fc-banner > .codicon { font-size: 15px; }
.fc-banner.warn > .codicon { color: var(--ui-yellow); }
.fc-banner.bad > .codicon { color: var(--ui-red); }
.fc-notice { position: absolute; top: 56px; left: 50%; transform: translateX(-50%); z-index: 40; display: flex; align-items: center; gap: 8px;
  max-width: min(640px, 80%); padding: 8px 14px; border-radius: 999px; background: var(--ui-bg-elevated); cursor: pointer;
  box-shadow: var(--shadow-md, 0 0 0 1px var(--ui-stroke-secondary), 0 10px 30px rgba(0,0,0,.3)); animation: fc-in .18s ease-out; }
.fc-notice span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-notice.ok .codicon { color: var(--ui-green); }
.fc-notice.error .codicon { color: var(--ui-red); }
.fc-notice.warn .codicon { color: var(--ui-yellow); }
.fc-notice.info .codicon { color: var(--ui-accent); }
@keyframes fc-in { from { opacity: 0; transform: translate(-50%, -6px); } }
.fc-main { flex: 1; display: flex; min-height: 0; position: relative; }
.fc-side { flex: none; display: flex; flex-direction: column; min-height: 0; }
.fc-palette { width: 232px; border-right: 1px solid var(--ui-stroke-tertiary); }
.fc-inspector { width: 316px; border-left: 1px solid var(--ui-stroke-tertiary); overflow-y: auto; }
.fc-search { margin: 10px 10px 6px; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px; border-radius: 7px;
  border: 1px solid var(--ui-stroke-secondary); background: var(--ui-bg-elevated); }
.fc-search:focus-within { border-color: var(--ui-accent); }
.fc-search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--ui-text-primary); font: inherit; }
.fc-search .codicon { color: var(--ui-text-tertiary); }
.fc-palette-list { flex: 1; overflow-y: auto; padding: 0 6px 10px; }
.fc-cat { display: flex; align-items: center; gap: 5px; padding: 8px 6px 4px; font-size: 10.5px; font-weight: 600; letter-spacing: .04em;
  text-transform: uppercase; color: var(--ui-text-tertiary); cursor: pointer; }
.fc-cat:hover { color: var(--ui-text-secondary); }
.fc-cat .fc-count { margin-left: auto; font-weight: 500; color: var(--ui-text-quaternary); }
.fc-item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: grab; color: var(--ui-text-secondary); }
.fc-item:hover, .fc-item.active { background: var(--ui-row-hover-background); color: var(--ui-text-primary); }
.fc-item.active { background: var(--ui-selection-background); }
.fc-item .codicon { color: var(--fc-cat); font-size: 14px; flex: none; }
.fc-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-item-name { flex: 1; min-width: 0; }
.fc-item-meta { flex: none; max-width: 120px; font-size: 10.5px; color: var(--ui-text-quaternary); }
.fc-palette-foot { flex: none; padding: 8px 12px; font-size: 11px; color: var(--ui-text-quaternary); border-top: 1px solid var(--ui-stroke-tertiary); }
.fc-quick { position: absolute; z-index: 35; display: flex; flex-direction: column; width: 340px; height: 440px; max-height: calc(100% - 16px);
  border-radius: 11px; background: var(--ui-bg-elevated); box-shadow: var(--shadow-lg, 0 0 0 1px var(--ui-stroke-secondary), 0 18px 50px rgba(0,0,0,.45)); }
.fc-quick .fc-search { flex: none; margin: 8px 8px 5px; background: var(--ui-bg-tertiary); }
.fc-quick-list { min-height: 0; overflow-y: auto; padding: 0 6px 6px; }
.fc-quick .fc-item { cursor: pointer; padding: 7px 8px; }
.fc-quick-label { padding: 7px 8px 4px; font-size: 10.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--ui-text-tertiary); }
.fc-quick-foot { flex: none; padding: 7px 12px; border-top: 1px solid var(--ui-stroke-tertiary); font-size: 10.5px; color: var(--ui-text-quaternary); }
.fc-canvas { position: relative; flex: 1; min-width: 0; overflow: hidden; outline: none; touch-action: none; cursor: default;
  background-color: var(--ui-bg-editor);
  background-image: radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--ui-text-tertiary) 34%, transparent) 1px, transparent 1.6px); }
.fc-canvas.panning, .fc-canvas.panning * { cursor: grabbing !important; }
.fc-canvas.space, .fc-canvas.space * { cursor: grab !important; }
/* U-4: edges live in world coordinates under the same transform as .fc-world, so a pan/zoom moves this layer
   instead of rewriting every path. vector-effect: non-scaling-stroke keeps the stroke 2.2/3.6/14 px on screen,
   as it was when the paths were computed in screen space. */
.fc-edges { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; transform-origin: 0 0; }
.fc-edge { fill: none; stroke-width: 2.2; opacity: .8; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.fc-edge.selected { stroke-width: 3.6; opacity: 1; }
.fc-edge.flowing { opacity: 1; stroke-dasharray: 7 6; animation: fc-dash .55s linear infinite; }
.fc-edge.dead { opacity: .28; }
.fc-edge.faded { opacity: .16; }
.fc-edge.lit { stroke-width: 3.2; opacity: 1; }
.fc-edge.lit.dead { opacity: .5; }
.fc-edges-top { z-index: 1; }
.fc-edge-hit { fill: none; stroke: transparent; stroke-width: 14; pointer-events: stroke; cursor: pointer; vector-effect: non-scaling-stroke; }
.fc-wire { fill: none; stroke-width: 2.4; stroke-dasharray: 6 5; vector-effect: non-scaling-stroke; }
@keyframes fc-dash { to { stroke-dashoffset: -13; } }
@media (prefers-reduced-motion: reduce) {
  .fc-edge.flowing { animation: none; }
  .fc-node.running { animation: none; box-shadow: 0 0 0 2px var(--ui-accent), 0 0 18px color-mix(in srgb, var(--ui-accent) 45%, transparent); }
}
.fc-world { position: absolute; left: 0; top: 0; width: 0; height: 0; transform-origin: 0 0; }
.fc-rect { position: absolute; border: 1px solid var(--ui-accent); background: color-mix(in srgb, var(--ui-accent) 12%, transparent); pointer-events: none; }
.fc-hint { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); text-align: center; color: var(--ui-text-tertiary);
  pointer-events: none; line-height: 1.6; }
.fc-hint > .codicon { font-size: 34px; color: var(--ui-text-quaternary); }
.fc-hint-title { margin-top: 6px; font-size: 15px; font-weight: 600; color: var(--ui-text-secondary); }
.fc-canvas.file-over { box-shadow: inset 0 0 0 2px var(--ui-accent); background-color: color-mix(in srgb, var(--ui-accent) 5%, var(--ui-bg-editor)); }
.fc-drop-hint { position: absolute; left: 50%; top: 18px; transform: translateX(-50%); z-index: 20; display: flex; align-items: center; gap: 8px;
  padding: 8px 14px; border-radius: 999px; font-size: 12.5px; font-weight: 600; color: var(--ui-text-primary); pointer-events: none;
  background: var(--ui-bg-elevated); box-shadow: 0 0 0 1px var(--ui-accent), var(--shadow-md, 0 10px 26px rgba(0,0,0,.35)); }
.fc-drop-hint .codicon { font-size: 15px; color: var(--ui-accent); }
.fc-drop-hint.busy { box-shadow: var(--shadow-md, 0 0 0 1px var(--ui-stroke-secondary), 0 10px 26px rgba(0,0,0,.35)); }
.fc-browse { display: flex; gap: 6px; }
.fc-browse .fc-input { flex: 1; min-width: 0; }
.fc-browse .fc-btn { flex: none; height: 30px; }
.fc-media-list { display: grid; gap: 6px; }
.fc-media-row { min-width: 0; }
.fc-media-list > .fc-linked { margin-bottom: 2px; font-size: 11px; }
.fc-media-list > .fc-row { justify-content: space-between; }
.fc-media-list > .fc-row .fc-help { margin-top: 0; }
.fc-add-file { margin: -2px 0 8px; color: var(--ui-text-secondary); }
.fc-preview.file .fc-muted { margin-left: auto; font-size: 10.5px; }
.fc-preview.file > span:nth-child(2) { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.fc-zoombar { position: absolute; right: 12px; bottom: 12px; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 9px;
  background: var(--ui-bg-elevated); box-shadow: var(--shadow-sm, 0 0 0 1px var(--ui-stroke-secondary), 0 6px 18px rgba(0,0,0,.25)); }
.fc-zoomval { min-width: 44px; text-align: center; font-size: 11.5px; color: var(--ui-text-secondary); font-variant-numeric: tabular-nums; }
.fc-node { position: absolute; width: ${NODE_W}px; border-radius: 10px; background: var(--ui-bg-elevated); cursor: grab;
  box-shadow: var(--shadow-sm, 0 0 0 1px var(--ui-stroke-secondary), 0 2px 4px rgba(0,0,0,.18), 0 10px 26px rgba(0,0,0,.32)); transition: box-shadow .15s, opacity .2s; }
.fc-node.selected { box-shadow: 0 0 0 2px var(--ui-accent), var(--shadow-md, 0 10px 26px rgba(0,0,0,.32)); }
.fc-node.running { animation: fc-pulse 1.3s ease-in-out infinite; }
.fc-node.error { box-shadow: 0 0 0 1.5px var(--ui-red), var(--shadow-sm, 0 8px 22px rgba(0,0,0,.26)); }
.fc-node.error.selected { box-shadow: 0 0 0 2.5px var(--ui-red), var(--shadow-md, 0 10px 26px rgba(0,0,0,.32)); }
.fc-node.muted { opacity: .55; }
.fc-node.unknown { outline: 1.5px dashed var(--ui-red); }
.fc-node.note { background: color-mix(in srgb, var(--ui-yellow) 10%, var(--ui-bg-elevated)); }
@keyframes fc-pulse { 0%, 100% { box-shadow: 0 0 0 2px var(--ui-accent), 0 0 14px color-mix(in srgb, var(--ui-accent) 35%, transparent); }
  50% { box-shadow: 0 0 0 2px var(--ui-accent), 0 0 32px color-mix(in srgb, var(--ui-accent) 62%, transparent); } }
.fc-node-head { height: ${HEAD_H}px; display: flex; align-items: center; gap: 9px; padding: 0 10px 0 9px; border-radius: 10px 10px 0 0;
  border-bottom: 1px solid var(--ui-stroke-tertiary); }
.fc-node-titles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.fc-node-sub { font-size: 11px; color: var(--ui-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-node-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 10px 6px;
  border-top: 1px solid var(--ui-stroke-tertiary); font-size: 10.5px; color: var(--ui-text-tertiary); font-variant-numeric: tabular-nums; }
.fc-node-time { flex: none; }
.fc-node-icon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 6px;
  background: color-mix(in srgb, var(--fc-cat) 24%, transparent); color: var(--fc-cat); }
.fc-node-icon .codicon { font-size: 13px; }
.fc-node-title { min-width: 0; font-size: 13px; font-weight: 600; letter-spacing: .005em; color: var(--ui-text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-node-issue { color: var(--ui-yellow); font-size: 13px; flex: none; }
.fc-node-loop { flex: none; color: color-mix(in srgb, var(--ui-purple) 55%, var(--ui-red)); }
.fc-node-loop .codicon { font-size: 12.5px; }
.fc-iters { display: grid; gap: 4px; }
.fc-iter { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 6px; align-items: baseline; }
.fc-iter-n { font-size: 10.5px; font-variant-numeric: tabular-nums; color: var(--ui-text-tertiary); text-align: right; }
.fc-iter-msg { font-size: 11.5px; color: var(--ui-text-tertiary); font-style: italic; overflow-wrap: anywhere; }
.fc-iter-msg.bad { color: var(--ui-red); font-style: normal; }
.fc-node-cost { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; font-weight: 500;
  color: var(--ui-text-secondary); font-variant-numeric: tabular-nums; cursor: help; }
.fc-cost { display: flex; align-items: center; gap: 6px; margin: 2px 0 10px; padding: 5px 8px; border-radius: 7px;
  background: color-mix(in srgb, var(--ui-yellow) 9%, transparent); font-size: 12px; color: var(--ui-text-secondary); }
.fc-cost .codicon { color: var(--ui-yellow); }
.fc-cost b { color: var(--ui-text-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.fc-cost > span:first-of-type { flex: none; }
.fc-multi { display: flex; flex-wrap: wrap; gap: 5px; }
.fc-extra { margin: 4px 0 6px; padding-top: 8px; border-top: 1px solid var(--ui-stroke-tertiary); }
.fc-info-row { display: flex; gap: 8px; font-size: 11.5px; line-height: 1.6; }
.fc-info-k { flex: none; width: 92px; color: var(--ui-text-tertiary); }
.fc-info-v { min-width: 0; color: var(--ui-text-secondary); overflow-wrap: anywhere; }
.fc-subhead { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 8px; font-size: 11.5px; font-weight: 600;
  line-height: 1.35; color: var(--ui-text-secondary); }
.fc-subhead > .codicon { margin-top: 1px; }
.fc-subhead > span:not(.fc-info) { min-width: 0; overflow-wrap: anywhere; } /* long model names wrap, never cut */
.fc-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px 3px 6px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--ui-stroke-primary); font-size: 11.5px; color: var(--ui-text-secondary); user-select: none; }
.fc-chip.on { border-color: var(--ui-accent); color: var(--ui-text-primary); }
.fc-chip input { margin: 0; }
.fc-chip:has(input:disabled) { opacity: .5; cursor: default; }
.fc-badge { flex: none; display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; color: var(--fc-st); white-space: nowrap;
  font-variant-numeric: tabular-nums; }
.fc-badge .codicon { color: var(--fc-st); font-size: 13px; }
.fc-ports { padding: ${PORTS_TOP}px 0 4px; }
.fc-port-row { position: relative; height: ${ROW_H}px; display: flex; align-items: center; }
.fc-port { display: flex; align-items: center; gap: 2px; height: ${ROW_H}px; max-width: 52%; font-size: 11.5px; color: var(--ui-text-secondary); cursor: crosshair; }
.fc-port:hover { color: var(--ui-text-primary); }
.fc-port-in { padding-left: 13px; }
.fc-port-out { margin-left: auto; padding-right: 13px; }
.fc-port-out.untaken { opacity: .42; }
.fc-port-out.taken .fc-port-label { color: var(--ui-text-primary); font-weight: 600; }
.fc-port-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-dot { position: absolute; top: 50%; width: 12px; height: 12px; margin-top: -6px; border-radius: 50%; background: var(--ui-bg-editor);
  border: 2px solid var(--fc-port); transition: transform .1s, background-color .1s; }
.fc-port-in .fc-dot { left: -6px; }
.fc-port-out .fc-dot { right: -6px; }
.fc-dot::after { content: ''; position: absolute; inset: -6px; border-radius: 50%; }
.fc-port.connected .fc-dot { background: var(--fc-port); }
.fc-port:hover .fc-dot { transform: scale(1.3); }
.fc-wiring .fc-port.dim { opacity: .28; }
.fc-wiring .fc-port.ok .fc-dot { transform: scale(1.25); box-shadow: 0 0 0 3px color-mix(in srgb, var(--fc-port) 30%, transparent); }
.fc-port.hot .fc-dot { transform: scale(1.5); background: var(--fc-port); }
.fc-req { color: var(--ui-red); margin-left: 1px; }
.fc-more { margin: 0 10px 6px 13px; font-size: 11px; color: var(--ui-text-tertiary); cursor: pointer; }
.fc-more:hover { color: var(--ui-accent); }
.fc-summary { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 8px; row-gap: 3px; margin: 2px 10px 0 13px;
  padding: 7px 0 9px; border-top: 1px solid var(--ui-stroke-tertiary); font-size: 11px; line-height: 1.3; }
.fc-summary-key { color: var(--ui-text-tertiary); white-space: nowrap; }
.fc-summary-val { color: var(--ui-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-note-text { padding: 9px 13px 11px; white-space: pre-wrap; word-break: break-word; line-height: 1.45; color: var(--ui-text-secondary); max-height: 160px; overflow: hidden; }
.fc-preview { margin: 0 8px 8px; padding: 6px 8px; border-radius: 7px; background: var(--ui-bg-tertiary); font-size: 11.5px; line-height: 1.4; color: var(--ui-text-secondary);
  overflow: hidden; white-space: pre-wrap; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; }
.fc-preview.media { padding: 4px; display: block; }
.fc-preview.file { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.fc-preview img { display: block; width: 100%; max-height: 170px; object-fit: contain; border-radius: 5px; }
/* Every finished output as a readable little card: label + type on top, picture or text underneath. */
.fc-minis { margin: 8px 8px 10px; display: flex; flex-direction: column; gap: 8px; }
.fc-minis .fc-out { display: block; width: auto; height: auto; margin: 0; padding: 7px 9px 8px;
  border: 1px solid var(--ui-stroke-tertiary); border-radius: 8px; background: var(--ui-bg-tertiary); }
.fc-mini-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.fc-mini-label { min-width: 0; font-size: 11.5px; font-weight: 600; color: var(--ui-text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-mini-badge { flex: none; padding: 1px 6px; border-radius: 4px; font-size: 10px; line-height: 14px;
  background: var(--ui-bg-elevated); color: var(--ui-text-tertiary); }
.fc-mini-thumb { margin-top: 7px; border-radius: 6px; overflow: hidden; }
.fc-mini-thumb img { display: block; width: 100%; height: auto; max-height: 140px; object-fit: contain;
  border-radius: 6px; background: var(--ui-bg-elevated); }
.fc-mini-file { margin-top: 6px; display: flex; align-items: center; gap: 8px; font-size: 12.5px;
  color: var(--ui-text-primary); }
.fc-mini-file .codicon { font-size: 19px; }
.fc-mini-player { margin-top: 7px; min-height: 56px; border-radius: 6px; overflow: hidden; }
.fc-mini-player[data-fc-inline-media="video"], .fc-mini-player[data-fc-inline-media="model3d"] { min-height: 140px; }
.fc-mini-player video { display: block; width: 100%; height: 140px; object-fit: contain; background: var(--ui-bg-elevated); }
.fc-mini-player audio { display: block; width: 100%; height: 40px; }
.fc-mini-player .fc-mini-unavailable { padding: 8px 0; font-size: 11px; color: var(--ui-text-tertiary); }
.fc-model-thumb { display: block; width: 100%; height: 140px; object-fit: contain; border-radius: 6px;
  background: var(--ui-bg-elevated); }
.fc-mini-text { margin-top: 6px; font-size: 12.5px; line-height: 1.55; color: var(--ui-text-primary);
  white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3;
  -webkit-box-orient: vertical; overflow: hidden; }
.fc-out.k-broken .fc-mini-badge { color: var(--ui-yellow); }
.fc-out.fc-zoomable { cursor: zoom-in; }
.fc-out.fc-zoomable:hover { border-color: var(--ui-accent); }
.fc-mini-more { padding: 0 4px; font-size: 11px; color: var(--ui-text-tertiary); }
.fc-out.fc-openable { cursor: pointer; text-align: left; }
.fc-out.fc-openable:hover { border-color: var(--ui-accent); }
.fc-out.fc-openable:focus-visible, .fc-mini-more[role="button"]:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 1px; }
.fc-mini-more[role="button"] { cursor: pointer; }
.fc-node-error { margin: 0 8px 8px; padding: 6px 8px; border-radius: 7px; font-size: 11px; color: var(--ui-red);
  background: color-mix(in srgb, var(--ui-red) 11%, transparent); white-space: pre-wrap; word-break: break-word; max-height: 74px; overflow: hidden; }
.fc-section { padding: 12px 14px; border-bottom: 1px solid var(--ui-stroke-tertiary); }
.fc-section h4 { margin: 0 0 9px; font-size: 10.5px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--ui-text-tertiary); }
.fc-insp-head { display: flex; align-items: center; gap: 8px; }
.fc-insp-head > .codicon { font-size: 18px; color: var(--fc-cat); }
.fc-insp-title { font-weight: 600; font-size: 13.5px; }
.fc-insp-type { margin: 10px 0 8px; font-size: 11px; color: var(--ui-text-tertiary); overflow-wrap: anywhere; }
/* Inspector layout B: title, a Run bar that stays on top while scrolling, foldable sections in working order */
.fc-insp-top { padding-bottom: 10px; }
.fc-insp-desc { margin-top: 5px; }
.fc-runbar { position: sticky; top: 0; z-index: 2; padding: 9px 14px; background: var(--ui-bg-elevated);
  border-bottom: 1px solid var(--ui-stroke-tertiary); }
.fc-runbar-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; min-width: 0; }
.fc-runbar-row .fc-btn { flex: none; }
.fc-runbar .fc-cost { margin: 0 0 0 auto; padding: 3px 7px; font-size: 11.5px; flex: 0 1 auto; min-width: 0; max-width: 100%; }
.fc-runbar .fc-cost b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-runbar .fc-timing { margin-top: 6px; font-size: 11px; }
.fc-insp-issues.fc-section { padding: 9px 14px; margin: 0; }
.fc-fold { border-bottom: 1px solid var(--ui-stroke-tertiary); }
.fc-fold-head { display: flex; align-items: center; gap: 7px; width: 100%; min-width: 0; padding: 10px 14px; border: 0; background: none;
  color: var(--ui-text-primary); font: inherit; text-align: left; cursor: pointer; }
.fc-fold-head:hover { background: color-mix(in srgb, var(--ui-text-primary) 4%, transparent); }
.fc-fold-head:focus-visible { outline: 1px solid var(--ui-accent); outline-offset: -1px; }
.fc-fold-head > .codicon { flex: none; color: var(--ui-text-tertiary); }
.fc-fold-title { flex: none; font-size: 12px; font-weight: 600; }
.fc-fold-sum { flex: 1; min-width: 0; text-align: right; font-size: 11px; color: var(--ui-text-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-fold-body { padding: 0 14px 12px; }
.fc-fold-body[hidden] { display: none; }
.fc-fold-body > .fc-row + .fc-check, .fc-fold-body > .fc-check + .fc-row { margin-top: 8px; }
.fc-fold-body > .fc-btn.danger { margin-top: 2px; }
.fc-result .fc-insp-error { margin-bottom: 6px; }
.fc-field { margin-bottom: 11px; }
.fc-field > label { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; font-size: 11.5px; color: var(--ui-text-secondary); }
.fc-more-btn { display: flex; align-items: center; gap: 6px; width: 100%; margin: 2px 0 0; padding: 6px 2px; border: 0; background: none;
  font: inherit; font-size: 12px; color: var(--ui-text-secondary); cursor: pointer; text-align: left; border-top: 1px dashed var(--ui-stroke-tertiary); }
.fc-more-btn:hover { color: var(--ui-accent); }
.fc-more-btn .fc-muted { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.fc-pal-sec + .fc-pal-sec { margin-top: 6px; }
.fc-pal-sec-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; font-size: 10.5px; font-weight: 700;
  letter-spacing: .06em; text-transform: uppercase; color: var(--ui-text-secondary); cursor: pointer; user-select: none; margin-bottom: 2px;
  background: color-mix(in srgb, var(--fc-sec) 9%, transparent); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--fc-sec) 70%, transparent); }
.fc-pal-sec-head:hover { color: var(--ui-text-primary); background: color-mix(in srgb, var(--fc-sec) 15%, transparent); }
.fc-pal-sec-head .fc-pal-chev { font-size: 12px; color: var(--ui-text-tertiary); }
.fc-pal-sec-head .fc-pal-sec-icon { font-size: 13px; color: var(--fc-sec); }
.fc-pal-sec-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-pal-sec-head .fc-count { font-weight: 500; letter-spacing: 0; color: var(--ui-text-quaternary); }
.fc-pal-top { flex: none; display: flex; align-items: center; gap: 2px; margin: 10px 6px 6px 10px; }
.fc-pal-top .fc-search { flex: 1; min-width: 0; margin: 0; }
.fc-pal-fold { flex: none; color: var(--ui-text-tertiary); }
.fc-pal-fold:hover:not(:disabled) { color: var(--ui-text-primary); }
/* Palette tooltip in the Arachne Flow look. The app bubble is inverted and padded via Tailwind utilities (a CSS layer)
   plus tooltip.css; this unlayered, doubled-class rule on our own className wins over both. overflow: hidden clips the
   tip arrow (Radix draws it just outside the box, still in the inverted colour); app markup itself is never styled. */
.fc-tt-bubble.fc-tt-bubble { padding: 0; max-width: 340px; border-radius: 10px; overflow: hidden; text-align: left;
  background: var(--ui-bg-elevated); color: var(--ui-text-secondary); font-size: 11.5px; font-weight: 400; line-height: 1.45;
  box-shadow: var(--shadow-md, 0 0 0 1px var(--ui-stroke-secondary), 0 14px 40px rgba(0,0,0,.35)); }
.fc-tt { width: 300px; max-width: 100%; white-space: normal; }
.fc-tt-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px 6px 7px;
  background: color-mix(in srgb, var(--fc-cat) 13%, var(--ui-bg-elevated));
  border-bottom: 1px solid color-mix(in srgb, var(--fc-cat) 26%, var(--ui-stroke-tertiary)); }
.fc-tt-title { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; color: var(--ui-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-tt-kind { flex: none; padding: 1px 7px; border-radius: 999px; font-size: 9.5px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase;
  white-space: nowrap; color: var(--fc-cat); background: color-mix(in srgb, var(--fc-cat) 16%, transparent); }
.fc-tt-body { display: grid; gap: 5px; padding: 8px 10px 9px; }
.fc-tt-desc { margin-bottom: 2px; color: var(--ui-text-secondary); }
.fc-tt-row { display: grid; grid-template-columns: 44px 1fr; gap: 6px; align-items: baseline; }
.fc-tt-k { font-size: 10px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--ui-text-tertiary); }
.fc-tt-v { display: flex; flex-wrap: wrap; gap: 2px 12px; min-width: 0; color: var(--ui-text-primary); }
.fc-tt-port { display: inline-flex; align-items: baseline; gap: 5px; }
.fc-tt-dot { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--fc-port); transform: translateY(-1px);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--fc-port) 22%, transparent); }
.fc-tt-type { color: var(--ui-text-tertiary); }
.fc-tt-tool { margin-top: 1px; font-family: var(--font-mono, ui-monospace, monospace); font-size: 10.5px; color: var(--ui-text-tertiary); overflow-wrap: anywhere; }
.fc-tt-foot { display: flex; align-items: center; gap: 6px; padding: 7px 10px 8px; border-top: 1px solid var(--ui-stroke-tertiary);
  font-size: 10.5px; line-height: 14px; color: var(--ui-text-tertiary); background: color-mix(in srgb, var(--ui-text-primary) 3%, transparent); }
.fc-tt-foot .codicon { display: block; font-size: 12px; line-height: 14px; }
.fc-info { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; margin-left: 2px; border-radius: 50%;
  color: var(--ui-text-tertiary); cursor: help; outline: none; }
.fc-info .codicon { font-size: 12.5px; }
.fc-info:hover, .fc-info:focus-visible { color: var(--ui-accent); background: color-mix(in srgb, var(--ui-accent) 14%, transparent); }
.fc-tip { max-width: 280px; white-space: normal; line-height: 1.45; }
.fc-tip > div + div { margin-top: 4px; opacity: .8; }
/* G9: small rich tips (status, ports, errors, header buttons) reuse the palette card look */
.fc-tipwrap { display: inline-flex; }
/* disabled buttons fire no pointer events; let them reach the wrapper (the Tip trigger) instead */
.fc-tipwrap > button:disabled { pointer-events: none; }
.fc-tt.fc-tt-sm { width: max-content; min-width: 150px; max-width: 300px; }
.fc-tt-sm .fc-tt-head { padding: 5px 10px 5px 8px; }
.fc-tt-sm .fc-tt-head .fc-node-icon { width: 20px; height: 20px; }
.fc-tt-sm .fc-tt-body { gap: 3px; padding: 7px 10px 8px; }
.fc-tt-line { color: var(--ui-text-secondary); overflow-wrap: anywhere; }
.fc-tt-line:first-child { color: var(--ui-text-primary); }
.fc-tt-sm[data-tone="bad"] .fc-tt-line:not(:first-child) { color: var(--ui-red); }
.fc-tt-sm .fc-tt-foot { padding: 6px 10px 7px; }
.fc-tt-keys { display: inline-flex; gap: 3px; flex: none; }
.fc-tt-keys kbd { padding: 0 5px; border-radius: 4px; font: 600 10px/16px var(--font-mono, ui-monospace, monospace); color: var(--ui-text-secondary);
  background: color-mix(in srgb, var(--ui-text-primary) 8%, transparent); box-shadow: inset 0 0 0 1px var(--ui-stroke-tertiary); }
.fc-badge-exp { color: var(--ui-text-tertiary); }
.fc-timing { display: grid; gap: 2px; margin-top: 8px; font-size: 11.5px; color: var(--ui-text-secondary); }
.fc-timing > div:first-child { color: var(--ui-text-primary); }
.fc-model { position: relative; }
.fc-model-btn { display: flex; align-items: center; gap: 6px; height: 30px; text-align: left; cursor: pointer; }
.fc-model-btn > span:first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-model-btn.open { border-color: var(--ui-accent); }
.fc-model-prov { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--ui-text-tertiary); }
.fc-model-pop { position: absolute; z-index: 30; top: 34px; left: 0; right: 0; border-radius: 9px; background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-stroke-secondary); box-shadow: var(--shadow-md, 0 12px 30px rgba(0,0,0,.35)); overflow: hidden; }
.fc-model-search { display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 9px; border-bottom: 1px solid var(--ui-stroke-tertiary); color: var(--ui-text-tertiary); }
.fc-model-search input { flex: 1; min-width: 0; font: inherit; font-size: 12.5px; color: var(--ui-text-primary); background: none; border: 0; outline: none; }
.fc-model-list { max-height: 320px; overflow-y: auto; padding: 4px; }
.fc-model-head { position: sticky; top: -4px; display: flex; align-items: center; gap: 6px; padding: 7px 8px 4px; font-size: 10.5px; font-weight: 600;
  letter-spacing: .04em; text-transform: uppercase; color: var(--ui-text-tertiary); background: var(--ui-bg-elevated); }
.fc-model-tag { padding: 0 5px; border-radius: 4px; font-size: 9.5px; color: var(--ui-accent); background: color-mix(in srgb, var(--ui-accent) 14%, transparent); }
.fc-model-count { margin-left: auto; font-weight: 400; }
.fc-model-item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; font-size: 12px; cursor: pointer; color: var(--ui-text-secondary); }
.fc-model-item > span:first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-model-item:hover { background: var(--ui-bg-tertiary); color: var(--ui-text-primary); }
.fc-model-item.active { color: var(--ui-accent); }
.fc-model-item[data-highlighted="true"] { background: var(--ui-bg-tertiary); color: var(--ui-text-primary); }
.fc-model-note { padding: 6px 8px; }
[data-fc-flow-picker] .fc-model-pop { position: static; margin-top: 4px; }
[data-fc-flow-picker] .fc-model-list { max-height: min(280px, 35vh); }
.fc-input { width: 100%; font: inherit; font-size: 12.5px; color: var(--ui-text-primary); background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-stroke-secondary); border-radius: 7px; padding: 6px 8px; outline: none; }
.fc-input:focus { border-color: var(--ui-accent); }
textarea.fc-input { resize: vertical; min-height: 60px; line-height: 1.45; }
select.fc-input { height: 30px; padding: 0 6px; }
.fc-mono { font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; font-size: 11.5px; }
.fc-help { margin-top: 4px; font-size: 11px; color: var(--ui-text-tertiary); line-height: 1.4; }
.fc-bad { color: var(--ui-red); }
.fc-linked { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 7px; border: 1px dashed var(--ui-stroke-primary);
  color: var(--ui-text-secondary); font-size: 12px; }
.fc-linked b { color: var(--ui-text-primary); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ui-text-secondary); cursor: pointer; }
.fc-out { margin-top: 10px; }
.fc-out-port { font-size: 11px; color: var(--ui-text-tertiary); margin-bottom: 4px; }
.fc-pre-wrap { position: relative; }
.fc-pre { margin: 0; padding: 8px 10px; border-radius: 7px; background: var(--ui-bg-tertiary); max-height: 260px; overflow: auto;
  white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; font-size: 11.5px; line-height: 1.45; }
.fc-md { padding: 8px 10px; border-radius: 7px; background: var(--ui-bg-tertiary); max-height: 320px; overflow: auto; font-size: 12.5px; line-height: 1.5; }
.fc-pre-wrap .fc-copy { position: absolute; top: 4px; right: 4px; }
.fc-media img, .fc-media video { display: block; width: 100%; border-radius: 7px; background: var(--ui-bg-tertiary); }
.fc-media audio { width: 100%; margin: 4px 0; }
.fc-media + .fc-media { margin-top: 8px; }
.fc-file-chip { display: flex; align-items: center; gap: 6px; margin-top: 6px; padding: 3px 3px 3px 8px; border-radius: 7px; background: var(--ui-bg-tertiary); font-size: 11.5px; }
.fc-chip-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-zoomable { cursor: zoom-in; }
.fc-preview.media.fc-zoomable:hover, .fc-preview.file.fc-zoomable:hover { box-shadow: 0 0 0 1px var(--ui-accent); }
.fc-media .fc-zoomable:hover { outline: 1px solid var(--ui-accent); }
.fc-lb { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center; outline: none;
  color: var(--ui-text-primary); background: var(--fc-scrim, color-mix(in srgb, #000 22%, transparent));
  -webkit-app-region: no-drag; user-select: none; -webkit-user-select: none; font-size: 12.5px; }
/* the preview is a window of 85 % of the app window, the dimmed margin around it closes it (07.11.) */
.fc-lb-panel { width: 85vw; height: 85vh; display: flex; flex-direction: column; min-width: 0; overflow: hidden; border-radius: 12px;
  background: var(--ui-bg-editor); border: 1px solid var(--ui-stroke-tertiary); box-shadow: var(--shadow-lg, 0 18px 50px rgba(0, 0, 0, .45)); }
.fc-lb:fullscreen .fc-lb-panel { width: 100%; height: 100%; border: 0; border-radius: 0; }
.fc-3d { position: relative; width: 100%; height: 100%; }
.fc-3d-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
.fc-3d-canvas:active { cursor: grabbing; }
.fc-3d-msg { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); max-width: 520px; text-align: center;
  color: var(--ui-text-secondary); }
.fc-3d-info { position: absolute; right: 16px; bottom: 12px; color: var(--ui-text-quaternary); font-size: 11px; pointer-events: none; }
.fc-lb *, .fc-lb *::before, .fc-lb *::after { box-sizing: border-box; }
.fc-lb-bar { flex: none; display: flex; align-items: center; gap: 4px; height: 48px; padding: 0 10px 0 16px; background: var(--ui-bg-chrome); border-bottom: 1px solid var(--ui-stroke-tertiary); }
.fc-lb-title { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.fc-lb-title b { font-weight: 600; white-space: nowrap; }
.fc-lb-title .fc-lb-file { color: var(--ui-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-lb-count { padding: 0 10px; color: var(--ui-text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.fc-lb-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 30px; min-width: 30px; padding: 0 8px; border: 0;
  border-radius: 7px; background: transparent; color: inherit; font: inherit; cursor: pointer; white-space: nowrap; }
.fc-lb-btn:hover:not(:disabled) { background: var(--ui-control-hover-background); }
.fc-lb-btn:disabled { opacity: .35; cursor: default; }
.fc-lb-btn .codicon { font-size: 16px; }
.fc-lb-zoom { min-width: 52px; font-variant-numeric: tabular-nums; }
.fc-lb-sep { width: 1px; height: 20px; margin: 0 4px; background: var(--ui-stroke-secondary); }
.fc-lb-stage { position: relative; flex: 1; min-height: 0; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.fc-lb-stage.zoomed { cursor: grab; }
.fc-lb-stage.panning { cursor: grabbing; }
.fc-lb-img { max-width: calc(100% - 120px); max-height: calc(100% - 32px); object-fit: contain; transform-origin: center center;
  will-change: transform; -webkit-user-drag: none; }
.fc-lb-stage video { max-width: calc(100% - 120px); max-height: calc(100% - 32px); background: var(--ui-bg-chrome); outline: none; box-shadow: 0 0 0 1px var(--ui-stroke-tertiary); }
.fc-lb-card { display: flex; flex-direction: column; align-items: center; gap: 14px; max-width: 520px; padding: 28px 34px; border-radius: 14px;
  background: var(--ui-bg-card); box-shadow: 0 0 0 1px var(--ui-stroke-tertiary); text-align: center; }
.fc-lb-card .codicon { font-size: 54px; opacity: .8; }
.fc-lb-card audio { width: 420px; max-width: 100%; }
.fc-lb-card .fc-lb-msg { color: var(--ui-text-secondary); }
.fc-lb-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 44px; height: 64px; border: 0; border-radius: 10px;
  background: var(--ui-bg-elevated); color: inherit; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.fc-lb-nav:hover { background: var(--ui-control-hover-background); }
.fc-lb-nav .codicon { font-size: 22px; }
.fc-lb-nav.prev { left: 14px; }
.fc-lb-nav.next { right: 14px; }
.fc-lb-strip { flex: none; display: flex; gap: 6px; justify-content: center; padding: 8px 12px 12px; overflow-x: auto; }
.fc-lb-thumb { flex: none; width: 58px; height: 44px; padding: 0; border: 2px solid transparent; border-radius: 6px; overflow: hidden; cursor: pointer;
  background: var(--ui-bg-tertiary); color: var(--ui-text-secondary); display: flex; align-items: center; justify-content: center; }
.fc-lb-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.fc-lb-thumb.active { border-color: var(--ui-accent); }
.fc-lb-thumb:hover:not(.active) { border-color: var(--ui-stroke-primary); }
.fc-lb-flash { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); padding: 7px 14px; border-radius: 8px;
  background: var(--ui-bg-elevated); box-shadow: 0 0 0 1px var(--ui-stroke-secondary); pointer-events: none; }
.fc-lb-hint { position: absolute; left: 16px; bottom: 12px; color: var(--ui-text-quaternary); font-size: 11px; pointer-events: none; }
.fc-issue { display: flex; gap: 6px; align-items: flex-start; padding: 5px 6px; border-radius: 6px; font-size: 12px; cursor: pointer; color: var(--ui-text-secondary); }
.fc-issue:hover { background: var(--ui-row-hover-background); }
.fc-issue.error .codicon { color: var(--ui-red); }
.fc-issue.warning .codicon { color: var(--ui-yellow); }
.fc-ok { display: flex; align-items: center; gap: 6px; color: var(--ui-green); font-size: 12px; }
.fc-shortcut { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 0; font-size: 11.5px; color: var(--ui-text-secondary); }
.fc-shortcut kbd { font: inherit; font-size: 10.5px; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--ui-stroke-secondary);
  color: var(--ui-text-tertiary); background: var(--ui-bg-elevated); white-space: nowrap; }
.fc-tool-pick { margin: 10px 0 4px; }
.fc-insp-issues { margin-top: 8px; }
.fc-insp-issues .fc-issue { cursor: default; padding: 3px 0; }
.fc-insp-issues .fc-issue:hover { background: none; }
.fc-insp-error .fc-copy { top: 12px; }
.fc-stats { margin-top: 2px; font-size: 11.5px; color: var(--ui-text-tertiary); }
details.fc-raw { margin-top: 10px; }
details.fc-raw summary { cursor: pointer; font-size: 11px; color: var(--ui-text-tertiary); margin-bottom: 4px; }
.fc-log { flex: none; border-top: 1px solid var(--ui-stroke-tertiary); display: flex; flex-direction: column; }
.fc-log.open { height: 168px; }
.fc-log-head { flex: none; display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 12px; cursor: pointer; font-size: 12px; }
.fc-log-head:hover { background: var(--ui-row-hover-background); }
.fc-log-title { font-weight: 600; }
.fc-log-body { flex: 1; overflow-y: auto; padding: 0 8px 8px; }
.fc-log-row { display: grid; grid-template-columns: 70px minmax(120px, 220px) 64px 1fr; align-items: center; gap: 10px; padding: 3px 6px;
  border-radius: 6px; cursor: pointer; font-size: 12px; }
.fc-log-row:hover { background: var(--ui-row-hover-background); }
/* U-8: run log rows are buttons, so Tab lands on them and the ring shows where. */
.fc-log-head:focus-visible, .fc-log-row:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
.fc-log-node { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-log-ms { color: var(--ui-text-tertiary); text-align: right; font-variant-numeric: tabular-nums; }
.fc-log-msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-text-tertiary); }
.fc-log-msg.bad { color: var(--ui-red); }
.fc-runchip { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--fc-st); }
.fc-runchip .codicon { color: var(--fc-st); }
.fc-center { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; min-height: 0; overflow: auto; }
.fc-welcome { max-width: 640px; text-align: center; }
.fc-welcome-icon .codicon { font-size: 42px; color: var(--ui-accent); }
.fc-welcome h2 { margin: 10px 0 8px; font-size: 20px; }
.fc-welcome p { margin: 0 auto 16px; max-width: 540px; color: var(--ui-text-secondary); line-height: 1.55; }
.fc-templates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 18px 0; text-align: left; }
.fc-template { display: flex; flex-direction: column; gap: 4px; padding: 12px; border-radius: 10px; border: 1px solid var(--ui-stroke-secondary);
  background: var(--ui-bg-elevated); color: var(--ui-text-primary); font: inherit; cursor: pointer; text-align: left; }
.fc-template:hover:not(:disabled) { border-color: var(--ui-accent); }
.fc-template:disabled { opacity: .5; cursor: default; }
.fc-template span { font-size: 11.5px; color: var(--ui-text-secondary); }
@media (max-width: 560px) { .fc-templates { grid-template-columns: 1fr; } }
`

// ---------------------------------------------------------------- hooks
/** Nearest ancestor that renders a box. Desktop wraps route pages in `display: contents`, whose clientHeight is 0. */
function boxParent(el) {
  let p = el.parentElement
  while (p && getComputedStyle(p).display === 'contents') p = p.parentElement
  return p
}

/**
 * Height that fills the space below `top` (all values in px): the box parent's content bottom when it has a
 * definite height, else the window bottom; minus whatever still overflows a scrolling ancestor. Pure, tested.
 */
function fillHeight({ top, parentBottom, windowHeight, overflow = 0, min = 320 }) {
  const bottom = parentBottom !== null && parentBottom !== undefined ? parentBottom : windowHeight
  return Math.max(min, Math.floor(bottom - top - Math.max(0, overflow)))
}

/** Fill the route's height exactly, so the page itself never scrolls (the run log stays on screen). */
function useFillHeight(ref, enabled = true) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    if (!enabled) {
      el.style.height = '' // the Arachne Flow window (G4) sizes itself to the whole window
      return undefined
    }
    let raf = 0
    const fit = () => {
      raf = 0
      const parent = boxParent(el)
      el.style.height = '0px'
      let parentBottom = null
      if (parent && parent.clientHeight >= 320) {
        const r = parent.getBoundingClientRect()
        const pad = parseFloat(getComputedStyle(parent).paddingBottom) || 0
        parentBottom = r.top + parent.clientTop + parent.clientHeight - pad
      }
      const top = el.getBoundingClientRect().top
      el.style.height = `${fillHeight({ top, parentBottom, windowHeight: window.innerHeight })}px`
      // Anything that still scrolls because of us (status bar, pane padding) comes off our height.
      const doc = document.scrollingElement || document.documentElement
      for (let a = el.parentElement; a; a = a.parentElement) {
        const scrolls = a === doc || /(auto|scroll)/.test(getComputedStyle(a).overflowY)
        const over = a.scrollHeight - a.clientHeight
        if (scrolls && over > 0) {
          el.style.height = `${fillHeight({ top, parentBottom, windowHeight: window.innerHeight, overflow: over })}px`
          break
        }
        if (a === doc) break
      }
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(fit)
    }
    fit()
    window.addEventListener('resize', schedule)
    let ro = null
    const parent = boxParent(el)
    if (typeof ResizeObserver === 'function' && parent) {
      ro = new ResizeObserver(schedule)
      ro.observe(parent)
    }
    return () => {
      window.removeEventListener('resize', schedule)
      if (ro) ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [ref, enabled])
}

const MEDIA_CACHE = new Map()
// Bounded by entries AND by the inline bytes it holds (U-12): a handful of 10 MB previews would otherwise sit in
// memory for the life of the module, and a reload never gets them back.
const MEDIA_CACHE_MAX = 160
const MEDIA_CACHE_MAX_BYTES = 64 * 1024 * 1024
/** What one cache entry keeps alive: the data URL it carries (files served by path cost only their key). */
function mediaEntryBytes(entry) {
  const v = entry && entry.value
  if (!v || typeof v !== 'object') return 0
  const text = typeof v.data_url === 'string' ? v.data_url : typeof v.url === 'string' ? v.url : ''
  return text.length
}
function mediaCacheBytes(cache) {
  let total = 0
  for (const entry of cache.values()) total += mediaEntryBytes(entry)
  return total
}
/** Drop the oldest entries until the cache fits `maxBytes` and `maxCount`; returns the dropped keys. `keep` (the
 *  entry just written) survives even when it alone is over budget, so one huge file cannot thrash the cache. */
function evictMediaCache(cache, { maxBytes = MEDIA_CACHE_MAX_BYTES, maxCount = MEDIA_CACHE_MAX, keep = null } = {}) {
  const evicted = []
  let total = mediaCacheBytes(cache)
  for (const key of cache.keys()) {
    if (total <= maxBytes && cache.size <= maxCount) break
    if (key === keep) continue
    total -= mediaEntryBytes(cache.get(key))
    cache.delete(key)
    evicted.push(key)
  }
  return evicted
}
function fetchMedia(api, key, runId, nodeId, port, thumb, index) {
  const hit = MEDIA_CACHE.get(key)
  if (hit) return hit.promise
  const entry = { promise: api.media(runId, nodeId, port, thumb, index), value: null }
  MEDIA_CACHE.set(key, entry)
  entry.promise.then(
    (v) => {
      entry.value = v
      // the entry only starts costing bytes once the data URL is here: cap again so a batch of big previews
      // that arrived together is trimmed in the order they were asked for
      evictMediaCache(MEDIA_CACHE, { keep: key })
    },
    () => MEDIA_CACHE.delete(key)
  )
  evictMediaCache(MEDIA_CACHE, { keep: key })
  return entry.promise
}
function useMedia(api, runId, nodeId, port, thumb, enabled, index = 0) {
  const key = enabled && runId && nodeId && port ? `${runId}|${nodeId}|${port}|${index}|${thumb}` : ''
  const cached = key ? MEDIA_CACHE.get(key) : null
  const [state, setState] = useState(null)
  useEffect(() => {
    if (!key) return undefined
    let alive = true
    fetchMedia(api, key, runId, nodeId, port, thumb, index).then(
      (value) => alive && setState({ key, value }),
      (err) => alive && setState({ key, error: parseRestError(err).message })
    )
    return () => {
      alive = false
    }
  }, [key])
  if (!key) return null
  if (state && state.key === key) return state.error ? { error: state.error } : state.value
  return cached && cached.value ? cached.value : null
}

/** Thumbnail cell of an image mini entry: the cached 320 px thumbnail the card already uses (same cache key, so no
 *  extra request); until it is there, or when it failed, a fixed-size icon, so the row never jumps. */
function MiniThumb({ api, runId, nodeId, port, index, name }) {
  const thumb = useMedia(api, runId, nodeId, port, 320, true, index)
  if (thumb && thumb.data_url) return h('img', { src: thumb.data_url, alt: name || '', draggable: false })
  return h(Icon, { name: thumb && thumb.error ? 'warning' : MEDIA_ICON.image })
}

/** Off-screen outputs should not fetch media or hold decoders. Keep the wrapper's dimensions while hidden. */
function useMediaVisible(ref) {
  const [visible, setVisible] = useState(typeof IntersectionObserver !== 'function')
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver !== 'function') return undefined
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)),
      { rootMargin: '100px' })
    observer.observe(ref.current)
    // The observer's first report can come late (busy or throttled renderer, headless virtual time): a player
    // that is already on screen when it mounts loads at once instead of waiting for it.
    const early = setTimeout(() => {
      const r = ref.current && ref.current.getBoundingClientRect()
      if (r && r.width > 0 && r.bottom > -100 && r.top < (window.innerHeight || 0) + 100 &&
          r.right > -100 && r.left < (window.innerWidth || 0) + 100) setVisible(true)
    }, 50)
    return () => { clearTimeout(early); observer.disconnect() }
  }, [ref])
  return visible
}

/** A video/audio player or mesh thumbnail in ANY producer node, not a dedicated output.preview node.
 *  Only the existing guarded media route is used; no remote URLs or file:// reads. The header still opens
 *  the large viewer. Player controls must not start a drag, open a dialog or trigger canvas shortcuts. */
function MiniMedia({ api, runId, nodeId, port, index, kind, name }) {
  const stop = (e) => e.stopPropagation()
  const ref = useRef(null)
  const visible = useMediaVisible(ref)
  const data = useMedia(api, runId, nodeId, port, 0, visible, index)
  const [failed, setFailed] = useState(null)
  const src = data && data.data_url
  const key = `${runId}|${nodeId}|${port}|${index}|${src ? src.length : 0}`
  let body
  if (failed === key) body = h('div', { className: 'fc-mini-unavailable' }, 'This media format cannot be played here.')
  else if (data && data.error) body = h('div', { className: 'fc-mini-unavailable' }, `Preview unavailable: ${data.error}`)
  else if (!visible || !data) body = h('div', { className: 'fc-mini-unavailable' }, !visible ? 'Preview' : 'Loading preview…')
  else if (!src) body = h('div', { className: 'fc-mini-unavailable' }, 'File too large for inline preview — open it from the viewer.')
  else if (kind === 'model3d') {
    const file = data.name || name || ''
    body = /\.glb$/i.test(file)
      ? h(ModelThumbnail, { cacheKey: `${runId}|${nodeId}|${port}|${index}`, dataUrl: src, name })
      : h('div', { className: 'fc-mini-unavailable' }, 'Only GLB models can be previewed here; the original file is preserved.')
  } else body = h(kind === 'video' ? 'video' : 'audio', {
    key, src, controls: true, preload: 'metadata', playsInline: true,
    'aria-label': name || kind, onError: () => setFailed(key)
  })
  const controls = kind === 'video' || kind === 'audio'
  return h('div', {
    ref, className: 'fc-mini-player', 'data-fc-inline-media': kind, 'data-fc-nodrag': '1',
    onPointerDown: stop, onDoubleClick: controls ? stop : undefined,
    onClick: controls ? stop : undefined, onKeyDown: controls ? stop : undefined, onWheel: controls ? stop : undefined,
  }, body)
}

// File node previews (G3): what the SAVED node points at. Keyed by flow, node and the raw path; `savedRev` only
// re-asks after a save until the server answers for the path shown (an unsaved edit gets the old path back).
const FILE_NODE_CACHE = new Map()
function useFileNode(api, flowId, nodeId, rawPath, savedRev, enabled) {
  const path = typeof rawPath === 'string' ? rawPath : ''
  const key = enabled && api && flowId && nodeId && path.trim() ? `${flowId}|${nodeId}|${path}` : ''
  const [, bump] = useState(0)
  useEffect(() => {
    if (!key || FILE_NODE_CACHE.has(key)) return undefined
    let alive = true
    api.fileNode(flowId, nodeId, 320).then((info) => {
      if (!info || info.path_param !== path) return // answer for an older saved path: wait for the next save
      FILE_NODE_CACHE.set(key, info)
      if (FILE_NODE_CACHE.size > 200) FILE_NODE_CACHE.delete(FILE_NODE_CACHE.keys().next().value)
      if (alive) bump((n) => n + 1)
    }, () => {})
    return () => {
      alive = false
    }
  }, [key, savedRev])
  return key ? FILE_NODE_CACHE.get(key) || null : null
}

// ---------------------------------------------------------------- small components
// ---------------------------------------------------------------- G9: rich tooltips + live clock
const richTips = () => typeof sdk.Tip === 'function'
/** Native `title` only when the app offers no rich Tip (old Desktop); never both at once. */
const nativeTitle = (tip) => (richTips() ? undefined : tipText(tip))
/** Small tooltip card in the palette-tip look: tinted head (icon or port dot, title, kind, keys), lines, foot. */
function TipCard({ tip }) {
  const color = tip.color || (tip.tone === 'bad' ? 'var(--ui-red)' : tip.tone === 'warn' ? 'var(--ui-yellow)' : 'var(--ui-accent)')
  return h('div', { className: 'fc-tt fc-tt-sm', 'data-fc-tip': tip.id, 'data-tone': tip.tone || undefined, style: { '--fc-cat': color } },
    h('div', { className: 'fc-tt-head' },
      tip.icon ? h('span', { className: 'fc-node-icon' }, h(Icon, { name: tip.icon }))
        : tip.color ? h('i', { className: 'fc-tt-dot', style: { '--fc-port': tip.color } }) : null,
      h('span', { className: 'fc-tt-title' }, tip.title),
      tip.kind ? h('span', { className: 'fc-tt-kind' }, tip.kind) : null,
      tip.keys && tip.keys.length ? h('span', { className: 'fc-tt-keys' }, tip.keys.map((k, i) => h('kbd', { key: i }, k))) : null),
    tip.lines && tip.lines.length ? h('div', { className: 'fc-tt-body' }, tip.lines.map((l, i) => h('div', { key: i, className: 'fc-tt-line' }, l))) : null,
    tip.foot ? h('div', { className: 'fc-tt-foot' }, h(Icon, { name: 'info' }), tip.foot) : null)
}
/** Wraps one DOM element in the app's Tip with a TipCard. Without Tip the element keeps its nativeTitle. */
function withTip(tip, el, side = 'top', key) {
  if (!tip || !el || !richTips()) return el
  return h(sdk.Tip, { key, label: h(TipCard, { tip }), side, sideOffset: 8, className: 'fc-tt-bubble' }, el)
}
/** While a wire is being pulled nothing may pop up. Every rich tip Arachne renders carries one of its own bubble
 *  classes (`fc-tt-bubble`, `fc-tip-bubble`), so the canvas renders this rule only for the length of the drag:
 *  it hides only our bubbles, never touches app markup, and lifts the moment the wire is dropped or cancelled. */
const WIRE_TIP_CSS = '.fc-tt-bubble, .fc-tip-bubble { display: none !important; }'
/** Native `title` tips inside the plugin are muted for the drag and restored afterwards, but only where the
 *  title is still the one we muted (a re-render that set a new title wins). Returns the restore function. */
function muteTitles(scope) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return () => {}
  const saved = []
  for (const el of scope.querySelectorAll('[title]:not([title=""])')) {
    saved.push({ el, text: el.getAttribute('title') })
    el.setAttribute('title', '')
  }
  return () => {
    for (const { el, text } of saved) if (el.isConnected && el.getAttribute('title') === '') el.setAttribute('title', text)
  }
}
/** Mutes the plugin's native titles exactly while a wire drag is live (`ref`: any element inside the page). */
function useWireTipGuard(wire, ref) {
  useEffect(() => {
    if (!wire) return undefined
    const el = ref.current
    return muteTitles(el && el.closest ? el.closest('.fc-root') || el : el)
  }, [!!wire])
}
/** Current time, re-rendering every `ms` while `active` (live clocks on running nodes and runs). */
function useNow(active, ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [active, ms])
  return now
}
const sinceMs = (iso, now) => {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? Math.max(0, now - t) : null
}

function StatusBadge({ state, exp = null, nameOf, showMs = true, side = 'top', branchName = '' }) {
  const s = STATUS[state.status] || STATUS.queued
  const running = state.status === 'running'
  const now = useNow(running)
  const elapsed = running ? sinceMs(state.started_at, now) : null
  const clock = elapsed !== null ? formatClock(elapsed) : ''
  const label = !showMs && !running ? '' : badgeLabel(state, clock)
  const usual = running && !state.items && exp && exp.n > 0 ? h('span', { className: 'fc-badge-exp' }, `/ ~${formatMs(exp.avg_ms)}`) : null
  const tip = { ...statusTip(state, exp, now, nameOf, branchName), icon: s.icon }
  return withTip(tip, h('span', {
    className: 'fc-badge', style: { '--fc-st': s.color }, 'data-fc-status': state.status,
    'data-fc-clock': running && clock ? clock : undefined, 'data-fc-items': state.items ? itemsFinished(state.items) : undefined,
    title: nativeTitle(tip)
  }, h(Icon, { name: s.icon, spin: s.spin }), label, usual), side)
}

function RunChip({ run }) {
  const s = RUN_STATUS[run.status] || RUN_STATUS.queued
  const active = isRunActive(run)
  const now = useNow(active)
  const counts = countStatuses(run)
  const total = (run.order && run.order.length) || Object.keys(run.nodes || {}).length
  const finished = (counts.done || 0) + (counts.cached || 0)
  const elapsed = active ? sinceMs(run.started_at, now) : null
  const tip = { ...runTip(run, now), icon: s.icon }
  return withTip(tip, h('span', { className: 'fc-runchip', style: { '--fc-st': s.color }, 'data-fc-runchip': run.status, title: nativeTitle(tip) },
    h(Icon, { name: s.icon, spin: s.spin }),
    s.label,
    total > 0 ? h('span', { className: 'fc-muted' }, ` · ${finished}/${total} steps`) : null,
    counts.cached > 0 ? h('span', { className: 'fc-muted' }, ` · ${counts.cached} cached`) : null,
    elapsed !== null ? h('span', { className: 'fc-muted', 'data-fc-run-clock': '1' }, ` · ${formatClock(elapsed)}`) : null,
    run.ms !== undefined && run.ms !== null && TERMINAL.has(run.status) ? h('span', { className: 'fc-muted' }, ` · ${formatMs(run.ms)}`) : null))
}

/** Did a clipboard write succeed? The app's SDK resolves undefined on success and `false` when the host refused;
 *  a write that throws is a failure the caller catches. Pure, tested. */
const clipboardOk = (res) => res !== false

function CopyBtn({ text, title = 'Copy' }) {
  const [done, setDone] = useState(false)
  const copy = async (e) => {
    e.stopPropagation()
    // U-18: the check mark means "it worked" — never show it for a refused or missing clipboard write.
    let ok = false
    try {
      if (typeof sdk.writeClipboardText === 'function') ok = clipboardOk(await sdk.writeClipboardText(text))
    } catch {
      ok = false
    }
    setDone(ok)
    if (ok) setTimeout(() => setDone(false), 1200)
  }
  return h('button', { className: 'fc-btn ghost icon fc-copy', title, onClick: copy }, h(Icon, { name: done ? 'check' : 'copy' }))
}

function NameInput({ value, onCommit }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const v = draft.trim()
    if (v && v !== value) onCommit(v)
    else setDraft(value)
  }
  return h('input', {
    className: 'fc-title-input',
    value: draft,
    size: Math.max(10, Math.min(40, draft.length + 2)),
    title: 'Rename this flow',
    onChange: (e) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e) => {
      if (e.key === 'Enter') e.currentTarget.blur()
      if (e.key === 'Escape') {
        setDraft(value)
        const el = e.currentTarget
        setTimeout(() => el.blur(), 0)
      }
    }
  })
}

function useDismiss(ref, onClose, ignoreSelector) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && ref.current.contains(e.target)) return
      if (ignoreSelector && e.target.closest && e.target.closest(ignoreSelector)) return
      close.current()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') close.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}

/** Review U-8: a menu that opens puts focus on its first row; arrows/Home/End move, Enter/Space activates the
 *  focused row (a real click, so the row's own handler decides), Escape/Tab close it and hand focus back to the
 *  control that opened it. */
function useMenuKeys(ref, onClose, returnFocus) {
  const root = useRef(null)
  const keyboard = useRef(false)   // the last thing that happened in this menu was a key, not a pointer
  useEffect(() => {
    const el = ref.current
    root.current = el && el.closest ? el.closest('.fc-root') : null
    const pointer = () => { keyboard.current = false }
    window.addEventListener('pointerdown', pointer, true)
    focusEl(menuRowsIn(el)[0])
    return () => {
      window.removeEventListener('pointerdown', pointer, true)
      // A row activated by key can close the menu from its own handler (open another flow, duplicate): without
      // this, focus falls to <body> and the canvas shortcuts stay dead until the user clicks the canvas.
      if (!keyboard.current) return
      const active = document.activeElement
      if (active && active !== document.body && active.isConnected) return   // a dialog or a field took it
      const back = returnFocus ? returnFocus() : null
      if (!back || !back.isConnected) focusEl(root.current)
    }
  }, [])
  return (e) => {
    const rows = menuRowsIn(ref.current)
    const at = rows.indexOf(document.activeElement)
    const next = menuKeyNav(at, rows.length, e.key)
    if (next === null) return
    e.preventDefault()
    e.stopPropagation()
    if (next === 'close') {
      onClose()
      if (returnFocus) returnFocus()
    } else if (next === 'activate') {
      const row = rows[at]
      if (!row) return
      const delId = row.getAttribute ? row.getAttribute('data-fc-template-delete') : null
      keyboard.current = true
      row.click()
      // A row that keeps the menu open re-renders it and drops the focused node: put the keyboard back on it.
      setTimeout(() => {
        const el = ref.current
        const active = document.activeElement
        if (!el || !el.isConnected) return
        if (active && active !== document.body && active.isConnected) return   // a dialog took it: leave it there
        const now = menuRowsIn(el)
        const target = (delId && now.find((n) => n.getAttribute && n.getAttribute('data-fc-template-delete') === delId)) ||
          (now.includes(row) ? row : now[Math.min(at, now.length - 1)])
        if (target) focusEl(target)
      }, 0)
    } else {
      focusEl(rows[next])
      rows[next]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    }
  }
}

function MenuItems({ items, onClose }) {
  return items.map((it, i) => (it === '-'
    ? h('div', { key: `sep${i}`, className: 'fc-menu-sep' })
    : h('div', {
      key: it.label,
      className: `fc-menu-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`,
      title: it.title || '',
      role: 'menuitem',
      tabIndex: -1,
      'aria-disabled': it.disabled ? 'true' : undefined,
      onClick: () => {
        if (it.disabled) return
        onClose()
        it.run()
      }
    }, h(Icon, { name: it.icon || 'blank' }), h('span', { className: 'fc-menu-name' }, it.label), it.hint ? h('span', { className: 'fc-menu-meta' }, it.hint) : null)))
}

function ContextMenu({ menu, items, onClose }) {
  const ref = useRef(null)
  useDismiss(ref, onClose)
  const onKeyDown = useMenuKeys(ref, onClose, () => focusPluginRoot(ref.current))
  return h('div', {
    ref,
    className: 'fc-menu fc-ctx',
    role: 'menu',
    'aria-label': 'Canvas menu',
    tabIndex: -1,
    style: { left: menu.x, top: menu.y },
    onPointerDown: (e) => e.stopPropagation(),
    onContextMenu: (e) => e.preventDefault(),
    onKeyDown
  }, h(MenuItems, { items, onClose }))
}

// ---------------------------------------------------------------- header + flow menu
const FLOW_MENU_LIMIT = 8          // recent flows shown before "Show all"
/** Every word of `query` appears in one of `texts` (case-insensitive). Pure, tested. */
function menuMatch(query, ...texts) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = texts.filter(Boolean).join(' ').toLowerCase()
  return words.every((w) => hay.includes(w))
}
/** What the flows menu lists: recent flows (or all), templates split into yours/built-in, all filtered by the
 *  search. With a search both kinds show at once, so the tab never hides a match. Pure, tested. */
function flowMenuModel({ flows, templates, query = '', tab = 'flows', showAll = false, limit = FLOW_MENU_LIMIT }) {
  const list = Array.isArray(flows) ? flows.slice() : []
  list.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
  const { own, builtin } = splitTemplates(templates)
  const searching = String(query || '').trim() !== ''
  const fl = list.filter((f) => menuMatch(query, f.name || 'Untitled flow'))
  const tpl = (arr) => arr.filter((x) => menuMatch(query, x.name || x.id, x.description))
  const ownHit = tpl(own)
  const builtinHit = tpl(builtin)
  const showFlows = searching || tab !== 'templates'
  const showTemplates = searching || tab === 'templates'
  const cut = !searching && !showAll && fl.length > limit
  return {
    searching,
    counts: { flows: list.length, templates: own.length + builtin.length },
    flows: showFlows ? (cut ? fl.slice(0, limit) : fl) : [],
    moreFlows: showFlows && cut ? fl.length - limit : 0,
    own: showTemplates ? ownHit : [],
    builtin: showTemplates ? builtinHit : [],
    empty: searching && !fl.length && !ownHit.length && !builtinHit.length
  }
}

function FlowMenu({ flows, current, templates, onOpen, onNew, onFromTemplate, onDuplicate, onDelete, onClose,
  onSaveTemplate, onEditTemplate, onDeleteTemplate, returnFocus }) {
  const ref = useRef(null)
  const searchRef = useRef(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmTemplate, setConfirmTemplate] = useState(null)
  const [query, setQuery] = useState('')
  const [tab, setTabState] = useState(SHARED.flowMenuTab || 'flows')
  const [showAll, setShowAll] = useState(false)
  useDismiss(ref, onClose, '.fc-menu-toggle')
  const onKeyDown = useMenuKeys(ref, onClose, returnFocus)
  useEffect(() => { focusEl(searchRef.current) }, [])
  const setTab = (next) => { SHARED.flowMenuTab = next; setTabState(next) }
  const model = flowMenuModel({ flows, templates, query, tab, showAll })
  const templateItem = (t) => {
    const mine = t.source === 'user'
    const armed = mine && confirmTemplate === t.id
    return h('div', {
      key: `t-${t.id}`,
      className: `fc-menu-item${t.available === false ? ' disabled' : ''}${armed ? ' danger' : ''}`,
      'data-fc-template': t.id,
      title: t.available === false ? `Needs: ${(t.missing_tools || []).join(', ')}` : t.description || '',
      role: 'menuitem',
      tabIndex: -1,
      'aria-disabled': t.available === false ? 'true' : undefined,
      onClick: () => t.available !== false && !armed && onFromTemplate(t.id)
    }, h(Icon, { name: mine ? 'bookmark' : 'symbol-structure' }),
    h('span', { className: 'fc-menu-name' }, armed ? 'Click the trash again to delete' : t.name || t.id),
    mine && onEditTemplate && !armed ? h('button', {
      key: 'edit', type: 'button', tabIndex: -1,
      className: 'fc-mini', title: 'Rename or describe', 'aria-label': `Edit template ${t.name || t.id}`, 'data-fc-template-edit': t.id,
      onClick: (e) => {
        e.stopPropagation()
        onEditTemplate(t)
      }
    }, h(Icon, { name: 'edit' })) : null,
    mine && onDeleteTemplate ? h('button', {
      key: 'delete', type: 'button', tabIndex: -1,
      className: `fc-mini${armed ? ' armed' : ''}`, title: armed ? 'Click again to delete' : 'Delete template',
      'aria-label': `Delete template ${t.name || t.id}`, 'data-fc-template-delete': t.id,
      onClick: (e) => {
        e.stopPropagation()
        if (!armed) return setConfirmTemplate(t.id)
        setConfirmTemplate(null)
        onDeleteTemplate(t)
      }
    }, h(Icon, { name: 'trash' })) : null)
  }
  const flowItem = (f) => {
    const st = f.last_run ? RUN_STATUS[f.last_run.status] : null
    return h('div', {
      key: f.id, className: `fc-menu-item${current && f.id === current.id ? ' active' : ''}`, 'data-fc-flow-item': f.id,
      role: 'menuitem', tabIndex: -1, 'aria-current': current && f.id === current.id ? 'true' : undefined,
      title: f.name || 'Untitled flow', onClick: () => onOpen(f.id)
    },
      h(Icon, { name: st ? st.icon : 'circle-large-outline', style: { color: st ? st.color : 'var(--ui-text-quaternary)' } }),
      h('span', { className: 'fc-menu-name' }, f.name || 'Untitled flow'),
      h('span', { className: 'fc-menu-meta' }, `${f.node_count} nodes · ${ago(f.updated_at)}`))
  }
  const firstHit = () => model.flows[0] ? () => onOpen(model.flows[0].id)
    : [...model.own, ...model.builtin].find((x) => x.available !== false)
      ? () => onFromTemplate([...model.own, ...model.builtin].find((x) => x.available !== false).id) : null
  const tabButton = (id, label, count) => h('div', {
    role: 'menuitem', tabIndex: -1, className: `fc-menu-tab${tab === id && !model.searching ? ' on' : ''}`,
    'data-fc-menu-tab': id, 'aria-pressed': tab === id ? 'true' : 'false', onClick: () => { setTab(id); setShowAll(false) }
  }, label, h('span', { className: 'fc-menu-count' }, String(count)))
  const label = (text) => h('div', { className: 'fc-menu-label' }, text)
  return h('div', { ref, className: 'fc-menu fc-flows-menu', role: 'menu', 'aria-label': 'Flows', tabIndex: -1, onKeyDown },
    h('div', { className: 'fc-menu-top' },
      h('div', { className: 'fc-menu-search' }, h(Icon, { name: 'search' }),
        h('input', {
          ref: searchRef, value: query, placeholder: 'Search flows and templates…', 'data-fc-menu-search': '1',
          'aria-label': 'Search flows and templates',
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              const go = firstHit()
              if (go) go()
            } else if (['Home', 'End', 'ArrowLeft', 'ArrowRight', ' ', 'Spacebar'].includes(e.key)) e.stopPropagation()
            else if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') }
          }
        })),
      model.searching ? null : h('div', { className: 'fc-menu-tabs' },
        tabButton('flows', 'Your flows', model.counts.flows), tabButton('templates', 'Templates', model.counts.templates))),
    h('div', { className: 'fc-menu-scroll' },
      model.searching ? null : h('div', { className: 'fc-menu-item', role: 'menuitem', tabIndex: -1, onClick: onNew },
        h(Icon, { name: 'add' }), h('span', { className: 'fc-menu-name' }, 'New blank flow')),
      model.empty ? h('div', { className: 'fc-menu-empty' }, `Nothing matches “${query.trim()}”.`) : null,
      model.searching && model.flows.length ? label('Your flows') : null,
      !model.searching && tab === 'flows' && !flows.length ? h('div', { className: 'fc-menu-empty' }, 'No flows yet. Start blank or from a template.') : null,
      model.flows.map(flowItem),
      model.moreFlows > 0 ? h('div', {
        className: 'fc-menu-item fc-menu-more', role: 'menuitem', tabIndex: -1, 'data-fc-flows-more': '1', onClick: () => setShowAll(true)
      }, h(Icon, { name: 'chevron-down' }), h('span', { className: 'fc-menu-name' }, `Show all ${model.counts.flows} flows`)) : null,
      model.own.length ? label('Your templates') : null,
      model.own.map(templateItem),
      model.builtin.length ? label(model.searching || model.own.length ? 'Built-in templates' : 'Start from a template') : null,
      model.builtin.map(templateItem)),
    current ? h('div', { className: 'fc-menu-foot', 'aria-label': 'This flow' },
      onSaveTemplate ? h('div', { className: 'fc-menu-item', role: 'menuitem', tabIndex: -1, 'data-fc-save-template': '1', title: 'Save this flow as a template…', onClick: onSaveTemplate },
        h(Icon, { name: 'save-as' }), h('span', { className: 'fc-menu-name' }, 'As template…')) : null,
      h('div', { className: 'fc-menu-item', role: 'menuitem', tabIndex: -1, 'data-fc-duplicate': '1', title: 'Duplicate this flow', onClick: onDuplicate },
        h(Icon, { name: 'copy' }), h('span', { className: 'fc-menu-name' }, 'Duplicate')),
      h('div', { className: 'fc-menu-item danger', role: 'menuitem', tabIndex: -1, 'data-fc-delete-flow': '1', title: 'Delete this flow',
        onClick: () => (confirmDelete ? onDelete() : setConfirmDelete(true)) },
      h(Icon, { name: 'trash' }), h('span', { className: 'fc-menu-name' }, confirmDelete ? 'Click again' : 'Delete'))) : null)
}

/** After flow trigger: searchable list of every flow (like the model picker). Stores the flow id. */
function FlowPicker({ api, value, ownId, onChange }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [flows, setFlows] = useState(null)
  const [error, setError] = useState(null)
  const [highlight, setHighlight] = useState(0)
  const wrapRef = useRef(null)
  const request = useRef(0)
  const load = () => {
    if (!api || typeof api.flows !== 'function') return
    const ticket = ++request.current
    api.flows().then((res) => {
      if (ticket !== request.current) return
      setFlows((res && res.flows) || [])
      setError(null)
    }, (e) => { if (ticket === request.current) setError(parseRestError(e).message) })
  }
  useEffect(() => { load(); return () => { request.current++ } }, [api])
  useEffect(() => {
    if (!open) return undefined
    const away = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [open])
  const others = (flows || []).filter((f) => f.id !== ownId)
  const chosen = flowPickerChoice(others, value)
  const shown = flowMenuModel({ flows: others, templates: [], query, showAll: true }).flows
  const index = Math.min(highlight, Math.max(0, shown.length - 1))
  const listId = `fc-flow-list-${ownId || 'picker'}`
  const optionId = (f) => `${listId}-${f.id}`
  const close = () => { setOpen(false); focusEl(wrapRef.current && wrapRef.current.querySelector('button')) }
  const pick = (f) => { onChange(f.id); close(); setQuery(''); setHighlight(0) }
  useLayoutEffect(() => {
    // Keep the whole chooser in the scrollable inspector, even with many flows in a short window.
    if (open) wrapRef.current?.querySelector('.fc-model-pop')?.scrollIntoView({ block: 'nearest' })
  }, [open, flows, query])
  useEffect(() => {
    if (open && wrapRef.current) wrapRef.current.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, highlight, query])
  return h('div', { className: 'fc-model', ref: wrapRef, 'data-fc-flow-picker': '1' },
    h('button', { type: 'button', className: `fc-input fc-model-btn${open ? ' open' : ''}`, 'aria-haspopup': 'listbox', 'aria-expanded': open,
      onClick: () => { if (!open) { setQuery(''); setHighlight(0); load() }; setOpen(!open) } },
    chosen ? h('span', null, chosen.name || 'Untitled flow') : h('span', { className: 'fc-muted' }, isBlank(value) ? 'Choose a flow…' : `${value} (not found)`),
    chosen ? h('span', { className: 'fc-model-prov' }, `${chosen.node_count} nodes`) : null,
    h(Icon, { name: 'chevron-down' })),
    open ? h('div', { className: 'fc-model-pop' },
      h('div', { className: 'fc-model-search' }, h(Icon, { name: 'search' }),
        h('input', { autoFocus: true, value: query, placeholder: 'Search flows…', 'data-fc-flow-search': '1',
          role: 'combobox', 'aria-label': 'Search flows', 'aria-controls': listId, 'aria-expanded': true,
          'aria-activedescendant': shown[index] ? optionId(shown[index]) : undefined,
          onChange: (e) => { setQuery(e.target.value); setHighlight(0) },
          onKeyDown: (e) => {
            e.stopPropagation()
            if (e.key === 'Escape') { e.preventDefault(); close() }
            else if (e.key === 'Tab') setOpen(false)
            else if (e.key === 'Enter' && shown[index]) { e.preventDefault(); pick(shown[index]) }
            else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shown.length) {
              e.preventDefault()
              setHighlight((index + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length)
            }
          } }),
        h('button', { type: 'button', className: 'fc-mini', title: 'Refresh flows', 'aria-label': 'Refresh flows',
          'data-fc-flow-refresh': '1', onClick: load }, h(Icon, { name: 'refresh' }))),
      h('div', { className: 'fc-model-list', id: listId, role: 'listbox', 'aria-label': 'Other flows' },
        error ? h('div', { className: 'fc-help fc-bad fc-model-note', 'data-fc-flow-error': '1' }, `Could not load flows: ${error}`) : null,
        !flows && !error ? h('div', { className: 'fc-help fc-model-note' }, 'Loading flows…') : null,
        flows && !shown.length ? h('div', { className: 'fc-help fc-model-note' }, query ? 'No flow matches.' : 'No other flows yet.') : null,
        shown.map((f, i) => {
          const st = f.last_run ? RUN_STATUS[f.last_run.status] : null
          return h('div', { key: f.id, id: optionId(f), role: 'option', 'aria-selected': !!(chosen && chosen.id === f.id),
            'data-fc-flow-option': f.id, 'data-highlighted': i === index ? 'true' : 'false', title: `${f.name || 'Untitled flow'} · ${f.id}`,
            className: `fc-model-item${chosen && chosen.id === f.id ? ' active' : ''}`, onMouseEnter: () => setHighlight(i), onClick: () => pick(f) },
          h('span', null, h(Icon, { name: st ? st.icon : 'circle-large-outline', style: { color: st ? st.color : 'var(--ui-text-quaternary)', marginRight: 6 } }), f.name || 'Untitled flow'),
          h('span', { className: 'fc-model-prov' }, `${f.node_count} nodes · ${ago(f.updated_at)}`))
        }))) : null)
}
/** The flow a stored After-flow value names: by id, else by (unique) name. Pure, tested. */
function flowPickerChoice(flows, value) {
  if (!Array.isArray(flows) || isBlank(value)) return null
  const v = String(value).trim()
  const byId = flows.find((f) => f.id === v)
  if (byId) return byId
  const byName = flows.filter((f) => String(f.name || '').trim().toLowerCase() === v.toLowerCase())
  return byName.length === 1 ? byName[0] : null
}

function SaveIndicator({ state, error }) {
  const map = {
    saved: ['check', 'Saved'],
    dirty: ['circle-filled', 'Unsaved'],
    saving: ['loading', 'Saving…'],
    error: ['error', 'Not saved'],
    conflict: ['warning', 'Conflict']
  }
  const [icon, label] = map[state] || map.saved
  return h('span', { className: `fc-save${state === 'error' || state === 'conflict' ? ' bad' : ''}`, title: error || label },
    h(Icon, { name: icon, spin: state === 'saving' }), label)
}

function Header(p) {
  const running = isRunActive(p.run)
  const f = p.flow
  const flowsBtn = useRef(null)
  // G9: rich tip per button. The wrapper span gets the pointer events a disabled button never fires.
  const tb = (id, el) => (el ? withTip(HEADER_TIPS[id], h('span', { className: 'fc-tipwrap', 'data-fc-header-tip': id }, el), 'bottom') : null)
  const tt = (id) => nativeTitle(HEADER_TIPS[id])
  const name = (id) => HEADER_TIPS[id].title
  return h('div', { className: 'fc-header' },
    h('div', { className: 'fc-menu-wrap' },
      tb('flows', h('button', {
        ref: flowsBtn, className: `fc-btn fc-menu-toggle${p.menuOpen ? ' active' : ''}`, title: tt('flows'),
        'aria-haspopup': 'menu', 'aria-expanded': p.menuOpen ? 'true' : 'false',
        onClick: () => p.setMenuOpen(!p.menuOpen),
        // U-8: ArrowDown/ArrowUp open the menu like every other menu button; focus lands on the first row.
        onKeyDown: (e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            p.setMenuOpen(true)
          }
        }
      },
        h(Icon, { name: 'type-hierarchy' }), 'Flows', h(Icon, { name: 'chevron-down' }))),
      p.menuOpen ? h(FlowMenu, {
        flows: p.flows, current: f, templates: p.templates, onOpen: p.onOpen, onNew: p.onNew,
        onFromTemplate: p.onFromTemplate, onDuplicate: p.onDuplicate, onDelete: p.onDelete, onClose: p.closeMenu,
        onSaveTemplate: p.onSaveTemplate, onEditTemplate: p.onEditTemplate, onDeleteTemplate: p.onDeleteTemplate,
        returnFocus: () => focusEl(flowsBtn.current)
      }) : null),
    f ? h(NameInput, { value: f.name || 'Untitled flow', onCommit: p.onRename }) : h('span', { className: 'fc-header-title' }, 'Arachne Flow'),
    f ? h(SaveIndicator, { state: p.saveState, error: p.saveError }) : null,
    h('span', { className: 'fc-grow' }),
    f ? tb('palette', h('button', { className: `fc-btn ghost icon${p.paletteOpen ? ' active' : ''}`, 'aria-label': name('palette'), title: tt('palette'), onClick: p.togglePalette }, h(Icon, { name: 'layout-sidebar-left' }))) : null,
    f ? tb('inspector', h('button', { className: `fc-btn ghost icon${p.inspectorOpen ? ' active' : ''}`, 'aria-label': name('inspector'), title: tt('inspector'), onClick: p.toggleInspector }, h(Icon, { name: 'layout-sidebar-right' }))) : null,
    f ? h('span', { className: 'fc-sep' }) : null,
    f ? tb('undo', h('button', { className: 'fc-btn ghost icon', 'aria-label': name('undo'), title: tt('undo'), disabled: !p.canUndo, onClick: p.onUndo }, h(Icon, { name: 'discard' }))) : null,
    f ? tb('redo', h('button', { className: 'fc-btn ghost icon', 'aria-label': name('redo'), title: tt('redo'), disabled: !p.canRedo, onClick: p.onRedo }, h(Icon, { name: 'redo' }))) : null,
    f ? tb('tidy', h('button', { className: 'fc-btn ghost', title: tt('tidy'), disabled: running || !f.nodes.length, onClick: p.onLayout }, h(Icon, { name: 'wand' }), 'Tidy')) : null,
    tb('generate', h('button', { className: 'fc-btn', title: tt('generate'), disabled: p.generationBusy, onClick: p.onGenerate },
      h(Icon, { name: 'sparkle' }), 'Build with Hermes')),
    tb('ask', h('button', { className: 'fc-btn ghost', title: tt('ask'), onClick: p.onAsk },
      h(Icon, { name: 'comment-discussion' }), 'Discuss in chat')),
    p.onShowHermes ? tb('unfocus', h('button', {
      className: 'fc-btn ghost icon', 'data-fc-unfocus': '1', 'aria-label': 'Show Hermes in this window',
      title: tt('unfocus'), onClick: p.onShowHermes
    }, h(Icon, { name: 'layout' }))) : null,
    f ? h('span', { className: 'fc-sep' }) : null,
    f && running ? tb('stop', h('button', { className: 'fc-btn danger', title: tt('stop'), onClick: p.onStop }, h(Icon, { name: 'debug-stop' }), 'Stop')) : null,
    f && !running ? tb('fresh', h('button', { className: 'fc-btn', title: tt('fresh'), disabled: !f.nodes.length, onClick: () => p.onRun({ fresh: true }) },
      h(Icon, { name: 'refresh' }), 'Fresh')) : null,
    f ? tb('run', h('button', {
      className: 'fc-btn primary', title: tt('run'), disabled: running || !f.nodes.length,
      onClick: (e) => p.onRun({ fresh: e.shiftKey })
    }, h(Icon, { name: running ? 'loading' : 'play', spin: running }), running ? 'Running…' : 'Run')) : null)
}

// ---------------------------------------------------------------- palette + quick search
/** Rich tooltip body for a palette entry, drawn like a small node card: tinted header with the category icon, port
 *  rows with port colours, duration, cost, tool. The bubble itself gets the Arachne Flow look via `fc-tt-bubble`. */
function TypeTip({ spec, portTypes, timings }) {
  const tip = typeTip(spec, portTypes, 6, timings)
  const row = (label, body, key) => h('div', { className: 'fc-tt-row', 'data-fc-tt': key }, h('span', { className: 'fc-tt-k' }, label), h('span', { className: 'fc-tt-v' }, body))
  const ports = (list, more, extra) => [
    ...list.map((p, i) => h('span', { key: i, className: 'fc-tt-port' },
      h('i', { className: 'fc-tt-dot', style: { '--fc-port': p.color } }), p.name,
      p.type || p.optional ? h('span', { className: 'fc-tt-type' }, [p.type, p.optional ? 'optional' : ''].filter(Boolean).join(', ')) : null)),
    more ? h('span', { key: 'more', className: 'fc-tt-type' }, `+${more} more`) : null,
    extra ? h('span', { key: 'extra', className: 'fc-tt-type' }, extra) : null
  ]
  return h('div', { className: 'fc-tt', 'data-fc-typetip': spec.type, style: { '--fc-cat': categoryColor(spec.category) } },
    h('div', { className: 'fc-tt-head' },
      h('span', { className: 'fc-node-icon' }, h(Icon, { name: spec.icon || 'symbol-misc' })),
      h('span', { className: 'fc-tt-title' }, tip.title),
      h('span', { className: 'fc-tt-kind' }, tip.kind)),
    h('div', { className: 'fc-tt-body' },
      tip.description ? h('div', { className: 'fc-tt-desc' }, tip.description) : null,
      tip.inputs.length || tip.dynamic ? row('In', ports(tip.inputs, tip.moreInputs, tip.dynamic), 'in') : null,
      tip.outputs.length ? row('Out', ports(tip.outputs, tip.moreOutputs, tip.moreOutputsText), 'out') : null,
      tip.typical || tip.measured ? row('Takes', [tip.typical, tip.measured].filter(Boolean).join(' · '), 'typical') : null,
      tip.cost ? row('Cost', tip.cost, 'cost') : null,
      tip.tool ? h('div', { className: 'fc-tt-tool' }, tip.tool) : null),
    h('div', { className: 'fc-tt-foot' }, h(Icon, { name: 'add' }), 'Click to add · or drag onto the canvas'))
}

function TypeItem({ spec: t, onAdd, active = false, onHover, showCategory = false, draggable = true, portTypes = {}, richTip = false, timings = null }) {
  // Palette entries get the app's rich tooltip; quick search (keyboard-driven) and the dev stub keep a plain title.
  const rich = richTip && typeof sdk.Tip === 'function'
  const item = h('div', {
    className: `fc-item${active ? ' active' : ''}`,
    draggable,
    'data-fc-type': t.type,
    role: showCategory ? 'option' : undefined,
    'aria-selected': showCategory ? active : undefined,
    title: rich ? undefined : typeTipText(typeTip(t, portTypes, 6, timings)),
    style: { '--fc-cat': categoryColor(t.category) },
    onDragStart: (e) => {
      e.dataTransfer.setData(DND_TYPE, t.type)
      e.dataTransfer.effectAllowed = 'copy'
    },
    onMouseEnter: onHover,
    onClick: (e) => {
      e.stopPropagation()
      onAdd(t.type)
    }
  },
  h(Icon, { name: t.icon || 'symbol-misc' }),
  h('span', { className: 'fc-item-name' }, t.title),
  showCategory ? h('span', { className: 'fc-item-meta' }, t.category || 'Other') : null)
  if (!rich) return item
  return h(sdk.Tip, { label: h(TypeTip, { spec: t, portTypes, timings }), side: 'right', align: 'start', sideOffset: 10, className: 'fc-tt-bubble' }, item)
}

function Palette({ types, recent, onAdd, folds, onFolds, timings }) {
  const [query, setQuery] = useState('')
  const open = folds && typeof folds === 'object' ? folds : {}
  const setOpen = (fn) => onFolds(fn(open))
  const items = useMemo(() => filterTypes(types.list, query), [types.list, query])
  const recents = useMemo(() => resolveRecentTypes(items, recent), [items, recent])
  const groups = useMemo(() => groupByCategory(items), [items])
  const sections = useMemo(() => paletteSections(groups, recents), [groups, recents])
  const searching = query.trim().length > 0
  const best = searching && items[0] ? items[0].type : null // what Enter adds; highlighted while searching
  const allOpen = !searching && allFoldsOpen(sections, open)
  const foldLabel = searching ? 'Search shows every match' : allOpen ? 'Collapse all' : 'Expand all'
  const toolCount = types.list.filter((t) => t.kind === 'tool').length
  const item = (t, key) => h(TypeItem, { key, spec: t, onAdd, active: t.type === best, portTypes: types.portTypes, richTip: true, timings })
  return h('div', { className: 'fc-side fc-palette' },
    h('div', { className: 'fc-pal-top' },
      h('div', { className: 'fc-search' },
        h(Icon, { name: 'search' }),
        h('input', {
          value: query,
          placeholder: 'Search nodes, ports…',
          'aria-label': 'Search nodes by name, description or port',
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter' && items[0]) onAdd(items[0].type)
            if (e.key === 'Escape') setQuery('')
          }
        }),
        searching ? h('button', { className: 'fc-btn ghost icon', style: { width: 20, height: 20 }, title: 'Clear', onClick: () => setQuery('') }, h(Icon, { name: 'close' })) : null),
      h('button', {
        className: 'fc-btn ghost icon fc-pal-fold',
        title: foldLabel,
        'aria-label': foldLabel,
        'data-fc-fold': allOpen ? 'collapse' : 'expand',
        disabled: searching,
        onClick: () => onFolds(setAllFolds(sections, !allOpen))
      }, h(Icon, { name: allOpen ? 'collapse-all' : 'expand-all' }))),
    h('div', { className: 'fc-palette-list' },
      groups.length === 0 ? h('div', { className: 'fc-muted', style: { padding: 12 } }, 'No node matches.') : null,
      sections.map((sec) => {
        const secKey = `§${sec.id}`
        const secOpen = searching || foldOpen(open, secKey, sec.open)
        return h('div', { key: sec.id, className: 'fc-pal-sec', 'data-fc-section': sec.id,
          'data-fc-recent': sec.id === 'recent' ? '1' : undefined, style: { '--fc-sec': sec.color } },
          h('div', {
            className: 'fc-pal-sec-head', title: sec.hint, role: 'button', tabIndex: 0, 'aria-expanded': secOpen,
            onClick: () => setOpen((o) => ({ ...o, [secKey]: !secOpen })),
            onKeyDown: (e) => {
              if (!activatesOn(e.key)) return
              e.preventDefault()
              setOpen((o) => ({ ...o, [secKey]: !secOpen }))
            }
          },
          h(Icon, { name: secOpen ? 'chevron-down' : 'chevron-right', className: 'fc-pal-chev' }),
          h(Icon, { name: sec.icon, className: 'fc-pal-sec-icon' }),
          h('span', { className: 'fc-pal-sec-title' }, sec.label),
          h('span', { className: 'fc-count' }, String(sec.count))),
          secOpen ? sec.groups.map((g) => {
            const label = g.category.replace(/^(Tools|MCP|Ready) · /, '')
            if (sec.flat) return h('div', { key: g.category }, g.items.map((t) => item(t, t.type)))
            const isOpen = searching || foldOpen(open, g.category, sec.id === 'basic' || sec.id === 'ready')
            return h('div', { key: g.category },
              h('div', { className: 'fc-cat', role: 'button', 'aria-expanded': isOpen, onClick: () => setOpen((o) => ({ ...o, [g.category]: !isOpen })) },
                h(Icon, { name: isOpen ? 'chevron-down' : 'chevron-right' }), label, h('span', { className: 'fc-count' }, String(g.items.length))),
              isOpen ? g.items.map((t) => item(t, t.type)) : null)
          }) : null)
      })),
    h('div', { className: 'fc-palette-foot' }, `${types.list.filter((t) => t.palette !== false).length} nodes · ${toolCount} from Hermes tools`))
}

function QuickSearch({ types, recent, position, onAdd, onClose }) {
  const ref = useRef(null)
  const inputRef = useRef(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  useDismiss(ref, onClose)
  useLayoutEffect(() => {
    if (inputRef.current) inputRef.current.focus({ preventScroll: true })
  }, [])
  const matches = useMemo(() => filterTypes(types.list, query), [types.list, query])
  const recents = useMemo(() => resolveRecentTypes(matches, recent), [matches, recent])
  const recentIds = new Set(recents.map((t) => t.type))
  const rest = matches.filter((t) => !recentIds.has(t.type))
  const items = [...recents, ...rest]
  const current = items.length ? clamp(active, 0, items.length - 1) : 0
  useEffect(() => {
    const el = ref.current && ref.current.querySelector('.fc-item.active')
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [current])
  const choose = (t) => {
    if (t) onAdd(t.type)
  }
  const section = (label, list, isRecent = false) => list.length > 0 ? h('div', {
    key: label, 'data-fc-recent': isRecent ? '1' : undefined
  },
  h('div', { className: 'fc-quick-label' }, label),
  list.map((t) => h(TypeItem, {
    key: `${isRecent ? 'recent' : 'all'}:${t.type}`, spec: t, onAdd: choose, showCategory: true, draggable: false, portTypes: types.portTypes,
    active: items[current] === t, onHover: () => setActive(items.indexOf(t))
  }))) : null
  return h('div', {
    ref,
    className: 'fc-quick',
    role: 'dialog',
    'aria-label': 'Add node',
    style: { left: position.x, top: position.y },
    onPointerDown: (e) => e.stopPropagation(),
    onDoubleClick: (e) => e.stopPropagation(),
    onContextMenu: (e) => e.preventDefault()
  },
  h('div', { className: 'fc-search' },
    h(Icon, { name: 'search' }),
    h('input', {
      ref: inputRef,
      autoFocus: true,
      value: query,
      placeholder: 'Add a node…',
      'aria-label': 'Search nodes',
      onChange: (e) => {
        setQuery(e.target.value)
        setActive(0)
      },
      onKeyDown: (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          if (!items.length) return
          const delta = e.key === 'ArrowDown' ? 1 : -1
          setActive((current + delta + items.length) % items.length)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          choose(items[current])
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }
    })),
  h('div', { className: 'fc-quick-list', role: 'listbox' },
    items.length === 0 ? h('div', { className: 'fc-menu-empty' }, 'No node matches.') : null,
    section('Recently used', recents, true),
    section(query.trim() ? 'Other matches' : 'All nodes', rest)),
  h('div', { className: 'fc-quick-foot' }, '↑↓ select · Enter add at cursor · Esc close'))
}

// ---------------------------------------------------------------- node card
// U-4: memoized — a pan, a zoom or another node's status update re-renders the canvas, but a card whose own
// data props are unchanged is skipped. Every callback handed to it is stable (see Canvas), and `state` is this
// node's slice of the run record rather than the whole run.
function nodeCardPropsEqual(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const k of keys) if (!Object.is(a[k], b[k])) return false
  return true
}
const NodeCard = memo(function NodeCard(p) {
  const { node, spec, layout, types, state, runId, selected, issue, connectedIn, connectedOut, expanded, portClass, api } = p
  const isNote = node.type === 'note'
  const status = state ? state.status : null
  const lay = layout || { inputs: [], outputs: [], hidden: 0, collapsible: false }
  const rows = Math.max(lay.inputs.length, lay.outputs.length)
  const inSet = connectedIn || EMPTY_SET
  const outSet = connectedOut || EMPTY_SET
  const finished = status === 'done' || status === 'cached'
  const media = finished && state ? findMedia(state.outputs) : null
  const thumb = useMedia(api, runId, node.id, media ? media.port : null, 320, !!media && media.kind === 'image', media ? media.index : 0)
  const isFile = node.type === 'input.file'
  const fileInfo = useFileNode(api, p.flowId, node.id, isFile ? (node.params || {}).path : '', p.savedRev, isFile && !media && status !== 'error')
  const cls = ['fc-node', selected && 'selected', status === 'running' && 'running', status === 'error' && 'error',
    !spec && !isNote && 'unknown', isNote && 'note', (status === 'skipped' || status === 'cancelled') && 'muted'].filter(Boolean).join(' ')
  const title = node.title || (spec && spec.title) || node.type
  const summary = isNote ? [] : paramSummary(node, spec, inSet)
  const mi = useModelInfo(api, node.type, spec, node.params)
  const mInfo = mi && mi.data && mi.data.found ? mi.data : null
  const llm = useLlmInfo(api, node.params || {}, node.type === 'llm.complete')
  const cost = mInfo ? estimateCost(mInfo.cost, effectiveValues(spec, node.params, mInfo.fields || {}))
    : llm ? estimateLlmCost(llm, node.params) : null
  const exp = isNote ? null : expectedTime(spec, node, p.timings)
  const ms = modelSetting(spec, node.params)
  const modelLabel = mInfo && mInfo.label ? String(mInfo.label) : mi && mi.model ? String(mi.model) : ''
  const sub = nodeSubline(node, spec, modelLabel, !!(ms && ms.auto))
  const foot = isNote ? { cost: '', time: '' } : nodeFooter(cost, exp)
  const wires = p.wires || {}

  const port = (pt, side) => {
    const isConn = side === 'in' ? inSet.has(pt.name) : outSet.has(pt.name)
    const extra = portClass ? portClass(node.id, pt, side) : ''
    const hasValue = !isBlank((node.params || {})[pt.name])
    const required = side === 'in' && pt.required && !isConn && !hasValue
    const br = side === 'out' ? branchPort(state, pt.name) : ''
    const tip = portTip(pt, side, { wires: ((wires[side] || {})[pt.name]) || 0, hasValue, portTypes: types.portTypes, branch: br })
    const dot = h('span', { className: 'fc-dot', style: { '--fc-port': portColor(pt.type, types.portTypes) } })
    return withTip(tip, h('div', {
      key: `${side}:${pt.name}`,
      className: `fc-port fc-port-${side}${isConn ? ' connected' : ''}${br ? ` ${br}` : ''}${extra ? ` ${extra}` : ''}`,
      'data-fc-branch': br || undefined,
      'data-fc-port': pt.name,
      'data-fc-owner': node.id,
      'data-fc-side': side,
      title: nativeTitle(tip),
      onPointerDown: (e) => p.onPortDown(e, node.id, pt, side)
    },
    side === 'in' ? dot : null,
    h('span', { className: 'fc-port-label' }, pt.label || pt.name),
    required ? h('span', { className: 'fc-req' }, '*') : null,
    side === 'out' ? dot : null), side === 'in' ? 'left' : 'right', `${side}:${pt.name}`)
  }

  let preview = null
  const stop = (e) => e.stopPropagation()
  const openProps = (m) => m && p.onOpenMedia ? {
    'data-fc-nodrag': '1',
    'data-fc-open-media': m.kind,
    title: 'Click to view large',
    onPointerDown: (e) => {
      if (e.button === 0) e.stopPropagation()
    },
    onDoubleClick: stop,
    onClick: (e) => {
      e.stopPropagation()
      p.onOpenMedia({ nodeId: node.id, port: m.port, index: m.index, path: m.media.path })
    }
  } : {}
  const openable = openProps(media)
  const canOpenValue = typeof p.onOpenValue === 'function'
  const openValueHandlers = (port) => ({
    onPointerDown: (e) => {
      if (e.button === 0) e.stopPropagation()
    },
    onClick: (e) => {
      e.stopPropagation()
      p.onOpenValue({ nodeId: node.id, port })
    },
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault?.()
        e.stopPropagation()
        p.onOpenValue({ nodeId: node.id, port })
      }
    }
  })
  const valueProps = (it) => !it.media && canOpenValue ? {
    role: 'button',
    tabIndex: 0,
    'data-fc-open-value': it.port,
    'aria-label': `${it.label}: ${it.detail}`,
    onDoubleClick: stop,
    ...openValueHandlers(it.port)
  } : {}
  const minis = finished && status !== 'error' ? nodeOutputItems(node, state, types.byName) : null
  // every finished node lists its outputs — no exceptions for one output, plain text or a single image
  const showRows = !!minis && minis.total > 0
  const zoomCls = media && p.onOpenMedia ? ' fc-zoomable' : ''
  if (status === 'error' && state.error) {
    const tip = errorTip(state.error)
    preview = withTip(tip, h('div', {
      className: 'fc-node-error',
      'data-fc-run-error': '1',
      title: nativeTitle(tip)
    }, state.error), 'bottom')
  }
  else if (showRows) {
    preview = h('div', { className: 'fc-minis', 'data-fc-minis': String(minis.total) },
      minis.items.map((it) => h('div', {
        key: it.key,
        className: `fc-out k-${it.kind}` +
          (it.link && p.onOpenMedia ? ' fc-zoomable' : '') +
          (!it.media && canOpenValue ? ' fc-openable' : ''),
        'data-fc-mini': it.kind,
        ...(it.link && p.onOpenMedia
          ? openProps({ kind: it.kind, port: it.port, index: it.index, media: it.media })
          : {}),
        ...valueProps(it),
        title: `${it.label}: ${it.detail}`
      },
      h('div', { className: 'fc-mini-top' },
        h('span', { className: 'fc-mini-label' }, it.label),
        h('span', { className: 'fc-mini-badge' }, it.badge)),
      it.kind === 'image' && it.link
        ? h('div', { className: 'fc-mini-thumb' },
          h(MiniThumb, { api, runId, nodeId: node.id, port: it.port, index: it.index, name: it.detail }))
        : it.link && ['video', 'audio', 'model3d'].includes(it.kind)
          ? h(MiniMedia, { api, runId, nodeId: node.id, port: it.port, index: it.index, kind: it.kind,
            name: it.media.file || it.detail })
        : it.media
          ? h('div', { className: 'fc-mini-file' },
            h(Icon, { name: it.kind === 'broken' ? 'warning' : MEDIA_ICON[it.kind] || 'file' }),
            h('span', null, it.detail))
          : h('div', { className: 'fc-mini-text' }, it.detail))),
    minis.more > 0 ? h('div', {
      className: 'fc-mini-more',
      'data-fc-mini-more': String(minis.more),
      ...(canOpenValue ? {
        role: 'button',
        tabIndex: 0,
        'aria-label': `Show all ${minis.more} hidden outputs`,
        ...openValueHandlers(null)
      } : {})
    }, `+${minis.more}`) : null)
  } else if (media && media.kind === 'image' && thumb && thumb.data_url) {
    preview = h('div', { className: `fc-preview media${zoomCls}`, ...openable }, h('img', { src: thumb.data_url, alt: media.media.file || '', draggable: false }))
  } else if (media) {
    preview = h('div', { className: `fc-preview file${zoomCls}`, ...openable }, h(Icon, { name: MEDIA_ICON[media.kind] || 'file' }), h('span', null, media.media.file || media.kind))
  } else if (finished && state.preview !== undefined && state.preview !== null) {
    const text = previewString(state.preview)
    if (text) preview = h('div', { className: 'fc-preview' }, text)
  } else if (fileInfo && fileInfo.data_url) {
    preview = h('div', { className: 'fc-preview media', 'data-fc-file-preview': 'image', title: fileInfo.path },
      h('img', { src: fileInfo.data_url, alt: fileInfo.name || '', draggable: false }))
  } else if (fileInfo) {
    preview = fileInfo.exists
      ? h('div', { className: 'fc-preview file', 'data-fc-file-preview': fileInfo.kind || 'file', title: fileInfo.path },
        h(Icon, { name: MEDIA_ICON[fileInfo.kind] || 'file' }), h('span', null, fileInfo.name),
        fileInfo.size !== null && fileInfo.size !== undefined ? h('span', { className: 'fc-muted' }, formatBytes(fileInfo.size)) : null)
      : h('div', { className: 'fc-node-error', 'data-fc-file-preview': 'missing', title: fileInfo.path }, `File not found: ${fileInfo.name || fileInfo.path}`)
  }

  return h('div', {
    className: cls,
    'data-fc-node': node.id,
    style: { left: node.x, top: node.y, '--fc-cat': spec ? categoryColor(spec.category) : 'var(--ui-red)' },
    onPointerDown: (e) => p.onDown(e, node),
    onDoubleClick: (e) => {
      e.stopPropagation()
      if (p.onOpenInspector) p.onOpenInspector(node.id)
    },
    ref: (el) => {
      if (el && p.heightsRef) p.heightsRef.current[node.id] = el.offsetHeight
    }
  },
  h('div', { className: 'fc-node-head' },
    h('span', { className: 'fc-node-icon' }, h(Icon, { name: (spec && spec.icon) || (isNote ? 'note' : 'question') })),
    p.loopOwner ? withTip({ id: 'loop', title: 'Runs once per item', icon: 'sync',
      lines: [`Repeats for every item of “${(p.nameOf && p.nameOf(p.loopOwner)) || 'For each'}”.`, 'A Collect after it gathers the results.'] },
    h('span', { className: 'fc-tipwrap fc-node-loop', 'data-fc-loop': p.loopOwner,
      title: nativeTitle({ title: 'Runs once per item', lines: ['A Collect after it gathers the results.'] }) }, h(Icon, { name: 'sync' }))) : null,
    h('span', { className: 'fc-node-titles' },
      h('span', { className: 'fc-node-title', title: (spec && spec.description) || title }, title),
      sub ? h('span', { className: 'fc-node-sub', 'data-fc-node-sub': '1', title: sub }, sub) : null),
    issue && !status ? withTip({ id: 'issue', title: 'Not ready to run', tone: 'warn', icon: 'warning', lines: [issue] },
      h('span', { className: 'fc-tipwrap', 'data-fc-issue': '1', title: nativeTitle({ title: 'Not ready to run', lines: [issue] }) },
        h(Icon, { name: 'warning', className: 'fc-node-issue' }))) : null,
    state && status ? h(StatusBadge, { state, exp, nameOf: p.nameOf, branchName: branchLabel(node, spec, state) }) : null),
  isNote ? h('div', { className: 'fc-note-text' }, (node.params && node.params.text) || 'Empty note — select it and type in the inspector.') : null,
  rows > 0 ? h('div', { className: 'fc-ports' },
    range(rows).map((i) => h('div', { key: i, className: 'fc-port-row' },
      lay.inputs[i] ? port(lay.inputs[i], 'in') : null,
      lay.outputs[i] ? port(lay.outputs[i], 'out') : null))) : null,
  lay.hidden > 0 ? h('div', { className: 'fc-more', 'data-fc-nodrag': '1', onPointerDown: stop, onClick: () => p.onToggleExpand(node.id) },
    `+ ${lay.hidden} more input${lay.hidden === 1 ? '' : 's'}`) : null,
  expanded && lay.collapsible ? h('div', { className: 'fc-more', 'data-fc-nodrag': '1', onPointerDown: stop, onClick: () => p.onToggleExpand(node.id) }, 'Show fewer inputs') : null,
  summary.length > 0 ? h('div', { className: 'fc-summary' }, summary.map(([k, v], i) => [
    // the row index, not the label: two params can share a label (U-18: duplicate React keys)
    h('span', { key: `k:${i}`, className: 'fc-summary-key' }, k),
    h('span', { key: `v:${i}`, className: 'fc-summary-val', title: String(v) }, v)])) : null,
  !spec && !isNote ? h('div', { className: 'fc-node-error' }, `Unknown node type “${node.type}”. The tool may be missing or blocked.`) : null,
  preview,
  foot.cost || foot.time ? h('div', { className: 'fc-node-foot', 'data-fc-node-foot': '1' },
    foot.cost ? h('span', { className: 'fc-node-cost', 'data-fc-node-cost': foot.cost, title: cost.lines.join('\n') }, foot.cost)
      : h('span', { className: 'fc-node-free' }, ''),
    foot.time ? h('span', { className: 'fc-node-time', title: 'Usual duration' }, foot.time) : null) : null)
}, nodeCardPropsEqual)

// ---------------------------------------------------------------- canvas
/** Current rendered card bounds in world pixels. Client rectangles would shrink when the canvas is zoomed out. */
function measureNodeSizes(root, flow) {
  const known = new Set((flow?.nodes || []).map((n) => n.id))
  return Object.fromEntries([...root?.querySelectorAll('[data-fc-node]') || []].flatMap((el) => {
    const id = el.dataset.fcNode, width = el.offsetWidth, height = el.offsetHeight
    return known.has(id) && [width, height].every((v) => Number.isFinite(v) && v > 0 && v <= 100000)
      ? [[id, { width, height }]] : []
  }))
}
function Canvas(p) {
  const { flow, types, layouts, run, view, setView } = p
  const ref = useRef(null)
  const live = useRef({})
  live.current = { flow, layouts, view, selection: p.selection, types, connectedIn: p.connectedIn }
  // U-4: node cards are memoized, so the callbacks they hold are created once and read the props of the frame
  // they run in. Anything a card is given must keep its identity across a pan or another node's status update.
  const props = useRef(p)
  props.current = p
  const stable = useRef(null)
  if (!stable.current) {
    const call = (name) => (...args) => {
      const fn = props.current[name]
      return typeof fn === 'function' ? fn(...args) : undefined
    }
    stable.current = {
      nameOf: call('nameOf'),
      onToggleExpand: call('onToggleExpand'),
      onOpenInspector: call('onOpenInspector'),
      onOpenMedia: call('onOpenMedia'),
      onOpenValue: call('onOpenValue')
    }
  }
  // One document update per animation frame while nodes are dragged; `up` flushes the last one before the
  // undo step, so a drag still commits its final position and stays a single undo entry.
  const moveRef = useRef(null)
  if (!moveRef.current) moveRef.current = rafThrottle((pos) => props.current.onMove(pos))
  const dragRef = useRef(null)
  const spaceRef = useRef(false)
  const [wire, setWire] = useState(null)
  useWireTipGuard(wire, ref)
  const [rect, setRect] = useState(null)
  const [panning, setPanning] = useState(false)
  const [space, setSpace] = useState(false)
  const [menu, setMenu] = useState(null)
  const [quick, setQuick] = useState(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hoverNode, setHoverNode] = useState(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const update = () => {
      const s = { w: el.clientWidth, h: el.clientHeight }
      if (p.sizeRef) p.sizeRef.current = s
      setSize(s)
    }
    update()
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(update)
      ro.observe(el)
      return () => ro.disconnect()
    }
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  const fit = () => {
    const el = ref.current
    const f = live.current.flow
    if (!el || !f) return
    const rects = f.nodes.map((n) => ({ x: n.x, y: n.y, w: NODE_W, h: p.heightsRef.current[n.id] || 110 }))
    setView(fitView(rects, el.clientWidth, el.clientHeight))
  }
  if (p.fitRef) p.fitRef.current = fit

  useLayoutEffect(() => {
    if (p.needFitRef.current && size.w > 0 && size.h > 0) {
      p.needFitRef.current = false
      fit()
    }
  })

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const onWheel = (e) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const pt = { x: e.clientX - r.left, y: e.clientY - r.top }
      if (e.shiftKey && !e.ctrlKey) {
        setView((v) => ({ ...v, x: v.x - (e.deltaY || e.deltaX) }))
        return
      }
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0016))
      setView((v) => zoomAt(v, factor, pt))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setView])

  // Space held = pan mode (like most canvas tools)
  useEffect(() => {
    const down = (e) => {
      if (e.code !== 'Space' || !spacePans(e.target, ref.current)) return
      e.preventDefault()
      if (!spaceRef.current) {
        spaceRef.current = true
        setSpace(true)
      }
    }
    const up = (e) => {
      if (e.code !== 'Space') return
      spaceRef.current = false
      setSpace(false)
    }
    const blur = () => {
      spaceRef.current = false
      setSpace(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const local = useCallback((e) => {
    const r = ref.current.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }, [])

  const wireOk = (from, blocked, nodeId, portName) => {
    if (!from || nodeId === from.node || (blocked && blocked.has(nodeId))) return false
    const lay = live.current.layouts[nodeId]
    if (!lay) return false
    const list = from.side === 'out' ? lay.allInputs : lay.outputs
    const pt = list.find((q) => q.name === portName)
    if (!pt) return false
    const compat = live.current.types.compat
    return from.side === 'out' ? compatible(compat, from.type, pt.type) : compatible(compat, pt.type, from.type)
  }

  const targetAt = (x, y, from, blocked) => {
    const el = document.elementFromPoint(x, y)
    if (!el || !ref.current || !ref.current.contains(el)) return null
    const wantSide = from.side === 'out' ? 'in' : 'out'
    const portEl = el.closest('[data-fc-port]')
    if (portEl) {
      if (portEl.getAttribute('data-fc-side') !== wantSide) return null
      const node = portEl.getAttribute('data-fc-owner')
      const port = portEl.getAttribute('data-fc-port')
      return wireOk(from, blocked, node, port) ? { node, port } : null
    }
    const card = el.closest('[data-fc-node]')
    if (!card) return null
    const node = card.getAttribute('data-fc-node')
    const lay = live.current.layouts[node]
    if (!lay) return null
    const list = wantSide === 'in' ? lay.allInputs : lay.outputs
    const ok = list.filter((q) => wireOk(from, blocked, node, q.name))
    if (!ok.length) return null
    const taken = live.current.connectedIn[node] || EMPTY_SET
    const best = wantSide === 'in' ? ok.find((q) => !taken.has(q.name)) || ok[0] : ok[0]
    return { node, port: best.name }
  }

  // window listeners for drags: created once, dispatch to the latest handlers
  const handlers = useRef({})
  const listeners = useRef(null)
  if (!listeners.current) {
    const move = (e) => handlers.current.move(e)
    const up = (e) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      handlers.current.up(e)
    }
    listeners.current = { move, up }
  }
  const detach = useCallback(() => {
    window.removeEventListener('pointermove', listeners.current.move)
    window.removeEventListener('pointerup', listeners.current.up)
    window.removeEventListener('pointercancel', listeners.current.up)
  }, [])
  const begin = useCallback((kind, e, data) => {
    detach()
    dragRef.current = { kind, sx: e.clientX, sy: e.clientY, moved: false, ...data }
    // Capture the pointer so a drag keeps reporting after the cursor leaves the canvas or the node it started on
    // (U-18: without it the drag only ends on the next click over the element).
    try {
      if (e.currentTarget && typeof e.currentTarget.setPointerCapture === 'function') e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* no capture (old browser, stale pointerId): the window listeners below still drive the drag */
    }
    window.addEventListener('pointermove', listeners.current.move)
    window.addEventListener('pointerup', listeners.current.up)
    window.addEventListener('pointercancel', listeners.current.up)
  }, [detach])
  // on unmount: drop the window listeners and any move that has not reached a frame yet
  useEffect(() => () => {
    detach()
    moveRef.current.cancel()
  }, [detach])

  handlers.current.move = (e) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (!d.moved) {
      if (Math.abs(dx) + Math.abs(dy) < 4) return
      d.moved = true
      if (d.kind === 'pan') setPanning(true)
    }
    if (d.kind === 'pan') setView({ ...d.view0, x: d.view0.x + dx, y: d.view0.y + dy })
    else if (d.kind === 'nodes') {
      const z = live.current.view.zoom
      const pos = {}
      for (const id of Object.keys(d.starts)) pos[id] = { x: snap(d.starts[id].x + dx / z), y: snap(d.starts[id].y + dy / z) }
      moveRef.current(pos)
    } else if (d.kind === 'rect') {
      const pt = local(e)
      setRect({ x0: d.origin.x, y0: d.origin.y, x1: pt.x, y1: pt.y })
    } else if (d.kind === 'wire') {
      const pt = local(e)
      const hot = targetAt(e.clientX, e.clientY, d.from, d.blocked)
      setWire({ from: d.from, blocked: d.blocked, detach: d.detach || null, point: pt, hot })
    }
  }
  handlers.current.up = (e) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (d.kind === 'pan') {
      setPanning(false)
      if (!d.moved && d.clear) p.onSelect([], 'replace')
    } else if (d.kind === 'nodes') {
      if (d.moved) {
        // the frame that is still pending holds the last pointer position: commit it before the undo step
        moveRef.current.flush()
        p.onMoveEnd(d.startFlow)
      } else if (d.collapseTo) p.onSelect([d.collapseTo], 'replace')
    } else if (d.kind === 'rect') {
      setRect(null)
      if (d.moved) {
        const v = live.current.view
        const a = screenToWorld(v, d.origin)
        const b = screenToWorld(v, local(e))
        const box = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }
        const rects = live.current.flow.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: NODE_W, h: p.heightsRef.current[n.id] || 110 }))
        p.onSelect(rectSelect(rects, box), d.additive ? 'add' : 'replace')
      }
    } else if (d.kind === 'wire') {
      setWire(null)
      if (!d.moved) return
      const t = targetAt(e.clientX, e.clientY, d.from, d.blocked)
      if (d.detach) {
        // dragged an existing edge off its input: re-route it, or drop it
        if (t && t.node === d.detach.to.node && t.port === d.detach.to.port) return
        if (t) p.onConnect({ node: d.from.node, port: d.from.port }, { node: t.node, port: t.port }, d.detach.id)
        else p.onDisconnect(d.detach.id)
        return
      }
      if (!t) return
      if (d.from.side === 'out') p.onConnect({ node: d.from.node, port: d.from.port }, { node: t.node, port: t.port })
      else p.onConnect({ node: t.node, port: t.port }, { node: d.from.node, port: d.from.port })
    }
  }

  useEffect(() => {
    if (!wire) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        dragRef.current = null
        detach()
        setWire(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [!!wire])

  const startPan = useCallback((e) => {
    e.preventDefault()
    begin('pan', e, { view0: live.current.view, clear: false })
  }, [begin])

  const onBgDown = (e) => {
    if (e.button !== 0 && e.button !== 1) return
    p.onFocusRoot()
    if (spaceRef.current || e.button === 1) {
      startPan(e)
      return
    }
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      begin('rect', e, { origin: local(e), additive: true })
      return
    }
    e.preventDefault()
    begin('pan', e, { view0: live.current.view, clear: true })
  }

  // Handed to every (memoized) card: stable for the life of the canvas, reading the latest props when it runs.
  const onNodeDown = useCallback((e, node) => {
    const p = props.current
    if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
      e.stopPropagation()
      p.onFocusRoot()
      startPan(e)
      return
    }
    if (e.button !== 0) return
    if (e.target.closest && (e.target.closest('[data-fc-port]') || e.target.closest('[data-fc-nodrag]'))) return
    e.stopPropagation()
    p.onFocusRoot()
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      p.onSelect([node.id], 'toggle')
      return
    }
    const sel = live.current.selection
    const already = sel.includes(node.id)
    const ids = already ? sel : [node.id]
    if (!already) p.onSelect([node.id], 'replace')
    const starts = {}
    for (const n of live.current.flow.nodes) if (ids.includes(n.id)) starts[n.id] = { x: n.x, y: n.y }
    begin('nodes', e, { starts, startFlow: live.current.flow, collapseTo: already && sel.length > 1 ? node.id : null })
  }, [begin, startPan])

  const onPortDown = useCallback((e, nodeId, pt, side) => {
    const p = props.current
    if (e.button !== 0 || spaceRef.current) return
    e.stopPropagation()
    e.preventDefault()
    p.onFocusRoot()
    const f = live.current.flow
    let from = { node: nodeId, port: pt.name, side, type: pt.type }
    let detachEdge = null
    if (side === 'in') {
      const existing = f.edges.find((ed) => ed.to.node === nodeId && ed.to.port === pt.name)
      if (existing) {
        const srcLayout = live.current.layouts[existing.from.node]
        const outPort = srcLayout ? srcLayout.outputs.find((q) => q.name === existing.from.port) : null
        from = { node: existing.from.node, port: existing.from.port, side: 'out', type: outPort ? outPort.type : 'any' }
        detachEdge = existing
      }
    }
    const blocked = from.side === 'out' ? ancestors(f, from.node) : descendants(f, from.node)
    blocked.add(from.node)
    if (!detachEdge) setWire({ from, blocked, detach: null, point: local(e), hot: null })
    begin('wire', e, { from, blocked, detach: detachEdge })
  }, [begin, local])

  const fileOverTimer = useRef(null)
  const [fileOver, setFileOver] = useState(false)
  const hasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files')
  const onDragOver = (e) => {
    const types = Array.from(e.dataTransfer.types || [])
    if (types.includes(DND_TYPE) || (hasFiles(e) && p.onDropFiles)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
    if (hasFiles(e) && p.onDropFiles) {
      // no reliable dragleave over child elements: the highlight ends 160 ms after the last dragover
      setFileOver(true)
      clearTimeout(fileOverTimer.current)
      fileOverTimer.current = setTimeout(() => setFileOver(false), 160)
    }
  }
  const onDrop = (e) => {
    const w = screenToWorld(live.current.view, local(e))
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
    if (files.length && p.onDropFiles) {
      e.preventDefault()
      clearTimeout(fileOverTimer.current)
      setFileOver(false)
      p.onDropFiles(files, w.x - NODE_W / 2, w.y - HEAD_H / 2)
      return
    }
    const type = e.dataTransfer.getData(DND_TYPE)
    if (!type) return
    e.preventDefault()
    p.onDropType(type, w.x - NODE_W / 2, w.y - HEAD_H / 2)
  }
  useEffect(() => () => clearTimeout(fileOverTimer.current), [])

  const onContextMenu = (e) => {
    if (e.target.closest('[data-fc-generate]')) return  // keep native paste/context behaviour in the composer
    e.preventDefault()
    setQuick(null)
    const pt = local(e)
    const card = e.target.closest ? e.target.closest('[data-fc-node]') : null
    const nodeId = card ? card.getAttribute('data-fc-node') : null
    const hit = !nodeId && e.target.closest ? e.target.closest('[data-fc-edge]') : null
    const edgeId = hit ? hit.getAttribute('data-fc-edge') : null
    if (nodeId && !live.current.selection.includes(nodeId)) p.onSelect([nodeId], 'replace')
    if (edgeId) p.onSelectEdge(edgeId)
    const w = ref.current ? ref.current.clientWidth : 800
    const hgt = ref.current ? ref.current.clientHeight : 600
    setMenu({ x: clamp(pt.x, 4, Math.max(4, w - 236)), y: clamp(pt.y, 4, Math.max(4, hgt - 250)), nodeId, edgeId, world: screenToWorld(live.current.view, pt) })
  }

  const onDoubleClick = (e) => {
    if (e.button !== 0) return
    const el = e.target
    if (el.closest && el.closest('[data-fc-node], [data-fc-generate], .fc-zoombar, .fc-menu, .fc-quick')) return
    e.preventDefault()
    e.stopPropagation()
    const pt = local(e)
    const w = ref.current ? ref.current.clientWidth : 800
    const hgt = ref.current ? ref.current.clientHeight : 600
    setMenu(null)
    setQuick({
      x: clamp(pt.x, 8, Math.max(8, w - 348)),
      y: clamp(pt.y, 8, Math.max(8, hgt - 440)),
      world: screenToWorld(live.current.view, pt)
    })
  }

  const menuItems = () => {
    if (!menu) return []
    const mod = 'Ctrl'
    if (menu.edgeId) {
      return [{ label: 'Remove connection', icon: 'trash', hint: 'Del', danger: true, run: () => {
        p.onDisconnect(menu.edgeId)
        p.onSelectEdge(null)
      } }]
    }
    if (menu.nodeId) {
      const node = flow.nodes.find((n) => n.id === menu.nodeId)
      const isNote = node && node.type === 'note'
      const many = p.selection.length > 1
      return [
        { label: 'Run up to here', icon: 'debug-continue', disabled: p.running || isNote || many, run: () => p.onRunTo(menu.nodeId) },
        '-',
        { label: many ? `Duplicate ${p.selection.length} nodes` : 'Duplicate', icon: 'copy', hint: `${mod}+D`, run: p.onDuplicate },
        { label: 'Copy', icon: 'clippy', hint: `${mod}+C`, run: p.onCopy },
        { label: 'Cut', icon: 'clippy', hint: `${mod}+X`, run: p.onCut },
        { label: many ? `Delete ${p.selection.length} nodes` : 'Delete', icon: 'trash', hint: 'Del', danger: true, run: p.onDelete }
      ]
    }
    return [
      { label: 'Paste here', icon: 'clippy', hint: `${mod}+V`, disabled: !p.canPaste(), run: () => p.onPaste(menu.world) },
      { label: 'Add a note here', icon: 'note', run: () => p.onDropType('note', menu.world.x, menu.world.y) },
      '-',
      { label: 'Select all', icon: 'checklist', hint: `${mod}+A`, disabled: !flow.nodes.length, run: p.onSelectAll },
      { label: 'Tidy layout', icon: 'wand', disabled: p.running || !flow.nodes.length, run: p.onTidy },
      { label: 'Fit to screen', icon: 'screen-full', hint: 'F', disabled: !flow.nodes.length, run: fit }
    ]
  }

  const byId = {}
  for (const n of flow.nodes) byId[n.id] = n
  const colorOf = (t) => portColor(t, types.portTypes)
  const stateOf = (id) => (run && run.nodes ? run.nodes[id] : null)
  const hiddenEdge = wire && wire.detach ? wire.detach.id : null
  // Edge layout A: the wires of the hovered (or the one selected) node are drawn bold above the cards, the rest fade.
  const lit = edgeFocus(flow.edges, { hover: hoverNode, selection: p.selection, selectedEdge: p.selectedEdge, dragging: !!wire })
  const boxOf = (n) => ({ x: n.x, y: n.y, w: NODE_W, h: (p.heightsRef && p.heightsRef.current[n.id]) || 110 })
  const litEls = []

  const edgeEls = flow.edges.map((ed) => {
    if (ed.id === hiddenEdge) return null
    const a = byId[ed.from.node]
    const b = byId[ed.to.node]
    const la = a && layouts[a.id]
    const lb = b && layouts[b.id]
    if (!la || !lb) return null
    // U-4: world coordinates — the layer carries the view transform, so a pan only moves one attribute and the
    // path data (whose strings are identical across pans) is left alone. Strokes stay screen-sized (CSS
    // `vector-effect: non-scaling-stroke`), so the curve looks exactly as it did in screen space.
    const pa = portPosition(a, la, 'out', ed.from.port)
    const pb = portPosition(b, lb, 'in', ed.to.port)
    const op = la.outputs.find((q) => q.name === ed.from.port)
    const d = edgeRouteWorld(pa, pb, boxOf(a), boxOf(b))
    const ts = stateOf(b.id)
    const ss = stateOf(a.id)
    const on = !!lit && lit.has(ed.id)
    const cls = ['fc-edge', p.selectedEdge === ed.id && 'selected', ts && ts.status === 'running' && 'flowing',
      edgeDead(ss, ts, ed.from.port) && 'dead', lit && !on && 'faded'].filter(Boolean).join(' ')
    const stroke = colorOf(op ? op.type : 'any')
    if (on) litEls.push(h('path', { key: ed.id, d, className: `${cls} lit`, 'data-fc-lit': ed.id, style: { stroke } }))
    return h('g', { key: ed.id },
      h('path', {
        d,
        className: 'fc-edge-hit',
        'data-fc-edge': ed.id,
        onPointerDown: (ev) => {
          if (ev.button !== 0 || spaceRef.current) return
          ev.stopPropagation()
          p.onFocusRoot()
          p.onSelectEdge(ed.id)
        }
      }),
      on ? null : h('path', { d, className: cls, style: { stroke } }))
  })

  let wireEl = null
  if (wire) {
    const n = byId[wire.from.node]
    const l = n && layouts[n.id]
    if (l) {
      // the pointer is in screen space; the temporary wire lives with the edges, in world space
      const p0 = portPosition(n, l, wire.from.side, wire.from.port)
      const tip = screenToWorld(view, wire.point)
      const d = wire.from.side === 'out' ? edgePathWorld(p0, tip) : edgePathWorld(tip, p0)
      wireEl = h('path', { d, className: 'fc-wire', style: { stroke: colorOf(wire.from.type) } })
    }
  }

  const portClass = wire
    ? (nodeId, pt, side) => {
        if (nodeId === wire.from.node && pt.name === wire.from.port && side === wire.from.side) return 'hot'
        if (wire.hot && wire.hot.node === nodeId && wire.hot.port === pt.name) return 'ok hot'
        if (side === wire.from.side) return 'dim'
        return wireOk(wire.from, wire.blocked, nodeId, pt.name) ? 'ok' : 'dim'
      }
    : null

  const nodeEls = flow.nodes.map((n) =>
    h(NodeCard, {
      key: n.id,
      node: n,
      spec: types.byName[n.type],
      layout: layouts[n.id],
      types,
      state: stateOf(n.id),
      runId: run ? run.id : null,
      selected: p.selection.includes(n.id),
      issue: p.issuesByNode[n.id],
      connectedIn: p.connectedIn[n.id],
      connectedOut: p.connectedOut[n.id],
      expanded: p.expanded.has(n.id),
      portClass,
      timings: p.timings,
      nameOf: stable.current.nameOf,
      loopOwner: p.loopOwners ? p.loopOwners[n.id] : null,
      wires: p.wireCounts ? p.wireCounts[n.id] : null,
      api: p.api,
      heightsRef: p.heightsRef,
      onDown: onNodeDown,
      onPortDown,
      onToggleExpand: stable.current.onToggleExpand,
      onOpenInspector: stable.current.onOpenInspector,
      onOpenMedia: stable.current.onOpenMedia,
      onOpenValue: stable.current.onOpenValue,
      flowId: flow.id,
      savedRev: p.savedRev
    }))

  const zoomBy = (factor) => setView((v) => zoomAt(v, factor, { x: size.w / 2, y: size.h / 2 }))
  const cls = ['fc-canvas', wire && 'fc-wiring', panning && 'panning', space && !panning && 'space', fileOver && 'file-over'].filter(Boolean).join(' ')
  return h('div', {
    ref,
    className: cls,
    style: { backgroundSize: `${20 * view.zoom}px ${20 * view.zoom}px`, backgroundPosition: `${view.x}px ${view.y}px` },
    onPointerDown: onBgDown,
    onDoubleClick,
    onContextMenu,
    onDragOver,
    onDrop
  },
  wire ? h('style', { 'data-fc-wire-tips': '1' }, WIRE_TIP_CSS) : null,
  h('svg', { className: 'fc-edges', style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` } }, edgeEls, wireEl),
  h('div', {
    className: 'fc-world',
    style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` },
    onPointerOver: (e) => { const el = e.target.closest && e.target.closest('[data-fc-node]'); setHoverNode(el ? el.getAttribute('data-fc-node') : null) },
    onPointerOut: (e) => { const el = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-fc-node]'); if (!el) setHoverNode(null) }
  }, nodeEls),
  litEls.length ? h('svg', { className: 'fc-edges fc-edges-top', style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` } }, litEls) : null,
  rect ? h('div', {
    className: 'fc-rect',
    style: { left: Math.min(rect.x0, rect.x1), top: Math.min(rect.y0, rect.y1), width: Math.abs(rect.x1 - rect.x0), height: Math.abs(rect.y1 - rect.y0) }
  }) : null,
  flow.nodes.length === 0 && !fileOver ? h('div', { className: 'fc-hint fc-generate-hint' },
    h('div', { className: 'fc-hint-title' }, 'Start building'),
    p.generation ? h(GenerateComposer, {
      flow, generation: p.generation, onEdit: p.onGenerateEdit, onSubmit: p.onGenerate, onStop: p.onGenerateStop, inline: true,
    }) : null,
    h('div', { className: 'fc-help', style: { marginTop: 10 } },
      'Or click/drag a node from the left panel. Connect an output to an input, then press Run.'),
    p.onDropFiles ? h('div', { className: 'fc-help' }, 'Drop files here to add them as File nodes.') : null) : null,
  fileOver ? h('div', { className: 'fc-drop-hint', 'data-fc-drop-hint': '1' },
    h(Icon, { name: 'cloud-upload' }), 'Drop to add as File nodes') : null,
  p.uploading ? h('div', { className: 'fc-drop-hint busy', 'data-fc-uploading': String(p.uploading) },
    h(Icon, { name: 'loading', spin: true }), `Adding ${p.uploading} file${p.uploading === 1 ? '' : 's'}…`) : null,
  h('div', { className: 'fc-zoombar', onPointerDown: (e) => e.stopPropagation() },
    h('button', { className: 'fc-btn ghost icon', title: 'Zoom out', onClick: () => zoomBy(1 / 1.2) }, h(Icon, { name: 'zoom-out' })),
    h('span', { className: 'fc-zoomval' }, `${Math.round(view.zoom * 100)}%`),
    h('button', { className: 'fc-btn ghost icon', title: 'Zoom in', onClick: () => zoomBy(1.2) }, h(Icon, { name: 'zoom-in' })),
    h('button', { className: 'fc-btn ghost icon', title: 'Fit to screen (F)', onClick: fit }, h(Icon, { name: 'screen-full' }))),
  quick ? h(QuickSearch, {
    types, recent: p.recent, position: quick,
    onAdd: (type) => {
      p.onDropType(type, quick.world.x - NODE_W / 2, quick.world.y - HEAD_H / 2)
      setQuick(null)
      p.onFocusRoot()
    },
    onClose: () => setQuick(null)
  }) : null,
  menu ? h(ContextMenu, { menu, items: menuItems(), onClose: () => setMenu(null) }) : null)
}

// ---------------------------------------------------------------- inspector
/** Tool picker label: the title (the group already names the server); the raw tool name only where two tools
 *  of one group share a title. Long raw names (mcp__server__tool) clipped the select. Pure, tested. */
function toolOptionLabel(t, group) {
  const name = (t && (t.title || t.tool || t.type)) || ''
  const twins = ((group && group.items) || []).filter((x) => (x.title || x.tool || x.type) === name).length
  return twins > 1 ? `${name} · ${t.tool || t.type}` : name
}

function ToolSelect({ types, value, missing, className, onChange, title }) {
  const groups = toolChoices(types)
  const known = groups.some((g) => g.items.some((t) => t.type === value))
  const current = known ? groups.flatMap((g) => g.items).find((t) => t.type === value) : null
  const hover = [current ? current.tool || current.type : null, title].filter(Boolean).join('\n') || undefined
  return h('select', { className: className || 'fc-input', value: value || '', title: hover, onChange: (e) => onChange(e.target.value) },
    !known ? h('option', { value: value || '' }, value ? `${missing || value} (missing)` : '— pick a tool —') : null,
    groups.map((g) => h('optgroup', { key: g.category, label: g.category },
      g.items.map((t) => h('option', { key: t.type, value: t.type, title: t.tool || t.type }, toolOptionLabel(t, g))))))
}

/** Small "i" next to a label; hover or keyboard focus shows the explanation (app tooltip when available). */
function InfoTip({ lines }) {
  const list = (Array.isArray(lines) ? lines : [lines]).filter(Boolean)
  if (!list.length) return null
  const text = list.join('\n')
  const icon = h('span', { className: 'fc-info', tabIndex: 0, role: 'img', 'aria-label': text, title: typeof sdk.Tip === 'function' ? undefined : text },
    h(Icon, { name: 'info' }))
  if (typeof sdk.Tip !== 'function') return icon
  return h(sdk.Tip, { label: h('div', { className: 'fc-tip' }, list.map((l, i) => h('div', { key: i }, l))), side: 'top', className: 'fc-tip-bubble' }, icon)
}

function loadModelOptions(refresh = false) {
  if (!refresh && SHARED.modelOptions) return SHARED.modelOptions
  if (typeof host.request !== 'function') return Promise.reject(new Error('Hermes gateway is not available'))
  const p = host.request('model.options', refresh ? { explicit_only: true, refresh: true } : { explicit_only: true }, 30000)
  SHARED.modelOptions = p
  p.catch(() => {
    if (SHARED.modelOptions === p) SHARED.modelOptions = null
  })
  return p
}

/** Puts a `position: fixed` popup under `anchor` (above it when there is clearly more room there), inside
 *  `bounds`, and caps its scrolling list to the space left. Corrects for a transformed ancestor by measuring. */
function placeFloating(pop, anchor, bounds, gap = 4) {
  const a = anchor.getBoundingClientRect()
  const b = bounds ? bounds.getBoundingClientRect() : { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight }
  const list = pop.querySelector('.fc-model-list')
  const below = b.bottom - a.bottom - gap - 8
  const above = a.top - b.top - gap - 8
  const up = below < 220 && above > below
  const chrome = pop.offsetHeight - (list ? list.offsetHeight : 0)
  if (list) list.style.maxHeight = `${Math.max(96, Math.min(320, (up ? above : below) - chrome))}px`
  const width = Math.min(Math.max(a.width, 260), b.right - b.left - 16)
  const left = Math.max(b.left + 8, Math.min(a.left, b.right - 8 - width))
  const top = up ? a.top - gap - pop.offsetHeight : a.bottom + gap
  pop.style.width = `${width}px`
  pop.style.left = `${left}px`
  pop.style.top = `${top}px`
  const got = pop.getBoundingClientRect()          // a transformed ancestor shifts `fixed`: correct by the offset
  if (Math.abs(got.left - left) > 0.5) pop.style.left = `${2 * left - got.left}px`
  if (Math.abs(got.top - top) > 0.5) pop.style.top = `${2 * top - got.top}px`
}
/** Searchable model dropdown, grouped by provider. Empty value = Hermes' active model. */
function ModelPicker({ model, provider, onChange, eager = false, disabled = false }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const wrapRef = useRef(null)
  const popRef = useRef(null)
  const load = (refresh) => {
    setLoading(true)
    setError(null)
    loadModelOptions(refresh).then((d) => setData(d || {}), (e) => setError(parseRestError(e).message)).finally(() => setLoading(false))
  }
  useEffect(() => {
    if ((open || eager) && !data && !loading) load(false)
    if (!open) return undefined
    const away = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [open, eager])
  useLayoutEffect(() => {
    // In the Build composer the list floats over the dialog instead of growing it: place it under (or above) the
    // button, inside the visible Arachne page, and shrink the list to the room that is there.
    const wrap = wrapRef.current
    if (!open || !wrap || !wrap.closest('.fc-generate-card')) return undefined
    const place = () => {
      const pop = popRef.current
      const btn = wrap.querySelector('.fc-model-btn')
      if (!pop || !btn) return
      placeFloating(pop, btn, wrap.closest('.fc-modal-scrim, .fc-root'))
    }
    place()
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [open, data, query])
  const groups = useMemo(() => modelGroups(data), [data])
  const { groups: shown, hidden } = useMemo(() => filterModelGroups(groups, query), [groups, query])
  const providerName = (slug) => (groups.find((g) => g.slug === slug) || {}).name || slug
  const active = data && data.model ? `${data.model}${data.provider ? ` · ${providerName(data.provider)}` : ''}` : 'active model'
  const pick = (next) => {
    onChange(next)
    setOpen(false)
    setQuery('')
  }
  const first = shown.length ? { provider: shown[0].slug, model: shown[0].models[0] } : null
  const label = isBlank(model)
    ? h('span', { className: 'fc-muted' }, data && data.model ? `Current · ${data.model}` : 'Current Hermes model')
    : h('span', null, String(model))
  return h('div', { className: 'fc-model', ref: wrapRef, 'data-fc-model-picker': '1' },
    h('button', {
      type: 'button', className: `fc-input fc-model-btn${open ? ' open' : ''}`, 'aria-haspopup': 'listbox', 'aria-expanded': open,
      disabled, onClick: () => setOpen(!open)
    }, label,
    !isBlank(model) && !isBlank(provider) ? h('span', { className: 'fc-model-prov' }, providerName(provider)) : null,
    h(Icon, { name: 'chevron-down' })),
    open ? h('div', { className: 'fc-model-pop', role: 'listbox', ref: popRef },
      h('div', { className: 'fc-model-search' },
        h(Icon, { name: 'search' }),
        h('input', {
          autoFocus: true, value: query, placeholder: 'Search models or providers…',
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
            if (e.key === 'Enter' && first) { e.preventDefault(); pick(first) }
          }
        }),
        h('button', { type: 'button', className: 'fc-btn ghost icon', title: 'Reload the model lists from your providers', onClick: () => load(true) },
          h(Icon, { name: 'refresh', spin: loading }))),
      h('div', { className: 'fc-model-list' },
        h('div', { className: `fc-model-item${isBlank(model) ? ' active' : ''}`, 'data-fc-model-default': '1', onClick: () => pick({ provider: null, model: null }) },
          h('span', null, 'Current Hermes model'), h('span', { className: 'fc-model-prov' }, active)),
        loading && !data ? h('div', { className: 'fc-help fc-model-note' }, 'Loading models…') : null,
        error ? h('div', { className: 'fc-help fc-bad fc-model-note' }, `Could not load models: ${error}`) : null,
        data && !shown.length ? h('div', { className: 'fc-help fc-model-note' }, query ? 'No model matches.' : 'No configured providers found.') : null,
        shown.map((g) => h('div', { key: g.slug, className: 'fc-model-group', 'data-fc-provider': g.slug },
          h('div', { className: 'fc-model-head' }, g.name, g.current ? h('span', { className: 'fc-model-tag' }, 'active') : null,
            h('span', { className: 'fc-model-count' }, String(g.models.length))),
          g.models.map((m) => {
            const price = g.prices[m]
            const caps = g.caps[m] || {}
            const tip = [m, price ? `Input ${price.input || '?'} · Output ${price.output || '?'} per Mtok` : null,
              caps.reasoning === false ? 'No reasoning' : caps.reasoning ? 'Reasoning' : null].filter(Boolean).join('\n')
            return h('div', {
              key: m, title: tip, 'data-fc-model': m, 'data-fc-model-provider': g.slug,
              className: `fc-model-item${m === model && g.slug === provider ? ' active' : ''}`,
              onClick: () => pick({ provider: g.slug, model: m })
            }, h('span', null, m), price ? h('span', { className: 'fc-model-prov' }, `in ${price.input || '–'} / out ${price.output || '–'}`) : null)
          }))),
        hidden > 0 ? h('div', { className: 'fc-help fc-model-note' }, `${hidden} more — type to narrow the list.`) : null)) : null)
}

/** Controlled G6 composer. The parent owns draft/busy/error so a failed request loses none of the input. */
function GenerateComposer({ flow, generation, onEdit, onSubmit, onCancel, onStop, inline = false }) {
  const { draft, busy, error } = generation
  const now = useNow(busy)
  const submit = () => {
    if (!busy && draft.prompt.trim()) onSubmit()
  }
  return h('div', {
    className: 'fc-generate-card', 'data-fc-generate': '1',
    onPointerDown: inline ? (e) => e.stopPropagation() : undefined,
    onMouseDown: inline ? (e) => e.stopPropagation() : undefined
  },
    h('div', { className: 'fc-generate-head' }, h(Icon, { name: 'sparkle' }),
      flow ? 'Build with Hermes · edit this flow' : 'Build a new flow with Hermes'),
    h('div', { className: 'fc-help' }, 'Describe the result. Hermes adds or changes nodes and connections, validates the graph, and does not run it.'),
    h('textarea', {
      className: 'fc-input', 'data-fc-generate-prompt': '1', value: draft.prompt, disabled: busy,
      autoFocus: !inline, rows: 4,
      placeholder: flow ? 'e.g. Add a preview after the LLM and tidy the layout…' : 'e.g. Turn an idea into an image and show the result…',
      onChange: (e) => onEdit({ prompt: e.target.value }),
      onKeyDown: (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit() }
        if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel() }
      }
    }),
    h('div', { className: 'fc-generate-controls' },
      h('div', { className: 'fc-generate-model' }, h('label', null, 'Model · all configured providers'),
        h(ModelPicker, {
          model: draft.model, provider: draft.provider, eager: true, disabled: busy,
          onChange: ({ model, provider }) => onEdit({ model, provider })
        })),
      h('div', { className: 'fc-row' },
        onCancel ? h('button', { type: 'button', className: 'fc-btn', disabled: busy, onClick: onCancel }, 'Cancel') : null,
        h('button', {
          type: 'button', className: 'fc-btn primary', 'data-fc-generate-submit': '1',
          disabled: busy || !draft.prompt.trim(), title: 'Build and validate the graph (Ctrl+Enter)', onClick: submit
        }, h(Icon, { name: busy ? 'loading' : 'sparkle', spin: busy }), busy ? 'Building…' : flow ? 'Apply changes' : 'Build flow'))),
    busy ? h('div', { className: 'fc-generate-busy fc-row', 'data-fc-generate-status': '1', role: 'status' },
      h('span', null, generationStatus(generation.phase, generationElapsed(generation, now))),
      onStop ? h('button', {
        type: 'button', className: 'fc-btn', 'data-fc-generate-stop': '1', disabled: !generation.jobId,
        title: 'Stop this build; nothing is saved', onClick: onStop
      }, 'Stop') : null) : null,
    error ? h('div', { className: 'fc-generate-error', 'data-fc-generate-error': '1', role: 'alert' }, error) : null)
}

/** "$0.01" style price label; null when unknown. */
function formatPrice(price) {
  if (typeof price !== 'number' || !(price > 0)) return null
  return price < 0.1 ? `$${price.toFixed(price < 0.01 ? 4 : 3).replace(/0+$/, '')}` : `$${price.toFixed(2)}`
}

// ---------------------------------------------------------------- G7: settings from schema + chosen model
const MODEL_DRIVEN = ['size', 'n', 'duration', 'resolution', 'aspect_ratio', 'quality']

/** The model setting a node's `from_model` settings follow and the model in effect (value, else preset default). */
function modelSetting(spec, params = {}) {
  const fields = (spec && spec.params) || []
  const m = fields.find((f) => f.options_source && f.options_source !== 'messaging_channels')
  if (!m) return null
  const value = (params || {})[m.name]
  const auto = !!m.auto && isBlank(value) && isBlank(m.default)
  const mode = auto ? String((params || {})[m.auto] || 'cheapest') : ''
  const out = { param: m.name, model: !isBlank(value) ? String(value) : !isBlank(m.default) ? String(m.default) : '' }
  return m.auto ? { ...out, auto, mode } : out
}

/** The model a blank `auto` setting runs with: cheapest (mode 'best': priciest) priced option, else the first.
 *  Mirrors engine presets.auto_pick. Pure, tested. */
function autoPick(options, mode = 'cheapest') {
  const list = (Array.isArray(options) ? options : []).filter((o) => o && typeof o.value === 'string' && o.value)
  const priced = list.filter((o) => typeof o.price === 'number' && Number.isFinite(o.price))
  const better = mode === 'best' ? (a, b) => b.price > a.price : (a, b) => b.price < a.price
  if (priced.length) return priced.reduce((a, b) => (better(a, b) ? b : a))
  return list[0] || null
}

/**
 * Setting spec (+ the chosen model's field from GET /x/options&model=) → what the inspector renders. Pure, tested.
 * Model choices win over the schema; model bounds only narrow the schema's.
 */
function fieldControl(spec, mf) {
  const m = mf && typeof mf === 'object' ? mf : null
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const ctl = { kind: spec.kind, options: [], fromModel: false, min: num(spec.min), max: num(spec.max),
    minExclusive: !!spec.min_exclusive, maxExclusive: !!spec.max_exclusive, integer: !!spec.integer,
    step: num(spec.step), modelDefault: m && !isBlank(m.default) ? String(m.default) : null,
    description: m && m.description ? String(m.description) : null }
  if (m && Array.isArray(m.options) && m.options.length && spec.kind !== 'multiselect' && spec.kind !== 'boolean') {
    ctl.kind = 'select'
    ctl.fromModel = true
    ctl.options = m.options.filter((o) => o && o.value !== undefined && o.value !== null).map((o) => ({
      value: String(o.value), label: String(o.label || o.value), raw: o.value,
      price: typeof o.price === 'number' ? (formatPrice(o.price) || '$0') + (o.unit || '') : null
    }))
  } else if (spec.kind === 'select' || spec.kind === 'multiselect') {
    ctl.options = (spec.options || []).map((o) => ({ value: String(o), label: String(o), raw: o, price: null }))
  }
  if (m) {
    if (num(m.min) !== null && (ctl.min === null || m.min > ctl.min)) { ctl.min = m.min; ctl.minExclusive = false }
    if (num(m.max) !== null && (ctl.max === null || m.max < ctl.max)) { ctl.max = m.max; ctl.maxExclusive = false }
    if (m.integer) ctl.integer = true
    if (ctl.step === null && num(m.step) !== null) ctl.step = m.step
  }
  // A free text setting that only takes numbers (e.g. duration: number | "auto") gets the number field once bounded.
  if (ctl.kind === 'text' && spec.numeric && (ctl.min !== null || ctl.max !== null)) ctl.kind = 'number'
  ctl.hint = rangeHint(ctl)
  return ctl
}

/** "1–4 · whole numbers", "> 0", "≤ 10"; empty without bounds. Pure, tested. */
function rangeHint(ctl) {
  const f = (v) => String(+v.toFixed(6))
  const parts = []
  if (ctl.min !== null && ctl.max !== null && !ctl.minExclusive && !ctl.maxExclusive) parts.push(`${f(ctl.min)}–${f(ctl.max)}`)
  else {
    if (ctl.min !== null) parts.push(`${ctl.minExclusive ? '>' : '≥'} ${f(ctl.min)}`)
    if (ctl.max !== null) parts.push(`${ctl.maxExclusive ? '<' : '≤'} ${f(ctl.max)}`)
  }
  if (ctl.integer && parts.length) parts.push('whole numbers')
  if (ctl.step !== null && !ctl.integer && parts.length) parts.push(`steps of ${f(ctl.step)}`)
  return parts.join(' · ')
}

/** Why a number does not fit the bounds, or null. Text values are left to the tool. Pure, tested. */
function numberIssue(value, ctl) {
  if (isBlank(value) || typeof value !== 'number') return null
  const outside = (ctl.min !== null && (ctl.minExclusive ? value <= ctl.min : value < ctl.min)) ||
    (ctl.max !== null && (ctl.maxExclusive ? value >= ctl.max : value > ctl.max))
  if (outside) return `Outside the allowed range (${ctl.hint}).`
  if (ctl.integer && !Number.isInteger(value)) return 'Must be a whole number.'
  return null
}

/** Select value → stored value: schema enums keep their JSON type, numeric settings store numbers. Pure, tested. */
function choiceValue(raw, spec, ctl) {
  if (raw === '') return null
  const o = ctl.options.find((x) => x.value === raw)
  if (o && !ctl.fromModel) return o.raw
  if ((spec.kind === 'number' || spec.numeric) && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

/** Multi-select value (list, or legacy JSON text) → string values. Pure, tested. */
function multiValues(value) {
  let v = value
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return [] }
  }
  return Array.isArray(v) ? v.map(String) : []
}

/** Media field value → clean string[] (scalar, array or legacy JSON list). Pure, tested. */
function mediaValues(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
  if (typeof value !== 'string' || !value.trim()) return []
  const text = value.trim()
  if (text.startsWith('[')) {
    try { return mediaValues(JSON.parse(text)) } catch { /* a plain path/URL is not JSON */ }
  }
  return [text]
}

/** Browse result → stored media value: replace a scalar, append uniquely to a bounded list. Pure, tested. */
function addMediaPath(value, path, { multiple = false, maxItems = null } = {}) {
  const clean = String(path || '').trim()
  if (!multiple) return clean || value
  const items = mediaValues(value)
  if (!clean || items.includes(clean) || (Number.isFinite(maxItems) && items.length >= maxItems)) return items
  return [...items, clean]
}

/** Toggle one choice; the result keeps the options' order and raw types. Pure, tested. */
function toggleChoice(value, option, options) {
  const have = new Set(multiValues(value))
  if (have.has(option.value)) have.delete(option.value)
  else have.add(option.value)
  return options.filter((o) => have.has(o.value)).map((o) => o.raw)
}

/** G7b: show a model setting? `show_when` = {other setting: value | [values]} from the model list. Pure, tested. */
function extraVisible(p, values) {
  const cond = p && p.show_when
  if (!cond || typeof cond !== 'object') return true
  return Object.entries(cond).every(([k, want]) => {
    const have = values ? values[k] : undefined
    const list = (Array.isArray(want) ? want : [want]).map(String)
    return !isBlank(have) && list.includes(String(have))
  })
}

/** Values in effect for `show_when`: what the node stores, else each setting's model default. Pure, tested. */
function extraValues(extras, params = {}) {
  const out = {}
  for (const p of extras || []) if (!isBlank(p.default)) out[p.name] = p.default
  for (const [k, v] of Object.entries(params || {})) if (!isBlank(v)) out[k] = v
  return out
}

/** A model setting from GET /x/options&model= → [inspector spec, model field] for ParamField. Pure, tested. */
function extraSpec(p) {
  const kind = { boolean: 'boolean', number: 'number', json: 'json', media: 'media', media_list: 'media_list' }[p.kind] || 'text'
  const spec = { name: p.name, kind, label: p.label || p.name, default: p.default === undefined ? null : p.default, extra: true }
  if (p.media_kind) spec.media_kind = p.media_kind
  for (const key of ['min_items', 'max_items']) if (p[key] !== undefined) spec[key] = p[key]
  if (p.description) spec.description = p.description
  if (p.required) spec.required = true
  if (p.numeric || p.kind === 'number') spec.numeric = true
  return [spec, p]
}

/** The value each model-driven setting has in effect: node value, else spec default, else the model's default. */
function effectiveValues(spec, params = {}, modelFields = {}) {
  const out = {}
  const fields = new Map(((spec && spec.params) || []).map((f) => [f.name, f]))
  for (const name of MODEL_DRIVEN) {
    const v = (params || {})[name]
    const f = fields.get(name)
    const mf = modelFields[name]
    if (!isBlank(v)) out[name] = v
    else if (f && !isBlank(f.default)) out[name] = f.default
    else if (mf && !isBlank(mf.default)) out[name] = mf.default
  }
  return out
}

/**
 * Cost data from the model list (engine/options.py model_cost) × the node's settings → {label, lines} or null.
 * Only multiplies what the list states (per image × n, per second × duration, per clip, per run). Pure, tested.
 */
function estimateCost(cost, values = {}) {
  if (!cost || typeof cost !== 'object') return null
  const money = (v) => formatPrice(v) || '$0'
  const unit = { image: 'image', second: 'second', video: 'clip', run: 'run' }[cost.unit] || 'run'
  const lines = []
  let label = null
  const byValue = cost.by ? values[cost.by] : undefined
  let rate = cost.by && cost.prices && !isBlank(byValue) ? cost.prices[String(byValue)] : undefined
  if (typeof rate !== 'number') rate = typeof cost.base === 'number' ? cost.base : null
  const minimum = typeof cost.minimum === 'number' ? cost.minimum : 0
  if (rate !== null) {
    const raw = cost.times ? values[cost.times] : 1
    const times = cost.times === 'n' && isBlank(raw) ? 1 : Number(raw)
    if (Number.isFinite(times) && times > 0) {
      const total = Math.max(rate * times, minimum)
      label = `≈ ${money(total)}`
      const per = `${money(rate)} per ${unit}${cost.by && !isBlank(byValue) ? ` (${cost.by} ${byValue})` : ''}`
      lines.push(times === 1 && cost.unit !== 'second' ? per : `${per} × ${times}${cost.unit === 'second' ? ' s' : ''} = ${money(rate * times)}`)
    } else {
      label = `${money(rate)}/${cost.unit === 'second' ? 's' : unit}`
      lines.push(`${money(rate)} per ${unit}; the total depends on ${cost.times}.`)
    }
  } else if (cost.prices) {
    const all = Object.values(cost.prices).filter((v) => typeof v === 'number' && v > 0)
    if (all.length) {
      label = `from ${money(Math.min(...all))}`
      lines.push(`From ${money(Math.min(...all))} per ${unit}, depending on ${cost.by}.`)
    }
  }
  if (Array.isArray(cost.range) && cost.range.length === 2) {
    lines.push(`${money(cost.range[0])}–${money(cost.range[1])} per ${unit} depending on the model settings; the estimate uses the model's default variant.`)
  }
  if (minimum) {
    lines.push(`At least ${money(minimum)} per run.`)
    if (!label) label = `≥ ${money(minimum)}`
  }
  if (cost.note) lines.push(String(cost.note))
  if (!label && !lines.length) return null
  lines.push('List price from the model list (USD); the provider bills the final amount.')
  return { label: label || 'see note', lines }
}

/** What Hermes' picker payload already knows about a model (per provider). Pure, tested. */
function llmPickerInfo(payload, provider, model) {
  const rows = (payload && Array.isArray(payload.providers)) ? payload.providers : []
  const row = rows.find((r) => r.slug === provider) || {}
  const price = (row.pricing || {})[model]
  const caps = (row.capabilities || {})[model]
  return {
    provider: row.name || provider || '', apiUrl: row.api_url || '',
    hermesPricing: price ? { input: price.input, output: price.output, cache: price.cache } : null,
    pricingPending: !!row.pricing_pending,
    caps: caps || null
  }
}

/** Rows for the LLM node's model info, merging Hermes' picker data with the provider's own catalog. Pure, tested. */
function llmInfoRows(info) {
  if (!info) return []
  const fmt = (n) => n >= 1000000 ? `${+(n / 1000000).toFixed(2)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n)
  const rows = []
  if (info.provider) rows.push(['Provider', info.provider])
  const pr = info.pricing
  if (pr && (pr.input !== null || pr.output !== null)) {
    rows.push(['Price', `$${pr.input} in / $${pr.output} out per Mtok`])
  } else if (info.hermesPricing) {
    rows.push(['Price', `${info.hermesPricing.input || '?'} in / ${info.hermesPricing.output || '?'} out per Mtok`])
  } else if (info.pricingPending) rows.push(['Price', 'loading from the provider…'])
  else if (info.found === false && !info.hermesPricing) rows.push(['Price', 'not published by this provider'])
  if (info.context_length) rows.push(['Context window', fmt(info.context_length) + ' tokens'])
  if (info.max_output_tokens) rows.push(['Max output', fmt(info.max_output_tokens) + ' tokens'])
  if (info.efforts && info.efforts.length) rows.push(['Reasoning', info.efforts.join(' · ')])
  else if (info.caps && info.caps.reasoning === false) rows.push(['Reasoning', 'not supported'])
  else if (info.caps && info.caps.reasoning) rows.push(['Reasoning', 'supported'])
  if (info.input_modalities && info.input_modalities.length) rows.push(['Input', info.input_modalities.join(', ')])
  return rows
}

/** Cost hint for an LLM node from the provider's token price; upper bound when max_tokens is set. Pure, tested. */
function estimateLlmCost(info, params = {}) {
  const pr = info && info.pricing
  if (!pr || pr.output === null || pr.output === undefined) {
    if (info && info.hermesPricing && info.hermesPricing.output) return { label: `out ${info.hermesPricing.output}/M`, lines: ['Hermes picker price per million output tokens.'] }
    return null
  }
  const money = (v) => formatPrice(v) || '$0'
  const lines = [`$${pr.input} per M input tokens, $${pr.output} per M output tokens.`]
  if (pr.cache_read !== undefined && pr.cache_read !== null) lines.push(`Cached input: $${pr.cache_read} per M tokens.`)
  const max = Number(params.max_tokens)
  if (Number.isFinite(max) && max > 0) {
    const upper = (pr.output * max) / 1000000
    lines.push(`At most ${money(upper)} output cost with max tokens ${max} (input tokens are extra).`)
    return { label: `≤ ${money(upper)}`, lines }
  }
  return { label: `out ${money(pr.output)}/M`, lines }
}

// Provider catalog info for the LLM node (GET /x/llm-info); Hermes' picker data comes from the gateway RPC.
const llmInfoCache = new Map()
const llmInfoListeners = new Set()
function useLlmInfo(api, params, enabled = true) {
  const [, bump] = useReducer((x) => x + 1, 0)
  const [payload, setPayload] = useState(SHARED.modelOptionsData || null)
  useEffect(() => {
    llmInfoListeners.add(bump)
    return () => { llmInfoListeners.delete(bump) }
  }, [])
  useEffect(() => {
    if (!enabled) return undefined
    let alive = true
    loadModelOptions(false).then((d) => {
      SHARED.modelOptionsData = d
      if (alive) setPayload(d)
    }).catch(() => {})
    return () => { alive = false }
  }, [enabled])
  const provider = !isBlank(params.provider) ? String(params.provider) : (payload && payload.provider) || ''
  const model = !isBlank(params.model) ? String(params.model) : (payload && payload.model) || ''
  const picker = llmPickerInfo(payload, provider, model)
  const key = model ? `${provider}\u0000${model}\u0000${picker.apiUrl}` : ''
  useEffect(() => {
    if (!enabled || !key || !api || typeof api.llmInfo !== 'function' || llmInfoCache.has(key)) return
    const entry = { data: null, error: null }
    llmInfoCache.set(key, entry)
    api.llmInfo(provider, model, picker.apiUrl, picker.provider).then((d) => { entry.data = d || {} },
      (e) => { entry.error = parseRestError(e).message })
      .finally(() => llmInfoListeners.forEach((fn) => fn()))
  }, [key])
  if (!enabled) return null
  const hit = key ? llmInfoCache.get(key) : null
  const catalog = hit && hit.data && hit.data.found ? hit.data.info : null
  const found = hit && hit.data ? hit.data.found : null
  return { model, provider, found, error: hit ? hit.error : null,
    loading: !!key && !!hit && !hit.data && !hit.error,
    ...picker, ...(catalog || {}) }
}

// One request per (node type, model) shared by the inspector and the node cards; the engine caches the list call.
const modelInfoCache = new Map()
const modelInfoListeners = new Set()
function loadModelInfo(api, type, param, model, refresh = false) {
  const key = `${type}\u0000${param}\u0000${model}`
  const hit = modelInfoCache.get(key)
  if (hit && !refresh) return hit.promise
  const entry = { promise: null, data: null, error: null }
  entry.promise = api.options(type, param, refresh, model)
  modelInfoCache.set(key, entry)
  entry.promise.then((d) => { entry.data = d || {} }, (e) => { entry.error = parseRestError(e).message })
    .finally(() => modelInfoListeners.forEach((fn) => fn()))
  return entry.promise
}
const autoModelCache = new Map()
/** '' until the node's model list arrived; then the auto-picked id (listeners re-render the cards). */
function autoModel(api, type, param, mode = 'cheapest') {
  const key = `${type}\u0000${param}\u0000${mode}`
  if (autoModelCache.has(key)) return autoModelCache.get(key)
  autoModelCache.set(key, '')
  if (api && typeof api.options === 'function') {
    loadToolOptions(api, type, param).then((d) => {
      const pick = autoPick(d && d.options, mode)
      if (pick) {
        autoModelCache.set(key, pick.value)
        modelInfoListeners.forEach((fn) => fn())
      }
    }, () => { autoModelCache.delete(key) })
  }
  return ''
}
function useModelInfo(api, nodeType, spec, params, { fetch = true } = {}) {
  let ms = modelSetting(spec, params)
  if (ms && ms.auto && fetch) ms = { ...ms, model: autoModel(api, nodeType, ms.param, ms.mode) }
  const key = ms && ms.model ? `${nodeType}\u0000${ms.param}\u0000${ms.model}` : ''
  const [, bump] = useReducer((x) => x + 1, 0)
  useEffect(() => {
    modelInfoListeners.add(bump)
    return () => { modelInfoListeners.delete(bump) }
  }, [])
  useEffect(() => {
    if (fetch && key && api && typeof api.options === 'function' && !modelInfoCache.has(key)) {
      loadModelInfo(api, nodeType, ms.param, ms.model).catch(() => {})
    }
  }, [key, fetch])
  if (!key) return null
  const hit = modelInfoCache.get(key)
  if (!hit) return fetch ? { model: ms.model, data: null, error: null, loading: true } : null
  return { model: ms.model, data: hit.data, error: hit.error, loading: !hit.data && !hit.error }
}

/** Options from GET /x/options → picker groups [{slug, name, models, labels, prices}], cheapest group first. Pure, tested. */
function optionGroups(options) {
  const byGroup = new Map()
  for (const o of Array.isArray(options) ? options : []) {
    if (!o || typeof o.value !== 'string') continue
    const g = String(o.group || 'Other')
    if (!byGroup.has(g)) byGroup.set(g, { slug: g, name: g, models: [], labels: {}, prices: {}, hints: {} })
    const grp = byGroup.get(g)
    grp.models.push(o.value)
    if (o.label && o.label !== o.value) grp.labels[o.value] = o.label
    if (typeof o.price === 'number') grp.prices[o.value] = formatPrice(o.price) + (o.unit || '')
    if (o.description) grp.hints[o.value] = o.description
  }
  return [...byGroup.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const optionsCache = new Map()
function loadToolOptions(api, type, param, refresh = false) {
  const key = `${type}\u0000${param}`
  if (!refresh && optionsCache.has(key)) return optionsCache.get(key)
  const p = api.options(type, param, refresh)
  optionsCache.set(key, p)
  p.catch(() => {
    if (optionsCache.get(key) === p) optionsCache.delete(key)
  })
  return p
}

/** Copy and refresh policy for model choices versus a fixed message recipient. */
function toolOptionCopy(type, param) {
  const recipient = type === 'output.send_message' && param === 'target'
  return recipient ? {
    kind: 'recipient', refreshOnOpen: true, blank: 'Choose recipient…',
    placeholder: 'Search recipients…', loading: 'Loading recipients…',
    empty: 'No recipients available. Reload the list or enter a fixed platform:recipient target.',
    noMatch: 'No recipient matches.', clear: 'No recipient selected', clearHint: 'required',
  } : {
    kind: 'model', refreshOnOpen: false, blank: 'Tool default',
    placeholder: 'Search models…', loading: 'Loading models…',
    empty: 'The tool listed no models.', noMatch: 'No model matches.',
    clear: 'Tool default', clearHint: 'leave empty',
  }
}

/** Searchable model or recipient choices. An explicit fixed value may also be entered. */
function ToolOptionPicker({ api, type, param, value, fallback, fallbackPrefix = 'Default', onChange }) {
  const copy = toolOptionCopy(type, param)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const wrapRef = useRef(null)
  const load = (refresh) => {
    if (!api || typeof api.options !== 'function') return
    setLoading(true)
    setError(null)
    loadToolOptions(api, type, param, refresh).then((d) => setData(d || {}), (e) => setError(parseRestError(e).message)).finally(() => setLoading(false))
  }
  useEffect(() => {
    if (open && !loading && (copy.refreshOnOpen || !data)) load(copy.refreshOnOpen)
    if (!open) return undefined
    const away = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [open])
  const groups = useMemo(() => optionGroups(data && data.options), [data])
  const { groups: shown, hidden } = useMemo(() => filterModelGroups(groups, query), [groups, query])
  const pick = (v) => {
    onChange(v)
    setOpen(false)
    setQuery('')
  }
  const typed = query.trim()
  const exact = typed && groups.some((g) => g.models.includes(typed))
  const first = shown.length ? shown[0].models[0] : typed || null
  const label = isBlank(value)
    ? h('span', { className: 'fc-muted' }, fallback ? `${fallbackPrefix} · ${fallback}` : copy.blank)
    : h('span', null, String(value))
  const priceOf = (v) => {
    for (const g of groups) if (v in g.prices) return g.prices[v]
    return null
  }
  return h('div', { className: 'fc-model', ref: wrapRef, 'data-fc-option-kind': copy.kind },
    h('button', { type: 'button', className: `fc-input fc-model-btn${open ? ' open' : ''}`, 'aria-haspopup': 'listbox', 'aria-expanded': open, onClick: () => setOpen(!open) },
      label, !isBlank(value) && priceOf(value) ? h('span', { className: 'fc-model-prov' }, priceOf(value)) : null, h(Icon, { name: 'chevron-down' })),
    open ? h('div', { className: 'fc-model-pop', role: 'listbox' },
      h('div', { className: 'fc-model-search' },
        h(Icon, { name: 'search' }),
        h('input', {
          autoFocus: true, value: query, placeholder: copy.placeholder,
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
            if (e.key === 'Enter' && first) { e.preventDefault(); pick(first) }
          }
        }),
        h('button', { type: 'button', className: 'fc-btn ghost icon', title: 'Reload the list', onClick: () => load(true) }, h(Icon, { name: 'refresh', spin: loading }))),
      h('div', { className: 'fc-model-list' },
        h('div', { className: `fc-model-item${isBlank(value) ? ' active' : ''}`, onClick: () => pick('') },
          h('span', null, fallback ? `${fallbackPrefix} · ${fallback}` : copy.clear), h('span', { className: 'fc-model-prov' }, copy.clearHint)),
        typed && !exact ? h('div', { className: 'fc-model-item', onClick: () => pick(typed) }, h('span', null, `Use “${typed}”`), h('span', { className: 'fc-model-prov' }, 'custom')) : null,
        loading && !data ? h('div', { className: 'fc-help fc-model-note' }, copy.loading) : null,
        error ? h('div', { className: 'fc-help fc-bad fc-model-note' }, `Could not load the list: ${error}`) : null,
        data && !shown.length ? h('div', { className: 'fc-help fc-model-note' }, query ? copy.noMatch : copy.empty) : null,
        shown.map((g) => h('div', { key: g.slug, className: 'fc-model-group' },
          h('div', { className: 'fc-model-head' }, g.name, h('span', { className: 'fc-model-count' }, String(g.models.length))),
          g.models.map((m) => h('div', {
            key: m, title: g.hints[m] ? `${m}\n\n${g.hints[m]}` : m,
            className: `fc-model-item${m === value ? ' active' : ''}`,
            onClick: () => pick(m)
          }, h('span', null, g.labels[m] || m), g.prices[m] ? h('span', { className: 'fc-model-prov' }, g.prices[m]) : null)))),
        hidden > 0 ? h('div', { className: 'fc-help fc-model-note' }, `${hidden} more — type to narrow the list.`) : null)) : null)
}

/** One URL/path row of a media list. Keeps the typed text (spaces, an emptied field) as a draft while focused,
 *  so typing never fights the trimmed stored list; an emptied row goes away on blur. */
function MediaRow({ item, index, existing, onSet, onRemove }) {
  const [draft, setDraft] = useState(null)
  const shown = draft !== null ? draft : item
  return h('div', { className: 'fc-browse fc-media-row', 'data-fc-media-item': index },
    h('input', { className: 'fc-input', value: shown, placeholder: 'https://… or C:\\path\\image.png', title: item || undefined,
      onChange: (e) => {
        setDraft(e.target.value)
        onSet(e.target.value)
      },
      onBlur: () => {
        if (draft !== null && !draft.trim() && existing) onRemove()
        setDraft(null)
      } }),
    existing ? h('button', {
      type: 'button', className: 'fc-btn ghost icon', title: 'Remove this file/URL', 'data-fc-media-remove': index,
      onClick: onRemove
    }, h(Icon, { name: 'close' })) : null)
}

/** The image list of a preset follows the chosen model's own limit (catalog ``max_images``; live 07.11.: MoGe 2
 *  takes one image, the field said "0 / 4"). ``count`` = images the node has now (wired + listed). */
function fitImageLimit(field, maxImages, modelName, count) {
  if (!field || field.kind !== 'media_list' || !Number.isFinite(maxImages)) return { field, note: null }
  const toolMax = typeof field.max_items === 'number' ? field.max_items : Infinity
  if (maxImages >= toolMax) return { field, note: null }
  const label = modelName || 'This model'
  const over = count > maxImages
  return {
    field: { ...field, max_items: maxImages },
    note: { bad: over, text: `${label} takes ${maxImages} image${maxImages === 1 ? '' : 's'}${over
      ? ` — only the first ${maxImages === 1 ? 'one' : maxImages} of ${count} will be used. Pick a multi-view model to use them all.`
      : '.'}` }
  }
}

/** Items a wire delivers, from the last run when known (a Collect node's list), else 1. */
function wiredItemCount(run, edge) {
  const st = run && run.nodes ? run.nodes[edge.from.node] : null
  const out = st && st.outputs ? st.outputs[edge.from.port] : undefined
  return Array.isArray(out) ? out.length : 1
}

function formatJsonText(raw) {
  const text = String(raw)
  if (text.length > 1048576) throw new Error('JSON input exceeds 1 MiB')
  const parsed = JSON.parse(text)
  const pending = [[parsed, 0]]
  let count = 0
  while (pending.length) {
    const [value, depth] = pending.pop()
    if (++count > 50000 || depth > 32) throw new Error('JSON exceeds 32 levels or 50,000 values')
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('JSON numbers must be finite')
    if (typeof value === 'string') {
      for (const ch of value) if (ch.length === 1 && /[\uD800-\uDFFF]/.test(ch)) throw new Error('JSON text must be valid Unicode')
    }
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) pending.push([child, depth + 1])
    }
  }
  // Lexical whitespace formatting: never stringify parsed numbers, which would
  // corrupt integer/decimal lexemes before the user even runs the node.
  let out = '', depth = 0, quoted = false, escaped = false
  const indent = () => '  '.repeat(depth)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
    } else if (ch === '"') { quoted = true; out += ch }
    else if (/\s/.test(ch)) continue
    else if (ch === '{' || ch === '[') {
      out += ch
      let j = i + 1
      while (/\s/.test(text[j] || '') && j < text.length) j++
      if (text[j] === (ch === '{' ? '}' : ']')) { out += text[j]; i = j }
      else { depth++; out += '\n' + indent() }
    } else if (ch === '}' || ch === ']') { depth--; out += '\n' + indent() + ch }
    else if (ch === ',') out += ',\n' + indent()
    else if (ch === ':') out += ': '
    else out += ch
  }
  return out
}

function JsonInputEditor({ value, onChange }) {
  const raw = value === undefined ? '{}' : value === null ? 'null' : typeof value === 'string' ? value : JSON.stringify(value)
  const checked = useMemo(() => {
    try { return { formatted: formatJsonText(raw), error: null } }
    catch (e) { return { formatted: null, error: String(e.message || e) } }
  }, [raw])
  return h('div', { className: 'fc-json-editor' },
    h('textarea', { className: 'fc-input fc-mono', rows: 6, value: raw, 'aria-label': 'JSON source', spellCheck: false, onChange: (e) => onChange(e.target.value) }),
    h('div', { className: 'fc-row' },
      h('button', { type: 'button', className: 'fc-btn', disabled: !!checked.error, onClick: () => onChange(checked.formatted) }, 'Format JSON'),
      h('span', { className: checked.error ? 'fc-help fc-bad' : 'fc-help', role: 'status' }, checked.error || 'Valid JSON · server validates size and types on run')),
    h('div', { className: 'fc-help' }, 'Formatting preserves numeric text. Reserved $large / $media keys become inert data when run.'),
    checked.error ? null : h('details', null, h('summary', null, 'JSON preview'), h('pre', { className: 'fc-pre' }, checked.formatted)))
}

function safeMarkdownInline(text) {
  const parts = [], pattern = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\[([^\]]+)\]\(([^)\s]+)\))/g
  let cursor = 0, match
  while ((match = pattern.exec(text))) {
    parts.push(text.slice(cursor, match.index))
    if (match[1]) parts.push(h('code', { key: match.index }, match[2]))
    else if (match[3]) parts.push(h('strong', { key: match.index }, match[4]))
    else {
      let href = null
      if (text[match.index - 1] !== '!' && /^https?:\/\//i.test(match[7]) && !/[\u0000-\u0020\u007f]/.test(match[7])) {
        try { const url = new URL(match[7]); if (url.protocol === 'http:' || url.protocol === 'https:') href = url.href } catch {}
      }
      parts.push(href ? h('a', { key: match.index, href, target: '_blank', rel: 'noopener noreferrer' }, match[6]) : match[0])
    }
    cursor = match.index + match[0].length
  }
  parts.push(text.slice(cursor))
  return parts
}

function SafeMarkdown({ text }) {
  const original = String(text == null ? '' : text)
  const lines = original.slice(0, 262144).replace(/\r\n?/g, '\n').split('\n').slice(0, 5000)
  const blocks = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    if (/^\s*```/.test(line)) {
      const code = []; i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++])
      if (i < lines.length) i++
      blocks.push(h('pre', { key: i, className: 'fc-pre' }, h('code', null, code.join('\n')))); continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) { blocks.push(h('h' + heading[1].length, { key: i }, safeMarkdownInline(heading[2]))); i++; continue }
    const bullet = /^\s*(?:[-+*]|\d+\.)\s+/.exec(line)
    if (bullet) {
      const ordered = /^\s*\d+\./.test(line), items = []
      while (i < lines.length && /^\s*(?:[-+*]|\d+\.)\s+/.test(lines[i]) && /^\s*\d+\./.test(lines[i]) === ordered) {
        items.push(h('li', { key: i }, safeMarkdownInline(lines[i].replace(/^\s*(?:[-+*]|\d+\.)\s+/, '')))); i++
      }
      blocks.push(h(ordered ? 'ol' : 'ul', { key: i }, items)); continue
    }
    const paragraph = [line]; i++
    while (i < lines.length && lines[i].trim() && !/^(?:#{1,6}\s|\s*```|\s*(?:[-+*]|\d+\.)\s)/.test(lines[i])) paragraph.push(lines[i++])
    blocks.push(h('p', { key: i, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, safeMarkdownInline(paragraph.join('\n'))))
  }
  let lineCount = 1
  for (let i = 0; i < original.length && lineCount <= 5000; i++) {
    const ch = original.charCodeAt(i)
    if (ch === 10) lineCount++
    else if (ch === 13) { lineCount++; if (original.charCodeAt(i + 1) === 10) i++ }
  }
  const truncated = original.length > 262144 || lineCount > 5000
  return h('div', { className: 'fc-markdown', 'data-fc-safe-markdown': true }, blocks,
    truncated ? h('div', { className: 'fc-help' }, 'Preview truncated at 256 Ki characters / 5,000 lines; source remains unchanged.') : null)
}

function MarkdownEditor({ value, onChange, placeholder }) {
  const [preview, setPreview] = useState(false)
  const raw = value == null ? '' : String(value)
  return h('div', { className: 'fc-markdown-editor' },
    h('div', { className: 'fc-row' },
      h('button', { type: 'button', className: 'fc-btn', 'aria-pressed': !preview, onClick: () => setPreview(false) }, 'Edit'),
      h('button', { type: 'button', className: 'fc-btn', 'aria-pressed': preview, onClick: () => setPreview(true) }, 'Preview Markdown')),
    preview ? h(SafeMarkdown, { text: raw }) : h('textarea', { className: 'fc-input', rows: 6, value: raw, placeholder, onChange: (e) => onChange(e.target.value) }),
    preview ? h('div', { className: 'fc-help' }, 'Safe preview: HTML is text; images are not loaded. Only http/https links are clickable.') : null)
}

function ParamField({ spec, value, source, types, onChange, onChangeMany, params, port, api, nodeType, onBrowse, modelField, modelName, note, flowId }) {
  const placeholder = spec.default !== null && spec.default !== undefined && spec.default !== '' ? `default: ${typeof spec.default === 'string' ? spec.default : JSON.stringify(spec.default)}` : ''
  const ctl = fieldControl(spec, modelField)
  const extra = []
  const info = paramInfo(spec, { port })
  if (ctl.fromModel) info.push(`Choices from the model list for ${modelName}.`)
  if (ctl.description && ctl.description !== spec.description) info.push(ctl.description)
  if (ctl.hint) info.push(`Allowed: ${ctl.hint}.`)
  let control
  if (source && spec.kind !== 'media_list') control = h('div', { className: 'fc-linked' }, h(Icon, { name: 'link' }), 'from', h('b', null, source))
  else if (spec.picker === 'flow') control = h(FlowPicker, { api, value, ownId: flowId, onChange })
  else if (spec.kind === 'media' || spec.kind === 'media_list') {
    const multiple = spec.kind === 'media_list'
    const items = multiple ? mediaValues(value) : []
    const maxItems = typeof spec.max_items === 'number' ? spec.max_items : null
    const pick = async () => {
      if (!onBrowse || (maxItems !== null && items.length >= maxItems)) return
      const picked = await onBrowse(spec.media_kind || 'auto')
      if (picked) onChange(multiple ? addMediaPath(items, picked, { multiple: true, maxItems }) : picked)
    }
    const browseButton = onBrowse ? h('button', {
      type: 'button', className: 'fc-btn', 'data-fc-media-browse': spec.name,
      disabled: multiple && maxItems !== null && items.length >= maxItems,
      title: multiple ? 'Add a local file to this list' : 'Choose a local file', onClick: pick
    }, h(Icon, { name: 'folder-opened' }), multiple ? 'Add file…' : 'Browse…') : null
    if (!multiple) {
      control = h('div', { className: 'fc-browse', 'data-fc-media': spec.name },
        h('input', { className: 'fc-input', value: value == null ? '' : String(value),
          placeholder: placeholder || 'https://… or C:\\path\\image.png', title: value ? String(value) : undefined,
          onChange: (e) => onChange(e.target.value === '' ? null : e.target.value) }), browseButton)
    } else {
      const remove = (index) => { const next = [...items]; next.splice(index, 1); onChange(next.length ? next : null) }
      const row = (item, index) => h(MediaRow, {
        key: `row-${index}`, item, index, existing: index < items.length,
        onSet: (text) => { const next = setMediaItem(items, index, text); if (next !== items) onChange(next) },
        onRemove: () => remove(index)
      })
      control = h('div', { className: 'fc-media-list', 'data-fc-media': spec.name, 'data-fc-media-count': items.length },
        source ? h('div', { className: 'fc-linked', title: 'Wired images are added after the files/URLs below' }, h(Icon, { name: 'link' }), 'also from', h('b', null, source)) : null,
        items.map((item, index) => row(item, index)),
        maxItems === null || items.length < maxItems ? row('', items.length) : null,
        h('div', { className: 'fc-row' }, browseButton,
          h('span', { className: 'fc-help' }, `${items.length}${maxItems !== null ? ` / ${maxItems}` : ''} file${(maxItems !== null ? maxItems : items.length) === 1 ? '' : 's'}`)))
    }
  } else if (spec.kind === 'textarea') {
    control = nodeType === 'input.text' || nodeType === 'note' ? h(MarkdownEditor, { value, onChange, placeholder }) : h('textarea', { className: 'fc-input', rows: 4, value: value === null || value === undefined ? '' : String(value), placeholder, onChange: (e) => onChange(e.target.value === '' ? null : e.target.value) })
  } else if (ctl.kind === 'number') {
    control = h('input', { className: 'fc-input', inputMode: 'decimal', 'data-fc-range': ctl.hint || undefined, value: value === null || value === undefined ? '' : String(value), placeholder: placeholder || ctl.hint, onChange: (e) => onChange(parseNumberInput(e.target.value)), onBlur: (e) => { const v = parseNumberInput(e.target.value, true); if (v !== value) onChange(v) } })
    if (ctl.hint) extra.push(h('div', { key: 'range', className: 'fc-help fc-range' }, ctl.hint))
    const issue = numberIssue(value, ctl)
    if (issue) extra.push(h('div', { key: 'bad', className: 'fc-help fc-bad' }, issue))
  } else if (spec.kind === 'boolean') {
    const checked = value === true || ((value === null || value === undefined) && spec.default === true)
    control = h('label', { className: 'fc-check' },
      h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) }),
      value === null || value === undefined ? `default (${spec.default === true ? 'on' : 'off'})` : value ? 'on' : 'off')
  } else if (ctl.kind === 'select') {
    const current = value === null || value === undefined ? '' : String(value)
    const listed = current === '' || ctl.options.some((o) => o.value === current)
    const blankLabel = !isBlank(spec.default) ? `default (${spec.default})`
      : ctl.modelDefault ? `model default (${ctl.modelDefault})` : ctl.fromModel ? 'tool default' : '—'
    control = h('select', {
      className: 'fc-input', value: current, 'data-fc-choices': ctl.fromModel ? 'model' : 'schema',
      onChange: (e) => onChange(choiceValue(e.target.value, spec, ctl))
    }, h('option', { value: '' }, blankLabel),
    listed ? null : h('option', { value: current }, `${current} (not listed)`),
    ctl.options.map((o) => h('option', { key: o.value, value: o.value }, o.price ? `${o.label} · ${o.price}` : o.label)))
    if (!listed) {
      extra.push(h('div', { key: 'unlisted', className: 'fc-help fc-bad' },
        ctl.fromModel ? `${modelName} does not list “${current}”. Pick one of its choices or leave the default.` : `“${current}” is not one of the choices.`))
    }
  } else if (ctl.kind === 'multiselect') {
    const have = new Set(multiValues(value))
    const max = typeof spec.max_items === 'number' ? spec.max_items : null
    const min = typeof spec.min_items === 'number' ? spec.min_items : null
    control = h('div', { className: 'fc-multi', role: 'group', 'data-fc-multi': spec.name },
      ctl.options.map((o) => {
        const on = have.has(o.value)
        return h('label', { key: o.value, className: `fc-chip${on ? ' on' : ''}` },
          h('input', {
            type: 'checkbox', checked: on, disabled: !on && max !== null && have.size >= max,
            onChange: () => {
              const next = toggleChoice(value, o, ctl.options)
              onChange(next.length ? next : null)
            }
          }), o.label)
      }))
    if (min !== null || max !== null) {
      const range = min !== null && max !== null ? (min === max ? `${min}` : `${min}–${max}`) : min !== null ? `at least ${min}` : `up to ${max}`
      extra.push(h('div', { key: 'count', className: `fc-help${have.size && min !== null && have.size < min ? ' fc-bad' : ''}` }, `Pick ${range}.`))
    }
  } else if (spec.options_source && (spec.kind === 'text' || spec.kind === 'textarea')) {
    const mode = spec.auto ? String((params && params[spec.auto]) || 'cheapest') : ''
    const picked = spec.auto && isBlank(spec.default) ? autoModel(api, nodeType, spec.name, mode) : ''
    control = h(ToolOptionPicker, {
      api, type: nodeType, param: spec.name, value, onChange,
      fallback: !isBlank(spec.default) ? String(spec.default) : picked || null,
      fallbackPrefix: spec.auto && isBlank(spec.default) ? `Auto (${mode})` : 'Default'
    })
  } else if (spec.kind === 'model') {
    control = h(ModelPicker, {
      model: value, provider: params ? params.provider : null,
      onChange: (next) => (onChangeMany ? onChangeMany({ model: next.model, provider: next.provider }) : onChange(next.model))
    })
  } else if (spec.kind === 'tool') {
    const prefixed = typeof value === 'string' && value ? `tool:${value}` : ''
    control = h(ToolSelect, { types, value: prefixed, missing: value, onChange: (t) => onChange(t ? t.replace(/^tool:/, '') : null) })
  } else if (spec.kind === 'json') {
    control = h(JsonInputEditor, { value: value === undefined ? spec.default : value, onChange })
  } else if (spec.browse === 'file' || spec.browse === 'folder') {
    const folder = spec.browse === 'folder'
    control = h('div', { className: 'fc-browse' },
      h('input', { className: 'fc-input', value: value === null || value === undefined ? '' : String(value), placeholder: placeholder || (folder ? 'C:\\path\\to\\folder' : 'C:\\path\\to\\file.png'), title: value ? String(value) : undefined,
        onChange: (e) => onChange(e.target.value === '' ? null : e.target.value) }),
      onBrowse ? h('button', {
        type: 'button', className: 'fc-btn', 'data-fc-browse': spec.name, title: folder ? 'Choose a folder' : 'Choose a file',
        onClick: async () => {
          const picked = await onBrowse(folder ? 'folder' : params ? params.kind : 'auto')
          if (picked) onChange(picked)
        }
      }, h(Icon, { name: 'folder-opened' }), 'Browse…') : null)
  } else {
    control = h('input', { className: 'fc-input', value: value === null || value === undefined ? '' : String(value), placeholder, onChange: (e) => onChange(spec.numeric ? parseNumberInput(e.target.value) : e.target.value === '' ? null : e.target.value), onBlur: spec.numeric ? (e) => { const v = parseNumberInput(e.target.value, true); if (v !== value) onChange(v) } : undefined })
  }
  return h('div', { className: 'fc-field', 'data-fc-field': spec.name },
    h('label', null, spec.label || spec.name, spec.required ? h('span', { className: 'fc-req' }, '*') : null,
      h(InfoTip, { lines: info })),
    control, source ? null : extra,
    note ? h('div', { className: `fc-help${note.bad ? ' fc-bad' : ''}`, 'data-fc-note': spec.name }, note.text) : null)
}

function FileChip({ media, onOpen }) {
  return h('div', { className: 'fc-file-chip' },
    h(Icon, { name: MEDIA_ICON[media.kind] || 'file' }),
    h('span', { className: 'fc-chip-name', title: media.path || media.file }, media.file || media.path),
    onOpen ? h('button', { className: 'fc-btn ghost icon', title: 'View large', onClick: onOpen }, h(Icon, { name: 'screen-full' })) : null,
    media.path ? h(CopyBtn, { text: media.path, title: 'Copy file path' }) : null)
}

function MediaView({ api, runId, nodeId, port, index, media, onOpenMedia }) {
  const kind = media.kind
  const wants = kind === 'image' || kind === 'audio' || kind === 'video'
  const data = useMedia(api, runId, nodeId, port, kind === 'image' ? 768 : 0, wants, index)
  const open = onOpenMedia ? () => onOpenMedia({ nodeId, port, index, path: media.path }) : null
  let body = null
  if (kind === 'image') {
    body = data && data.data_url
      ? h('img', { src: data.data_url, alt: media.file || '', className: open ? 'fc-zoomable' : '', title: open ? 'Click to view large' : undefined, onClick: open || undefined })
      : h('div', { className: 'fc-help' }, data && data.error ? 'Preview unavailable.' : 'Loading preview…')
  } else if (kind === 'audio' && data && data.data_url) body = h('audio', { controls: true, src: data.data_url })
  else if (kind === 'video' && data && data.data_url) body = h('video', { controls: true, src: data.data_url })
  else if (wants) {
    const msg = !data ? 'Loading preview…' : data.error ? 'Preview unavailable.' : 'Too large to preview here — open the file instead.'
    body = h('div', { className: 'fc-help' }, msg)
  }
  return h('div', { className: 'fc-media' }, body, h(FileChip, { media, onOpen: open }))
}

function OutputValue({ api, runId, nodeId, port, value, onOpenMedia }) {
  if (isMedia(value)) return h(MediaView, { api, runId, nodeId, port, index: 0, media: value.$media, onOpenMedia })
  if (Array.isArray(value) && value.length && value.every(isMedia)) {
    return h('div', null,
      value.slice(0, 6).map((m, i) => h(MediaView, { key: `${i}:${m.$media.file || ''}`, api, runId, nodeId, port, index: i, media: m.$media, onOpenMedia })),
      value.length > 6 ? h('div', { className: 'fc-help' }, `+ ${value.length - 6} more files — open the first one large and use ← → to see all`) : null)
  }
  if (value && typeof value === 'object' && value.$large) {
    return h('div', null,
      h('pre', { className: 'fc-pre' }, value.$large.preview || ''),
      h('div', { className: 'fc-help' }, `${value.$large.chars} characters — full value saved to ${value.$large.path}`))
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (typeof value === 'string' && port === 'text' && typeof sdk.Streamdown === 'function' && text.length <= 20000) {
    // Output text is model/tool output: only inline `data:` images may load, so `![](http…)` in it cannot ping a
    // remote server (a tracking pixel) from the app (U-17).
    return h('div', { className: 'fc-pre-wrap' }, h('div', { className: 'fc-md' }, h(sdk.Streamdown, { allowedImagePrefixes: ['data:'] }, text)), h(CopyBtn, { text }))
  }
  return h('div', { className: 'fc-pre-wrap' },
    h('pre', { className: 'fc-pre' }, text.length > 20000 ? `${text.slice(0, 20000)}…` : text),
    h(CopyBtn, { text }))
}

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

// ---------------------------------------------------------------- run log + welcome
function RunLog({ run, flow, types, open, onToggle, onSelect, timings, nameOf }) {
  const order = run ? (run.order && run.order.length ? run.order : Object.keys(run.nodes || {})) : []
  const byId = {}
  for (const n of flow.nodes) byId[n.id] = n
  return h('div', { className: `fc-log${open ? ' open' : ''}` },
    h('div', {
      className: 'fc-log-head', role: 'button', tabIndex: 0, 'aria-expanded': open ? 'true' : 'false',
      onClick: onToggle, onKeyDown: rowPress(onToggle)
    },
      h(Icon, { name: open ? 'chevron-down' : 'chevron-up' }),
      h('span', { className: 'fc-log-title' }, 'Run log'),
      run ? h(RunChip, { run }) : h('span', { className: 'fc-muted' }, 'No runs yet — press Run or Ctrl+Enter.'),
      h('span', { className: 'fc-grow' }),
      run && run.started_at ? h('span', { className: 'fc-muted' }, ago(run.started_at)) : null),
    open ? h('div', { className: 'fc-log-body' },
      run && run.status === 'invalid' ? (run.issues || []).map((i, k) => h('div', {
        key: `i${k}`, className: 'fc-log-row', role: 'button', tabIndex: 0,
        onClick: () => i.node && onSelect([i.node], 'replace'),
        onKeyDown: rowPress(() => i.node && onSelect([i.node], 'replace'))
      },
        h('span', { className: 'fc-badge', style: { '--fc-st': 'var(--ui-yellow)' } }, h(Icon, { name: 'warning' })),
        h('span', { className: 'fc-log-node' }, i.node ? nodeTitle(byId[i.node], types.byName) || i.node : 'Flow'),
        h('span', { className: 'fc-log-ms' }),
        h('span', { className: 'fc-log-msg bad' }, i.message))) : null,
      run && run.error && run.status !== 'invalid' ? h('div', { className: 'fc-log-row' },
        h('span', { className: 'fc-badge', style: { '--fc-st': 'var(--ui-red)' } }, h(Icon, { name: 'error' })),
        h('span', { className: 'fc-log-node' }, 'Run'), h('span', { className: 'fc-log-ms' }), h('span', { className: 'fc-log-msg bad' }, run.error)) : null,
      order.map((nid) => {
        const st = (run.nodes && run.nodes[nid]) || { status: 'queued' }
        return h('div', {
          key: nid, className: 'fc-log-row', role: 'button', tabIndex: 0,
          onClick: () => onSelect([nid], 'replace'),
          onKeyDown: rowPress(() => onSelect([nid], 'replace'))
        },
          h(StatusBadge, { state: st, showMs: false, nameOf, side: 'right', exp: byId[nid] ? expectedTime(types.byName[byId[nid].type], byId[nid], timings) : null,
            branchName: byId[nid] ? branchLabel(byId[nid], types.byName[byId[nid].type], st) : '' }),
          h('span', { className: 'fc-log-node' }, nodeTitle(byId[nid], types.byName) || nid),
          h('span', { className: 'fc-log-ms' }, formatMs(st.ms)),
          h('span', { className: `fc-log-msg${st.error ? ' bad' : ''}` }, st.error || st.reason || previewString(st.preview)))
      })) : null)
}

/**
 * Review U-8: every modal in this page goes through here — role=dialog + aria-modal, focus moves to the first field
 * on open, Tab/Shift+Tab stay inside, Escape cancels, and closing returns focus to whatever opened it. When the
 * opener itself is gone (a row of the Flows menu, which closed to open the dialog), focus goes back to the page
 * root: without that, the canvas shortcuts stop working after Cancel.
 */
function DialogFrame({ label, onCancel, onKeyDown, className = 'fc-modal-scrim', scrim, children }) {
  const ref = useRef(null)
  // The opener is read at render time: React's autoFocus on the first field runs during the commit, so by the time
  // an effect runs the dialog already owns the focus.
  const opener = useRef(document.activeElement)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const back = opener.current
    const root = el.closest ? el.closest('.fc-root') : null
    if (!el.contains(document.activeElement)) focusEl(el.querySelector('[data-fc-modal-focus]') || focusablesIn(el)[0])
    return () => {
      if (back && back !== document.body && back.isConnected) focusEl(back)
      else focusEl(root)
    }
  }, [])
  const onKey = (e) => {
    e.stopPropagation()   // canvas shortcuts (Delete, Ctrl+Z, …) must not fire behind a dialog
    if (e.defaultPrevented) return   // a field handled it already (the generate composer closes itself on Escape)
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
      return
    }
    if (e.key === 'Tab') {
      const el = ref.current
      const list = el ? focusablesIn(el) : []
      const inside = el && el.contains(document.activeElement) ? document.activeElement : null
      const next = trapFocus(list[0], list[list.length - 1], inside, e.shiftKey)
      if (next) {
        e.preventDefault()
        focusEl(next)
      }
      return
    }
    if (onKeyDown) onKeyDown(e)
  }
  return h('div', {
    ref, className, role: 'dialog', 'aria-modal': 'true', 'aria-label': label,
    tabIndex: -1, onKeyDown: onKey,
    onPointerDown: (e) => {
      if (e.target === e.currentTarget) onCancel()
    },
    ...(scrim || null)
  }, children)
}

/** "Save as template" (mode save) / rename + describe one of your templates (mode edit). G5. */
function renderJsonTreeNode(val, keyName, depth) {
  if (val === null || typeof val !== 'object') {
    const type = val === null ? 'null' : typeof val;
    const strVal = val === null ? 'null' : typeof val === 'string' ? JSON.stringify(val) : String(val);
    return h('div', { key: keyName != null ? keyName : 'val', className: 'fc-json-leaf' },
      keyName != null ? h('span', { className: 'fc-json-key' }, keyName + ': ') : null,
      h('span', { className: 'fc-json-' + type }, strVal)
    );
  }
  if (depth >= 8) {
    return h('div', { key: keyName != null ? keyName : 'depth', className: 'fc-json-truncated' },
      (keyName != null ? keyName + ': ' : '') + '[Depth limit reached]'
    );
  }
  const isArr = Array.isArray(val);
  const keys = Object.keys(val);
  const count = keys.length;
  const MAX_ITEMS = 100;
  const visibleKeys = keys.slice(0, MAX_ITEMS);
  const isTruncated = count > MAX_ITEMS;
  const summaryText = (keyName != null ? keyName + ': ' : '') +
    (isArr ? ('Array(' + count + ')') : ('Object{' + count + '}'));

  return h('details', {
    key: keyName != null ? keyName : 'root',
    className: 'fc-json-branch',
    open: depth === 0 && count <= 20
  },
    h('summary', { className: 'fc-json-summary' }, summaryText),
    h('div', { className: 'fc-json-children' },
      visibleKeys.map(function(k) {
        return renderJsonTreeNode(val[k], isArr ? ('[' + k + ']') : k, depth + 1);
      }),
      isTruncated ? h('div', { key: '__trunc__', className: 'fc-json-truncated' }, '[Truncated: showing ' + MAX_ITEMS + ' of ' + count + ' items]') : null
    )
  );
}

function JsonTreeNode({ val, keyName, depth = 0 }) {
  const [open, setOpen] = useState(false);
  const keyPrefix = keyName != null ? keyName + ': ' : '';

  if (val === null) {
    return h('div', { className: 'fc-json-node' }, keyPrefix, h('span', { className: 'fc-json-null' }, 'null'));
  }
  if (val === undefined) {
    return h('div', { className: 'fc-json-node' }, keyPrefix, h('span', { className: 'fc-json-undefined' }, 'undefined'));
  }
  if (typeof val === 'boolean') {
    return h('div', { className: 'fc-json-node' }, keyPrefix, h('span', { className: 'fc-json-bool' }, val ? 'true' : 'false'));
  }
  if (typeof val === 'number') {
    const isUnsafe = !Number.isSafeInteger(val) && Math.abs(val) > Number.MAX_SAFE_INTEGER;
    return h('div', { className: 'fc-json-node' }, keyPrefix, h('span', { className: 'fc-json-num' }, String(val) + (isUnsafe ? ' (exceeds safe integer)' : '')));
  }
  if (typeof val === 'string') {
    return h('div', { className: 'fc-json-node' }, keyPrefix, h('span', { className: 'fc-json-str' }, JSON.stringify(val)));
  }

  const isArr = Array.isArray(val);
  const count = isArr ? val.length : Object.keys(val).length;
  const entries = [];
  if (open) {
    const limit = Math.min(count, 100);
    if (isArr) {
      for (let i = 0; i < limit; i++) {
        entries.push([i, val[i]]);
      }
    } else {
      const keys = Object.keys(val);
      for (let i = 0; i < limit; i++) {
        entries.push([keys[i], val[keys[i]]]);
      }
    }
  }

  if (depth >= 8) {
    return h('div', { className: 'fc-json-node' }, keyPrefix, h('span', { className: 'fc-json-truncated' }, (isArr ? `[Array(${count})` : `{Object(${count})`) + ' - max depth 8 reached]'));
  }

  if (count === 0) {
    return h('div', { className: 'fc-json-node' }, keyPrefix, isArr ? '[]' : '{}');
  }

  return h('details', {
    className: 'fc-json-branch',
    open: open,
    onToggle: (e) => {
      setOpen(e.currentTarget.open);
    },
  },
    h('summary', { className: 'fc-json-summary' },
      keyPrefix + (isArr ? `Array(${count})` : `Object(${count})`)
    ),
    open ? h('div', { className: 'fc-json-children', style: { paddingLeft: 16 } },
      entries.slice(0, 100).map(([k, v]) =>
        h(JsonTreeNode, {
          key: k,
          keyName: isArr ? k : k,
          val: v,
          depth: depth + 1,
        })
      ),
      count > 100 ? h('div', { className: 'fc-json-truncated', style: { paddingLeft: 4, color: 'var(--ui-text-tertiary)' } }, `... [${count - 100} more items truncated (max 100)]`) : null
    ) : null
  );
}

function ValueViewer({ api, run, flow, node, port, onClose, onOpenMedia, onSelectPort, state, field = 'outputs' }) {
  const currentKey = JSON.stringify([run?.id,node?.id,field,port]);
  const [fetched, setFetched] = useState(null);
  const [jsonView, setJsonView] = useState('tree');

  const nodeState = run && run.nodes && node && node.id ? run.nodes[node.id] : null;
  const ports = valueFieldPorts(nodeState, field);
  const selectedPortObj = port != null ? ports.find(function(p) { return p.port === port; }) : null;
  const isSelectedNonMedia = selectedPortObj && selectedPortObj.kind !== 'media';

  useEffect(function() {
    if (!run || !run.id || !node || !node.id || port == null) {
      setFetched(null);
      return;
    }
    const nState = run.nodes ? run.nodes[node.id] : null;
    const pList = valueFieldPorts(nState, field);
    const sPort = pList.find(function(p) { return p.port === port; });
    if (!sPort || sPort.kind === 'media') {
      setFetched(null);
      return;
    }
    let cancelled = false;
    setFetched({ key: currentKey, result: { status: 'loading' } });
    if (typeof loadRunValue === 'function') {
      loadRunValue(api, run.id, node.id, port, { field }).then(
        function(res) {
          if (!cancelled) setFetched({ key: currentKey, result: res });
        },
        function(err) {
          if (!cancelled) {
            setFetched({
              key: currentKey,
              result: {
                status: 'error',
                reason: String(err && err.message ? err.message : err)
              }
            });
          }
        }
      );
    }
    return function() {
      cancelled = true;
    };
  }, [api, run && run.id, node && node.id, field, port]);

  const currState = state !== undefined
    ? state
    : ((fetched && fetched.key === currentKey ? fetched.result : null) || (port != null && isSelectedNonMedia ? { status: 'loading' } : null));

  const modalLabel = ((node && (node.title || node.id)) || 'Value Viewer') + (field === 'inputs' ? ' — Inputs' : '');

  let contentEl = null;

  if (ports.length === 0) {
    contentEl = h('div', { role: 'status', className: 'fc-help' }, field === 'inputs' ? (nodeState?.input_history?.status === 'recorded' ? 'No wired inputs for this step.' : 'Inputs were not recorded for this run. Enable Record wired inputs before a new run.') : 'No outputs recorded');
  } else if (port == null) {
    contentEl = h('div', { role: 'status', className: 'fc-help' }, 'Choose an output');
  } else if (selectedPortObj && selectedPortObj.kind === 'media') {
    contentEl = h('div', { role: 'status', className: 'fc-help' }, 'Media output');
  } else if (currState && currState.status === 'loading') {
    contentEl = h('div', { role: 'status', className: 'fc-value-status' }, 'Loading...');
  } else if (currState && currState.status === 'unavailable') {
    contentEl = h('div', { role: 'status', className: 'fc-value-status' }, 'Value unavailable' + (currState.reason ? ': ' + currState.reason : ''));
  } else if (currState && currState.status === 'error') {
    contentEl = h('div', { role: 'alert', className: 'fc-value-error' }, 'Error loading value' + (currState.reason ? ': ' + currState.reason : ''));
  } else if (currState && currState.status === 'ready') {
    const rawText = currState.text != null ? String(currState.text) : '';
    const isEmpty = rawText === '';

    if (isEmpty) {
      contentEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { className: 'fc-value-toolbar' },
          h('div', null),
          h(CopyBtn, { text: '', title: 'Copy value' })
        ),
        h('div', { role: 'status', className: 'fc-value-empty' }, 'Empty value'),
        h('pre', { className: 'fc-pre' }, '')
      );
    } else if (currState.kind === 'json') {
      let parsedJson = null;
      let jsonParseError = null;
      try {
        parsedJson = JSON.parse(rawText);
      } catch (e) {
        jsonParseError = e && e.message ? e.message : String(e);
      }

      if (jsonParseError) {
        contentEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('div', { className: 'fc-value-toolbar' },
            h('div', null),
            h(CopyBtn, { text: rawText, title: 'Copy value' })
          ),
          h('div', { role: 'alert', className: 'fc-value-error' }, 'Malformed JSON: ' + jsonParseError),
          h('pre', { className: 'fc-pre' }, rawText)
        );
      } else {
        let formattedJson = rawText;
        let formatError = null;
        if (jsonView === 'formatted') {
          try {
            formattedJson = JSON.stringify(parsedJson, null, 2);
          } catch (err) {
            formatError = err.message || String(err);
          }
        }

        let bodyView = null;
        if (jsonView === 'raw') {
          bodyView = h('pre', { className: 'fc-pre' }, rawText);
        } else if (jsonView === 'formatted') {
          bodyView = h('div', null,
            h('div', { className: 'fc-value-warning', role: 'note' }, 'Tree and Formatted views can round numbers. Raw preserves the server response.'),
            formatError ? h('div', { className: 'fc-error' }, formatError) : null,
            h('pre', { className: 'fc-pre' }, formattedJson),
            h('details', null,
              h('summary', null, currState.expanded ? 'Raw (expanded)' : 'Raw JSON'),
              h('pre', { className: 'fc-pre' }, rawText)
            )
          );
        } else {
          bodyView = h('div', { className: 'fc-json-tree-container' },
            h('div', { className: 'fc-value-warning', role: 'note' }, 'Tree and Formatted views can round numbers. Raw preserves the server response.'),
            h(JsonTreeNode,{ val: parsedJson, keyName:null, depth:0 }),
            h('details', { className: 'fc-raw-collapse' },
              h('summary', null, currState.expanded ? 'Raw (expanded)' : 'Raw JSON'),
              h('pre', { className: 'fc-pre' }, rawText)
            )
          );
        }

        contentEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          currState.expanded ? h('div', { className: 'fc-value-warning', role: 'note' }, 'Expanded JSON: server normalization may have changed number precision and formatting; this is not the original stored JSON.') : null,
          h('div', { className: 'fc-value-toolbar' },
            h('div', { className: 'fc-value-btn-group' },
              h('button', {
                type: 'button',
                className: 'fc-btn' + (jsonView === 'tree' ? ' active' : ''),
                onClick: function() { setJsonView('tree'); }
              }, 'Tree'),
              h('button', {
                type: 'button',
                className: 'fc-btn' + (jsonView === 'raw' ? ' active' : ''),
                onClick: function() { setJsonView('raw'); }
              }, 'Raw'),
              h('button', {
                type: 'button',
                className: 'fc-btn' + (jsonView === 'formatted' ? ' active' : ''),
                onClick: function() { setJsonView('formatted'); }
              }, 'Formatted')
            ),
            h(CopyBtn, { text: rawText, title: 'Copy value' })
          ),
          bodyView
        );
      }
    } else {
      contentEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { className: 'fc-value-toolbar' },
          h('div', null),
          h(CopyBtn, { text: rawText, title: 'Copy value' })
        ),
        h('pre', { className: 'fc-pre' }, rawText)
      );
    }
  }

  return h(DialogFrame, { label: modalLabel, onCancel: onClose },
    h('div', { className: 'fc-value-modal' },
      h('div', { className: 'fc-value-modal-header' },
        h('div', { className: 'fc-value-modal-title' }, modalLabel),
        h('button', {
          type: 'button',
          className: 'fc-btn',
          onClick: function() { if (typeof onClose === 'function') onClose(); },
          'aria-label': 'Close'
        }, 'Close')
      ),
      h('div', { className: 'fc-value-modal-body' },
        h('div', { className: 'fc-value-modal-selectors' },
          ports.map(function(p) {
            const isSelected = port != null && p.port === port;
            return h('button', {
              key: p.port,
              type: 'button',
              className: 'fc-btn' + (isSelected ? ' active' : ''),
              'data-fc-value-port': p.port,
              'aria-pressed': isSelected,
              onClick: function() {
                if (p.kind === 'media') {
                  if (typeof onOpenMedia === 'function' && node) {
                    let firstMedia = null;
                    const rawOutputs = nodeState && nodeState.outputs ? nodeState.outputs[p.port] : null;
                    if (rawOutputs && rawOutputs.$media) {
                      firstMedia = rawOutputs;
                    } else if (Array.isArray(rawOutputs) && rawOutputs.length > 0 && rawOutputs[0] && rawOutputs[0].$media) {
                      firstMedia = rawOutputs[0];
                    }
                    const mediaPath = (firstMedia && firstMedia.$media && firstMedia.$media.path) || '';
                    onOpenMedia({ nodeId: node.id, port: p.port, index: 0, path: mediaPath });
                  }
                } else {
                  if (typeof onSelectPort === 'function' && node) {
                    onSelectPort({ nodeId: node.id, port: p.port });
                  }
                }
              }
            }, p.port);
          })
        ),
        h('div', { className: 'fc-value-modal-content' },
          contentEl
        )
      )
    )
  );
}

function TemplateDialog({ mode, initial, inputs, busy, onSubmit, onCancel }) {
  const [name, setName] = useState((initial && initial.name) || '')
  const [description, setDescription] = useState((initial && initial.description) || '')
  const [clear, setClear] = useState(false)
  const nameRef = useRef(null)
  useEffect(() => {
    const el = nameRef.current
    if (el) {
      el.focus()
      el.select()
    }
  }, [])
  const saving = mode === 'save'
  const ok = name.trim().length > 0 && !busy
  const submit = (e) => {
    if (e) e.preventDefault()
    if (ok) onSubmit({ name: name.trim(), description: description.trim(), clear_inputs: saving && clear })
  }
  const list = inputs || []
  return h(DialogFrame, {
    label: saving ? 'Save as template' : 'Edit template',
    scrim: { 'data-fc-template-dialog': mode },
    onCancel,
    onKeyDown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e)
    }
  },
  h('form', { className: 'fc-modal', onSubmit: submit },
    h('div', { className: 'fc-modal-title' }, h(Icon, { name: saving ? 'save-as' : 'edit' }), saving ? 'Save as template' : 'Edit template'),
    saving ? h('p', { className: 'fc-help' }, 'Saves a copy of this flow as a starting point. It shows under Your templates in the Flows menu and on the start screen, and Hermes can build from it too.') : null,
    h('div', { className: 'fc-field' },
      h('label', { htmlFor: 'fc-tpl-name' }, 'Name'),
      h('input', { id: 'fc-tpl-name', ref: nameRef, className: 'fc-input', value: name, maxLength: 80, onChange: (e) => setName(e.target.value) })),
    h('div', { className: 'fc-field' },
      h('label', { htmlFor: 'fc-tpl-desc' }, 'Description'),
      h('textarea', {
        id: 'fc-tpl-desc', className: 'fc-input', rows: 3, maxLength: 500, value: description,
        placeholder: 'What does it do? Shown on the start screen.', onChange: (e) => setDescription(e.target.value)
      })),
    saving ? h('label', { className: `fc-check${list.length ? '' : ' disabled'}`, title: list.length ? `Empties: ${list.join(', ')}` : '' },
      h('input', { type: 'checkbox', checked: clear, disabled: !list.length, 'data-fc-clear-inputs': '1', onChange: (e) => setClear(e.target.checked) }),
      list.length
        ? `Clear input values (${list.slice(0, 3).join(', ')}${list.length > 3 ? ', …' : ''})`
        : 'No input values to clear') : null,
    h('div', { className: 'fc-modal-actions' },
      h('button', { type: 'button', className: 'fc-btn', onClick: onCancel }, 'Cancel'),
      h('button', { type: 'submit', className: 'fc-btn primary', disabled: !ok, 'data-fc-template-submit': '1' },
        busy ? h(Icon, { name: 'loading', spin: true }) : null, saving ? 'Save template' : 'Save'))))
}

function Welcome({ templates, hasFlows, onNew, onFromTemplate, onOpenMenu, generation, onGenerate, onGenerateEdit, onGenerateStop }) {
  return h('div', { className: 'fc-welcome' },
    h('div', { className: 'fc-welcome-icon' }, h(Icon, { name: 'type-hierarchy' })),
    h('h2', null, hasFlows ? 'Open a flow' : 'Build your first flow'),
    h('p', null, 'Wire Hermes tools, MCP tools and LLM calls into a pipeline, then run it with one click. Every step shows its status and result live, and finished steps are cached.'),
    h('div', { className: 'fc-row center' },
      h('button', { className: 'fc-btn primary', onClick: onNew }, h(Icon, { name: 'add' }), 'New blank flow'),
      hasFlows ? h('button', { className: 'fc-btn', onClick: onOpenMenu }, h(Icon, { name: 'type-hierarchy' }), 'Your flows') : null),
    h(GenerateComposer, { flow: null, generation, onEdit: onGenerateEdit, onSubmit: onGenerate, onStop: onGenerateStop, inline: true }),
    templates.length > 0 ? h('div', { className: 'fc-templates' },
      [...splitTemplates(templates).own, ...splitTemplates(templates).builtin].map((t) => h('button', {
        key: t.id,
        className: 'fc-template',
        'data-fc-template': t.id,
        disabled: t.available === false,
        title: t.available === false ? `Needs: ${(t.missing_tools || []).join(', ')}` : '',
        onClick: () => onFromTemplate(t.id)
      }, h('b', null, t.name || t.id, t.source === 'user' ? h('span', { className: 'fc-tag' }, 'Yours') : null),
      h('span', null, t.description || ''), t.available === false ? h('span', { className: 'fc-bad' }, 'Missing tools') : null))) : null,
    h('p', { className: 'fc-muted', style: { marginTop: 18 } }, 'Tip: ask Hermes in chat — “build me a flow that turns an idea into an image and a 3D model”.'))
}

// ---------------------------------------------------------------- page
function ArachneFlowPage({ ctx }) {
  const api = useMemo(() => makeApi(ctx), [ctx])
  const storage = ctx ? ctx.storage : null
  const sget = (k, d) => {
    try {
      const v = storage && storage.get ? storage.get(k, d) : d
      return v === undefined || v === null ? d : v
    } catch {
      return d
    }
  }
  const sset = (k, v) => {
    try {
      if (storage && storage.set) storage.set(k, v)
    } catch {
      /* storage is best effort */
    }
  }

  const rootRef = useRef(null)
  const [focusWin, setFocusWin] = useState(() => !!SHARED.focusWindow)
  useFillHeight(rootRef, !focusWin)
  const leaveFocusWindow = () => {
    focusWindowSet(false)
    setFocusWin(false)
  }
  const latest = useRef({})

  const [boot, setBoot] = useState({ status: 'loading', error: '' })
  const [types, setTypes] = useState(EMPTY_TYPES)
  const [flows, setFlows] = useState([])
  const [templates, setTemplates] = useState([])
  const [timings, setTimings] = useState(() => indexTimings(null))
  const [doc, setDoc] = useState(EMPTY_DOC)
  const [selection, setSelection] = useState([])
  // read before the persist effect below overwrites it with the empty initial selection
  const storedSelectionRef = useRef(undefined)
  if (storedSelectionRef.current === undefined) storedSelectionRef.current = sget('selection', null)
  const [selectedEdge, setSelectedEdge] = useState(null)
  const [saveState, setSaveState] = useState('saved')
  const [saveError, setSaveError] = useState('')
  const [conflict, setConflict] = useState(null)
  const [connLost, setConnLost] = useState(false)
  const [run, setRun] = useState(null)
  const [issues, setIssues] = useState([])
  const [notice, setNotice] = useState(null)
  const [view, setView] = useState({ x: 60, y: 60, zoom: 1 })
  const [expanded, setExpanded] = useState(() => new Set())
  const [menuOpen, setMenuOpen] = useState(false)
  const [templateDialog, setTemplateDialog] = useState(null)
  const [templateBusy, setTemplateBusy] = useState(false)
  const [generation, dispatchGeneration] = useReducer(generateReducer, undefined, generateInitial)
  const [logOpen, setLogOpen] = useState(() => sget('logOpen', true) !== false)
  const [paletteOpen, setPaletteOpen] = useState(() => sget('paletteOpen', true) !== false)
  const [uploading, setUploading] = useState(0)
  const [paletteFoldState, setPaletteFoldState] = useState(() => {
    const v = sget('paletteFolds', {})
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  })
  const savePaletteFolds = (next) => {
    sset('paletteFolds', next)
    setPaletteFoldState(next)
  }
  const [inspectorOpen, setInspectorOpen] = useState(() => sget('inspectorOpen', true) !== false)
  const [recent, setRecent] = useState(() => rememberType(sget('recentTypes', []), null))
  const [lightbox, setLightbox] = useState(null)   // key of the media item shown large (G1)
  const [valueViewer, setValueViewer] = useState(null)
  const flow = doc.flow

  const docRef = useRef(doc)
  docRef.current = doc
  const flowRef = useRef(null)
  flowRef.current = flow
  const runRef = useRef(null)
  runRef.current = run
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const edgeSelRef = useRef(null)
  edgeSelRef.current = selectedEdge
  const typesRef = useRef(types)
  typesRef.current = types
  const recentRef = useRef(recent)
  recentRef.current = recent
  const conflictRef = useRef(null)
  conflictRef.current = conflict
  const loadedRef = useRef(null)
  const baseRevRef = useRef(null)
  const savingRef = useRef(null)
  const generatingRef = useRef(false)
  const generationJobRef = useRef(null)   // id of the running build job, for Stop
  const saveTimerRef = useRef(null)
  const openTokenRef = useRef(0)
  const needFitRef = useRef(false)
  const heightsRef = useRef({})
  const fitRef = useRef(null)
  const sizeRef = useRef({ w: 800, h: 600 })
  const announcedRef = useRef(new Set())
  const noticeTimerRef = useRef(null)
  const flowsTimerRef = useRef(null)
  const runRefreshTimerRef = useRef(null)
  const lastEventRef = useRef(0)
  const deletingRef = useRef(null)
  const connRef = useRef({ fails: 0, lost: false })

  // ---- notices, saving
  const notify = (text, tone = 'info', ms = 5000) => {
    clearTimeout(noticeTimerRef.current)
    setNotice({ text, tone })
    if (ms) noticeTimerRef.current = setTimeout(() => setNotice(null), ms)
  }
  const validateNow = async (flowId) => {
    try {
      const res = await api.validate(flowId)
      if (flowRef.current && flowRef.current.id === flowId) setIssues(res.issues || [])
    } catch {
      /* validation is advisory */
    }
  }
  const refreshFlows = async () => {
    try {
      const res = await api.flows()
      const list = res.flows || []
      setFlows(list)
      return list
    } catch {
      return null
    }
  }
  const scheduleSave = () => {
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => latest.current.persist(), SAVE_DELAY)
  }
  // ---- backend contact (U-5): while a run is active the fallback poll is the only regular health check
  const reportConnection = (ok) => {
    const next = connectionState(connRef.current, ok)
    connRef.current = next
    setConnLost(next.lost)
    return next
  }
  // The backend answers again: reload what the page shows (open flow + its last run) instead of leaving a
  // run chip and clocks frozen on "running" forever.
  const recoverConnection = async () => {
    const plan = recoveryPlan(flowRef.current, loadedRef.current)
    let ok = false
    try {
      if (plan === 'boot') ok = await latest.current.bootUp()
      else if (plan === 'reload') ok = await latest.current.openFlow(flowRef.current.id, { preserveState: true })
      else {
        await latest.current.persist()
        ok = flowRef.current === loadedRef.current || !!conflictRef.current
        const r = runRef.current
        if (ok && r && r.id) await latest.current.refreshRun(r.id)
      }
    } catch {
      ok = false
    }
    reportConnection(!!ok)
    if (ok) notify('Connection restored.', 'ok', 3000)
    return !!ok
  }
  const retryConnection = async () => {
    const r = runRef.current
    if (r && r.id && !TERMINAL.has(r.status) && (await latest.current.refreshRun(r.id))) return
    await latest.current.recoverConnection()
  }
  const doSave = async () => {
    const current = flowRef.current
    if (!current || current === loadedRef.current || conflictRef.current) return
    setSaveState('saving')
    try {
      const res = await api.saveFlow(current.id, current, baseRevRef.current)
      baseRevRef.current = res.flow.revision
      loadedRef.current = current
      setSaveError('')
      setFlows((list) => list.map((f) => (f.id === current.id
        ? { ...f, name: current.name, revision: res.flow.revision, updated_at: res.flow.updated_at, node_count: current.nodes.length }
        : f)))
      if (flowRef.current === current) setSaveState('saved')
      else {
        setSaveState('dirty')
        latest.current.scheduleSave()
      }
      latest.current.validateNow(current.id)
    } catch (err) {
      const e = parseRestError(err)
      if (e.status === 409) {
        const c = { revision: e.detail && typeof e.detail === 'object' ? e.detail.current_revision : null }
        conflictRef.current = c
        setConflict(c)
        setSaveState('conflict')
      } else {
        setSaveState('error')
        setSaveError(e.status === 404 ? 'This flow no longer exists.' : e.message)
      }
    }
  }
  // Serialises saves (and other revision-changing calls) so events can wait for them.
  const chainWork = (work) => {
    const chain = (savingRef.current || Promise.resolve()).then(work).catch(() => {})
    savingRef.current = chain
    chain.then(() => {
      if (savingRef.current === chain) savingRef.current = null
    })
    return chain
  }
  const persist = () => {
    clearTimeout(saveTimerRef.current)
    return chainWork(() => latest.current.doSave())
  }

  // ---- flows
  const loadLastRun = async (flowId, token) => {
    try {
      const res = await api.runs(flowId, 1)
      const last = res.runs && res.runs[0]
      if (token !== openTokenRef.current || !last) return
      const full = await api.run(last.id)
      if (token !== openTokenRef.current) return
      if (TERMINAL.has(full.run.status)) announcedRef.current.add(full.run.id)
      setRun((cur) => (cur && cur.id !== full.run.id && isRunActive(cur) ? cur : full.run))
    } catch {
      /* history is optional */
    }
  }
  const openFlow = async (id, opts = {}) => {
    const token = ++openTokenRef.current
    let f = null
    try {
      const saved = await persistForFlowChange(
        latest.current.persist,
        () => saveBlocker(conflictRef.current, flowRef.current, loadedRef.current),
        async () => (id ? (await api.getFlow(id)).flow : null),
        (reason) => { if (token === openTokenRef.current) latest.current.notify(reason, conflictRef.current ? 'warn' : 'error') },
      )
      if (!saved.ok) return false
      f = saved.value
    } catch (err) {
      if (token === openTokenRef.current) latest.current.notify(parseRestError(err).message, 'error')
      return false
    }
    if (token !== openTokenRef.current) return false
    setMenuOpen(false)
    if (!id) {
      loadedRef.current = null
      baseRevRef.current = null
      setDoc(EMPTY_DOC)
      setRun(null)
      setIssues([])
      setSelection([])
      setSelectedEdge(null)
      setConflict(null)
      conflictRef.current = null
      sset('flowId', null)
      return true
    }
    const preserve = !!opts.preserveState && flowRef.current && flowRef.current.id === id
    // A user can edit while the reconnect GET is in flight. Never replace those unsaved changes.
    if (preserve && (flowRef.current !== loadedRef.current || conflictRef.current)) return false
    const restored = !preserve && SHARED.session && SHARED.session.flowId === id ? SHARED.session : null
    if (!preserve) SHARED.session = null
    loadedRef.current = f
    baseRevRef.current = f.revision
    conflictRef.current = null
    setConflict(null)
    setSaveState('saved')
    setSaveError('')
    if (preserve) {
      setDoc((d) => {
        // Revision/timestamp churn alone is not an external edit that invalidates local history.
        const content = (value) => {
          const { revision, updated_at, ...rest } = value || {}
          return JSON.stringify(rest)
        }
        return content(d.flow) === content(f) ? { ...d, flow: f } : applyRemote(d, f)
      })
      const ids = new Set(f.nodes.map((n) => n.id))
      setSelection((cur) => cur.filter((nid) => ids.has(nid)))
      setSelectedEdge((cur) => f.edges.some((e) => e.id === cur) ? cur : null)
      setExpanded((cur) => new Set([...cur].filter((nid) => ids.has(nid))))
    } else {
      setDoc({ flow: f, undo: restored ? restored.undo : [], redo: restored ? restored.redo : [], key: null, at: 0 })
      setSelection((opts.select || []).filter((nid) => f.nodes.some((n) => n.id === nid)))
      setSelectedEdge(null)
      setRun(null)
      setExpanded(new Set())
      heightsRef.current = {}
      const stored = sget(`view:${id}`, null)
      if (stored && Number.isFinite(stored.zoom) && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
        setView(stored)
        needFitRef.current = false
      } else needFitRef.current = true
    }
    setIssues([])
    sset('flowId', id)
    latest.current.loadLastRun(id, token)
    latest.current.validateNow(id)
    return true
  }
  const bootUp = async () => {
    setBoot({ status: 'loading', error: '' })
    try {
      const [nt, fl, tp] = await Promise.all([api.nodeTypes(), api.flows(), api.templates().catch(() => ({ templates: [] }))])
      setTypes(indexTypes(nt))
      const list = fl.flows || []
      setFlows(list)
      setTemplates(tp.templates || [])
      latest.current.refreshTimings()
      const wanted = SHARED.pendingOpen || sget('flowId', null)
      SHARED.pendingOpen = null
      const pick = list.find((f) => f.id === wanted) ? wanted : list[0] ? list[0].id : null
      const sel = storedSelectionRef.current
      storedSelectionRef.current = null
      // Stay on the loading screen until the last flow is open: switching ready first flashed the Welcome page.
      try {
        if (pick) await latest.current.openFlow(pick, { select: Array.isArray(sel) ? sel : [] })
      } finally {
        setBoot({ status: 'ready', error: '' })
      }
      if (SHARED.pendingRun) {
        SHARED.pendingRun = false
        if (pick) latest.current.startRun({})
      }
      return true
    } catch (err) {
      setBoot({ status: 'error', error: parseRestError(err).message })
      return false
    }
  }
  const createAndOpen = async (body, okText) => {
    try {
      const saved = await persistForFlowChange(
        latest.current.persist,
        () => saveBlocker(conflictRef.current, flowRef.current, loadedRef.current),
        () => api.createFlow(body),
        (reason) => notify(reason, conflictRef.current ? 'warn' : 'error'),
      )
      if (!saved.ok) return
      const res = saved.value
      await latest.current.refreshFlows()
      await latest.current.openFlow(res.flow.id)
      if (okText) notify(okText, 'ok', 2500)
    } catch (err) {
      notify(parseRestError(err).message, 'error')
    }
  }
  const newFlow = () => createAndOpen({ name: 'Untitled flow' })
  const newFromTemplate = (templateId) => createAndOpen({ template: templateId }, 'Flow created from the template.')
  const refreshTemplates = async () => {
    try {
      const tp = await api.templates()
      setTemplates(tp.templates || [])
    } catch {
      /* keep the list we have */
    }
  }
  const onTemplatesChanged = () => latest.current.refreshTemplates()
  const submitTemplate = async (values) => {
    const dialog = templateDialog
    if (!dialog) return
    setTemplateBusy(true)
    try {
      if (dialog.mode === 'save') {
        const current = flowRef.current
        if (!current) return
        // The engine copies the saved file: only a confirmed save may become a template (review R5).
        const saved = await persistForFlowChange(
          latest.current.persist,
          () => saveBlocker(conflictRef.current, flowRef.current, loadedRef.current),
          () => api.saveTemplate({ flow_id: current.id, ...values }),
          (reason) => notify(reason, conflictRef.current ? 'warn' : 'error'),
        )
        if (!saved.ok) return
        const res = saved.value
        notify(`Saved as template “${res.template.name}”. It is in the Flows menu under Your templates.`, 'ok', 4500)
      } else {
        await api.updateTemplate(dialog.template.id, { name: values.name, description: values.description })
        notify('Template updated.', 'ok', 2500)
      }
      setTemplateDialog(null)
      await latest.current.refreshTemplates()
    } catch (err) {
      notify(parseRestError(err).message, 'error')
    } finally {
      setTemplateBusy(false)
    }
  }
  const removeTemplate = async (t) => {
    try {
      await api.deleteTemplate(t.id)
      notify(`Template “${t.name || t.id}” deleted.`, 'ok', 2500)
      await latest.current.refreshTemplates()
    } catch (err) {
      notify(parseRestError(err).message, 'error')
    }
  }
  const duplicateFlow = async () => {
    const current = flowRef.current
    if (!current) return
    try {
      const saved = await persistForFlowChange(
        latest.current.persist,
        () => saveBlocker(conflictRef.current, flowRef.current, loadedRef.current),
        () => api.duplicate(current.id),
        (reason) => notify(reason, conflictRef.current ? 'warn' : 'error'),
      )
      if (!saved.ok) return
      const res = saved.value
      await latest.current.refreshFlows()
      await latest.current.openFlow(res.flow.id)
      notify('Flow duplicated.', 'ok', 2500)
    } catch (err) {
      notify(parseRestError(err).message, 'error')
    }
  }
  const deleteFlow = async () => {
    const current = flowRef.current
    if (!current) return
    clearTimeout(saveTimerRef.current)
    loadedRef.current = current
    deletingRef.current = current.id
    try {
      await api.deleteFlow(current.id)
      const list = (await latest.current.refreshFlows()) || []
      await latest.current.openFlow(list[0] ? list[0].id : null)
      notify('Flow moved to the trash.', 'ok', 3000)
    } catch (err) {
      notify(parseRestError(err).message, 'error')
    }
  }
  const tidy = async () => {
    const current = flowRef.current
    if (!current) return
    await latest.current.persist()
    if (conflictRef.current || flowRef.current !== loadedRef.current) return
    await chainWork(async () => {
      try {
        const res = await api.layout(current.id, baseRevRef.current, measureNodeSizes(rootRef.current, current))
        loadedRef.current = res.flow
        baseRevRef.current = res.flow.revision
        setDoc((d) => applyEdit(d, res.flow))
        needFitRef.current = true
      } catch (err) {
        notify(parseRestError(err).message, 'error')
      }
    })
  }
  const messagingOptIn = async (nodeId, enable, allowAttachments = false) => {
    const current = flowRef.current
    if (!current) return
    await latest.current.persist()
    if (conflictRef.current || flowRef.current !== loadedRef.current) return
    await chainWork(async () => {
      try {
        const res = await api.messagingOptIn(current.id, nodeId, enable, baseRevRef.current, allowAttachments)
        loadedRef.current = res.flow
        baseRevRef.current = res.flow.revision
        setDoc((d) => applyEdit(d, res.flow))
        notify(enable
          ? (allowAttachments ? 'Text and file sending enabled. A run can upload a real attachment.' : 'Sending enabled for this recipient. A run will now send a real message.')
          : 'Sending disabled for this node.', enable ? 'warn' : 'info', 4500)
      } catch (err) {
        notify(parseRestError(err).message, 'error')
      }
    })
  }
  const triggerSwitch = async (nodeId, active, rotate = false) => {
    const current = flowRef.current
    if (!current) return null
    await latest.current.persist()           // a trigger fires what is saved: save the canvas first
    if (conflictRef.current || flowRef.current !== loadedRef.current) {
      notify(saveBlocker(conflictRef.current, flowRef.current, loadedRef.current) || 'Save the flow first.', 'warn')
      return null
    }
    let out = null
    await chainWork(async () => {
      try {
        const res = await api.triggerSwitch(current.id, nodeId, active, baseRevRef.current, rotate)
        loadedRef.current = res.flow
        baseRevRef.current = res.flow.revision
        setDoc((d) => applyEdit(d, res.flow))
        notify(rotate ? 'New webhook URL. The old one no longer works.'
          : active ? 'Trigger active: it starts this flow by itself while Hermes runs.' : 'Trigger off.', active ? 'ok' : 'info', 4500)
        out = res
      } catch (err) {
        notify(parseRestError(err).message, 'error')
      }
    })
    return out
  }
  const stopGeneration = async () => {
    const id = generationJobRef.current
    if (!id) return
    try {
      await api.generateCancel(id)   // the poll loop then reports "Build cancelled" and keeps the prompt
    } catch (err) {
      notify(parseRestError(err).message, 'error')
    }
  }
  const generateFlow = async () => {
    if (generatingRef.current) return
    const draft = { ...generation.draft }
    if (!draft.prompt.trim()) return
    const original = flowRef.current
    generatingRef.current = true
    dispatchGeneration({ type: 'start', at: Date.now() })
    let result = null
    let failure = null
    try {
      await latest.current.persist()
      if (original && flowRef.current?.id !== original.id) throw new Error('The open flow changed. Build again from its current state.')
      if (conflictRef.current) throw new Error('Resolve the save conflict first, then build again.')
      if (original && flowRef.current !== loadedRef.current) throw new Error('Save the current edits successfully before building with Hermes.')
      await chainWork(async () => {
        try {
          // The model list Hermes offers, so the build can set LLM nodes to models the user names. Optional:
          // without the gateway the build still works, it just cannot pick LLM models.
          const llmModels = await loadModelOptions().then(llmModelsHint, () => null)
          const res = await runGenerationJob(api, generationBody({
            ...draft, flow: original, baseRevision: original ? baseRevRef.current : null, llmModels,
          }), {
            onProgress: (job) => {
              generationJobRef.current = job.id
              dispatchGeneration({ type: 'progress', jobId: job.id, phase: job.phase, elapsed: job.elapsed_s })
            },
          })
          if (!res.created) {
            if (!flowRef.current || flowRef.current.id !== res.flow.id) {
              throw new Error(`Hermes saved the changes to “${res.flow.name}”; open it from Flows to view them.`)
            }
            loadedRef.current = res.flow
            baseRevRef.current = res.flow.revision
            conflictRef.current = null
            setConflict(null)
            setSaveError('')
            setSaveState('saved')
            setDoc((d) => applyEdit(d, res.flow))
            needFitRef.current = true
            setFlows((list) => list.map((f) => (f.id === res.flow.id
              ? { ...f, name: res.flow.name, revision: res.flow.revision, updated_at: res.flow.updated_at, node_count: res.flow.nodes.length }
              : f)))
            latest.current.validateNow(res.flow.id)
          }
          result = res
        } catch (err) {
          failure = err
        }
      })
      if (failure) throw failure
      if (result.created) {
        if (flowRef.current !== original) throw new Error(`Hermes saved “${result.flow.name}”; open it from Flows.`)
        await latest.current.refreshFlows()
        await latest.current.openFlow(result.flow.id)
      }
      dispatchGeneration({ type: 'success' })
      notify(generationSummary(result), 'ok', 6000)
    } catch (err) {
      const e = parseRestError(err)
      if (e.status === 409) {
        const c = { revision: e.detail && typeof e.detail === 'object' ? e.detail.current_revision : null }
        conflictRef.current = c
        setConflict(c)
        setSaveState('conflict')
        dispatchGeneration({ type: 'close' }) // keeps the draft for the retry
        notify('The flow changed elsewhere. Choose Load latest or Keep mine, then build again.', 'warn', 7000)
      } else {
        dispatchGeneration({ type: 'fail', error: e.message })
      }
    } finally {
      generatingRef.current = false
      generationJobRef.current = null
    }
  }
  const loadTheirs = async () => {
    const current = flowRef.current
    const token = openTokenRef.current
    if (!current) return
    try {
      const res = await api.getFlow(current.id)
      if (token !== openTokenRef.current || flowRef.current !== current) return
      const hadHistory = !!(docRef.current && (docRef.current.undo.length || docRef.current.redo.length))
      loadedRef.current = res.flow
      baseRevRef.current = res.flow.revision
      conflictRef.current = null
      setConflict(null)
      setSaveState('saved')
      setDoc((d) => applyRemote(d, res.flow))   // U-15: the local history belongs to a flow this is not
      latest.current.validateNow(current.id)
      if (hadHistory) notify('Loaded the latest revision — undo history cleared.', 'info', 5000)
    } catch (err) {
      if (token === openTokenRef.current && flowRef.current === current) notify(parseRestError(err).message, 'error')
    }
  }
  const keepMine = async () => {
    const current = flowRef.current
    const token = openTokenRef.current
    if (!current) return
    let revision = conflictRef.current && conflictRef.current.revision
    if (revision === null || revision === undefined) {
      try {
        revision = (await api.getFlow(current.id)).flow.revision
      } catch {
        if (token !== openTokenRef.current || flowRef.current !== current) return
        revision = baseRevRef.current
      }
    }
    if (token !== openTokenRef.current || flowRef.current !== current) return
    baseRevRef.current = revision
    conflictRef.current = null
    setConflict(null)
    loadedRef.current = null
    latest.current.persist()
  }
  const askHermes = async () => {
    const text = askPrompt(flowRef.current)
    const focused = host.state && host.state.focusedSessionId
    const sid = focused && typeof focused.get === 'function' ? focused.get() : null
    try {
      if (await draftToComposer(host, sid, text)) {
        notify('A prompt is waiting in your chat composer — finish the sentence and send it.', 'ok', 4500)
        return
      }
      if (typeof sdk.writeClipboardText === 'function') {
        await sdk.writeClipboardText(text)
        notify('No chat composer is open, so the prompt was copied — open a chat, paste it and finish the sentence.', 'warn', 6500)
      } else notify('Open a chat first, then choose Discuss in chat again.', 'warn')
    } catch (err) {
      notify(parseRestError(err).message, 'error')
    }
  }

  // ---- runs
  const refreshTimings = async () => {
    try {
      setTimings(indexTimings(await api.timings()))
    } catch {
      /* durations are a hint; an older engine has no /x/timings */
    }
  }
  const finishedRun = (r) => {
    if (!r || !r.id || announcedRef.current.has(r.id)) return
    announcedRef.current.add(r.id)
    latest.current.refreshFlows()
    latest.current.refreshTimings()
    if (r.status === 'done') notify(`Run finished in ${formatMs(r.ms)}.`, 'ok')
    else if (r.status === 'error') notify(`Run failed — ${r.error || 'see the run log'}`, 'error', 9000)
    else if (r.status === 'cancelled') notify('Run stopped.', 'warn')
    else if (r.status === 'interrupted') notify('The run was interrupted (Hermes restarted).', 'warn')
    else if (r.status === 'invalid') notify(`The flow cannot run yet — ${r.error || 'see the checks'}`, 'error', 9000)
  }
  const refreshRun = async (runId) => {
    if (!runId) return false
    try {
      const res = await api.run(runId)
      // events may have landed while this fetch was in flight: merge them instead of dropping the newer status
      setRun((cur) => (cur && cur.id === runId ? mergeRun(cur, res.run) : cur))
      if (TERMINAL.has(res.run.status) && runRef.current && runRef.current.id === runId) latest.current.finishedRun(res.run)
      // first answer after a lost connection: the flow and its last run may have changed meanwhile
      if (reportConnection(true).recovered) latest.current.recoverConnection()
      return true
    } catch {
      /* the fallback poll retries; three misses in a row show the retry banner */
      reportConnection(false)
      return false
    }
  }
  const scheduleRunRefresh = (runId) => {
    if (runRefreshTimerRef.current) return
    runRefreshTimerRef.current = setTimeout(() => {
      runRefreshTimerRef.current = null
      latest.current.refreshRun(runId)
    }, 300)
  }
  const startRun = async (opts = {}) => {
    const current = flowRef.current
    if (!current || !current.nodes.length) return
    if (isRunActive(runRef.current)) {
      notify('A run is already in progress.', 'warn')
      return
    }
    await latest.current.persist()
    const blocked = saveBlocker(conflictRef.current, flowRef.current, loadedRef.current)
    if (blocked) {
      notify(blocked, conflictRef.current ? 'warn' : 'error')
      return
    }
    setRun({ id: null, flow_id: current.id, status: 'starting', nodes: {}, order: [] })
    try {
      const res = await api.startRun({ flow_id: current.id, target_node: opts.target || undefined, fresh: !!opts.fresh })
      if (res.status === 'invalid') {
        setIssues(res.issues || [])
        const r = {
          id: res.run_id, flow_id: current.id, status: 'invalid', issues: res.issues || [], nodes: {}, order: [],
          error: res.issues && res.issues[0] ? res.issues[0].message : 'invalid flow', started_at: new Date().toISOString()
        }
        setRun(r)
        latest.current.finishedRun(r)
        return
      }
      setRun((r) => (r && r.id === res.run_id ? r : {
        id: res.run_id, flow_id: current.id, status: 'running', nodes: {}, order: [], target_node: opts.target || null,
        fresh: !!opts.fresh, started_at: new Date().toISOString()
      }))
      latest.current.refreshRun(res.run_id)
    } catch (err) {
      setRun(null)
      notify(parseRestError(err).message, 'error', 9000)
    }
  }
  const stopRun = async () => {
    const r = runRef.current
    if (!r || !r.id) return
    try {
      await api.cancel(r.id)
      latest.current.refreshRun(r.id)
    } catch (err) {
      notify(parseRestError(err).message, 'error')
    }
  }

  // ---- live events
  const onFlowChanged = (pl) => {
    clearTimeout(flowsTimerRef.current)
    flowsTimerRef.current = setTimeout(() => latest.current.refreshFlows(), 300)
    const current = flowRef.current
    if (!current || pl.flow_id !== current.id) return
    if (pl.deleted) {
      if (deletingRef.current === pl.flow_id) return
      if (loadedRef.current === current && savingRef.current === null) {
        notify('This flow was deleted elsewhere.', 'warn')
        latest.current.refreshFlows().then((list) => latest.current.openFlow(list && list[0] ? list[0].id : null))
      }
      return
    }
    if (savingRef.current) {
      savingRef.current.then(() => latest.current.onFlowChanged(pl))
      return
    }
    if (!(pl.revision > (baseRevRef.current || 0))) return
    if (current === loadedRef.current) {
      api.getFlow(current.id).then((res) => {
        if (flowRef.current !== current) return
        const hadHistory = !!(docRef.current && (docRef.current.undo.length || docRef.current.redo.length))
        loadedRef.current = res.flow
        baseRevRef.current = res.flow.revision
        setDoc((d) => applyRemote(d, res.flow))   // U-15: not undoable — Ctrl+Z must not revert Hermes' edit
        latest.current.validateNow(current.id)
        if (hadHistory) {
          notify(pl.origin === 'agent'
            ? 'Hermes changed this flow — undo history cleared.'
            : 'This flow was changed elsewhere — undo history cleared.', 'info', 6000)
        } else {
          notify(pl.origin === 'agent' ? 'Hermes updated this flow.' : 'This flow was updated elsewhere.', 'info', 3500)
        }
      }).catch(() => {})
    } else {
      const c = { revision: pl.revision }
      conflictRef.current = c
      setConflict(c)
      setSaveState('conflict')
    }
  }
  const onRunStarted = (pl) => {
    const current = flowRef.current
    if (!current || pl.flow_id !== current.id) return
    const r = runRef.current
    if (r && (r.id === pl.run_id || r.status === 'starting')) return
    lastEventRef.current = Date.now()
    setRun({
      id: pl.run_id, flow_id: pl.flow_id, status: 'running', order: pl.nodes || [],
      nodes: Object.fromEntries((pl.nodes || []).map((n) => [n, { status: 'queued' }])), started_at: new Date().toISOString()
    })
  }
  const onNodeStatus = (pl) => {
    const r = runRef.current
    if (!r || r.id !== pl.run_id) return
    lastEventRef.current = Date.now()
    setRun((cur) => {
      if (!cur || cur.id !== pl.run_id) return cur
      const next = applyNodeStatus((cur.nodes && cur.nodes[pl.node_id]) || {}, pl)
      return { ...cur, status: cur.status === 'queued' ? 'running' : cur.status, nodes: { ...cur.nodes, [pl.node_id]: next } }
    })
    // outputs (thumbnails, inspector values) only live in the run record
    if (pl.status === 'done' || pl.status === 'cached' || pl.status === 'error') latest.current.scheduleRunRefresh(pl.run_id)
  }
  const onRunFinished = (pl) => {
    const r = runRef.current
    if (!r || r.id !== pl.run_id) return
    lastEventRef.current = Date.now()
    setRun((cur) => (cur && cur.id === pl.run_id ? { ...cur, status: pl.status, ms: pl.ms } : cur))
    latest.current.refreshRun(pl.run_id)
  }
  const openPending = async (flowId) => {
    if (!flowId) return
    await latest.current.refreshFlows()
    latest.current.openFlow(flowId)
  }

  // ---- edits
  const edit = (fn, key) => setDoc((d) => (d.flow ? applyEdit(d, fn(d.flow), key ? { key } : {}) : d))
  const select = (ids, mode = 'replace') => {
    setSelectedEdge(null)
    setSelection((cur) => {
      if (mode === 'toggle') {
        const s = new Set(cur)
        for (const id of ids) {
          if (s.has(id)) s.delete(id)
          else s.add(id)
        }
        return [...s]
      }
      if (mode === 'add') return [...new Set([...cur, ...ids])]
      return ids
    })
  }
  const addNodeAt = (type, x, y) => {
    const current = flowRef.current
    if (!current) return
    const spec = typesRef.current.byName[type]
    const pos = freeSpot(current, snap(x), snap(y))
    const { node } = addNode(current, { type, x: pos.x, y: pos.y, params: defaultParams(spec) })
    const nextRecent = rememberType(recentRef.current, type)
    recentRef.current = nextRecent
    setRecent(nextRecent)
    sset('recentTypes', nextRecent)
    edit((f) => ({ ...f, nodes: [...f.nodes, node] }))
    setSelection([node.id])
    setSelectedEdge(null)
  }
  // ---- files (G3): Browse… through ctx.os (one file per dialog), drops through the upload route
  // A picked file is signed for (flow, node, path) and kept in the node's picked_files: the backend runs a local file
  // outside the uploads folder only with that pick, and drops it whenever the agent edits the node.
  const confirmPick = async (nodeId, path, folder = false) => {
    const current = flowRef.current
    if (!current || !nodeId || !path) return
    try {
      const res = await api.filePick(current.id, nodeId, path, folder)
      edit((f) => {
        const n = f.nodes.find((x) => x.id === nodeId)
        if (!n) return f
        return updateNode(f, nodeId, { params: { [PICKED_FILES]: pickedFilesWith(n.params, res.path || path, res.token) } }, typesRef.current.byName)
      }, `p:${nodeId}:${PICKED_FILES}`)
    } catch (err) {
      notify(`This file cannot be used: ${parseRestError(err).message}`, 'error')
    }
  }
  const pickFile = async (kind, nodeId) => {
    const os = ctx && ctx.os
    if (!os || typeof os.pickOpenPath !== 'function') return null
    let picked = null
    const folder = kind === 'folder'   // Folder watch trigger: a folder dialog, signed like a file pick
    try {
      picked = await os.pickOpenPath(folder ? { title: 'Choose a folder to watch', directories: true }
        : { title: `Choose ${kind && kind !== 'auto' ? `an ${kind}` : 'a'} file`, filters: fileFilters(kind, typesRef.current.extKinds) })
    } catch {
      return null
    }
    if (picked && nodeId) await confirmPick(nodeId, picked, folder)
    return picked
  }
  const addFileNodes = (files, x, y) => {
    const current = flowRef.current
    const spec = typesRef.current.byName['input.file']
    if (!current || !files.length) return []
    if (!spec) {
      notify('The File node type is not available.', 'error')
      return []
    }
    const added = fileNodes(current, files, x, y, spec)
    edit((f) => ({ ...f, nodes: [...f.nodes, ...added] }))
    setSelection(added.map((n) => n.id))
    setSelectedEdge(null)
    return added
  }
  const dropFiles = async (files, x, y) => {
    const t = typesRef.current
    const flowId = flowRef.current && flowRef.current.id
    const problems = files.length > MAX_DROP_FILES ? [`Only the first ${MAX_DROP_FILES} files are added.`] : []
    const ok = []
    for (const f of files.slice(0, MAX_DROP_FILES)) {
      const c = checkDropFile(f, t.extKinds, t.uploadMax)
      if (c.ok) ok.push(f)
      else problems.push(c.reason)
    }
    const stored = []
    if (ok.length) {
      setUploading(ok.length)
      try {
        for (const f of ok) {
          try {
            const res = await api.upload(f.name, f)
            stored.push({ path: res.path, name: res.name || f.name })
          } catch (err) {
            problems.push(`${f.name}: ${parseRestError(err).message}`)
          }
        }
      } finally {
        setUploading(0)
      }
    }
    if (stored.length && flowRef.current && flowRef.current.id === flowId) addFileNodes(stored, x, y)
    else if (stored.length) problems.push('The flow changed while uploading; the files were stored but not added.')
    if (problems.length) notify(problems.slice(0, 3).join(' · ') + (problems.length > 3 ? ` (+${problems.length - 3} more)` : ''), stored.length ? 'warn' : 'error', 9000)
    else notify(`Added ${stored.length} File node${stored.length === 1 ? '' : 's'}.`, 'ok', 2500)
  }
  const addFromPalette = (type) => {
    const s = sizeRef.current
    const c = screenToWorld(view, { x: s.w / 2, y: s.h / 2 })
    addNodeAt(type, c.x - NODE_W / 2, c.y - 50)
  }
  const deleteSelection = () => {
    const edgeId = edgeSelRef.current
    if (edgeId) {
      edit((f) => disconnect(f, edgeId))
      setSelectedEdge(null)
      return
    }
    const ids = selectionRef.current
    if (!ids.length) return
    edit((f) => removeNodes(f, ids))
    setSelection([])
  }
  const duplicateSelection = () => {
    const current = flowRef.current
    const ids = selectionRef.current
    if (!current || !ids.length) return
    const sub = cloneSubgraph(current, ids, 40, 40)
    edit((f) => insertSubgraph(f, sub))
    setSelection(sub.nodes.map((n) => n.id))
  }
  const copySelection = (verb = 'Copied') => {
    const current = flowRef.current
    const ids = new Set(pruneSelection(selectionRef.current, current))
    if (!current || !ids.size) return 0
    CLIPBOARD = {
      nodes: JSON.parse(JSON.stringify(current.nodes.filter((n) => ids.has(n.id)))),
      edges: JSON.parse(JSON.stringify(current.edges.filter((e) => ids.has(e.from.node) && ids.has(e.to.node))))
    }
    notify(`${verb} ${ids.size} node${ids.size === 1 ? '' : 's'}.`, 'info', 1800)
    return ids.size
  }
  const cutSelection = () => {
    if (!copySelection('Cut')) return
    const ids = selectionRef.current
    edit((f) => removeNodes(f, ids))
    setSelection([])
    setSelectedEdge(null)
  }
  /** `at` (world point) pastes there — context menu; without it the copy lands +40 px or in view. */
  const pasteClipboard = (at) => {
    const current = flowRef.current
    if (!current || !CLIPBOARD || !CLIPBOARD.nodes.length) return
    let sub = cloneSubgraph(CLIPBOARD, CLIPBOARD.nodes.map((n) => n.id), 40, 40, nodeIdSet(current), edgeIdSet(current))
    sub = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? placeSubgraph(sub, at) : placeInView(sub, view, sizeRef.current)
    CLIPBOARD = { nodes: JSON.parse(JSON.stringify(sub.nodes)), edges: CLIPBOARD.edges.map((e) => ({ ...e, from: { ...e.from, node: sub.map[e.from.node] }, to: { ...e.to, node: sub.map[e.to.node] } })) }
    edit((f) => insertSubgraph(f, sub))
    setSelection(sub.nodes.map((n) => n.id))
  }
  const connectPorts = (from, to, replaceEdgeId) => {
    const base = replaceEdgeId ? disconnect(flowRef.current, replaceEdgeId) : flowRef.current
    const check = canConnect(base, typesRef.current, from, to)
    if (!check.ok) {
      notify(check.reason, 'warn', 3500)
      return
    }
    edit((f) => connect(replaceEdgeId ? disconnect(f, replaceEdgeId) : f, from, to, typesRef.current))
  }
  const toggleExpand = (id) => setExpanded((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  })

  latest.current = {
    notify, validateNow, refreshFlows, scheduleSave, doSave, persist, loadLastRun, openFlow, bootUp, finishedRun,
    refreshRun, scheduleRunRefresh, startRun, refreshTimings, onFlowChanged, onRunStarted, onNodeStatus, onRunFinished, openPending,
    refreshTemplates, onTemplatesChanged, recoverConnection, retryConnection
  }

  // ---- effects
  useEffect(() => {
    latest.current.bootUp()
  }, [])
  useEffect(() => {
    const offs = []
    if (typeof host.onEvent === 'function') {
      const map = {
        'flow.changed': 'onFlowChanged', 'run.started': 'onRunStarted', 'node.status': 'onNodeStatus', 'run.finished': 'onRunFinished',
        'templates.changed': 'onTemplatesChanged'
      }
      for (const [name, fn] of Object.entries(map)) {
        offs.push(host.onEvent(evt(name), (msg) => latest.current[fn]((msg && msg.payload) || {})))
      }
    }
    const onOpen = (id) => latest.current.openPending(id)
    SHARED.listeners.add(onOpen)
    // Sticky for the life of the window (U-14): the boot navigation retries stop for good once the page showed,
    // so navigating away later is not undone by a late retry.
    SHARED.pageMounted = true
    SHARED.runCurrent = () => latest.current.startRun({})
    return () => {
      offs.forEach((off) => {
        if (typeof off === 'function') off()
      })
      SHARED.listeners.delete(onOpen)
      SHARED.runCurrent = null
    }
  }, [])
  useEffect(() => {
    if (!flow || flow === loadedRef.current || conflictRef.current) return
    setSaveState('dirty')
    latest.current.scheduleSave()
  }, [flow])
  const runId = run ? run.id : null
  const runActive = !!runId && !TERMINAL.has(run.status)
  useEffect(() => {
    if (!runActive) return undefined
    // fallback when live events stop arriving
    const t = setInterval(() => {
      if (Date.now() - lastEventRef.current > POLL_MS) latest.current.refreshRun(runId)
    }, POLL_MS)
    return () => clearInterval(t)
  }, [runActive, runId])
  const flowId = flow ? flow.id : null
  useEffect(() => {
    if (!flowId) return undefined
    const t = setTimeout(() => sset(`view:${flowId}`, view), 400)
    return () => clearTimeout(t)
  }, [view, flowId])
  useEffect(() => {
    sset('selection', selection)
  }, [selection])
  // undo/redo or an agent edit can remove nodes/edges that are still selected
  useEffect(() => {
    if (!flow) return
    setSelection((cur) => pruneSelection(cur, flow))
    setSelectedEdge((cur) => (cur && !flow.edges.some((e) => e.id === cur) ? null : cur))
  }, [flow])
  useEffect(() => () => {
    clearTimeout(saveTimerRef.current)
    clearTimeout(noticeTimerRef.current)
    clearTimeout(flowsTimerRef.current)
    clearTimeout(runRefreshTimerRef.current)
    const d = docRef.current
    if (d.flow) SHARED.session = { flowId: d.flow.id, undo: d.undo, redo: d.redo }
    latest.current.persist()
  }, [])

  // ---- derived
  const edges = flow ? flow.edges : null
  const nodes = flow ? flow.nodes : null
  const connectedIn = useMemo(() => {
    const m = {}
    for (const e of edges || []) (m[e.to.node] = m[e.to.node] || new Set()).add(e.to.port)
    return m
  }, [edges])
  const connectedOut = useMemo(() => {
    const m = {}
    for (const e of edges || []) (m[e.from.node] = m[e.from.node] || new Set()).add(e.from.port)
    return m
  }, [edges])
  const wireCounts = useMemo(() => {
    const m = {}
    const bump = (node, side, port) => {
      const bySide = (m[node] = m[node] || { in: {}, out: {} })[side]
      bySide[port] = (bySide[port] || 0) + 1
    }
    for (const e of edges || []) {
      bump(e.to.node, 'in', e.to.port)
      bump(e.from.node, 'out', e.from.port)
    }
    return m
  }, [edges])
  const loopOwners = useMemo(() => loopBodies({ nodes: nodes || [], edges: edges || [] }), [nodes, edges])
  const nameOf = (id) => {
    const n = (nodes || []).find((x) => x.id === id)
    return n ? nodeTitle(n, types.byName) : ''
  }
  const layouts = useMemo(() => {
    const out = {}
    for (const n of nodes || []) out[n.id] = nodeLayout(n, types.byName[n.type], connectedIn[n.id], expanded.has(n.id))
    return out
  }, [nodes, types, connectedIn, expanded])
  const issuesByNode = useMemo(() => {
    const m = {}
    for (const i of issues) if (i.node && (!m[i.node] || i.level === 'error')) m[i.node] = i.message
    return m
  }, [issues])
  const running = isRunActive(run)
  const mediaItems = useMemo(() => runMediaList(run, flow, types.byName), [run, flow, types])
  const lightboxAt = lightbox ? mediaItems.findIndex((m) => m.key === lightbox) : -1
  useEffect(() => {
    if (lightbox && lightboxAt < 0) setLightbox(null)   // its run was replaced or re-started
  }, [lightbox, lightboxAt])
  const openMedia = ({ nodeId, port, index = 0, path }) => {
    const hit = mediaItems.find((m) => m.key === `${nodeId}|${port}|${index}`) ||
      (path ? mediaItems.find((m) => m.media.path === path) : null) ||
      mediaItems.find((m) => m.nodeId === nodeId)
    if (hit) setLightbox(hit.key)
  }
  const openValue = ({ nodeId, port = null, field = 'outputs' } = {}) => {
    if (!flow || !run || !run.id || !nodeId) return
    const node = flow.nodes && flow.nodes.find((n) => n.id === nodeId)
    if (!node || !run.nodes || !run.nodes[nodeId]) return
    setValueViewer({ flowId: flow.id, runId: run.id, nodeId, port: port != null ? port : null, field })
  }
  useEffect(() => {
    if (valueViewer && (!run || valueViewer.runId !== run.id || !flow || valueViewer.flowId !== flow.id)) {
      setValueViewer(null)
    }
  }, [valueViewer, run && run.id, flow && flow.id])

  const focusRoot = () => {
    if (rootRef.current) rootRef.current.focus({ preventScroll: true })
  }
  const onKeyDown = (e) => {
    if (!flow || isEditableTarget(e.target)) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
    if (mod && (k === 'a' || k === 'c' || k === 'x')) {
      const sel = window.getSelection ? String(window.getSelection()) : ''
      const canvasEl = rootRef.current && rootRef.current.querySelector('.fc-canvas')
      if (!canvasClipboardKey(k, { textSelected: sel !== '', nodesSelected: selection.length, inCanvas: inCanvasArea(e.target, canvasEl) })) return
    }
    let handled = true
    if (mod && k === 'z') setDoc(e.shiftKey ? redoDoc : undoDoc)
    else if (mod && k === 'y') setDoc(redoDoc)
    else if (mod && k === 'a') select(flow.nodes.map((n) => n.id))
    else if (mod && k === 'd') duplicateSelection()
    else if (mod && k === 'c') copySelection()
    else if (mod && k === 'x') cutSelection()
    else if (mod && k === 'v') pasteClipboard()
    else if (mod && k === 's') persist()
    else if (mod && k === 'Enter') startRun({ fresh: e.shiftKey })
    else if (!mod && (k === 'Delete' || k === 'Backspace')) deleteSelection()
    else if (!mod && k === 'f') {
      if (fitRef.current) fitRef.current()
    } else if (k === 'Escape') {
      setSelection([])
      setSelectedEdge(null)
      setMenuOpen(false)
    } else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  let body
  if (boot.status === 'loading') {
    body = h('div', { className: 'fc-center' }, h('div', { className: 'fc-muted' }, h(Icon, { name: 'loading', spin: true }), '  Loading Arachne Flow…'))
  } else if (boot.status === 'error') {
    body = h('div', { className: 'fc-center' }, h('div', { className: 'fc-welcome' },
      h('div', { className: 'fc-welcome-icon' }, h(Icon, { name: 'debug-disconnect' })),
      h('h2', null, 'Arachne Flow could not start'),
      h('p', null, boot.error || 'The plugin backend did not answer.'),
      h('p', { className: 'fc-muted' }, 'If you just installed or updated the plugin, restart Hermes Desktop once.'),
      h('button', { className: 'fc-btn primary', onClick: () => latest.current.bootUp() }, h(Icon, { name: 'refresh' }), 'Try again')))
  } else if (!flow) {
    body = h('div', { className: 'fc-center' }, h(Welcome, {
      templates, hasFlows: flows.length > 0, onNew: newFlow, onFromTemplate: newFromTemplate, onOpenMenu: () => setMenuOpen(true),
      generation, onGenerate: generateFlow, onGenerateEdit: (patch) => dispatchGeneration({ type: 'edit', patch }), onGenerateStop: stopGeneration,
    }))
  } else {
    body = h('div', { className: 'fc-main' },
      paletteOpen ? h(Palette, { types, recent, onAdd: addFromPalette, folds: paletteFoldState, onFolds: savePaletteFolds, timings }) : null,
      h(Canvas, {
        flow, types, recent, layouts, connectedIn, connectedOut, run, running, selection, selectedEdge, issuesByNode, view, setView, expanded, api,
        timings, nameOf, wireCounts, loopOwners,
        heightsRef, needFitRef, fitRef, sizeRef,
        generation, onGenerate: generateFlow, onGenerateEdit: (patch) => dispatchGeneration({ type: 'edit', patch }), onGenerateStop: stopGeneration,
        onFocusRoot: focusRoot,
        onSelect: select,
        onSelectEdge: (id) => {
          setSelectedEdge(id)
          setSelection([])
        },
        onMove: (positions) => setDoc((d) => (d.flow ? { ...d, flow: moveNodes(d.flow, positions) } : d)),
        onMoveEnd: (startFlow) => setDoc((d) => (d.flow && d.flow !== startFlow
          ? { ...d, undo: [...d.undo, startFlow].slice(-UNDO_LIMIT), redo: [], key: null } : d)),
        onConnect: connectPorts,
        onDisconnect: (id) => edit((f) => disconnect(f, id)),
        onDropType: addNodeAt,
        onToggleExpand: toggleExpand,
        onOpenInspector: () => {
          if (!inspectorOpen) {
            setInspectorOpen(true)
            sset('inspectorOpen', true)
          }
        },
        onRunTo: (id) => startRun({ target: id }),
        onOpenMedia: openMedia,
        onOpenValue: openValue,
        onDuplicate: duplicateSelection,
        onCopy: () => copySelection(),
        onCut: cutSelection,
        onPaste: pasteClipboard,
        canPaste: () => !!(CLIPBOARD && CLIPBOARD.nodes.length),
        onDelete: deleteSelection,
        onSelectAll: () => select(flow.nodes.map((n) => n.id)),
        onTidy: tidy,
        onDropFiles: dropFiles,
        uploading,
        savedRev: (flows.find((f) => f.id === flow.id) || flow).revision
      }),
      inspectorOpen ? h(Inspector, {
        flow, selection, types, run, issues, api, running, timings, onOpenValue: openValue,
        onSelect: select,
        onUpdateNode: (id, patch, key) => edit((f) => updateNode(f, id, patch, typesRef.current.byName), key),
        onChangeType: (id, type) => {
          edit((f) => changeNodeType(f, id, type, typesRef.current))
          const nextRecent = rememberType(recentRef.current, type)
          recentRef.current = nextRecent
          setRecent(nextRecent)
          sset('recentTypes', nextRecent)
        },
        onUpdateFlow: (patch, key) => edit((f) => ({ ...f, ...patch }), key),
        onMessagingOptIn: messagingOptIn,
        onTriggerSwitch: triggerSwitch,
        onRunTo: (id) => startRun({ target: id }),
        onOpenMedia: openMedia,
        onDelete: deleteSelection,
        onDuplicate: duplicateSelection,
        onPickFile: ctx && ctx.os && typeof ctx.os.pickOpenPath === 'function' ? pickFile : null,
        onAddFileBelow: (id, files) => {
          const n = flowRef.current && flowRef.current.nodes.find((x) => x.id === id)
          if (!n) return
          // measure now; the preview may still be loading (it vanishes while a new path is saved), so reserve
          // room for a full image preview (~250 px) to keep the new node clear of it
          const el = rootRef.current && rootRef.current.querySelector(`[data-fc-node="${id}"]`)
          const height = Math.max(el ? el.offsetHeight : 0, heightsRef.current[id] || 0, FILE_NODE_MIN_H)
          const added = addFileNodes(files, n.x, n.y + height + 40)
          for (const node of added) confirmPick(node.id, node.params && node.params.path)   // picked with Browse…
        }
      }) : null)
  }

  return h('div', { ref: rootRef, className: focusWin ? 'fc-root fc-focus' : 'fc-root', tabIndex: -1, onKeyDown, 'data-fc-focus-window': focusWin ? '1' : undefined },
    h('style', null, CSS),
    h(Header, {
      flows, flow, templates, saveState, saveError, run, menuOpen, setMenuOpen, paletteOpen, inspectorOpen,
      closeMenu: () => setMenuOpen(false),
      onOpen: (id) => latest.current.openFlow(id),
      onNew: newFlow,
      onFromTemplate: newFromTemplate,
      onDuplicate: duplicateFlow,
      onDelete: deleteFlow,
      onSaveTemplate: () => {
        setMenuOpen(false)
        if (flowRef.current) setTemplateDialog({ mode: 'save' })
      },
      onEditTemplate: (t) => {
        setMenuOpen(false)
        setTemplateDialog({ mode: 'edit', template: t })
      },
      onDeleteTemplate: removeTemplate,
      onRename: (name) => edit((f) => ({ ...f, name })),
      onRun: (opts) => startRun(opts),
      onStop: stopRun,
      onLayout: tidy,
      onGenerate: () => dispatchGeneration({ type: 'open' }),
      generationBusy: generation.busy,
      onAsk: askHermes,
      onShowHermes: focusWin ? leaveFocusWindow : null,
      onUndo: () => setDoc(undoDoc),
      onRedo: () => setDoc(redoDoc),
      canUndo: doc.undo.length > 0,
      canRedo: doc.redo.length > 0,
      togglePalette: () => {
        sset('paletteOpen', !paletteOpen)
        setPaletteOpen(!paletteOpen)
      },
      toggleInspector: () => {
        sset('inspectorOpen', !inspectorOpen)
        setInspectorOpen(!inspectorOpen)
      }
    }),
    conflict ? h('div', { className: 'fc-banner warn' },
      h(Icon, { name: 'warning' }),
      h('span', null, 'This flow was changed elsewhere (maybe by Hermes) while you were editing.'),
      h('span', { className: 'fc-grow' }),
      h('button', { className: 'fc-btn', onClick: loadTheirs }, 'Load latest'),
      h('button', { className: 'fc-btn', onClick: keepMine }, 'Keep mine')) : null,
    saveState === 'error' ? h('div', { className: 'fc-banner bad' },
      h(Icon, { name: 'error' }),
      h('span', null, `Saving failed: ${saveError}`),
      h('span', { className: 'fc-grow' }),
      h('button', { className: 'fc-btn', onClick: () => persist() }, 'Retry')) : null,
    connLost ? h('div', { className: 'fc-banner bad' },
      h(Icon, { name: 'debug-disconnect' }),
      h('span', null, 'Lost contact with the Arachne Flow backend.'),
      h('span', { className: 'fc-grow' }),
      h('button', { className: 'fc-btn', onClick: () => latest.current.retryConnection() }, h(Icon, { name: 'refresh' }), 'Retry')) : null,
    notice ? h('div', { className: `fc-notice ${notice.tone}`, onClick: () => setNotice(null) },
      h(Icon, { name: NOTICE_ICON[notice.tone] || 'info' }), h('span', null, notice.text)) : null,
    body,
    flow ? h(RunLog, {
      run, flow, types, open: logOpen, onSelect: select, timings, nameOf,
      onToggle: () => {
        sset('logOpen', !logOpen)
        setLogOpen(!logOpen)
      }
    }) : null,
    generation.open ? h(DialogFrame, {
      label: 'Build with Hermes',
      scrim: { 'data-fc-generate-dialog': '1' },
      onCancel: () => dispatchGeneration({ type: 'close' })
    }, h('div', { className: 'fc-generate-modal' }, h(GenerateComposer, {
      flow, generation,
      onEdit: (patch) => dispatchGeneration({ type: 'edit', patch }),
      onSubmit: generateFlow,
      onStop: stopGeneration,
      onCancel: () => dispatchGeneration({ type: 'close' }),
    }))) : null,
    templateDialog ? h(TemplateDialog, {
      key: templateDialog.mode === 'edit' ? `edit-${templateDialog.template.id}` : 'save',
      mode: templateDialog.mode,
      initial: templateDialog.mode === 'edit' ? templateDialog.template : { name: flow ? flow.name : '', description: flow ? flow.description : '' },
      inputs: templateDialog.mode === 'save' ? filledInputs(flow) : [],
      busy: templateBusy,
      onSubmit: submitTemplate,
      onCancel: () => {
        setTemplateDialog(null)
        focusRoot()
      }
    }) : null,
    valueViewer && flow && run && valueViewer.flowId === flow.id && valueViewer.runId === run.id && flow.nodes && flow.nodes.find((n) => n.id === valueViewer.nodeId) ? h(ValueViewer, {
      api,
      run,
      flow,
      node: flow.nodes.find((n) => n.id === valueViewer.nodeId),
      port: valueViewer.port,
      field: valueViewer.field || 'outputs',
      onClose: () => setValueViewer(null),
      onSelectPort: ({ nodeId, port }) => {
        const nextNodeId = nodeId || valueViewer.nodeId
        if (flow.nodes && flow.nodes.some((n) => n.id === nextNodeId)) {
          setValueViewer({
            flowId: flow.id,
            runId: run.id,
            nodeId: nextNodeId,
            field: valueViewer.field || 'outputs',
            port: port != null ? port : null,
          })
        }
      },
      onOpenMedia: (args) => {
        setValueViewer(null)
        openMedia(args)
      },
    }) : null,
    lightboxAt >= 0 && run ? h(Lightbox, {
      api, ctx, runId: run.id, items: mediaItems, at: lightboxAt,
      onMove: (i) => mediaItems[i] && setLightbox(mediaItems[i].key),
      onClose: () => {
        setLightbox(null)
        focusRoot()
      }
    }) : null)
}

// ---------------------------------------------------------------- exports
// U-12: a reload hot-swaps a fresh copy of this module, so nothing app-side may inherit the old run's data:
// media previews, file previews and model/tool catalogs are all thrown away when the host disposes the plugin.
function clearCaches() {
  MODEL_THUMBNAILS.clear()
  MEDIA_CACHE.clear()
  FILE_NODE_CACHE.clear()
  llmInfoCache.clear()
  modelInfoCache.clear()
  optionsCache.clear()
}
const cacheSizes = () => ({
  media: MEDIA_CACHE.size,
  fileNode: FILE_NODE_CACHE.size,
  llmInfo: llmInfoCache.size,
  modelInfo: modelInfoCache.size,
  toolOptions: optionsCache.size
})
const _internals = {
  Palette, MiniMedia, ModelThumbnail, createModelThumbnailCache, menuMatch, flowMenuModel, flowPickerChoice, FlowPicker, triggerWhen, triggerLines, TriggerGuard, isTriggerType,
  runGenerationJob, llmModelsHint, generationJobError, generationStatus, generationElapsed, GenerateComposer, measureNodeSizes, GENERATE_POLL_MS,
  NODE_W, HEAD_H, PORTS_TOP, ROW_H, GRID, MIN_ZOOM, MAX_ZOOM, COLLAPSE_AFTER, VISIBLE_OPTIONAL, UNDO_LIMIT, POLL_MS,
  // U-4: pure helpers used by the canvas render path (tested in tests/js/perf.test.mjs)
  edgePathWorld, rafThrottle, NodeCard, nodeCardPropsEqual, Canvas,
  templatePlaceholders, nodePorts, visibleInputs, nodeLayout, portPosition, edgePath, worldToScreen, screenToWorld,
  zoomAt, fitView, rectSelect, snap, compatible, addNode, removeNodes, moveNodes, ancestors, descendants, reaches,
  canConnect, connect, disconnect, updateNode, cloneSubgraph, insertSubgraph, defaultParams, freeSpot, applyEdit,
  disarmCopiedNode, messagingArmed, messagingScope,
  undoDoc, redoDoc, applyRemote, mergeRun, mergeNodeState, generateInitial, generateReducer, generationBody, generationSummary, filterTypes, groupByCategory, toolChoices, changeNodeType, nodesBox, placeSubgraph, placeInView, pruneSelection, askPrompt, draftToComposer, rememberType, resolveRecentTypes, formatMs, ago, parseRestError, findMedia, runMediaList, nodeOutputItems, MiniThumb, lightboxZoom, previewString,
  fileFilters, checkDropFile, dropSpots, fileNodes, pickedFilesWith, baseName, formatBytes, popoutFlow, takePopout, POPOUT_KEY, FOCUS_WINDOW_KEY, SHARED,
  // small review findings (E0): per-window hand-off ownership, boot navigation retries, copy feedback
  shouldConsumeHandoff, peekPopout, clearPopout, windowIdGet, WINDOW_ID_KEY, shouldRetryNavigate, clipboardOk,
  splitTemplates, filledInputs,
  muteTitles, WIRE_TIP_CSS, paramSummary, paramInfo, splitFields, inspectorGroups, inspectorSummaries, Fold, edgeRouteWorld, roundedPath, edgeFocus, paletteSections, presetGroups, nodeSubline, nodeFooter, toolProvider, autoPick, modelSetting, paletteFolds, allFoldsOpen, setAllFolds, typeTip, typeTipText, modelGroups, filterModelGroups, optionGroups, toolOptionCopy, formatPrice, fillHeight, parseNumberInput, saveBlocker, persistForFlowChange, spacePans, canvasClipboardKey, connectionState, recoveryPlan, LOST_CONTACT_AFTER, categoryColor, portColor, indexTypes, countStatuses, isRunActive, makeApi, loadRunValue, isEditableTarget,
  // accessibility (U-8): keyboard decisions for menus and dialogs
  menuKeyNav, menuRowsIn, FlowMenu, trapFocus, activatesOn,
  modelSetting, fieldControl, rangeHint, numberIssue, choiceValue, multiValues, mediaValues, addMediaPath, toggleChoice, effectiveValues, estimateCost,
  toolOptionLabel, extraVisible, extraValues, extraSpec, llmPickerInfo, llmInfoRows, estimateLlmCost,
  cacheOn, cachePatch, formatClock, typicalShort, timingModel, indexTimings, expectedTime, timingLines, typeTiming, statusTip, runTip, portTip,
  errorTip, tipText, HEADER_TIPS, switchCases, branchPort, edgeDead, branchLabel, MAX_CASES,
  loopBodies, itemsFinished, itemsLine, badgeLabel, itemRows,
  applyNodeStatus, setMediaItem, valuePorts, ValueViewer, formatJsonText, JsonInputEditor, SafeMarkdown, MarkdownEditor,
  fitImageLimit, wiredItemCount, parseGlb, readAccessor, collectModel, fitOrbit, orbitEye, orbitMatrix, computeNormals, uploadModelTexture, createModelRenderer, bindLightboxPan,
  // lifecycle (U-12): the byte-capped media cache rule, the caches themselves and the dispose hook
  mediaEntryBytes, mediaCacheBytes, evictMediaCache, fetchMedia, clearCaches, cacheSizes, MEDIA_CACHE_MAX_BYTES,
  caches: { media: MEDIA_CACHE, fileNode: FILE_NODE_CACHE, llmInfo: llmInfoCache, modelInfo: modelInfoCache, toolOptions: optionsCache }
}

export default {
  id: PLUGIN_ID,
  name: 'Arachne Flow',
  _internals,
  register(ctx) {
    // Everything this module wires to the outside goes through ctx when the host offers the lifecycle helpers
    // (U-12): bare timers/listeners are invisible to the host, so they would survive disable and every hot reload.
    const disposal = []
    const later = (fn, ms) => {
      if (typeof ctx.setTimeout === 'function') disposal.push(ctx.setTimeout(fn, ms))
      else {
        const t = setTimeout(fn, ms)
        disposal.push(() => clearTimeout(t))
      }
    }
    const subscribe = (type, fn) => {
      if (typeof ctx.onEvent === 'function') return ctx.onEvent(type, fn) // tracked by the host
      if (typeof host.onEvent !== 'function') return null
      const off = host.onEvent(type, fn)
      if (typeof off === 'function') disposal.push(off)
      return off
    }
    // One place to undo it all: scoped timers and fallback subscriptions, then the module-level caches (a reload
    // must not inherit the previous copy's media previews or model catalogs).
    const dispose = () => {
      const fns = disposal.splice(0)
      fns.forEach((fn) => {
        try {
          fn()
        } catch {
          /* one bad disposer must not keep the rest alive */
        }
      })
      clearCaches()
    }
    if (typeof ctx.onDispose === 'function') ctx.onDispose(dispose)
    const navigate = () => {
      if (typeof host.navigate === 'function') host.navigate(ROUTE)
    }
    ctx.register({ id: 'page', area: sdk.ROUTES_AREA, data: { path: ROUTE }, render: () => h(ArachneFlowPage, { ctx }) })
    ctx.register({ id: 'nav', area: sdk.SIDEBAR_NAV_AREA, data: { path: ROUTE, label: 'Arachne Flow', codicon: 'type-hierarchy' } })
    if (sdk.PALETTE_AREA) {
      ctx.register({
        id: 'palette-open',
        area: sdk.PALETTE_AREA,
        data: { id: 'arachne-flow.open', label: 'Arachne Flow: Open', keywords: ['flow', 'canvas', 'nodes', 'pipeline', 'workflow'], run: navigate }
      })
      ctx.register({
        id: 'palette-run',
        area: sdk.PALETTE_AREA,
        data: {
          id: 'arachne-flow.run',
          label: 'Arachne Flow: Run current flow',
          keywords: ['flow', 'run', 'execute', 'pipeline'],
          run: () => {
            if (SHARED.runCurrent) SHARED.runCurrent()
            else {
              SHARED.pendingRun = true
              navigate()
            }
          }
        }
      })
    }
    // G4: a window opened by "Open in new window" boots on the app's start route; take the hand-off (once, so no
    // other window acts on it) and show the same flow. Only a window that is not the one that left it takes it
    // (U-14: a hot reload of the source window must not turn it into the plugin-only window), and the entry stays
    // put for the peer when we do not take it. Re-navigate while the page has not mounted yet, because the peer
    // window's own boot can settle on its start route after this runs.
    const myId = windowIdGet()
    const handoff = peekPopout(ctx.storage)
    const now = Date.now()
    const takeIt = shouldConsumeHandoff(handoff, myId, now)
    const popped = takeIt ? popoutFlow(handoff, now) : null
    if (takeIt) clearPopout(ctx.storage)
    if (popped) focusWindowSet(true)
    else SHARED.focusWindow = focusWindowGet() // a reloaded Arachne Flow window stays one
    if (SHARED.focusWindow) {
      // this window exists for Arachne Flow: show the page (the popped flow, else the last one) right away
      if (popped) SHARED.pendingOpen = popped
      navigate()
      for (const ms of [700, 2000, 4500]) later(() => { if (shouldRetryNavigate(SHARED.pageMounted, SHARED.listeners.size)) navigate() }, ms)
    }
    subscribe(evt('ui.open'), (msg) => {
      const id = msg && msg.payload ? msg.payload.flow_id : null
      if (SHARED.listeners.size) SHARED.listeners.forEach((fn) => fn(id))
      else SHARED.pendingOpen = id
      navigate()
    })
  }
}
