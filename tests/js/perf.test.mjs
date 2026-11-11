// U-4: canvas render cost. Panning/zooming must move one transform, not rebuild every edge path; a node drag
// must commit at most one document update per frame; node cards must skip re-rendering when their own data did
// not change. The rendered components need a DOM, so this covers the pure helpers the canvas is built from plus
// the structural facts (memoized card, world-space edges) that would silently regress.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadPlugin, loadReactStub } from './load.mjs'

const I = (await loadPlugin())._internals
const { withHookState } = await loadReactStub()
const SOURCE = readFileSync(new URL('../../desktop/plugin.js', import.meta.url), 'utf8')

const walkVdom = (node, visit) => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const c of node) walkVdom(c, visit)
    return
  }
  visit(node)
  const ch = node.props && node.props.children
  if (ch !== undefined) walkVdom(ch, visit)
}

const makeCanvasFixture = (overrides = {}) => {
  const spec = {
    type: 'tool:echo',
    title: 'Echo',
    category: 'Text',
    inputs: [{ name: 'text', type: 'text', required: true, label: 'Text' }],
    outputs: [{ name: 'text', type: 'text', label: 'Text' }],
    params: [{ name: 'text', type: 'text', default: '' }]
  }
  const types = I.indexTypes([spec], { text: ['text', 'any'] }, { text: { color: '#6ea8fe', label: 'Text' } })
  const flow = {
    id: 'f_perf',
    name: 'Perf',
    nodes: [
      { id: 'n_a', type: 'tool:echo', x: 40, y: 60, params: { text: 'hello' } },
      { id: 'n_b', type: 'tool:echo', x: 360, y: 140, params: { text: '' } }
    ],
    edges: [{ id: 'e_1', from: { node: 'n_a', port: 'text' }, to: { node: 'n_b', port: 'text' } }]
  }
  const connectedIn = { n_a: new Set(), n_b: new Set(['text']) }
  const connectedOut = { n_a: new Set(['text']), n_b: new Set() }
  const expanded = new Set()
  const layouts = {
    n_a: I.nodeLayout(flow.nodes[0], spec, connectedIn.n_a, false),
    n_b: I.nodeLayout(flow.nodes[1], spec, connectedIn.n_b, false)
  }
  return {
    flow,
    types,
    layouts,
    run: {
      id: 'r_1',
      status: 'running',
      nodes: {
        n_a: { status: 'running' },
        n_b: { status: 'queued' }
      }
    },
    view: { x: 0, y: 0, zoom: 1 },
    setView: () => {},
    selection: ['n_a'],
    selectedEdge: null,
    issuesByNode: {},
    connectedIn,
    connectedOut,
    expanded,
    timings: null,
    loopOwners: {},
    wireCounts: {},
    api: null,
    heightsRef: { current: {} },
    needFitRef: { current: false },
    nameOf: (id) => id,
    onToggleExpand: () => {},
    onOpenInspector: () => {},
    onOpenMedia: () => {},
    onFocusRoot: () => {},
    onSelect: () => {},
    onSelectEdge: () => {},
    onMove: () => {},
    onMoveEnd: () => {},
    savedRev: 1,
    ...overrides
  }
}

const numbers = (d) => (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number)

test('edgePathWorld equals the old screen path pulled back through the view transform', () => {
  const pairs = [
    [{ x: 0, y: 0 }, { x: 300, y: 40 }],
    [{ x: 120, y: 90 }, { x: -40, y: 260 }],
    [{ x: 10, y: 10 }, { x: 10, y: 400 }],
    [{ x: 5, y: 5 }, { x: 6, y: 300 }]
  ]
  const views = [
    { x: 0, y: 0, zoom: 1 },
    { x: 40, y: -20, zoom: 1.5 },
    { x: -300, y: 120, zoom: 0.35 },
    { x: 12, y: 8, zoom: 2.5 }
  ]
  for (const view of views) {
    for (const [a, b] of pairs) {
      const screen = numbers(I.edgePath(I.worldToScreen(view, a), I.worldToScreen(view, b), view.zoom))
      const world = numbers(I.edgePathWorld(a, b))
      assert.equal(world.length, 8, 'world path is M + one cubic')
      assert.equal(screen.length, 8)
      for (let i = 0; i < 8; i += 2) {
        const x = world[i] * view.zoom + view.x
        const y = world[i + 1] * view.zoom + view.y
        assert.ok(Math.abs(x - screen[i]) < 0.2, `x ${x} vs ${screen[i]} at zoom ${view.zoom}`)
        assert.ok(Math.abs(y - screen[i + 1]) < 0.2, `y ${y} vs ${screen[i + 1]} at zoom ${view.zoom}`)
      }
    }
  }
  // identity view: the world path is the screen path, character for character
  assert.equal(I.edgePathWorld({ x: 10, y: 20 }, { x: 310, y: 200 }), I.edgePath({ x: 10, y: 20 }, { x: 310, y: 200 }, 1))
})

test('rafThrottle runs once per frame with the last arguments', () => {
  const queued = new Map()
  let next = 1
  const raf = (cb) => {
    const id = next
    next += 1
    queued.set(id, cb)
    return id
  }
  const caf = (id) => queued.delete(id)
  const frame = () => {
    const [id, cb] = [...queued.entries()][0] || []
    if (!cb) throw new Error('no frame scheduled')
    queued.delete(id)
    cb()
  }
  const calls = []
  const fn = I.rafThrottle((...args) => calls.push(args), raf, caf)
  assert.equal(typeof fn.flush, 'function')
  fn(1)
  fn(2)
  fn(3)
  assert.equal(queued.size, 1, 'three calls in one frame schedule one frame')
  assert.equal(calls.length, 0, 'nothing runs before the frame')
  frame()
  assert.deepEqual(calls, [[3]], 'last arguments win')
  fn(4)
  assert.equal(queued.size, 1, 'a call after the frame schedules the next one')
  assert.equal(calls.length, 1)
  frame()
  assert.deepEqual(calls, [[3], [4]])
  // flush applies a pending call now (pointerup must not lose the last position) and leaves no stray frame
  fn(5)
  fn(6)
  fn.flush()
  assert.deepEqual(calls, [[3], [4], [6]])
  assert.equal(queued.size, 0, 'the frame flush ran is cancelled')
  fn.flush()
  assert.deepEqual(calls, [[3], [4], [6]], 'flush with nothing pending is a no-op')
  // cancel drops the pending call
  fn(7)
  fn.cancel()
  assert.equal(queued.size, 0)
  assert.deepEqual(calls, [[3], [4], [6]])
})

const block = (from, to) => {
  const start = SOURCE.indexOf(from)
  const end = SOURCE.indexOf(to, start)
  assert.ok(start > 0 && end > start, `source block "${from}" … "${to}" found`)
  return SOURCE.slice(start, end)
}

test('node cards are memoized', () => {
  assert.ok(SOURCE.includes('const NodeCard = memo(function NodeCard'), 'NodeCard must be wrapped in React.memo')
  assert.ok(/import \{[^}]*\bmemo\b[^}]*\} from 'react'/.test(SOURCE), 'memo comes from react')
  // a card must be given its own run state, never the whole run record
  assert.ok(SOURCE.includes('state: stateOf(n.id)'), 'cards get per-node run state')
  assert.equal(typeof I.NodeCard, 'function')
  assert.equal(I.NodeCard._memo, true)
  assert.equal(I.NodeCard.compare, I.nodeCardPropsEqual)
  assert.equal(typeof I.nodeCardPropsEqual, 'function')

  const hooks = {}
  const base = makeCanvasFixture()
  const cardsOf = (tree) => {
    const out = {}
    walkVdom(tree, (el) => {
      if (el.type === I.NodeCard && el.props && el.props.node) out[el.props.node.id] = el.props
    })
    return out
  }
  const first = cardsOf(withHookState(hooks, () => I.Canvas(base)))
  // Panning/zooming and recreating parent callbacks must leave every NodeCard's props shallow-equal.
  const panned = cardsOf(withHookState(hooks, () => I.Canvas({
    ...base,
    view: { x: 220, y: -110, zoom: 1.6 },
    nameOf: (id) => `node:${id}`,
    onToggleExpand: () => {},
    onOpenInspector: () => {},
    onOpenMedia: () => {}
  })))
  assert.equal(I.nodeCardPropsEqual(first.n_a, panned.n_a), true, 'n_a skips re-render on pan/zoom')
  assert.equal(I.nodeCardPropsEqual(first.n_b, panned.n_b), true, 'n_b skips re-render on pan/zoom')

  // Updating n_a's run status re-renders only n_a; n_b keeps identical props.
  const nextRun = {
    ...base.run,
    nodes: {
      n_a: { status: 'done', ms: 42 },
      n_b: base.run.nodes.n_b
    }
  }
  const afterNodeA = cardsOf(withHookState(hooks, () => I.Canvas({ ...base, run: nextRun })))
  assert.equal(I.nodeCardPropsEqual(first.n_a, afterNodeA.n_a), false, 'n_a re-renders when its own state changes')
  assert.equal(I.nodeCardPropsEqual(first.n_b, afterNodeA.n_b), true, 'n_b skips re-render when sibling state changes')
})

test('edges are drawn in world coordinates inside the transformed layer', () => {
  assert.ok(SOURCE.includes('function edgePathWorld('), 'edgePathWorld exists')
  assert.ok(!SOURCE.includes('worldToScreen(view, portPosition'), 'edge endpoints stay in world space')
  const edges = block('const edgeEls = flow.edges.map', 'const portClass = wire')
  assert.ok(edges.includes('edgePathWorld(pa, pb)'), 'visible and hit paths share one world-space geometry')
  assert.ok(edges.includes('screenToWorld(view, wire.point)'), 'the dragging wire converts its screen tip once')
  assert.ok(edges.includes('edgePathWorld(p0, tip)') && edges.includes('edgePathWorld(tip, p0)'),
    'the temporary wire is world-space too, either direction')
  assert.ok(!edges.includes('edgePath(p0, wire.point'), 'no screen-space path for the wire')
  // the svg carries the same transform as the node layer, so pan/zoom touches one attribute, not every path
  assert.ok(/className: 'fc-edges', style: \{ transform: `translate\(\$\{view\.x\}px, \$\{view\.y\}px\) scale\(\$\{view\.zoom\}\)` \}/.test(SOURCE),
    'the edge layer is transformed by the view')

  const hooks = {}
  const base = makeCanvasFixture({ view: { x: 0, y: 0, zoom: 1 } })
  const inspectEdges = (tree) => {
    let svg = null
    const paths = []
    walkVdom(tree, (el) => {
      if (el.type === 'svg' && el.props && el.props.className === 'fc-edges') svg = el
      if (el.type === 'path' && el.props && typeof el.props.className === 'string' && el.props.className.includes('fc-edge')) {
        paths.push(el.props.d)
      }
    })
    return { transform: svg && svg.props.style && svg.props.style.transform, paths }
  }
  const pa = I.portPosition(base.flow.nodes[0], base.layouts.n_a, 'out', 'text')
  const pb = I.portPosition(base.flow.nodes[1], base.layouts.n_b, 'in', 'text')
  const expectedD = I.edgePathWorld(pa, pb)
  const v1 = inspectEdges(withHookState(hooks, () => I.Canvas(base)))
  const v2 = inspectEdges(withHookState(hooks, () => I.Canvas({ ...base, view: { x: -140, y: 85, zoom: 1.75 } })))
  assert.equal(v1.transform, 'translate(0px, 0px) scale(1)')
  assert.equal(v2.transform, 'translate(-140px, 85px) scale(1.75)')
  assert.deepEqual(v1.paths, [expectedD, expectedD])
  assert.deepEqual(v2.paths, v1.paths, 'edge path strings stay byte-for-byte identical across pan/zoom')
})

test('a node drag commits through the frame throttle', () => {
  const drag = block("else if (d.kind === 'nodes')", "} else if (d.kind === 'rect'")
  assert.ok(drag.includes('moveRef.current(pos)'), 'pointermove does not call onMove directly')
  assert.ok(!drag.includes('p.onMove(pos)'), 'no unthrottled onMove in the drag path')
  assert.ok(SOURCE.includes('moveRef.current.flush()'), 'pointerup flushes the pending frame before the undo step')

  const prevWindow = globalThis.window
  const prevRaf = globalThis.requestAnimationFrame
  const prevCaf = globalThis.cancelAnimationFrame
  const winListeners = new Map()
  const frames = new Map()
  let nextFrame = 1
  globalThis.window = {
    addEventListener: (ev, fn) => {
      if (!winListeners.has(ev)) winListeners.set(ev, new Set())
      winListeners.get(ev).add(fn)
    },
    removeEventListener: (ev, fn) => {
      if (winListeners.has(ev)) winListeners.get(ev).delete(fn)
    }
  }
  globalThis.requestAnimationFrame = (cb) => {
    const id = nextFrame
    nextFrame += 1
    frames.set(id, cb)
    return id
  }
  globalThis.cancelAnimationFrame = (id) => frames.delete(id)
  try {
    const moves = []
    const ends = []
    const hooks = {}
    const base = makeCanvasFixture({
      onMove: (pos) => moves.push(pos),
      onMoveEnd: (startFlow) => ends.push(startFlow)
    })
    const tree = withHookState(hooks, () => I.Canvas(base))
    let cardA = null
    walkVdom(tree, (el) => {
      if (el.type === I.NodeCard && el.props && el.props.node && el.props.node.id === 'n_a') cardA = el
    })
    assert.ok(cardA, 'rendered NodeCard n_a found')
    cardA.props.onDown({
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 1,
      target: { closest: () => null },
      currentTarget: { setPointerCapture: () => {} },
      stopPropagation: () => {}
    }, base.flow.nodes[0])

    const emit = (ev, payload) => {
      for (const fn of [...(winListeners.get(ev) || [])]) fn(payload)
    }
    emit('pointermove', { clientX: 112, clientY: 108 })
    emit('pointermove', { clientX: 124, clientY: 118 })
    emit('pointermove', { clientX: 140, clientY: 130 })
    assert.equal(moves.length, 0, 'multiple pointermoves in one frame do not commit synchronously')
    assert.equal(frames.size, 1, 'exactly one animation frame is scheduled')

    const [[fid, fcb]] = [...frames.entries()]
    frames.delete(fid)
    fcb()
    assert.deepEqual(moves, [{ n_a: { x: 80, y: 90 } }], 'the frame commits only the latest position')

    // A further move followed by pointerup flushes the pending position before onMoveEnd.
    emit('pointermove', { clientX: 160, clientY: 150 })
    assert.equal(moves.length, 1)
    assert.equal(ends.length, 0)
    emit('pointerup', { clientX: 160, clientY: 150 })
    assert.deepEqual(moves, [{ n_a: { x: 80, y: 90 } }, { n_a: { x: 100, y: 110 } }])
    assert.equal(ends.length, 1, 'onMoveEnd runs after the flushed frame')
    assert.equal(frames.size, 0, 'flush cancelled the pending animation frame')
  } finally {
    globalThis.window = prevWindow
    globalThis.requestAnimationFrame = prevRaf
    globalThis.cancelAnimationFrame = prevCaf
  }
})
