// Inspector layout B (18.11.2026): settings sorted into Provider & model / Inputs / Settings, folded summaries.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals
const f = (name, extra = {}) => ({ name, kind: 'text', ...extra })

test('inspectorGroups: model fields, input ports and plain settings land in their own section', () => {
  const fields = [f('prompt'), f('model'), f('model_auto'), f('size'), f('provider', { kind: 'model' }), f('image')]
  const g = I.inspectorGroups(fields, { modelNames: new Set(['model', 'model_auto']), portNames: new Set(['prompt', 'image']) })
  assert.deepEqual(g.model.map((x) => x.name), ['model', 'model_auto', 'provider'])
  assert.deepEqual(g.inputs.map((x) => x.name), ['prompt', 'image'])
  assert.deepEqual(g.settings.map((x) => x.name), ['size'])
})

test('inspectorGroups: a builtin without ports or models keeps everything under Settings', () => {
  const g = I.inspectorGroups([f('template'), f('separator')])
  assert.deepEqual([g.model.length, g.inputs.length, g.settings.length], [0, 0, 2])
  assert.deepEqual(I.inspectorGroups(undefined), { model: [], inputs: [], settings: [] })
})

test('inspectorSummaries: short folded summaries, plural-aware and honest about missing runs', () => {
  const s = I.inspectorSummaries({ provider: 'NanoGPT', model: 'Auto (cheapest)', inputs: 2, wired: 1, settings: 1, more: 3,
    status: '', cache: false, recorded: true })
  assert.equal(s.model, 'NanoGPT · Auto (cheapest)')
  assert.equal(s.inputs, '1 of 2 connected')
  assert.equal(s.settings, '1 setting · 3 more')
  assert.equal(s.result, 'not run yet')
  assert.equal(s.advanced, 'cache off · inputs recorded')
  const empty = I.inspectorSummaries({})
  assert.deepEqual([empty.model, empty.inputs, empty.settings, empty.advanced], ['', '', '', 'cache on'])
  assert.equal(I.inspectorSummaries({ settings: 2, status: 'Done' }).settings, '2 settings')
})

test('Fold: the header toggles, the body stays mounted while folded and the summary shows only when closed', () => {
  let toggled = 0
  const closed = I.Fold({ id: 'settings', icon: 'settings', title: 'Settings', summary: '2 settings', open: false, onToggle: () => toggled++, children: 'BODY' })
  const [head, body] = closed.props.children
  assert.equal(closed.props['data-fc-fold'], 'settings')
  assert.equal(head.props['aria-expanded'], 'false')
  assert.ok(JSON.stringify(head.props.children).includes('2 settings'))
  assert.equal(body.props.hidden, true)
  assert.equal(body.props.children, 'BODY')
  head.props.onClick()
  assert.equal(toggled, 1)
  const open = I.Fold({ id: 'settings', icon: 'settings', title: 'Settings', summary: '2 settings', open: true, onToggle: () => {}, children: 'BODY' })
  assert.equal(open.props.children[0].props['aria-expanded'], 'true')
  assert.ok(!JSON.stringify(open.props.children[0].props.children).includes('2 settings'))
  assert.equal(open.props.children[1].props.hidden, false)
})
