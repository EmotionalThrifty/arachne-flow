// Pure helpers of desktop/plugin.js: geometry, graph edits, undo, parsing (C2/C3/C7).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals

const TYPES = I.indexTypes({
  types: [
    { type: 'input.text', title: 'Text', category: 'Inputs', inputs: [], outputs: [{ name: 'text', type: 'text' }],
      params: [{ name: 'value', kind: 'textarea', default: '' }] },
    { type: 'text.template', title: 'Template', category: 'Text', inputs: [], outputs: [{ name: 'text', type: 'text' }],
      params: [{ name: 'template', kind: 'textarea', default: '{{text}}' }], dynamic_inputs: 'template' },
    { type: 'json.pick', title: 'Pick field', category: 'Data', inputs: [{ name: 'data', type: 'any', required: true }],
      outputs: [{ name: 'value', type: 'any' }], params: [{ name: 'path', kind: 'text', default: '' }] },
    { type: 'input.number', title: 'Number', category: 'Inputs', inputs: [], outputs: [{ name: 'number', type: 'number' }],
      params: [{ name: 'value', kind: 'number', default: 0 }] },
    { type: 'tool:image_gen', kind: 'tool', title: 'Image', category: 'Tools · image', inputs: [{ name: 'prompt', type: 'text', required: true }],
      outputs: [{ name: 'media', type: 'any' }], params: [{ name: 'prompt', kind: 'textarea', default: 'x' }] }
  ],
  compat: { text: ['text', 'any'], number: ['number', 'text', 'any'], any: ['any', 'text', 'number', 'json'] },
  port_types: { text: { label: 'Text', color: '--ui-text-secondary' } }
})

const flow0 = () => ({
  id: 'f', name: 'F', nodes: [
    { id: 'a', type: 'input.text', x: 0, y: 0, params: {} },
    { id: 'b', type: 'text.template', x: 300, y: 0, params: { template: 'Hi {{name}} and {{other}}' } },
    { id: 'c', type: 'json.pick', x: 600, y: 0, params: {} }
  ], edges: []
})

test('coordinates round-trip and zoomAt keeps the cursor point fixed', () => {
  const view = { x: 40, y: -20, zoom: 1.5 }
  const w = { x: 123, y: 45 }
  const s = I.worldToScreen(view, w)
  const back = I.screenToWorld(view, s)
  assert.ok(Math.abs(back.x - w.x) < 1e-9 && Math.abs(back.y - w.y) < 1e-9)
  const p = { x: 300, y: 200 }
  const before = I.screenToWorld(view, p)
  const z = I.zoomAt(view, 1.7, p)
  const after = I.screenToWorld(z, p)
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9)
  assert.equal(I.zoomAt({ x: 0, y: 0, zoom: 2 }, 100, p).zoom, I.MAX_ZOOM)
  assert.equal(I.zoomAt({ x: 0, y: 0, zoom: 0.3 }, 0.01, p).zoom, I.MIN_ZOOM)
})

test('snap, rectSelect, fitView', () => {
  assert.equal(I.snap(14), 10)
  assert.equal(I.snap(15), 20)
  assert.equal(I.snap(-6), -10)
  const rects = [{ id: 'a', x: 0, y: 0, w: 100, h: 50 }, { id: 'b', x: 500, y: 500, w: 100, h: 50 }]
  assert.deepEqual(I.rectSelect(rects, { x0: 50, y0: 10, x1: 200, y1: 30 }), ['a'])
  assert.deepEqual(I.rectSelect(rects, { x0: -10, y0: -10, x1: 1000, y1: 1000 }), ['a', 'b'])
  const v = I.fitView(rects, 1000, 800)
  const tl = I.worldToScreen(v, { x: 0, y: 0 })
  const br = I.worldToScreen(v, { x: 600, y: 550 })
  assert.ok(tl.x >= 0 && tl.y >= 0 && br.x <= 1000 && br.y <= 800)
  assert.deepEqual(I.fitView([], 800, 600), { x: 48, y: 48, zoom: 1 })
})

test('edgePath is a cubic bezier between the two points', () => {
  const d = I.edgePath({ x: 0, y: 0 }, { x: 200, y: 100 })
  assert.match(d, /^M 0\.0 0\.0 C .* 200\.0 100\.0$/)
})

test('template placeholders become dynamic inputs; port positions follow rows', () => {
  const f = flow0()
  assert.deepEqual(I.templatePlaceholders('{{a}} {{ b }} {{a}} {{1x}}'), ['a', 'b'])
  const ports = I.nodePorts(f.nodes[1], TYPES.byName['text.template'])
  assert.deepEqual(ports.inputs.map((p) => p.name), ['name', 'other'])
  assert.ok(ports.inputs.every((p) => p.dynamic))
  const lay = I.nodeLayout(f.nodes[1], TYPES.byName['text.template'], new Set(), false)
  const p0 = I.portPosition(f.nodes[1], lay, 'in', 'name')
  const p1 = I.portPosition(f.nodes[1], lay, 'in', 'other')
  assert.equal(p0.x, 300)
  assert.equal(p1.y - p0.y, I.ROW_H)
  assert.equal(I.portPosition(f.nodes[1], lay, 'out', 'text').x, 300 + I.NODE_W)
  // default template when the param is unset
  assert.deepEqual(I.nodePorts({ params: {} }, TYPES.byName['text.template']).inputs.map((p) => p.name), ['text'])
})

test('long input lists collapse but keep required and connected inputs', () => {
  const inputs = Array.from({ length: 12 }, (_, i) => ({ name: `p${i}`, required: i === 11 }))
  const vis = I.visibleInputs(inputs, new Set(['p9']), false)
  const names = vis.shown.map((p) => p.name)
  assert.ok(names.includes('p11') && names.includes('p9'))
  assert.equal(vis.shown.length, I.VISIBLE_OPTIONAL + 2)
  assert.equal(vis.hidden, 12 - vis.shown.length)
  assert.equal(I.visibleInputs(inputs, new Set(), true).hidden, 0)
})

test('canConnect checks types, self-links and cycles; connect replaces the old edge', () => {
  let f = flow0()
  const ok = I.canConnect(f, TYPES, { node: 'a', port: 'text' }, { node: 'b', port: 'name' })
  assert.equal(ok.ok, true)
  f = I.connect(f, { node: 'a', port: 'text' }, { node: 'b', port: 'name' })
  f = I.connect(f, { node: 'b', port: 'text' }, { node: 'c', port: 'data' })
  assert.equal(f.edges.length, 2)
  assert.equal(I.canConnect(f, TYPES, { node: 'c', port: 'value' }, { node: 'b', port: 'other' }).ok, false, 'cycle')
  assert.equal(I.canConnect(f, TYPES, { node: 'b', port: 'text' }, { node: 'b', port: 'name' }).ok, false, 'self')
  // replacing the edge into b.name
  const f2 = I.connect({ ...f, nodes: [...f.nodes, { id: 'd', type: 'input.text', x: 0, y: 200, params: {} }] },
    { node: 'd', port: 'text' }, { node: 'b', port: 'name' })
  const into = f2.edges.filter((e) => e.to.node === 'b' && e.to.port === 'name')
  assert.equal(into.length, 1)
  assert.equal(into[0].from.node, 'd')
  // identical connection is a no-op
  assert.equal(I.connect(f, { node: 'a', port: 'text' }, { node: 'b', port: 'name' }), f)
  // type mismatch: text output into a number-only port is rejected via compat table
  const g = { id: 'g', nodes: [{ id: 'n', type: 'input.number', x: 0, y: 0, params: {} }, { id: 't', type: 'input.text', x: 0, y: 0, params: {} }], edges: [] }
  assert.equal(I.compatible(TYPES.compat, 'text', 'number'), false)
  assert.equal(I.compatible(TYPES.compat, 'number', 'text'), true)
  assert.equal(I.canConnect(g, TYPES, { node: 't', port: 'text' }, { node: 'n', port: 'zzz' }).ok, false)
})

test('ancestors/descendants/removeNodes/disconnect', () => {
  let f = flow0()
  f = I.connect(f, { node: 'a', port: 'text' }, { node: 'b', port: 'name' })
  f = I.connect(f, { node: 'b', port: 'text' }, { node: 'c', port: 'data' })
  assert.deepEqual([...I.descendants(f, 'a')].sort(), ['b', 'c'])
  assert.deepEqual([...I.ancestors(f, 'c')].sort(), ['a', 'b'])
  assert.ok(I.reaches(f, 'a', 'c') && !I.reaches(f, 'c', 'a'))
  const r = I.removeNodes(f, ['b'])
  assert.equal(r.nodes.length, 2)
  assert.equal(r.edges.length, 0)
  assert.equal(I.removeNodes(f, ['zzz']), f)
  const d = I.disconnect(f, f.edges[0].id)
  assert.equal(d.edges.length, 1)
  assert.equal(I.disconnect(f, 'nope'), f)
})

test('updateNode patches params/title and drops edges into removed template inputs', () => {
  let f = flow0()
  f = I.connect(f, { node: 'a', port: 'text' }, { node: 'b', port: 'other' })
  const u = I.updateNode(f, 'b', { title: 'Greeting', params: { template: 'Hi {{name}}' } }, TYPES.byName)
  assert.equal(u.nodes[1].title, 'Greeting')
  assert.equal(u.edges.length, 0, 'edge into {{other}} removed')
  const cleared = I.updateNode(u, 'b', { title: '', params: { template: null } }, TYPES.byName)
  assert.equal('title' in cleared.nodes[1], false)
  assert.equal('template' in cleared.nodes[1].params, false)
  assert.equal(I.updateNode(f, 'missing', { title: 'x' }, TYPES.byName), f)
})

test('moveNodes, cloneSubgraph, insertSubgraph, freeSpot, defaultParams', () => {
  let f = flow0()
  f = I.connect(f, { node: 'a', port: 'text' }, { node: 'b', port: 'name' })
  const m = I.moveNodes(f, { a: { x: 10, y: 20 } })
  assert.deepEqual([m.nodes[0].x, m.nodes[0].y], [10, 20])
  assert.equal(I.moveNodes(f, { a: { x: 0, y: 0 } }), f)
  const sub = I.cloneSubgraph(f, ['a', 'b'], 40, 40)
  assert.equal(sub.nodes.length, 2)
  assert.equal(sub.edges.length, 1)
  assert.ok(sub.nodes.every((n) => !['a', 'b', 'c'].includes(n.id)))
  assert.equal(sub.edges[0].from.node, sub.map.a)
  assert.equal(sub.nodes[0].x, 40)
  const merged = I.insertSubgraph(f, sub)
  assert.equal(merged.nodes.length, 5)
  assert.equal(new Set(merged.nodes.map((n) => n.id)).size, 5)
  assert.deepEqual(I.freeSpot(f, 0, 0), { x: 30, y: 30 })
  assert.deepEqual(I.defaultParams(TYPES.byName['text.template']), { template: '{{text}}' })
  assert.deepEqual(I.defaultParams(TYPES.byName['tool:image_gen']), {}, 'tool defaults stay with the tool')
  const added = I.addNode(f, { type: 'input.text', x: 12.4, y: 7.6 })
  assert.equal(added.flow.nodes.length, 4)
  assert.deepEqual([added.node.x, added.node.y], [12, 8])
})

test('undo/redo history with coalescing and a 50-step limit', () => {
  const f = flow0()
  let doc = { flow: f, undo: [], redo: [], key: null, at: 0 }
  const g = { ...f, name: 'G' }
  doc = I.applyEdit(doc, g, { key: 'name', now: 1000 })
  const h2 = { ...g, name: 'H' }
  doc = I.applyEdit(doc, h2, { key: 'name', now: 1500 })
  assert.equal(doc.undo.length, 1, 'same key within 1.2 s coalesces')
  doc = I.undoDoc(doc)
  assert.equal(doc.flow, f)
  doc = I.redoDoc(doc)
  assert.equal(doc.flow, h2)
  assert.equal(I.applyEdit(doc, doc.flow), doc, 'no-op edit')
  let big = { flow: f, undo: [], redo: [], key: null, at: 0 }
  for (let i = 0; i < 70; i += 1) big = I.applyEdit(big, { ...f, name: `n${i}` }, { now: i })
  assert.equal(big.undo.length, I.UNDO_LIMIT)
  assert.equal(I.undoDoc({ flow: f, undo: [], redo: [] }).flow, f)
})

test('palette filtering and grouping', () => {
  assert.equal(I.filterTypes(TYPES.list, '').length, TYPES.list.length)
  assert.deepEqual(I.filterTypes(TYPES.list, 'pick').map((t) => t.type), ['json.pick'])
  assert.deepEqual(I.filterTypes(TYPES.list, 'tools image').map((t) => t.type), ['tool:image_gen'])
  const groups = I.groupByCategory(TYPES.list)
  assert.deepEqual(groups.map((g) => g.category), ['Inputs', 'Text', 'Data', 'Tools · image'])
  assert.equal(groups[0].items.length, 2)
})

test('rememberType moves the newest addition first and bounds recent history', () => {
  let recent = ['json.pick', 'input.text']
  recent = I.rememberType(recent, 'input.text')
  assert.deepEqual(recent, ['input.text', 'json.pick'])
  recent = I.rememberType(recent, 'llm.complete')
  assert.deepEqual(recent, ['llm.complete', 'input.text', 'json.pick'])
  recent = I.rememberType([null, '', 'input.text', 42, 'json.pick'], 'input.text')
  assert.deepEqual(recent, ['input.text', 'json.pick'])
  recent = Array.from({ length: 12 }, (_, i) => `tool:t${i}`)
  assert.equal(I.rememberType(recent, 'input.text').length, 8)
  assert.deepEqual(I.rememberType(recent, 'input.text').slice(0, 2), ['input.text', 'tool:t0'])
})

test('resolveRecentTypes returns current specs in MRU order without stale entries', () => {
  const resolved = I.resolveRecentTypes(TYPES.list, ['missing.tool', 'json.pick', 'input.text', 'json.pick'])
  assert.deepEqual(resolved.map((t) => t.type), ['json.pick', 'input.text'])
  assert.deepEqual(I.resolveRecentTypes(TYPES.list, null), [])
})

test('parseRestError reads the Desktop bridge error format', () => {
  const e = I.parseRestError(new Error(`Error invoking remote method 'hermes:api': Error: 409: {"detail":{"code":"conflict","message":"stale","current_revision":7}}`))
  assert.equal(e.status, 409)
  assert.equal(e.detail.current_revision, 7)
  assert.equal(e.message, 'stale')
  const plain = I.parseRestError(new Error('Error: 404: {"detail":"flow f_x not found"}'))
  assert.equal(plain.status, 404)
  assert.equal(plain.message, 'flow f_x not found')
  const net = I.parseRestError(new Error('socket hang up'))
  assert.equal(net.status, 0)
  assert.equal(net.message, 'socket hang up')
})

test('formatting, media lookup and summaries', () => {
  assert.equal(I.formatMs(12), '12 ms')
  assert.equal(I.formatMs(2345), '2.3 s')
  assert.equal(I.formatMs(42000), '42 s')
  assert.equal(I.formatMs(125000), '2 min 5 s')
  assert.equal(I.formatMs(null), '')
  const now = Date.parse('2026-11-05T12:00:00Z')
  assert.equal(I.ago('2026-11-05T11:59:50Z', now), 'just now')
  assert.equal(I.ago('2026-11-05T11:30:00Z', now), '30 min ago')
  assert.equal(I.ago('2026-11-03T12:00:00Z', now), '2 d ago')
  const img = { $media: { kind: 'image', file: 'a.png' } }
  assert.equal(I.findMedia({ text: 'x', media: img }).port, 'media')
  assert.equal(I.findMedia({ media: [img] }).index, 0)
  assert.equal(I.findMedia({ _media: [img] }).port, '_media')
  assert.equal(I.findMedia({ text: 'x' }), null)
  assert.equal(I.previewString({ $large: { preview: 'abc' } }), 'abc')
  assert.equal(I.previewString(img), 'a.png')
  const node = { params: { value: 'hello   world', cache: false, other: '' } }
  assert.deepEqual(I.paramSummary(node, TYPES.byName['input.text'], new Set()), [['value', 'hello world']])
  assert.equal(I.parseNumberInput(''), null)
  assert.equal(I.parseNumberInput('3.5'), 3.5)
  assert.equal(I.parseNumberInput('3.'), '3.', 'keeps partial input while typing')
  // Review U-1: the field shows String(value), so a value that does not print back as typed eats keystrokes
  // ("0.0" -> 0 turned "0.05" into 5). While typing, only exact round-trips become numbers.
  for (const typed of ['0.0', '0.05', '-0', '-0.5', '1.0', '1.05', '-', '1.50']) {
    const v = I.parseNumberInput(typed)
    assert.equal(String(v), typed, `"${typed}" is shown as typed`)
  }
  assert.equal(I.parseNumberInput('0.05'), 0.05)
  assert.equal(I.parseNumberInput('-0.5'), -0.5)
  assert.equal(I.parseNumberInput('1.05'), 1.05)
  // On blur the value is final: numeric text becomes a number.
  assert.equal(I.parseNumberInput('1.50', true), 1.5)
  assert.equal(I.parseNumberInput('0.0', true), 0)
  assert.ok(Object.is(I.parseNumberInput('-0', true), 0), '-0 is stored as 0')
  assert.equal(I.parseNumberInput('abc', true), 'abc')
  assert.equal(I.parseNumberInput('  ', true), null)
  assert.equal(I.portColor('text', TYPES.portTypes), 'var(--ui-text-secondary)')
  assert.equal(I.categoryColor('MCP · nanogpt'), 'var(--ui-orange)')
  assert.equal(I.categoryColor('Presets'), 'var(--ui-warm)', 'curated presets stand out from Utility grey')
  assert.deepEqual(I.countStatuses({ nodes: { a: { status: 'done' }, b: { status: 'done' }, c: {} } }), { done: 2, queued: 1 })
  assert.equal(I.isRunActive({ id: 'r', status: 'running' }), true)
  assert.equal(I.isRunActive({ id: 'r', status: 'done' }), false)
  assert.equal(I.isRunActive({ id: null, status: 'starting' }), true)
})

test('API client builds the documented REST paths', async () => {
  const calls = []
  const api = I.makeApi({ rest: async (path, opts) => { calls.push([path, opts]); return {} } })
  await api.saveFlow('f_1', { id: 'f_1' }, 3)
  await api.runs('f_1', 1)
  await api.media('r_1', 'n_1', 'media', 320, 0)
  await api.startRun({ flow_id: 'f_1', fresh: true })
  assert.deepEqual(calls[0], ['/x/flows/f_1', { method: 'PUT', body: { flow: { id: 'f_1' }, base_revision: 3, origin: 'ui' } }])
  assert.equal(calls[1][0], '/x/runs?flow_id=f_1&limit=1')
  assert.equal(calls[2][0], '/x/runs/r_1/media?node=n_1&port=media&thumb=320&index=0')
  assert.equal(calls[2][1].timeoutMs, 60000)
  assert.deepEqual(calls[3], ['/x/runs', { method: 'POST', body: { flow_id: 'f_1', fresh: true } }])
})

test('register contributes the route, the sidebar entry and palette commands', async () => {
  const plugin = await loadPlugin()
  const got = []
  plugin.register({ register: (c) => got.push(c), storage: { get: (k, d) => d, set() {} }, onDispose() {} })
  const areas = got.map((c) => c.area)
  assert.ok(areas.includes('routes') && areas.includes('sidebar.nav'))
  assert.equal(got.find((c) => c.area === 'routes').data.path, '/flowcanvas')
  assert.deepEqual(got.filter((c) => c.area === 'palette').map((c) => c.data.id), ['flowcanvas.open', 'flowcanvas.run'])
})

test('templates: yours vs built-in, and which inputs "Clear input values" empties (G5)', () => {
  const list = [
    { id: 'prompt-to-3d', source: 'bundled' }, { id: 'u-a', source: 'user', name: 'A' }, null, { name: 'no id' },
    { id: 'old-style' }, { id: 'u-b', source: 'user', name: 'B' }
  ]
  const { own, builtin } = I.splitTemplates(list)
  assert.deepEqual(own.map((t) => t.id), ['u-a', 'u-b'])
  assert.deepEqual(builtin.map((t) => t.id), ['prompt-to-3d', 'old-style'])
  assert.deepEqual(I.splitTemplates(undefined), { own: [], builtin: [] })
  const flow = { nodes: [
    { type: 'input.text', title: 'Idea', params: { value: 'a robot' } },
    { type: 'input.text', title: 'Empty', params: { value: '' } },
    { type: 'input.number', title: 'Seed', params: { value: 7 } },
    { type: 'input.number', title: 'Zero', params: { value: 0 } },
    { type: 'input.file', params: { path: 'C:/a.png', kind: 'image' } },
    { type: 'input.file', title: 'No file', params: { kind: 'image' } },
    { type: 'llm.complete', title: 'LLM', params: { template: 'x' } }
  ] }
  assert.deepEqual(I.filledInputs(flow), ['Idea', 'Seed', 'input.file'])
  assert.deepEqual(I.filledInputs(null), [])
})

test('pop-out hand-off: fresh entries open the flow once, stale or malformed ones are dropped (G4)', async () => {
  const now = 1_000_000
  assert.equal(I.popoutFlow({ flowId: 'f_1', at: now - 5000 }, now), 'f_1')
  assert.equal(I.popoutFlow({ flowId: 'f_1', at: now - 25000 }, now), null) // too old
  assert.equal(I.popoutFlow({ flowId: 'f_1', at: now + 5000 }, now), null) // from the future
  assert.equal(I.popoutFlow({ flowId: '', at: now }, now), null)
  assert.equal(I.popoutFlow({ at: now }, now), null)
  assert.equal(I.popoutFlow('f_1', now), null)
  assert.equal(I.popoutFlow(null, now), null)
  const store = new Map([[I.POPOUT_KEY, { flowId: 'f_2', at: now - 100 }]])
  const storage = { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v), remove: (k) => store.delete(k) }
  assert.equal(I.takePopout(storage, now), 'f_2')
  assert.equal(store.has(I.POPOUT_KEY), false, 'consumed once')
  assert.equal(I.takePopout(storage, now), null)
  store.set(I.POPOUT_KEY, { flowId: 'f_3', at: now - 60000 })
  assert.equal(I.takePopout(storage, now), null)
  assert.equal(store.has(I.POPOUT_KEY), false, 'stale hand-off is cleared too')
  assert.equal(I.takePopout({ get: () => { throw new Error('x') } }, now), null)
  assert.equal(I.takePopout(null, now), null)

  const { loadSdkStub } = await import('./load.mjs')
  const sdk = await loadSdkStub()
  const plugin = await loadPlugin()
  const disposers = []

  const FOCUS_WINDOW_KEY = 'hermes.plugin.flowcanvas.focusWindow'
  const WINDOW_ID_KEY = 'hermes.plugin.flowcanvas.windowId'
  const createSessionStorage = () => {
    const map = new Map()
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
      get length() { return map.size },
    }
  }
  const installSessionStorage = (value) => {
    Object.defineProperty(globalThis, 'sessionStorage', { value, configurable: true, writable: true })
  }

  const origDesc = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  try {
    const storageA = createSessionStorage()
    installSessionStorage(storageA)
    sdk.host.navigated.length = 0
    store.set(I.POPOUT_KEY, { flowId: 'f_4', at: Date.now() })
    plugin.register({ register: () => {}, storage, onDispose: (fn) => disposers.push(fn) })
    assert.deepEqual(sdk.host.navigated, ['/flowcanvas'], 'a fresh hand-off navigates to the page at registration')
    assert.equal(store.has(I.POPOUT_KEY), false)
    assert.equal(I.SHARED.focusWindow, true, 'the new window becomes an Arachne Flow-only window')
    assert.ok(storageA.getItem(WINDOW_ID_KEY), 'window A holds WINDOW_ID_KEY')
    assert.equal(storageA.getItem(FOCUS_WINDOW_KEY), '1', 'window A holds focusWindow 1')
    disposers.forEach((fn) => fn()) // clears the re-navigation timers

    const storageB = createSessionStorage()
    assert.equal(storageB.length, 0, 'window B starts empty')
    installSessionStorage(storageB)
    sdk.host.navigated.length = 0
    plugin.register({ register: () => {}, storage, onDispose: (fn) => disposers.push(fn) })
    assert.deepEqual(sdk.host.navigated, [], 'no hand-off, no navigation')
    assert.equal(I.SHARED.focusWindow, false, 'an ordinary window shows the whole app')
    assert.notEqual(storageA.getItem(WINDOW_ID_KEY), storageB.getItem(WINDOW_ID_KEY), 'the two window ids differ')
    assert.equal(storageB.getItem(FOCUS_WINDOW_KEY), null, 'window B has no FOCUS_WINDOW_KEY')
    disposers.forEach((fn) => fn())
  } finally {
    if (origDesc) {
      Object.defineProperty(globalThis, 'sessionStorage', origDesc)
    } else {
      delete globalThis.sessionStorage
    }
  }
})

test('toolChoices groups only tool nodes by category, sorted', () => {
  const info = I.indexTypes({ types: [
    { type: 'tool:web_search', kind: 'tool', tool: 'web_search', title: 'Web search', category: 'Tools · web' },
    { type: 'tool:b', kind: 'tool', tool: 'b', title: 'B', category: 'MCP · x' },
    { type: 'tool:a', kind: 'tool', tool: 'a', title: 'A', category: 'MCP · x' },
    { type: 'llm.complete', kind: 'builtin', title: 'LLM', category: 'AI' },
    { type: 'preset.vision', kind: 'preset', title: 'Vision', category: 'Presets' }
  ] })
  const groups = I.toolChoices(info)
  assert.deepEqual(groups.map((g) => g.category), ['MCP · x', 'Tools · web'])
  assert.deepEqual(groups[0].items.map((t) => t.type), ['tool:a', 'tool:b'])
  assert.deepEqual(I.toolChoices(null), [])
})

test('changeNodeType swaps a tool, keeps shared params and still-valid wires', () => {
  const info = I.indexTypes({
    types: [
      { type: 'input.text', title: 'Text', outputs: [{ name: 'text', type: 'text' }], params: [] },
      { type: 'tool:img_a', kind: 'tool', title: 'Image A', inputs: [{ name: 'prompt', type: 'text' }, { name: 'size', type: 'text' }],
        outputs: [{ name: 'media', type: 'any' }, { name: 'result', type: 'json' }],
        params: [{ name: 'prompt', kind: 'textarea' }, { name: 'size', kind: 'text' }] },
      { type: 'tool:img_b', kind: 'tool', title: 'Image B', inputs: [{ name: 'prompt', type: 'text' }, { name: 'style', type: 'text' }],
        outputs: [{ name: 'media', type: 'any' }],
        params: [{ name: 'prompt', kind: 'textarea' }, { name: 'style', kind: 'text' }] },
      { type: 'output.preview', title: 'Preview', inputs: [{ name: 'value', type: 'any' }], outputs: [] }
    ],
    compat: { text: ['text', 'any'], any: ['any', 'text', 'json'], json: ['json', 'any'] }
  })
  const flow = {
    id: 'f', nodes: [
      { id: 't', type: 'input.text', x: 0, y: 0 },
      { id: 'n', type: 'tool:img_a', title: 'Image A', x: 300, y: 0, params: { prompt: 'cat', size: '1024', cache: false } },
      { id: 'o', type: 'output.preview', x: 600, y: 0 },
      { id: 'o2', type: 'output.preview', x: 600, y: 200 }
    ],
    edges: [
      { id: 'e1', from: { node: 't', port: 'text' }, to: { node: 'n', port: 'prompt' } },
      { id: 'e2', from: { node: 't', port: 'text' }, to: { node: 'n', port: 'size' } },
      { id: 'e3', from: { node: 'n', port: 'media' }, to: { node: 'o', port: 'value' } },
      { id: 'e4', from: { node: 'n', port: 'result' }, to: { node: 'o2', port: 'value' } }
    ]
  }
  const next = I.changeNodeType(flow, 'n', 'tool:img_b', info)
  const n = next.nodes.find((x) => x.id === 'n')
  assert.equal(n.type, 'tool:img_b')
  assert.deepEqual(n.params, { prompt: 'cat', cache: false }, 'unknown params dropped, cache kept')
  assert.equal(n.title, undefined, 'auto title follows the new tool')
  assert.deepEqual(next.edges.map((e) => e.id), ['e1', 'e3'])
  assert.equal(flow.nodes[1].type, 'tool:img_a', 'input flow is not mutated')
  const custom = I.changeNodeType({ ...flow, nodes: flow.nodes.map((x) => (x.id === 'n' ? { ...x, title: 'Hero shot' } : x)) }, 'n', 'tool:img_b', info)
  assert.equal(custom.nodes.find((x) => x.id === 'n').title, 'Hero shot', 'custom title survives')
  assert.equal(I.changeNodeType(flow, 'n', 'tool:img_a', info), flow, 'same type is a no-op')
  assert.equal(I.changeNodeType(flow, 'n', 'tool:missing', info), flow, 'unknown target is a no-op')
  assert.equal(I.changeNodeType(flow, 'zz', 'tool:img_b', info), flow)
})

test('placeSubgraph and placeInView position pasted nodes', () => {
  const sub = { nodes: [{ id: 'a', x: 1000, y: 500 }, { id: 'b', x: 1300, y: 640 }], edges: [{ id: 'e', from: { node: 'a', port: 'o' }, to: { node: 'b', port: 'i' } }], map: {} }
  assert.deepEqual(I.nodesBox(sub.nodes), { x0: 1000, y0: 500, x1: 1540, y1: 750 })
  assert.equal(I.nodesBox([]), null)
  const placed = I.placeSubgraph(sub, { x: 203, y: 98 })
  assert.deepEqual(placed.nodes.map((n) => [n.x, n.y]), [[200, 100], [500, 240]], 'top-left snapped to the point, shape kept')
  assert.equal(placed.edges, sub.edges)
  assert.equal(sub.nodes[0].x, 1000, 'input not mutated')
  assert.equal(I.placeSubgraph(sub, null), sub)
  const size = { w: 800, h: 600 }
  const view = { x: 0, y: 0, zoom: 1 }
  const near = { nodes: [{ id: 'a', x: 100, y: 100 }], edges: [] }
  assert.equal(I.placeInView(near, view, size), near, 'visible copy keeps its +40 offset')
  const centred = I.placeInView(sub, view, size)
  const box = I.nodesBox(centred.nodes)
  assert.ok(box.x0 < 800 && box.x1 > 0 && box.y0 < 600 && box.y1 > 0, 'off-screen copy lands in view')
  assert.equal(Math.abs((box.x0 + box.x1) / 2 - 400) <= 10, true, 'centred horizontally')
  const zoomed = I.placeInView(sub, { x: -1800, y: -900, zoom: 2 }, size)
  assert.equal(zoomed, sub, 'zoomed view that shows the copy keeps it')
})

test('pruneSelection drops vanished nodes and keeps identity when unchanged', () => {
  const flow = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [] }
  const sel = ['a', 'b']
  assert.equal(I.pruneSelection(sel, flow), sel)
  assert.deepEqual(I.pruneSelection(['a', 'zz', 'b'], flow), ['a', 'b'])
  const empty = []
  assert.equal(I.pruneSelection(empty, flow), empty)
  assert.equal(I.pruneSelection(sel, null), sel)
})

test('askPrompt names the open flow; draftToComposer falls back to the active composer', async () => {
  assert.equal(I.askPrompt({ id: 'f_1', name: 'Demo' }), 'In Arachne Flow, look at my flow "Demo" (id f_1) and ')
  assert.equal(I.askPrompt(null), 'Build me a flow in Arachne Flow that ')
  const calls = []
  const host = (answers) => ({ composer: { setDraft: async (sid, text) => { calls.push([sid, text]); return answers.shift() } } })
  assert.equal(await I.draftToComposer(host([true]), 's1', 'x'), 'session')
  assert.equal(await I.draftToComposer(host([false, true]), 's1', 'x'), 'active', 'focused session not mounted -> active composer')
  assert.deepEqual(calls.slice(-2), [['s1', 'x'], [null, 'x']])
  assert.equal(await I.draftToComposer(host([true]), null, 'x'), 'active', 'no focused session -> active composer')
  assert.equal(await I.draftToComposer(host([false, false]), 's1', 'x'), null, 'no composer answered')
  assert.equal(await I.draftToComposer(host([undefined]), 's1', 'x'), 'session', 'older hosts without a result count as delivered')
  assert.equal(await I.draftToComposer({}, 's1', 'x'), null)
})

test('ui.open from /flow open navigates to the page; the subscription is disposed with the plugin', async () => {
  const { loadSdkStub } = await import('./load.mjs')
  const sdk = await loadSdkStub()
  const plugin = await loadPlugin()
  const disposers = []
  plugin.register({ register: () => {}, storage: { get: (k, d) => d, set() {} }, onDispose: (fn) => disposers.push(fn) })
  sdk.host.navigated.length = 0
  sdk.__emitHostEvent('plugin.flowcanvas.ui.open', { flow_id: 'f_abc' })
  assert.deepEqual(sdk.host.navigated, ['/flowcanvas'])
  assert.ok(disposers.length >= 1, 'the event subscription is disposed with the plugin')
  disposers.forEach((fn) => fn())
  sdk.__emitHostEvent('plugin.flowcanvas.ui.open', { flow_id: 'f_abc' })
  assert.deepEqual(sdk.host.navigated, ['/flowcanvas'], 'no navigation after dispose')
})

test('paramInfo explains every setting: description or type hint, default, wire hint', () => {
  assert.deepEqual(I.paramInfo({ kind: 'number', default: null }), ['A number, e.g. 3 or 0.5.', 'Optional — leave empty to use the default.'])
  const lines = I.paramInfo({ kind: 'text', description: 'Search words.', required: true }, { port: true })
  assert.equal(lines[0], 'Search words.')
  assert.ok(lines.includes('Required.'))
  assert.ok(lines.some((l) => l.startsWith('Can also come from a wire')))
  assert.ok(I.paramInfo({ kind: 'select', default: 'auto' }).includes('Default: auto'))
  assert.ok(I.paramInfo({ kind: 'json', default: { a: 1 } }).includes('Default: {"a":1}'))
})

test('modelGroups keeps configured providers, drops MoA, unauthenticated and unavailable models; active first', () => {
  const groups = I.modelGroups({ providers: [
    { slug: 'anthropic', name: 'Anthropic', authenticated: true, models: ['claude-opus-5-5'] },
    { slug: 'custom', name: 'NanoGPT', authenticated: true, is_current: true, models: ['z/glm', 'z/glm', { id: 'x/mimo' }] },
    { slug: 'moa', name: 'MoA', authenticated: true, models: ['default'] },
    { slug: 'openai', name: 'OpenAI', authenticated: false, models: ['gpt'] },
    { slug: 'nous', name: 'Nous', authenticated: true, models: ['a'], unavailable_models: ['a'] }
  ] })
  assert.deepEqual(groups.map((g) => g.slug), ['custom', 'anthropic'])
  assert.deepEqual(groups[0].models, ['z/glm', 'x/mimo'])
  assert.deepEqual(I.modelGroups(null), [])
})

test('filterModelGroups matches all words against model or provider and caps the list', () => {
  const groups = [{ slug: 'custom', name: 'NanoGPT', models: ['z-ai/glm-5.3-flash', 'z-ai/glm-5.2', 'xiaomi/mimo'] },
    { slug: 'anthropic', name: 'Anthropic', models: ['claude-haiku-4-5'] }]
  assert.deepEqual(I.filterModelGroups(groups, 'glm flash').groups.map((g) => g.models), [['z-ai/glm-5.3-flash']])
  assert.deepEqual(I.filterModelGroups(groups, 'anthropic').groups.map((g) => g.slug), ['anthropic'])
  const capped = I.filterModelGroups(groups, '', 2)
  assert.equal(capped.groups.reduce((n, g) => n + g.models.length, 0), 2)
  assert.equal(capped.hidden, 2)
})

test('fillHeight fills to the parent or window bottom and subtracts leftover overflow', () => {
  assert.equal(I.fillHeight({ top: 100, parentBottom: 900, windowHeight: 1000 }), 800)
  assert.equal(I.fillHeight({ top: 100, parentBottom: null, windowHeight: 1000 }), 900)
  assert.equal(I.fillHeight({ top: 100, parentBottom: 900, windowHeight: 1000, overflow: 28 }), 772)
  assert.equal(I.fillHeight({ top: 900, parentBottom: 950, windowHeight: 1000 }), 320)
})

test('optionGroups groups tool model options by owner; formatPrice is short', () => {
  const groups = I.optionGroups([
    { value: 'tripo3d/p1', label: 'Tripo P1', group: 'tripo', price: 0.48 },
    { value: 'hunyuan', group: 'wavespeed', price: 0.27, description: 'fast' },
    { value: 'ltx', group: 'wavespeed', price: 0.04, unit: '/s' },
    { value: 'x' }, null, { value: 3 }
  ])
  assert.deepEqual(groups.map((g) => g.name), ['Other', 'tripo', 'wavespeed'])
  assert.equal(groups[1].labels['tripo3d/p1'], 'Tripo P1')
  assert.equal(groups[2].hints.hunyuan, 'fast')
  assert.equal(groups[2].prices.ltx, '$0.04/s')
  assert.equal(groups[1].prices['tripo3d/p1'], '$0.48')
  assert.equal(I.formatPrice(0.01), '$0.01')
  assert.equal(I.formatPrice(0.0085), '$0.0085')
  assert.equal(I.formatPrice(0.27), '$0.27')
  assert.equal(I.formatPrice(null), null)
})

test('splitFields keeps builtin settings, folds untouched optional tool settings', () => {
  const fields = [{ name: 'prompt', required: true }, { name: 'model', options_source: 'x' }, { name: 'n', kind: 'number' },
    { name: 'size', kind: 'text' }, { name: 'q', kind: 'text', default: 'hd' }, { name: 'r' }, { name: 'provider', hidden: true }]
  assert.equal(I.splitFields(fields, { spec: { kind: 'builtin' } }).main.length, 6)
  assert.equal(I.splitFields(fields.slice(0, 4), { spec: { kind: 'tool', inputs: [] } }).more.length, 0)
  const r = I.splitFields(fields, { spec: { kind: 'tool', inputs: [] }, params: { size: '1024', q: 'hd' }, connected: new Set() })
  assert.deepEqual(r.main.map((f) => f.name), ['prompt', 'model', 'size'])
  assert.deepEqual(r.more.map((f) => f.name), ['n', 'q', 'r'])
  const c = I.splitFields(fields, { spec: { kind: 'tool', inputs: [] }, connected: new Set(['n']) })
  assert.ok(c.main.some((f) => f.name === 'n'))
})

test('search also finds descriptions and ports, best title match first', () => {
  const list = [
    { type: 'a.desc', title: 'Alpha', description: 'Turns text into speech audio', inputs: [], outputs: [] },
    { type: 'b.port', title: 'Beta', inputs: [{ name: 'clip', type: 'audio', label: 'Clip' }], outputs: [] },
    { type: 'c.title', title: 'Audio mixer', inputs: [], outputs: [] },
    { type: 'd.none', title: 'Delta', description: 'nothing here', inputs: [], outputs: [{ name: 'out', type: 'text' }] },
    { type: 'tool:speak', kind: 'tool', tool: 'speak_out', title: 'Speak', inputs: [], outputs: [] }
  ]
  // title hit first, then description and port hits in registry order
  assert.deepEqual(I.filterTypes(list, 'audio').map((t) => t.type), ['c.title', 'a.desc', 'b.port'])
  assert.deepEqual(I.filterTypes(list, 'clip').map((t) => t.type), ['b.port']) // port name
  assert.deepEqual(I.filterTypes(list, 'speak_out').map((t) => t.type), ['tool:speak']) // tool name
  assert.deepEqual(I.filterTypes(list, 'speech audio').map((t) => t.type), ['a.desc']) // all words must match
  assert.deepEqual(I.filterTypes(list, 'delta').map((t) => t.type), ['d.none'])
  assert.deepEqual(I.filterTypes(list, 'zzz'), [])
})

test('typeTip summarises ports, duration and cost; typeTipText is the plain fallback', () => {
  const portTypes = { text: { label: 'Text', color: '--ui-green' }, image: { label: 'Image', color: '--ui-red' } }
  const tip = I.typeTip({
    type: 'preset.text_to_image', kind: 'preset', tool: 'image_generate', title: 'Text to image', category: 'Presets',
    description: 'Generate an image from a prompt.', typical: 'seconds', cost: '~$0.01 per image with the default model',
    inputs: [{ name: 'prompt', type: 'text', required: true, label: 'Prompt' }, { name: 'seed', type: 'number' }],
    outputs: [{ name: 'image', type: 'image', label: 'Image' }]
  }, portTypes)
  assert.equal(tip.kind, 'Ready-made')
  assert.deepEqual(tip.inputs, [{ name: 'Prompt', type: 'Text', color: 'var(--ui-green)', optional: false },
    { name: 'seed', type: 'number', color: 'var(--ui-text-tertiary)', optional: true }])
  assert.deepEqual(tip.outputs, [{ name: 'Image', type: '', color: 'var(--ui-red)', optional: false }]) // type = name -> hidden
  assert.equal(tip.tool, 'image_generate')
  const text = I.typeTipText(tip)
  assert.match(text, /^Text to image · Ready-made\n/)
  assert.match(text, /In: Prompt \(Text\), seed \(number, optional\)/)
  assert.match(text, /\nOut: Image\n/)
  assert.match(text, /Takes: seconds/)
  assert.match(text, /Cost: ~\$0\.01 per image/)
  const many = Array.from({ length: 9 }, (_, i) => ({ name: `p${i}`, type: 'text' }))
  const tool = I.typeTip({ type: 'tool:x', kind: 'tool', tool: 'x', title: 'X', category: 'MCP · nanogpt', inputs: many, outputs: [],
    description: 'word '.repeat(80) })
  assert.equal(tool.kind, 'MCP · nanogpt')
  assert.equal(tool.inputs.length, 6)
  assert.equal(tool.moreInputs, 3)
  assert.ok(tool.description.length <= 240 && tool.description.endsWith('…'))
  assert.equal(tool.typical, '')
  const llm = I.typeTip({ type: 'llm.complete', title: 'LLM', category: 'AI', inputs: [], outputs: [], dynamic_inputs: 'template' })
  assert.equal(llm.kind, 'Built-in')
  assert.equal(llm.tool, '')
  assert.match(I.typeTipText(llm), /In: one text input per \{\{placeholder\}\}/)
})

test('palette folds: expand all / collapse all over sections and categories', () => {
  const g = (category, n) => ({ category, items: Array.from({ length: n }, (_, i) => ({ type: `${category}${i}` })) })
  const secs = I.paletteSections([g('Inputs', 2), g('AI', 1), g('Tools · web', 3), g('Tools · file', 1), g('Presets', 5)])
  assert.deepEqual(secs.map((s) => [s.id, s.icon, s.flat]), [['ready', 'star-full', true], ['basic', 'layers', false], ['tools', 'tools', false]])
  assert.ok(secs.every((s) => s.color.startsWith('var(--ui-')))
  assert.deepEqual(secs.map((s) => [s.label, s.count]), [['Ready-made', 5], ['Basics', 3], ['Hermes tools', 4]])
  const folds = I.paletteFolds(secs)
  // ready is flat: only its section fold; basics categories open by default, tool categories closed
  assert.deepEqual(folds.map((f) => [f.key, f.def]), [['§ready', true], ['§basic', true], ['Inputs', true], ['AI', true],
    ['§tools', false], ['Tools · web', false], ['Tools · file', false]])
  assert.equal(I.allFoldsOpen(secs, {}), false)
  const all = I.setAllFolds(secs, true)
  assert.equal(I.allFoldsOpen(secs, all), true)
  const none = I.setAllFolds(secs, false)
  assert.equal(Object.values(none).every((v) => v === false), true)
  assert.equal(Object.keys(none).length, folds.length)
  assert.equal(I.allFoldsOpen(secs, { ...all, 'Tools · file': false }), false)
  assert.equal(I.allFoldsOpen(secs, { ...all, junk: 'x' }), true) // unknown keys / non-booleans are ignored
})

test('fileFilters: kind first, all known types for auto, "All files" always last (G3)', () => {
  const ext = { '.png': 'image', '.jpg': 'image', '.mp3': 'audio', '.glb': 'model3d', '.pdf': 'file' }
  assert.deepEqual(I.fileFilters('image', ext), [{ name: 'Images', extensions: ['png', 'jpg'] }, { name: 'All files', extensions: ['*'] }])
  const auto = I.fileFilters('auto', ext)
  assert.deepEqual(auto[0], { name: 'Media and documents', extensions: ['png', 'jpg', 'mp3', 'glb', 'pdf'] })
  assert.deepEqual(auto.map((f) => f.name), ['Media and documents', 'Images', 'Audio', '3D models', 'Documents', 'All files'])
  assert.deepEqual(I.fileFilters(undefined, ext)[0].name, 'Media and documents')
  assert.deepEqual(I.fileFilters('video', ext), [{ name: 'All files', extensions: ['*'] }]) // no known video ext
  assert.deepEqual(I.fileFilters('auto', {}), [{ name: 'All files', extensions: ['*'] }])
})

test('pickedFilesWith keeps picks the node still names and adds the new one', () => {
  const params = { path: 'C:/a.png', images: '["C:/b.png", "https://x/y.png"]', picked_files: { 'C:/a.png': 'ta', 'C:/b.png': 'tb', 'C:/gone.png': 'tg' } }
  assert.deepEqual(I.pickedFilesWith(params, 'C:/c.png', 'tc'), { 'C:/a.png': 'ta', 'C:/b.png': 'tb', 'C:/c.png': 'tc' })
  assert.deepEqual(I.pickedFilesWith({}, 'C:/c.png', 'tc'), { 'C:/c.png': 'tc' })
  assert.deepEqual(I.pickedFilesWith(null, '', ''), {})
  assert.deepEqual(I.pickedFilesWith({ path: 'C:/a.png', picked_files: 'broken' }, 'C:/a.png', 't'), { 'C:/a.png': 't' })
})

test('checkDropFile, dropSpots, fileNodes place dropped files as File nodes (G3)', () => {
  const ext = { '.png': 'image', '.wav': 'audio' }
  assert.deepEqual(I.checkDropFile({ name: 'Cat.PNG', size: 10 }, ext, 100), { ok: true, kind: 'image' })
  assert.match(I.checkDropFile({ name: 'run.exe', size: 10 }, ext, 100).reason, /\.exe is not a supported file type/)
  assert.match(I.checkDropFile({ name: 'README', size: 10 }, ext, 100).reason, /no extension/)
  const big = I.checkDropFile({ name: 'song.wav', size: 30 * 1048576 }, ext, 25 * 1048576)
  assert.equal(big.ok, false)
  assert.match(big.reason, /30 MB.*25 MB.*Browse/)
  assert.deepEqual(I.dropSpots(3, 100, 50).map((s) => s.y), [50, 50, 50])
  const xs = I.dropSpots(3, 100, 50).map((s) => s.x)
  assert.ok(xs[1] - xs[0] >= 240 && xs[2] - xs[1] === xs[1] - xs[0])
  const spec = { type: 'input.file', params: [{ name: 'path', default: '' }, { name: 'kind', default: 'auto' }] }
  const flow = { id: 'f', nodes: [{ id: 'n_000001', type: 'input.text', x: 100, y: 50, params: {} }], edges: [] }
  const added = I.fileNodes(flow, [{ path: 'C:/u/a.png', name: 'a.png' }, { path: 'C:/u/b.wav', name: '' }], 100, 50, spec)
  assert.equal(added.length, 2)
  assert.deepEqual(added.map((n) => [n.type, n.params.path, n.params.kind]), [['input.file', 'C:/u/a.png', 'auto'], ['input.file', 'C:/u/b.wav', 'auto']])
  assert.equal(added[0].title, 'a.png')
  assert.equal(added[1].title, undefined)
  assert.equal(new Set([...flow.nodes, ...added].map((n) => n.id)).size, 3) // unique ids
  assert.notDeepEqual([added[0].x, added[0].y], [100, 50]) // nudged off the existing node
  assert.equal(I.baseName('"C:\\Users\\me\\Pictures\\cat.png"'), 'cat.png')
  assert.equal(I.baseName('/home/me/x.glb'), 'x.glb')
  assert.equal(I.formatBytes(1536), '2 KB')
  assert.equal(I.formatBytes(3 * 1048576), '3.0 MB')
})

test('paletteSections puts ready-made presets first and folds tools and MCP', () => {
  const g = (category, n) => ({ category, items: Array.from({ length: n }, (_, i) => ({ type: `${category}${i}` })) })
  const secs = I.paletteSections([g('Inputs', 2), g('AI', 1), g('Tools · web', 3), g('MCP · nanogpt', 4), g('Presets', 5)])
  assert.deepEqual(secs.map((s) => s.id), ['ready', 'basic', 'tools', 'mcp'])
  assert.equal(secs[2].title, 'Hermes tools · 3')
  assert.deepEqual(secs.map((s) => s.open), [true, true, false, false])
  assert.deepEqual(I.paletteSections([g('Inputs', 1)]).map((s) => s.id), ['basic'])
})

test('paramSummary hides values that equal the default', () => {
  const spec = { params: [{ name: 'a', default: 5000 }, { name: 'b', default: false }, { name: 'c', label: 'C' }] }
  assert.deepEqual(I.paramSummary({ params: { a: 5000, b: false, c: 'x' } }, spec, new Set()), [['C', 'x']])
})

test('runMediaList: run order, list ports, _media, dedupe by path, finished nodes only (G1)', () => {
  const m = (path, kind = 'image') => ({ $media: { kind, file: path.split('/').pop(), path } })
  const flow = { nodes: [
    { id: 'img', type: 'tool:image_gen', title: 'Picture' },
    { id: 'many', type: 'tool:image_gen' },
    { id: 'out', type: 'json.pick' },
    { id: 'run', type: 'tool:image_gen' }
  ] }
  const run = {
    order: ['many', 'img', 'out', 'run'],
    nodes: {
      img: { status: 'done', outputs: { media: m('/o/a.png'), result: { x: 1 }, _media: [m('/o/extra.mp4', 'video')] } },
      many: { status: 'cached', outputs: { media: [m('/o/b.png'), 'not media', m('/o/c.glb', 'model3d')] } },
      out: { status: 'done', outputs: { value: m('/o/a.png') } },          // passes a.png on: listed once
      run: { status: 'running', outputs: { media: m('/o/d.png') } }        // unfinished: not listed
    }
  }
  const items = I.runMediaList(run, flow, TYPES.byName)
  assert.deepEqual(items.map((i) => i.key), ['many|media|0', 'many|media|1', 'img|media|0', 'img|_media|0'])
  assert.deepEqual(items.map((i) => i.kind), ['image', 'model3d', 'image', 'video'])
  assert.equal(items[2].title, 'Picture')
  assert.equal(items[0].title, 'Image')        // spec title when the node has none
  assert.equal(items[3].portLabel, 'Files')
  assert.deepEqual(I.runMediaList(null, flow, TYPES.byName), [])
  // nodes missing from run.order still count, after the ordered ones
  const extra = I.runMediaList({ order: ['img'], nodes: { img: run.nodes.img, many: run.nodes.many } }, flow, TYPES.byName)
  assert.deepEqual(extra.map((i) => i.nodeId), ['img', 'img', 'many', 'many'])
})

test('lightboxZoom keeps the cursor point fixed, clamps and re-centres at fit (G1)', () => {
  const v1 = I.lightboxZoom({ zoom: 1, x: 0, y: 0 }, 2, { x: 100, y: -50 })
  assert.equal(v1.zoom, 2)
  // image point under the cursor before: (p - t) / z = (100, -50); after: (p - t') / z' must be the same
  assert.deepEqual([(100 - v1.x) / v1.zoom, (-50 - v1.y) / v1.zoom], [100, -50])
  assert.equal(I.lightboxZoom({ zoom: 6, x: 0, y: 0 }, 4).zoom, 8)
  assert.deepEqual(I.lightboxZoom({ zoom: 1.2, x: 30, y: 40 }, 0.5, { x: 9, y: 9 }), { zoom: 1, x: 0, y: 0 })
})

// Review U-2/U-3: fake DOM nodes (parent chain, tag, role) for the key routing helpers.
function el(tag, parent = null, attrs = {}) {
  const node = { tagName: tag, parent, attrs, isContentEditable: false }
  node.contains = (other) => { for (let n = other; n; n = n.parent) if (n === node) return true; return false }
  node.closest = (sel) => {
    const want = sel.split(',').map((x) => x.trim())
    for (let n = node; n; n = n.parent) {
      for (const w of want) {
        if (w === n.tagName.toLowerCase() && !(w === 'a' && !n.attrs.href)) return n
        if (w === 'a[href]' && n.tagName === 'A' && n.attrs.href) return n
        const m = /^\[role=(\w+)\]$/.exec(w)
        if (m && n.attrs.role === m[1]) return n
      }
    }
    return null
  }
  return node
}

test('space pans only on the canvas, never on buttons or elsewhere in the app (U-2)', () => {
  const body = el('BODY')
  const sidebarBtn = el('BUTTON', body)
  const root = el('DIV', body)
  const canvas = el('DIV', root)
  const nodeCard = el('DIV', canvas)
  const cardBtn = el('BUTTON', nodeCard)
  const roleBtn = el('DIV', canvas, { role: 'button' })
  const field = el('INPUT', root)
  assert.equal(I.spacePans(canvas, canvas), true)
  assert.equal(I.spacePans(nodeCard, canvas), true)
  assert.equal(I.spacePans(root, canvas), true, 'the focused plugin root holds the canvas')
  assert.equal(I.spacePans(sidebarBtn, canvas), false, 'app sidebar button keeps Space')
  assert.equal(I.spacePans(cardBtn, canvas), false)
  assert.equal(I.spacePans(roleBtn, canvas), false)
  assert.equal(I.spacePans(field, canvas), false)
  assert.equal(I.spacePans(canvas, null), false)
})

test('Ctrl+C/X/A go to the browser for text, and without a node selection (U-3)', () => {
  const k = I.canvasClipboardKey
  assert.equal(k('c', { textSelected: true, nodesSelected: 2, inCanvas: true }), false, 'selected text wins')
  assert.equal(k('c', { textSelected: false, nodesSelected: 0, inCanvas: true }), false, 'nothing to copy')
  assert.equal(k('x', { textSelected: false, nodesSelected: 0, inCanvas: true }), false)
  assert.equal(k('c', { textSelected: false, nodesSelected: 1, inCanvas: true }), true)
  assert.equal(k('x', { textSelected: false, nodesSelected: 1, inCanvas: false }), true)
  assert.equal(k('a', { textSelected: false, nodesSelected: 0, inCanvas: true }), true, 'select all nodes')
  assert.equal(k('a', { textSelected: false, nodesSelected: 0, inCanvas: false }), false, 'inspector/log: select text')
  assert.equal(k('a', { textSelected: true, nodesSelected: 0, inCanvas: true }), false)
})

test('drafts are appended with insertText, never replace what you typed (U-7)', async () => {
  const calls = []
  const host = (answers) => ({ composer: {
    insertText: async (sid, text, opts) => { calls.push(['insert', sid, text, opts && opts.mode]); return answers.shift() },
    setDraft: async (sid, text) => { calls.push(['set', sid, text]); return true } } })
  assert.equal(await I.draftToComposer(host([true]), 's1', 'x'), 'session')
  assert.deepEqual(calls.at(-1), ['insert', 's1', 'x', 'block'])
  assert.equal(await I.draftToComposer(host([false, true]), 's1', 'x'), 'active')
  assert.deepEqual(calls.at(-1), ['insert', null, 'x', 'block'])
  assert.equal(await I.draftToComposer(host([false, false]), 's1', 'x'), null)
  assert.ok(!calls.some((c) => c[0] === 'set'), 'setDraft is never used when insertText exists')
})

test('a flow that did not save blocks run and schedule alike (U-7)', () => {
  const f = { id: 'f_1' }
  assert.equal(I.saveBlocker(false, f, f), null)
  assert.match(I.saveBlocker(true, f, f), /conflict/)
  assert.match(I.saveBlocker(false, f, { id: 'f_1' }), /could not be saved/)
})

test('the chat button label is English (U-9)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../../desktop/plugin.js', import.meta.url), 'utf8')
  assert.ok(!src.includes('Im Chat besprechen'))
  assert.ok(src.includes('Discuss in chat'))
})

test('a lost backend connection is reported after three failed polls (U-5)', () => {
  assert.equal(I.LOST_CONTACT_AFTER, 3)
  const first = { fails: 0, lost: false }
  let st = I.connectionState(first, false)
  assert.deepEqual(st, { fails: 1, lost: false, recovered: false })
  st = I.connectionState(st, false)
  assert.deepEqual(st, { fails: 2, lost: false, recovered: false })
  st = I.connectionState(st, false)
  assert.deepEqual(st, { fails: 3, lost: true, recovered: false })
  st = I.connectionState(st, false)
  assert.deepEqual(st, { fails: 4, lost: true, recovered: false }, 'the banner stays up while the backend is away')
  assert.deepEqual(I.connectionState(st, true), { fails: 0, lost: false, recovered: true })
  assert.deepEqual(first, { fails: 0, lost: false }, 'the helper is pure')
})

test('a connection that was never lost does not trigger a reload (U-5)', () => {
  assert.deepEqual(I.connectionState(null, false), { fails: 1, lost: false, recovered: false })
  assert.deepEqual(I.connectionState({ fails: 2, lost: false }, true), { fails: 0, lost: false, recovered: false })
  assert.deepEqual(I.connectionState(undefined, true), { fails: 0, lost: false, recovered: false })
})

test('reconnecting never reloads over unsaved edits (U-5 review)', () => {
  const saved = { id: 'f_1' }
  assert.equal(I.recoveryPlan(saved, saved), 'reload', 'nothing pending: reload flow + last run')
  assert.equal(I.recoveryPlan({ id: 'f_1', nodes: [1] }, saved), 'save', 'local edits: save them, do not reload')
  assert.equal(I.recoveryPlan(null, null), 'boot')
})
