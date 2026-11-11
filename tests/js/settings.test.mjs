// G7: settings from the tool schema and the chosen model's list entry; cost hint. Pure helpers of desktop/plugin.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals

// Shapes as GET /x/options&model= returns them (engine/options.py model_fields / model_cost on the live lists).
const P_H3 = {
  size: { options: [{ value: '1k', label: '1k', price: 0.02, unit: '' }, { value: '4k', label: '4k', price: 0.12, unit: '' }] },
  n: { min: 1, max: 4, integer: true }
}
const SPEC = {
  type: 'tool:img', kind: 'tool',
  params: [
    { name: 'prompt', kind: 'textarea' },
    { name: 'model', kind: 'text', options_source: 'list', default: 'flux-2-klein-9b' },
    { name: 'n', kind: 'number', min: 1, max: 10, from_model: 'model' },
    { name: 'size', kind: 'text', from_model: 'model' },
    { name: 'duration', kind: 'text', numeric: true, from_model: 'model' }
  ]
}

test('modelSetting: chosen model, else the preset default', () => {
  assert.deepEqual(I.modelSetting(SPEC, {}), { param: 'model', model: 'flux-2-klein-9b' })
  assert.deepEqual(I.modelSetting(SPEC, { model: 'p-h3-image' }), { param: 'model', model: 'p-h3-image' })
  assert.equal(I.modelSetting({ params: [{ name: 'x', kind: 'text' }] }, {}), null)
})

test('recipient directory is not a model-settings source', () => {
  const spec = { type: 'output.send_message', kind: 'builtin', params: [{ name: 'target', kind: 'text', options_source: 'messaging_channels' }] }
  assert.equal(I.modelSetting(spec, { target: 'signal:synthetic' }), null)
})

test('recipient picker uses recipient copy and always refreshes its directory when opened', () => {
  assert.equal(typeof I.toolOptionCopy, 'function')
  const copy = I.toolOptionCopy('output.send_message', 'target')
  assert.equal(copy.placeholder, 'Search recipients…')
  assert.equal(copy.blank, 'Choose recipient…')
  assert.match(copy.empty, /No recipients/)
  assert.equal(copy.refreshOnOpen, true)
  assert.equal(copy.kind, 'recipient')
})

test('ordinary tool model pickers retain model copy and caching', () => {
  assert.equal(typeof I.toolOptionCopy, 'function')
  const copy = I.toolOptionCopy('tool:image', 'model')
  assert.equal(copy.placeholder, 'Search models…')
  assert.equal(copy.blank, 'Tool default')
  assert.equal(copy.refreshOnOpen, false)
  assert.equal(copy.kind, 'model')
})

test('attachment consent UI never infers file permission from text consent', () => {
  assert.equal(typeof I.messagingScope, 'function')
  const text = { type: 'output.send_message', params: { target: 'signal:test', authorized_target: 'signal:test', send_enabled: true, optin_token: 'abc' } }
  assert.equal(I.messagingScope(text), 'text')
  assert.equal(I.messagingScope({ ...text, params: { ...text.params, allow_attachments: true } }), 'files')
  assert.equal(I.messagingScope({ ...text, params: { ...text.params, send_enabled: false, allow_attachments: true } }), 'off')
  const copied = I.disarmCopiedNode({ ...text, params: { ...text.params, allow_attachments: true } })
  assert.equal(I.messagingScope(copied), 'off')
  assert.notEqual(copied.params.allow_attachments, true)
})

test('fieldControl: schema bounds, model narrows them, model choices become a select', () => {
  const n = I.fieldControl(SPEC.params[2], P_H3.n)
  assert.deepEqual([n.kind, n.min, n.max, n.integer, n.hint], ['number', 1, 4, true, '1–4 · whole numbers'])
  const schemaOnly = I.fieldControl(SPEC.params[2], undefined)
  assert.deepEqual([schemaOnly.max, schemaOnly.hint], [10, '1–10'])
  const size = I.fieldControl(SPEC.params[3], P_H3.size)
  assert.equal(size.kind, 'select')
  assert.equal(size.fromModel, true)
  assert.deepEqual(size.options.map((o) => [o.value, o.price]), [['1k', '$0.02'], ['4k', '$0.12']])
  assert.equal(I.fieldControl(SPEC.params[3], undefined).kind, 'text') // model lists nothing -> free text stays
  const exclusive = I.fieldControl({ kind: 'number', min: 0, min_exclusive: true, max: 2, step: 0.5 })
  assert.equal(exclusive.hint, '> 0 · ≤ 2 · steps of 0.5')
  const ranged = I.fieldControl(SPEC.params[4], { min: 3, max: 30, integer: true })
  assert.equal(ranged.kind, 'number') // numeric text with model bounds -> number field
  const enumSpec = { kind: 'select', options: [10, 20] }
  assert.deepEqual(I.fieldControl(enumSpec).options.map((o) => o.raw), [10, 20])
})

test('numberIssue and choiceValue keep the stored types right', () => {
  const n = I.fieldControl(SPEC.params[2], P_H3.n)
  assert.equal(I.numberIssue(3, n), null)
  assert.match(I.numberIssue(5, n), /Outside the allowed range \(1–4/)
  assert.equal(I.numberIssue(2.5, n), 'Must be a whole number.')
  assert.equal(I.numberIssue('auto', n), null)
  const enumCtl = I.fieldControl({ kind: 'select', options: [10, 20] })
  assert.equal(I.choiceValue('20', { kind: 'select' }, enumCtl), 20)
  assert.equal(I.choiceValue('', { kind: 'select' }, enumCtl), null)
  const dur = I.fieldControl(SPEC.params[4], { options: [{ value: 'auto' }, { value: '6' }] })
  assert.equal(I.choiceValue('6', SPEC.params[4], dur), 6)
  assert.equal(I.choiceValue('auto', SPEC.params[4], dur), 'auto')
  const size = I.fieldControl(SPEC.params[3], P_H3.size)
  assert.equal(I.choiceValue('1k', SPEC.params[3], size), '1k')
})

test('multi-select: toggle keeps option order and raw values; reads legacy JSON text', () => {
  const ctl = I.fieldControl({ kind: 'multiselect', options: ['a', 'b', 'c'] })
  assert.deepEqual(I.toggleChoice(null, ctl.options[2], ctl.options), ['c'])
  assert.deepEqual(I.toggleChoice(['c'], ctl.options[0], ctl.options), ['a', 'c'])
  assert.deepEqual(I.toggleChoice(['a', 'c'], ctl.options[0], ctl.options), ['c'])
  assert.deepEqual(I.multiValues('["b"]'), ['b'])
  assert.deepEqual(I.multiValues('not json'), [])
})

test('estimateCost multiplies only what the list states', () => {
  const img = { unit: 'image', by: 'size', prices: { '1k': 0.02, '4k': 0.12 }, base: 0.02, times: 'n' }
  assert.equal(I.estimateCost(img, {}).label, '≈ $0.02')
  const big = I.estimateCost(img, { size: '4k', n: 2 })
  assert.equal(big.label, '≈ $0.24')
  assert.match(big.lines[0], /\$0\.12 per image \(size 4k\) × 2 = \$0\.24/)
  const ltx = { unit: 'second', base: 0.04, times: 'duration' }
  assert.equal(I.estimateCost(ltx, { duration: '6' }).label, '≈ $0.24')
  assert.equal(I.estimateCost(ltx, { duration: 'auto' }).label, '$0.04/s')
  const kling = { unit: 'second', by: 'resolution', prices: { '720p': 0.1727, '1080p': 0.2585 }, times: 'duration', minimum: 0.5181 }
  assert.equal(I.estimateCost(kling, { resolution: '720p', duration: 3 }).label, '≈ $0.52') // minimum charge wins
  assert.equal(I.estimateCost(kling, {}).label, 'from $0.17')
  assert.equal(I.estimateCost({ unit: 'video', by: 'duration', prices: { 5: 0.35, 10: 0.7 } }, { duration: 10 }).label, '≈ $0.70')
  assert.equal(I.estimateCost({ unit: 'run', base: 0.27 }, {}).label, '≈ $0.27')
  const noteOnly = I.estimateCost({ minimum: 0.408, note: 'Duration and resolution set the price.' }, {})
  assert.equal(noteOnly.label, '≥ $0.41')
  assert.ok(noteOnly.lines.includes('Duration and resolution set the price.'))
  assert.equal(I.estimateCost(null, {}), null)
})

test('toolOptionLabel shows the title; the raw tool name only for twins in one group', () => {
  const img = { type: 'tool:mcp__nanogpt__nanogpt_image_generate', tool: 'mcp__nanogpt__nanogpt_image_generate', title: 'Image generate' }
  const other = { type: 'tool:mcp__nanogpt__nanogpt_vision', tool: 'mcp__nanogpt__nanogpt_vision', title: 'Vision' }
  assert.equal(I.toolOptionLabel(img, { items: [img, other] }), 'Image generate')
  const twin = { type: 'tool:mcp__nanogpt__image_generate', tool: 'mcp__nanogpt__image_generate', title: 'Image generate' }
  assert.equal(I.toolOptionLabel(twin, { items: [img, twin] }), 'Image generate · mcp__nanogpt__image_generate')
  assert.equal(I.toolOptionLabel({ type: 'tool:x', tool: 'x' }, { items: [] }), 'x')
})

test('model settings (G7b): show_when, values in effect, spec mapping, cost range', () => {
  const extras = [
    { name: 'swap_type', kind: 'select', default: 'character', options: [{ value: 'character' }, { value: 'object' }] },
    { name: 'role_1', kind: 'text', show_when: { swap_type: 'character' } },
    { name: 'target', kind: 'text', show_when: { swap_type: ['object'] } },
    { name: 'enable_pbr', kind: 'boolean', default: false },
    { name: 'target_polycount', kind: 'number', default: '30000', min: 100, max: 300000, step: 1000 }
  ]
  const shown = (params) => extras.filter((x) => I.extraVisible(x, I.extraValues(extras, params))).map((x) => x.name)
  assert.deepEqual(shown({}), ['swap_type', 'role_1', 'enable_pbr', 'target_polycount'])
  assert.deepEqual(shown({ swap_type: 'object' }), ['swap_type', 'target', 'enable_pbr', 'target_polycount'])
  const [sel, mf] = I.extraSpec(extras[0])
  assert.equal(I.fieldControl(sel, mf).kind, 'select')
  assert.equal(I.fieldControl(sel, mf).fromModel, true)
  const [bool] = I.extraSpec(extras[3])
  assert.deepEqual([bool.kind, bool.default], ['boolean', false])
  const [num, nf] = I.extraSpec(extras[4])
  assert.equal(I.fieldControl(num, nf).hint, '100–300000 · steps of 1000')
  assert.equal(I.modelSetting({ params: [{ name: 'model', options_source: 'list', default: 'm' }] }, {}).model, 'm')
  const ranged = I.estimateCost({ unit: 'run', base: 1.44, range: [0.96, 2.064] }, {})
  assert.equal(ranged.label, '≈ $1.44')
  assert.ok(ranged.lines.some((l) => l.startsWith('$0.96–$2.06 per run depending on the model settings')))
})

test('LLM node (G7c): provider catalog rows, price, output cap, picker price', () => {
  const payload = { providers: [
    { slug: 'custom', name: 'NanoGPT', api_url: 'https://nano-gpt.com/api/v1',
      pricing: { 'glm': { input: '$0.10', output: '$0.30' } },
      capabilities: { 'glm': { reasoning: true } } },
    { slug: 'anthropic', name: 'Anthropic', capabilities: { 'claude-opus-5-5': { reasoning: true } } }
  ] }
  const picker = I.llmPickerInfo(payload, 'custom', 'glm')
  assert.equal(picker.provider, 'NanoGPT')
  assert.equal(picker.hermesPricing.output, '$0.30')
  const catalog = { provider: 'NanoGPT', context_length: 1048576, max_output_tokens: 131072,
    efforts: ['low', 'high', 'max'], pricing: { input: 0.1, output: 0.3, unit: '/Mtok' }, found: true }
  const rows = I.llmInfoRows(catalog)
  assert.ok(rows.some(([k, v]) => k === 'Price' && v === '$0.1 in / $0.3 out per Mtok'))
  assert.ok(rows.some(([k, v]) => k === 'Context window' && v === '1.05M tokens'))
  assert.ok(rows.some(([k, v]) => k === 'Max output' && v === '131.1k tokens'))
  assert.ok(rows.some(([k, v]) => k === 'Reasoning' && v === 'low · high · max'))
  assert.equal(I.estimateLlmCost(catalog, {}).label, 'out $0.30/M')
  assert.equal(I.estimateLlmCost(catalog, { max_tokens: 2000 }).label, '≤ $0.0006')
  assert.equal(I.estimateLlmCost({ hermesPricing: { output: '$20.00' } }, {}).label, 'out $20.00/M')
  assert.equal(I.estimateLlmCost({}, {}), null)
  const rowsOnlyHermes = I.llmInfoRows({ provider: 'Anthropic', hermesPricing: null, found: false })
  assert.ok(rowsOnlyHermes.some(([k, v]) => k === 'Price' && v === 'not published by this provider'))
})

test('effectiveValues and splitFields surface the settings the model describes', () => {
  const vals = I.effectiveValues(SPEC, { n: 2 }, { size: { default: '1k' }, duration: { default: '6' } })
  assert.deepEqual(vals, { n: 2, size: '1k', duration: '6' })
  const many = { kind: 'tool', inputs: [], params: ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, kind: 'text' })).concat(SPEC.params) }
  const plain = I.splitFields(many.params, { spec: many, params: {} })
  assert.ok(plain.more.some((f) => f.name === 'size'))
  const withModel = I.splitFields(many.params, { spec: many, params: {}, modelFields: P_H3 })
  assert.ok(withModel.main.some((f) => f.name === 'size') && withModel.main.some((f) => f.name === 'n'))
  assert.ok(withModel.more.some((f) => f.name === 'duration')) // model does not describe it
})
