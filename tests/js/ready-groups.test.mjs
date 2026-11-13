import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'
const I = (await loadPlugin())._internals

const providers = [{ type: 'preset.text_to_3d', label: 'Meshy (best available)' }, { type: 'preset.text_to_3d~tripo', label: 'Tripo' }]
const list = [
  { type: 'preset.web_search', title: 'Web search', category: 'Presets', group: 'General' },
  { type: 'preset.text_to_3d', title: 'Text to 3D', category: 'Presets', group: '3D', provider_group: 'preset.text_to_3d', providers,
    params: [{ name: 'prompt' }, { name: 'model', options_source: 'mcp__meshy__list' }, { name: 'quality', from_model: 'model' }],
    inputs: [{ name: 'prompt', type: 'text' }], outputs: [{ name: 'model', type: 'model3d' }] },
  { type: 'preset.text_to_3d~tripo', title: 'Text to 3D · Tripo', category: 'Presets', group: '3D', palette: false,
    provider_group: 'preset.text_to_3d', providers, params: [{ name: 'prompt' }, { name: 'model', options_source: 'mcp__tripo__list' }],
    inputs: [{ name: 'prompt', type: 'text' }], outputs: [{ name: 'model', type: 'model3d' }] },
  { type: 'preset.text_to_image', title: 'Text to image', category: 'Presets', group: 'Image' },
  { type: 'preset.custom', title: 'Custom', category: 'Presets', group: 'Zeta' },
  { type: 'input.text', title: 'Text', category: 'Inputs' }
]

test('ready-made nodes are grouped General, Image, Video, 3D, Audio; unknown groups follow', () => {
  const groups = I.presetGroups(I.groupByCategory(I.filterTypes(list, '')))
  assert.deepEqual(groups.map(g => g.category), ['Ready · General', 'Ready · Image', 'Ready · 3D', 'Ready · Zeta'])
})

test('presets show only under Ready-made, never again under Basics', () => {
  const sections = I.paletteSections(I.groupByCategory(I.filterTypes(list, '')))
  const basics = sections.find(s => s.id === 'basic')
  assert.deepEqual(basics.groups.map(g => g.category), ['Inputs'])
  const ready = sections.find(s => s.id === 'ready').groups.flatMap(g => g.items.map(t => t.type))
  assert.equal(ready.filter(t => t.startsWith('preset.')).length, 4)
})

test('other providers of a step are not palette entries, also not in search', () => {
  assert.ok(!I.filterTypes(list, '').some(t => t.type.includes('~')))
  assert.ok(!I.filterTypes(list, 'tripo').some(t => t.type.includes('~')))
})

test('a missing provider variant resolves to the same step; unknown types stay unknown', () => {
  const types = I.indexTypes({ types: list })
  assert.equal(types.byName['preset.text_to_3d~gone'].type, 'preset.text_to_3d')
  assert.equal(types.byName['preset.text_to_3d~tripo'].type, 'preset.text_to_3d~tripo')
  assert.equal(types.byName['tool:nope'], undefined)
  assert.equal(types.byName['preset.nope~x'], undefined)
})

test('switching provider keeps wires and text, drops the old provider model settings', () => {
  const types = I.indexTypes({ types: list })
  const flow = {
    nodes: [{ id: 'a', type: 'input.text', x: 0, y: 0, params: {} },
      { id: 'b', type: 'preset.text_to_3d', x: 300, y: 0, params: { prompt: 'chest', model: 'meshy-6', quality: 'high' } }],
    edges: [{ id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'prompt' } }]
  }
  types.byName['input.text'] = { type: 'input.text', outputs: [{ name: 'text', type: 'text' }], inputs: [], params: [] }
  types.compat = { text: ['text'] }
  const next = I.changeNodeType(flow, 'b', 'preset.text_to_3d~tripo', types)
  const b = next.nodes.find(n => n.id === 'b')
  assert.equal(b.type, 'preset.text_to_3d~tripo')
  assert.deepEqual(b.params, { prompt: 'chest' })
  assert.equal(next.edges.length, 1)
})

test('auto model: cheapest or best priced option, else the first; only for a blank auto setting', () => {
  const opts = [{ value: 'b', price: 0.2 }, { value: 'a', price: 0.01 }, { value: 'c' }]
  assert.equal(I.autoPick(opts).value, 'a')
  assert.equal(I.autoPick(opts, 'best').value, 'b')
  assert.equal(I.autoPick([{ value: 'x' }, { value: 'y' }]).value, 'x')
  assert.equal(I.autoPick([]), null)
  const spec = { params: [{ name: 'model', options_source: 'mcp__m__list', auto: 'model_auto' }, { name: 'model_auto' }] }
  assert.deepEqual(I.modelSetting(spec, {}), { param: 'model', model: '', auto: true, mode: 'cheapest' })
  assert.equal(I.modelSetting(spec, { model_auto: 'best' }).mode, 'best')
  assert.equal(I.modelSetting(spec, { model: 'm1' }).auto, false)
})

test('clean card: second line names provider and model, footer shows cost and usual time', () => {
  const preset = { type: 'preset.text_to_3d', kind: 'preset', provider: 'NanoGPT', category: 'Presets' }
  assert.equal(I.nodeSubline({ type: 'preset.text_to_3d', params: {} }, preset, 'Tripo H3.0'), 'NanoGPT · Tripo H3.0')
  assert.equal(I.nodeSubline({ type: 'preset.text_to_3d', params: {} }, preset, 'tripo3d/h3.0', true), 'NanoGPT · Auto · tripo3d/h3.0')
  assert.equal(I.nodeSubline({ type: 'preset.text_to_3d', params: {} }, preset, '', true), 'NanoGPT · Auto model')
  assert.equal(I.nodeSubline({ type: 'llm.complete', params: {} }, { kind: 'builtin' }), 'Hermes · current model')
  assert.equal(I.nodeSubline({ type: 'llm.complete', params: { provider: 'openrouter', model: 'glm-5.3' } }, { kind: 'builtin' }), 'openrouter · glm-5.3')
  assert.equal(I.nodeSubline({ type: 'tool:mcp__fal-ai__gen', params: {} }, { kind: 'tool', category: 'MCP · fal-ai' }), 'FAL AI')
  assert.equal(I.nodeSubline({ type: 'tool:web_search', params: {} }, { kind: 'tool' }), 'Hermes')
  assert.equal(I.toolProvider('tool:mcp__nanogpt__nanogpt_3d_generate', 'Generate a 3D model with NanoGPT 3D models.'), 'NanoGPT')
  assert.equal(I.toolProvider('tool:mcp__nanogpt__x', 'no name here'), 'Nanogpt')
  assert.equal(I.nodeSubline({ type: 'logic.if', params: {} }, { kind: 'builtin', category: 'Logic' }), 'Logic')
  assert.equal(I.nodeSubline({ type: 'note', params: {} }, { kind: 'builtin' }), '')
  assert.deepEqual(I.nodeFooter({ label: '≈ $0.24' }, { n: 0, avg_ms: null, typical: 'minutes: waits for a job' }), { cost: '≈ $0.24', time: 'minutes' })
  assert.deepEqual(I.nodeFooter(null, { n: 3, avg_ms: 2100, typical: '' }).cost, '')
  assert.ok(I.nodeFooter(null, { n: 3, avg_ms: 2100, typical: '' }).time.startsWith('≈ '))
  assert.deepEqual(I.nodeFooter(null, null), { cost: '', time: '' })
})
