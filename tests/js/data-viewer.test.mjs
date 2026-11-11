// Data outputs on a node card: every finished output value is a row you can open, and the card never hides a
// value that exists. Media keeps its lightbox; everything else opens through one seam:
//
//   onOpenValue({ nodeId, port })            one output port -> viewer shows that value
//   onOpenValue({ nodeId, port: null })      the "+N" button  -> viewer shows every output of the node
//
// The contract these tests demand (the implementation is free in layout, wording and viewer design):
//   1. one row per output value, in port order, also for number, boolean false, null and empty string; a row
//      shows the value truthfully (`false`, `null`, `0`, an explicit empty marker) and never claims the node
//      lost data (`data-fc-minis` counts every stored output, not only the visible four);
//   2. a value row is a semantic button (native <button>, or role=button with tabIndex 0 and Enter/Space) whose
//      accessible name names its port, and it stops click *and* pointerdown propagation so the node is neither
//      selected nor dragged;
//   3. media rows keep `onOpenMedia({nodeId, port, index, path})` and are not routed through `onOpenValue`;
//   4. an object output that wraps media keeps exactly one JSON row of its own next to the media rows;
//   5. more than four outputs: four rows plus a "+N" button that opens the all-outputs view;
//   6. running / queued / skipped / error / no-run / no-outputs render no rows, no "+N", and do not throw.
//
// Rendered with the same hook stubs as node-outputs.test.mjs: no effects run, nothing is fetched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals

// ---------------------------------------------------------------- tree helpers
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const c of node) walk(c, visit)
    return
  }
  visit(node)
  const ch = node.props && node.props.children
  if (ch !== undefined) walk(ch, visit)
}
const findAll = (tree, pred) => {
  const out = []
  walk(tree, (el) => {
    if (el.props && pred(el.props, el)) out.push(el)
  })
  return out
}
const textOf = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node !== 'object') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props && node.props.children)
}
const minis = (tree) => findAll(tree, (p) => p['data-fc-mini'] !== undefined)
const more = (tree) => findAll(tree, (p) => p['data-fc-mini-more'] !== undefined)
const labelOf = (row) => textOf(findAll(row, (p) => p.className === 'fc-mini-label')[0]).trim()
const badgeOf = (row) => textOf(findAll(row, (p) => p.className === 'fc-mini-badge')[0]).trim()
/** The value cell of a row (text / file line); thumbnails have no text. */
const bodyOf = (row) => {
  const cell = findAll(row, (p) => p.className === 'fc-mini-text' || p.className === 'fc-mini-file')[0]
  return cell ? textOf(cell).trim() : ''
}
/** What a reader can actually see of the value: its text cell plus its badge. */
const visible = (row) => `${bodyOf(row)} ${badgeOf(row)}`.trim()
const totalOf = (tree) => {
  const wrap = findAll(tree, (p) => p['data-fc-minis'] !== undefined)[0]
  return wrap ? Number(wrap.props['data-fc-minis']) : 0
}

// ---------------------------------------------------------------- semantics helpers
const isButton = (el) => el && el.type === 'button'
const isRoleButton = (el) => el && el.props && el.props.role === 'button'
/** The element a reader would press for this row: the row itself, or the button inside it. */
const activator = (row) => {
  if (isButton(row) || isRoleButton(row)) return row
  return findAll(row, (p, el) => isButton(el) || p.role === 'button')[0] || null
}
const accessibleName = (el) => String((el.props && (el.props['aria-label'] || el.props.title)) || textOf(el)).trim()
const event = () => ({ stopped: 0, prevented: 0, stopPropagation() { this.stopped += 1 }, preventDefault() { this.prevented += 1 } })

/** The pressable element of a row: its button, else the row itself (media rows are pressable rows today). */
const seat = (row) => activator(row) || row

/** Mouse activation, exactly what a pointer click reaches. */
const click = (el) => {
  assert.equal(typeof el.props.onClick, 'function', 'the row accepts a click')
  const e = event()
  el.props.onClick(e)
  return e
}
/** Keyboard activation; a native button gets its click, a role=button must handle Enter and Space. */
const keyboard = (el, key = 'Enter') => {
  if (isButton(el)) return click(el)
  assert.equal(el.props.tabIndex, 0, 'a role=button row is in the tab order')
  assert.equal(typeof el.props.onKeyDown, 'function', 'a role=button row handles keys itself')
  const e = { key, ...event() }
  el.props.onKeyDown(e)
  return e
}
/** The pointerdown guard: without it the node drag swallows the press. */
const pointerdownGuard = (row, act) => {
  const candidates = [act, row, ...findAll(row, () => true)]
  return candidates.find((el) => el && el.props && typeof el.props.onPointerDown === 'function') || null
}

// ---------------------------------------------------------------- fixture
const OUTPUTS = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name, type: 'any', label: `Out ${name.toUpperCase()}` }))
const SPEC = { type: 'tool:multi', kind: 'tool', title: 'Multi', category: 'Tools', inputs: [], outputs: OUTPUTS, params: [] }
const TYPES = I.indexTypes({ types: [SPEC], compat: { any: ['any'] }, port_types: { any: { color: '#999', label: 'Any' } } })
const NODE = { id: 'n1', type: 'tool:multi', x: 0, y: 0, params: {} }

const img = (n = 'a') => ({ $media: { kind: 'image', path: `C:/pics/${n}.png`, file: `${n}.png` } })
const aud = (n = 'a') => ({ $media: { kind: 'audio', path: `C:/snd/${n}.mp3`, file: `${n}.mp3` } })
const done = (outputs, extra = {}) => ({ status: 'done', ms: 5, outputs, ...extra })

const card = (state, extra = {}) => {
  const spec = extra.spec || SPEC
  return I.NodeCard({
    node: NODE, spec, layout: I.nodeLayout(NODE, spec, new Set(), false), types: TYPES, state, runId: 'r1', flowId: 'f1',
    selected: false, connectedIn: new Set(), connectedOut: new Set(), expanded: false, api: null, wires: {},
    onDown: () => {}, onPortDown: () => {}, onToggleExpand: () => {}, onOpenInspector: () => {}, nameOf: (id) => id,
    ...extra.props
  })
}
const opened = () => {
  const calls = []
  const fn = (arg) => calls.push(arg)
  fn.calls = calls
  return fn
}
const rowFor = (tree, label) => minis(tree).find((r) => labelOf(r) === label)

// ---------------------------------------------------------------- 1. every value is a row and opens
test('text, JSON, number, false, null and empty string each get their own openable row', () => {
  const cases = [
    ['hello world', /hello world/],
    [{ k: 1 }, /"k"/],
    [42, /\b42\b/],
    [0, /\b0\b/],
    [false, /false/i],
    [null, /null/i],
    ['', /empty|blank|""|''|none/i]
  ]
  for (const [value, detail] of cases) {
    const onOpenValue = opened()
    const tree = card(done({ a: value }), { props: { onOpenValue } })
    const rows = minis(tree)
    assert.equal(rows.length, 1, `${JSON.stringify(value)}: exactly one row, nothing dropped`)
    assert.equal(totalOf(tree), 1, `${JSON.stringify(value)}: the card counts it`)
    const row = rows[0]
    assert.equal(labelOf(row), 'Out A', `${JSON.stringify(value)}: the row keeps the port label`)
    assert.match(badgeOf(row), /\S/, `${JSON.stringify(value)}: the row has a badge`)
    assert.match(visible(row), detail, `${JSON.stringify(value)}: the value is visible, not blank`)
    assert.equal(row.props['data-fc-open-media'], undefined, `${JSON.stringify(value)}: a value is not a medium`)

    const act = activator(row)
    assert.ok(act, `${JSON.stringify(value)}: the row is a button`)
    click(act)
    assert.deepEqual(onOpenValue.calls, [{ nodeId: 'n1', port: 'a' }], `${JSON.stringify(value)}: opening reports the port`)
  }
})

// ---------------------------------------------------------------- 2. semantic button + keyboard
test('a value row is a semantic button with the port in its name and works from the keyboard', () => {
  const onOpenValue = opened()
  const tree = card(done({ a: 'hello' }), { props: { onOpenValue } })
  const row = minis(tree)[0]
  const act = activator(row)
  assert.ok(act, 'one pressable element')
  assert.ok(accessibleName(act).includes('Out A') || accessibleName(row).includes('Out A'),
    `the button announces its port (name: ${JSON.stringify(accessibleName(act))})`)
  if (isButton(act)) {
    assert.notEqual(act.props.disabled, true, 'the button is enabled')
    assert.notEqual(act.props.tabIndex, -1, 'the button is in the tab order')
  } else {
    assert.equal(act.props.tabIndex, 0, 'role=button rows are focusable')
  }
  const e = keyboard(act, 'Enter')
  assert.deepEqual(onOpenValue.calls, [{ nodeId: 'n1', port: 'a' }], 'Enter opens the value')
  if (!isButton(act)) {
    assert.equal(e.stopped > 0, true, 'the row does not leak Enter to the canvas shortcuts')
    keyboard(act, ' ')
    assert.equal(onOpenValue.calls.length, 2, 'Space opens the value too')
  }
})

// ---------------------------------------------------------------- 3. no drag / no selection
test('pressing a value row neither starts a node drag nor selects the node', () => {
  const onOpenValue = opened()
  const tree = card(done({ a: 'hello' }), { props: { onOpenValue } })
  const row = minis(tree)[0]
  const act = activator(row)
  assert.ok(act, 'the row is a button')

  const clickEvent = click(act)
  assert.ok(clickEvent.stopped > 0, 'the click does not bubble into the card (selection / double-click inspector)')

  const guard = pointerdownGuard(row, act)
  assert.ok(guard, 'the row guards pointerdown')
  const down = { button: 0, ...event() }
  guard.props.onPointerDown(down)
  assert.ok(down.stopped > 0, 'a left press on the row does not reach the node drag handler')
})

test('a value row without a handler still renders and never throws', () => {
  let tree
  assert.doesNotThrow(() => {
    tree = card(done({ a: 'hello', b: null }))
  })
  assert.equal(minis(tree).length, 2, 'the data is shown even when no viewer is wired')
  for (const row of minis(tree)) {
    const act = activator(row)
    if (!act) continue
    assert.doesNotThrow(() => act.props.onClick && click(act), 'a dead button is not an exception')
  }
})

// ---------------------------------------------------------------- 4. media stays on onOpenMedia
test('media rows still open the lightbox and are not routed through the value viewer', () => {
  const viewed = opened()
  const media = opened()
  const tree = card(done({ a: img('cat'), b: aud('song') }), { props: { onOpenValue: viewed, onOpenMedia: media } })
  const rows = minis(tree)
  assert.equal(rows.length, 2)
  click(seat(rows[0]))
  click(seat(rows[1]))
  assert.deepEqual(media.calls, [
    { nodeId: 'n1', port: 'a', index: 0, path: 'C:/pics/cat.png' },
    { nodeId: 'n1', port: 'b', index: 0, path: 'C:/snd/song.mp3' }
  ], 'images and audio open the media viewer with their file')
  assert.deepEqual(viewed.calls, [], 'media never goes through the value seam')
})

// ---------------------------------------------------------------- 5. nested media keeps its JSON
test('an object output wrapping media keeps one JSON row of its own, next to the media rows', () => {
  const onOpenValue = opened()
  const value = { images: [img('1'), img('2')], caption: 'two views' }
  const tree = card(done({ a: value, b: 'done' }), { props: { onOpenValue } })
  const rows = minis(tree)
  assert.equal(rows.length, 4, 'two media rows + one JSON row for the object + the text output')
  assert.equal(totalOf(tree), 4, 'nothing is lost in the count')

  const images = rows.filter((r) => r.props['data-fc-mini'] === 'image')
  const json = rows.filter((r) => r.props['data-fc-mini'] === 'json')
  const texts = rows.filter((r) => r.props['data-fc-mini'] === 'text')
  assert.equal(images.length, 2, 'both wrapped pictures are still listed')
  assert.equal(json.length, 1, 'the object is not flattened away into links')
  assert.equal(texts.length, 1, 'the plain text output stays a text row')
  assert.equal(json[0].props['data-fc-open-media'], undefined, 'the JSON row is a value, not a medium')
  assert.equal(labelOf(json[0]), 'Out A', 'the JSON row keeps the port label')
  assert.match(visible(json[0]), /two views/, 'the data next to the media survives in the JSON row')
  for (const image of images) {
    assert.equal(image.props['data-fc-open-media'], undefined, 'nested media has no media route')
  }

  click(activator(json[0]))
  assert.deepEqual(onOpenValue.calls, [{ nodeId: 'n1', port: 'a' }], 'the whole object opens as a value')
})

// ---------------------------------------------------------------- 6. falsy values are not data loss
test('null, false and empty strings are counted and shown, not reported as missing output', () => {
  const tree = card(done({ a: null, b: false, c: '', d: 0, e: 'x', f: {} }))
  const rows = minis(tree)
  assert.equal(rows.length, 4, 'four compact rows')
  assert.equal(totalOf(tree), 6, 'the card counts all six stored outputs')
  assert.deepEqual(rows.map(labelOf), ['Out A', 'Out B', 'Out C', 'Out D'], 'the falsy ones are real rows')
  assert.match(visible(rows[0]), /null/i, 'null stays null')
  assert.match(visible(rows[1]), /false/i, 'false stays false')
  assert.match(visible(rows[2]), /empty|blank|null|none|""|''|—|–/i, 'an empty string is shown as empty, not dropped')
  assert.match(visible(rows[3]), /\b0\b/, 'zero is a value')
  assert.equal(more(tree).length, 1, 'the hidden two are signalled')
  assert.equal(textOf(more(tree)[0]).trim(), '+2')
  assert.doesNotMatch(textOf(tree), /no outputs?|nothing to show|output lost/i, 'no false data-loss claim')
})

// ---------------------------------------------------------------- 7. +N opens everything
test('with more than four outputs "+N" opens one view that can reach every output', () => {
  const onOpenValue = opened()
  const onOpenMedia = opened()
  const tree = card(done({ a: img('1'), b: 'bee', c: 2, d: false, e: 'five', f: { f: 6 } }),
    { props: { onOpenValue, onOpenMedia } })
  assert.equal(totalOf(tree), 6, 'all six outputs are counted')
  assert.equal(minis(tree).length, 4, 'four rows on the card')
  assert.deepEqual(minis(tree).map(labelOf), ['Out A', 'Out B', 'Out C', 'Out D'])

  const ports = []
  for (const row of minis(tree)) {
    const valueBefore = onOpenValue.calls.length
    const mediaBefore = onOpenMedia.calls.length
    if (row.props['data-fc-mini'] === 'image') {
      click(seat(row))
      assert.equal(onOpenMedia.calls.length, mediaBefore + 1, 'the image row opens its medium')
      assert.equal(onOpenValue.calls.length, valueBefore, 'and not the value viewer')
      continue
    }
    assert.ok(activator(row), `${labelOf(row)}: the value row is a button`)
    click(seat(row))
    assert.equal(onOpenValue.calls.length, valueBefore + 1, 'every value row opens')
    ports.push(onOpenValue.calls[onOpenValue.calls.length - 1].port)
  }
  assert.deepEqual(ports, ['b', 'c', 'd'], 'each value row reports its own port')
  assert.equal(new Set(ports).size, 3, 'no two rows collapse onto one port')
  assert.deepEqual(onOpenMedia.calls, [{ nodeId: 'n1', port: 'a', index: 0, path: 'C:/pics/1.png' }],
    'the image row opens its medium, the value rows open their value')

  const rest = more(tree)
  assert.equal(rest.length, 1)
  assert.equal(textOf(rest[0]).trim(), '+2')
  const act = activator(rest[0])
  assert.ok(act, 'the "+N" control is a button')
  assert.match(accessibleName(act) + ' ' + accessibleName(rest[0]), /2/, 'it says how many outputs are hidden')
  const e = click(act)
  assert.ok(e.stopped > 0, 'opening the full list does not select the node')
  assert.deepEqual(onOpenValue.calls[onOpenValue.calls.length - 1], { nodeId: 'n1', port: null },
    'port null means "every output of this node"')
})

// ---------------------------------------------------------------- 8. other run states
test('running, queued, skipped, error and absent outputs render no rows and invent nothing', () => {
  const states = [
    ['running', { status: 'running' }],
    ['queued', { status: 'queued' }],
    ['skipped', { status: 'skipped' }],
    ['error with outputs', { status: 'error', error: 'boom', outputs: { a: 'partial' } }],
    ['done without an outputs object', { status: 'done' }],
    ['done with empty outputs', done({})],
    ['no run at all', null]
  ]
  for (const [why, state] of states) {
    const onOpenValue = opened()
    let tree
    assert.doesNotThrow(() => {
      tree = card(state, { props: { onOpenValue } })
    }, why)
    assert.equal(minis(tree).length, 0, `${why}: no value rows`)
    assert.equal(more(tree).length, 0, `${why}: no "+N"`)
    assert.equal(findAll(tree, (p) => p['data-fc-minis'] !== undefined).length, 0, `${why}: no rows wrapper`)
    assert.deepEqual(onOpenValue.calls, [], `${why}: nothing opens by itself`)
    if (state && state.status === 'error') {
      assert.equal(findAll(tree, (p) => p['data-fc-run-error'] === '1').length, 1, 'an error still shows its message')
    }
  }
  // a cached node is finished: its outputs are rows like any other
  const cached = card({ status: 'cached', outputs: { a: 'from cache' } })
  assert.equal(minis(cached).length, 1, 'cached outputs are rows too')
  assert.equal(labelOf(minis(cached)[0]), 'Out A')
})

// ---------------------------------------------------------------- 9. wiring
test('the canvas hands the value seam to every card and forwards both arguments', () => {
  const spec = {
    type: 'tool:echo', kind: 'tool', title: 'Echo', category: 'Text',
    inputs: [{ name: 'text', type: 'text', required: true, label: 'Text' }],
    outputs: [{ name: 'text', type: 'text', label: 'Text' }],
    params: [{ name: 'text', type: 'text', default: '' }]
  }
  const types = I.indexTypes([spec], { text: ['text', 'any'] }, { text: { color: '#6ea8fe', label: 'Text' } })
  const flow = {
    id: 'f1',
    name: 'Echo',
    nodes: [{ id: 'n_a', type: 'tool:echo', x: 40, y: 60, params: { text: 'hello' } }],
    edges: []
  }
  const layouts = { n_a: I.nodeLayout(flow.nodes[0], spec, new Set(), false) }
  const opened = []
  const tree = I.Canvas({
    flow, types, layouts,
    run: { id: 'r_1', status: 'done', nodes: { n_a: { status: 'done', outputs: { text: 'hello' } } } },
    view: { x: 0, y: 0, zoom: 1 },
    setView: () => {},
    selection: [],
    selectedEdge: null,
    issuesByNode: {},
    connectedIn: {},
    connectedOut: {},
    expanded: new Set(),
    timings: null,
    loopOwners: {},
    wireCounts: {},
    api: null,
    heightsRef: { current: {} },
    needFitRef: { current: false },
    nameOf: (id) => id,
    onToggleExpand: () => {},
    onOpenInspector: () => {},
    onOpenValue: (arg) => opened.push(arg),
    onFocusRoot: () => {},
    onSelect: () => {},
    onSelectEdge: () => {},
    onMove: () => {},
    onMoveEnd: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    onDropType: () => {},
    onDuplicate: () => {},
    onCopy: () => {},
    onCut: () => {},
    onPaste: () => {},
    canPaste: () => false,
    onDelete: () => {},
    onSelectAll: () => {},
    onTidy: () => {},
    onDropFiles: () => {},
    uploading: false,
    savedRev: 1
  })
  const cards = findAll(tree, (p, el) => el.type === I.NodeCard && p.node && p.node.id === 'n_a')
  assert.equal(cards.length, 1, 'the canvas renders the node card')
  const props = cards[0].props
  assert.equal(typeof props.onOpenValue, 'function', 'the card gets an onOpenValue callback')
  props.onOpenValue({ nodeId: 'n_a', port: 'text' })
  assert.deepEqual(opened, [{ nodeId: 'n_a', port: 'text' }], 'the callback reaches the page handler unchanged')
})
