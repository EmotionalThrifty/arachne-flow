// G9: live clock, typical + measured durations, tooltip contents for badges, ports, errors and header buttons.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals

const IMG = { type: 'preset.text_to_image', typical: 'seconds',
  params: [{ name: 'model', kind: 'text', options_source: 'list', default: 'cheap-1' }, { name: 'prompt', kind: 'textarea' }] }
const JOB = { type: 'preset.text_to_3d', typical: 'minutes: waits for a background job (stops at the timeout, default 15 min)',
  params: [{ name: 'model', kind: 'text', options_source: 'list', default: 'tripo3d/p1' }] }
const LLM = { type: 'llm.complete', typical: 'seconds; longer for long answers or thinking models',
  params: [{ name: 'model', kind: 'model', default: null }, { name: 'system', kind: 'textarea' }] }
const TIMINGS = I.indexTimings({
  window: 5,
  nodes: [
    { type: 'preset.text_to_image', model: 'cheap-1', n: 5, avg_ms: 4200, min_ms: 3100, max_ms: 6000 },
    { type: 'preset.text_to_image', model: 'big-2', n: 1, avg_ms: 21000, min_ms: 21000, max_ms: 21000 },
    { type: 'llm.complete', model: '', n: 2, avg_ms: 1800, min_ms: 900, max_ms: 2700 },
    { type: 'bad' }, null, 'x'
  ],
  types: [{ type: 'preset.text_to_image', n: 5, avg_ms: 7000, min_ms: 3100, max_ms: 21000 }, { n: 3 }]
})

test('formatClock: live elapsed time, whole seconds, then m:ss and h:mm:ss', () => {
  assert.equal(I.formatClock(0), '0 s')
  assert.equal(I.formatClock(4999), '4 s')
  assert.equal(I.formatClock(59999), '59 s')
  assert.equal(I.formatClock(65000), '1:05')
  assert.equal(I.formatClock(3725000), '1:02:05')
  assert.equal(I.formatClock(-5), '0 s')
  assert.equal(I.formatClock(NaN), '')
  assert.equal(I.formatClock(undefined), '')
})

test('typicalShort keeps the headline of a spec typical text', () => {
  assert.equal(I.typicalShort(JOB.typical), 'minutes')
  assert.equal(I.typicalShort(LLM.typical), 'seconds')
  assert.equal(I.typicalShort('instant'), 'instant')
  assert.equal(I.typicalShort(''), '')
  assert.equal(I.typicalShort(null), '')
})

test('timingModel matches the engine: model setting, its default, or empty', () => {
  assert.equal(I.timingModel(IMG, { params: { model: 'big-2' } }), 'big-2')
  assert.equal(I.timingModel(IMG, { params: { model: ' ' } }), 'cheap-1')
  assert.equal(I.timingModel(IMG, {}), 'cheap-1')
  assert.equal(I.timingModel(LLM, { params: { model: 'glm-5' } }), 'glm-5')
  assert.equal(I.timingModel(LLM, { params: {} }), '')
  assert.equal(I.timingModel({ type: 'tool:echo', params: [{ name: 'text' }] }, { params: { text: 'x' } }), '')
  assert.equal(I.timingModel(null, { params: { model: 'x' } }), '')
})

test('indexTimings drops malformed rows', () => {
  assert.deepEqual(Object.keys(TIMINGS.nodes), ['preset.text_to_image', 'llm.complete'])
  assert.deepEqual(Object.keys(TIMINGS.types), ['preset.text_to_image'])
  assert.equal(TIMINGS.window, 5)
  assert.deepEqual(I.indexTimings(null), { window: 0, nodes: {}, types: {} })
})

test('expectedTime: measured average for this type and model, plus the spec typical', () => {
  assert.deepEqual(I.expectedTime(IMG, { type: IMG.type, params: {} }, TIMINGS),
    { model: 'cheap-1', n: 5, avg_ms: 4200, min_ms: 3100, max_ms: 6000, typical: 'seconds' })
  assert.equal(I.expectedTime(IMG, { type: IMG.type, params: { model: 'big-2' } }, TIMINGS).avg_ms, 21000)
  // another model has no runs yet: no borrowed average, only the typical text
  assert.deepEqual(I.expectedTime(IMG, { type: IMG.type, params: { model: 'new-3' } }, TIMINGS),
    { model: 'new-3', n: 0, avg_ms: null, min_ms: null, max_ms: null, typical: 'seconds' })
  assert.equal(I.expectedTime(LLM, { type: 'llm.complete', params: {} }, TIMINGS).avg_ms, 1800)
  assert.equal(I.expectedTime({ type: 'note', params: [] }, { type: 'note' }, TIMINGS), null)
  assert.equal(I.expectedTime(JOB, { type: JOB.type }, null).typical, JOB.typical)
})

test('timingLines: measured runs first, then the typical text', () => {
  assert.deepEqual(I.timingLines(I.expectedTime(IMG, { type: IMG.type }, TIMINGS)),
    ['Your last 5 runs with cheap-1: ~4.2 s (3.1 s – 6.0 s)', 'Typical: seconds'])
  assert.deepEqual(I.timingLines(I.expectedTime(IMG, { type: IMG.type, params: { model: 'big-2' } }, TIMINGS)),
    ['Your last run with big-2: 21 s', 'Typical: seconds'])
  assert.deepEqual(I.timingLines(I.expectedTime(LLM, { type: 'llm.complete' }, TIMINGS)),
    ['Your last 2 runs: ~1.8 s (900 ms – 2.7 s)', 'Typical: seconds; longer for long answers or thinking models'])
  assert.deepEqual(I.timingLines(I.expectedTime(JOB, { type: JOB.type }, TIMINGS)), ['Typical: ' + JOB.typical, 'No runs of tripo3d/p1 yet'])
  assert.deepEqual(I.timingLines(null), [])
})

test('typeTiming: palette entries show the measured average over every model', () => {
  assert.equal(I.typeTiming('preset.text_to_image', TIMINGS), 'your last 5 runs: ~7.0 s')
  assert.equal(I.typeTiming('llm.complete', TIMINGS), '')
  assert.equal(I.typeTiming('preset.text_to_image', null), '')
})

test('statusTip: running shows the live time and the usual duration', () => {
  const now = Date.parse('2026-11-06T12:00:42Z')
  const exp = I.expectedTime(IMG, { type: IMG.type }, TIMINGS)
  const tip = I.statusTip({ status: 'running', started_at: '2026-11-06T12:00:00Z' }, exp, now)
  assert.equal(tip.title, 'Running')
  assert.equal(tip.id, 'status-running')
  assert.deepEqual(tip.lines, ['Running for 42 s', 'Usually ~4.2 s (your last 5 runs with cheap-1)'])
  const fresh = I.statusTip({ status: 'running' }, I.expectedTime(JOB, { type: JOB.type }, null), now)
  assert.deepEqual(fresh.lines, ['Typically minutes'])
})

test('statusTip: done, cached, failed, skipped, stopped, queued', () => {
  const exp = I.expectedTime(IMG, { type: IMG.type }, TIMINGS)
  assert.deepEqual(I.statusTip({ status: 'done', ms: 5100 }, exp).lines, ['Took 5.1 s', 'Usually ~4.2 s (your last 5 runs with cheap-1)'])
  assert.match(I.statusTip({ status: 'cached', ms: 3 }, exp).lines.join(' '), /Reused the last result/)
  const failed = I.statusTip({ status: 'error', ms: 900, error: 'x'.repeat(400) }, exp)
  assert.equal(failed.title, 'Failed')
  assert.equal(failed.tone, 'bad')
  assert.equal(failed.lines[0], 'After 900 ms')
  assert.equal(failed.lines[1].length, 281)
  assert.ok(failed.lines[1].endsWith('…'))
  assert.match(failed.foot, /inspector/)
  const names = { n_a1: 'Make image' }
  const skipped = I.statusTip({ status: 'skipped', error: 'upstream failed: n_a1, n_zz' }, null, 0, (id) => names[id])
  assert.deepEqual(skipped.lines, ['An earlier step failed: Make image, n_zz'])
  assert.equal(I.statusTip({ status: 'skipped', error: 'run cancelled' }, null).lines[0], 'run cancelled')
  assert.equal(I.statusTip({ status: 'cancelled' }, null).title, 'Stopped')
  assert.match(I.statusTip({ status: 'queued' }, null).lines[0], /Waits/)
  assert.equal(I.statusTip({ status: 'weird' }, null).title, 'Queued')
})

test('runTip: live total, steps, and the run error', () => {
  const now = Date.parse('2026-11-06T12:01:05Z')
  const run = { id: 'r_1', status: 'running', started_at: '2026-11-06T12:00:00Z', order: ['a', 'b', 'c'],
    nodes: { a: { status: 'done' }, b: { status: 'cached' }, c: { status: 'running' } } }
  assert.deepEqual(I.runTip(run, now), { id: 'run', title: 'Running', tone: '', lines: ['Running for 1:05', '2 of 3 steps finished · 1 cached'] })
  const failed = I.runTip({ status: 'error', ms: 3200, error: 'Image: boom', nodes: { a: { status: 'error' } } }, now)
  assert.equal(failed.tone, 'bad')
  assert.deepEqual(failed.lines, ['Took 3.2 s', '0 of 1 steps finished', 'Image: boom'])
})

test('portTip: type, required state, wires, multiple inputs, description', () => {
  const pts = { image: { label: 'Image', color: '#f0f' } }
  const req = I.portTip({ name: 'prompt', type: 'text', required: true, description: 'What to draw.' }, 'in', { wires: 0, portTypes: pts })
  assert.equal(req.title, 'prompt')
  assert.equal(req.kind, 'text')
  assert.deepEqual(req.lines, ['What to draw.', 'Required — wire something in or set it in the inspector'])
  assert.equal(req.tone, 'warn')
  const set = I.portTip({ name: 'prompt', type: 'text', required: true }, 'in', { wires: 0, hasValue: true })
  assert.deepEqual(set.lines, ['Required · set in the inspector'])
  assert.equal(set.tone, '')
  const multi = I.portTip({ name: 'image', label: 'Images', type: 'image', multiple: true }, 'in', { wires: 2, portTypes: pts })
  assert.equal(multi.kind, 'Image')
  assert.equal(multi.color, I.portColor('image', pts))
  assert.deepEqual(multi.lines, ['Optional', '2 wires connected · takes several, in wiring order'])
  const out = I.portTip({ name: 'media', type: 'any' }, 'out', { wires: 0 })
  assert.deepEqual(out.lines, ['Drag from here to an input to connect'])
  assert.deepEqual(I.portTip({ name: 'text', type: 'text' }, 'out', { wires: 3 }).lines, ['Feeds 3 inputs'])
  assert.equal(I.portTip({ name: 'text', type: 'text' }, 'out', { wires: 3 }).kind, '')   // no "Text · Text"
  assert.deepEqual(I.portTip({ name: 'text', type: 'text' }, 'in', { wires: 1 }).lines, ['Optional', '1 wire connected'])
})

test('errorTip and tipText', () => {
  const tip = I.errorTip('Line one\nline two')
  assert.equal(tip.title, 'Error')
  assert.equal(tip.tone, 'bad')
  assert.deepEqual(tip.lines, ['Line one line two'])
  assert.match(tip.foot, /inspector/)
  assert.equal(I.tipText({ title: 'Run', keys: ['Ctrl', 'Enter'], lines: ['a', 'b'], foot: 'c' }), 'Run (Ctrl+Enter)\na\nb\nc')
  assert.equal(I.tipText(null), '')
})

test('every header button has a tooltip; run and undo name their shortcuts', () => {
  const ids = ['flows', 'palette', 'inspector', 'undo', 'redo', 'tidy', 'generate', 'ask', 'unfocus', 'stop', 'fresh', 'run']
  for (const id of ids) {
    const tip = I.HEADER_TIPS[id]
    assert.ok(tip && tip.title && tip.lines.length, id)
    assert.equal(tip.id, `header-${id}`)
  }
  assert.deepEqual(I.HEADER_TIPS.run.keys, ['Ctrl', 'Enter'])
  assert.deepEqual(I.HEADER_TIPS.undo.keys, ['Ctrl', 'Z'])
  assert.deepEqual(I.HEADER_TIPS.redo.keys, ['Ctrl', 'Y'])
})
