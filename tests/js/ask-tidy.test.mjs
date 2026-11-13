import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin, loadReactStub } from './load.mjs'
const I = (await loadPlugin())._internals
const { withHookState } = await loadReactStub()

test('Ask Hermes counts every second between slow backend progress responses and catches up after a suspended window', () => {
  let s = I.generateReducer(I.generateInitial(), { type: 'start', at: 100_000 })
  assert.equal(s.startedAt, 100_000)
  assert.deepEqual([0, 1000, 2000, 3000, 4000].map(ms => Math.floor(I.generationElapsed(s, 100_000 + ms))), [0, 1, 2, 3, 4])
  s = I.generateReducer(s, { type: 'progress', jobId: 'g_test', phase: 'thinking', elapsed: 5 })
  assert.deepEqual([5, 6, 7, 8, 9].map(sec => Math.floor(I.generationElapsed(s, 100_000 + sec * 1000))), [5, 6, 7, 8, 9])
  assert.equal(I.generationElapsed(s, 225_000), 125)
  assert.equal(I.generationStatus('thinking', 59.999), 'Hermes is designing the flow · 59 s')
})

test('generation clock restarts for a retry and clears when stopped, closed, or successful', () => {
  let s = I.generateReducer(I.generateInitial(), { type: 'start', at: 1000 })
  s = I.generateReducer(s, { type: 'fail', error: 'stop' })
  assert.equal(s.startedAt, null)
  s = I.generateReducer(s, { type: 'start', at: 9000 })
  assert.equal(I.generationElapsed(s, 10_000), 1)
  assert.equal(I.generateReducer(s, { type: 'success' }).startedAt, null)
  assert.equal(I.generateReducer(s, { type: 'close' }).startedAt, null)
})

test('the rendered build composer uses the live clock instead of the last backend elapsed value', () => {
  const saved = Date.now
  Date.now = () => 108_000
  try {
    const s = I.generateReducer(I.generateInitial(), { type: 'start', at: 100_000 })
    const tree = withHookState({}, () => I.GenerateComposer({ generation: s, onEdit() {}, onSubmit() {} }))
    const text = v => typeof v === 'string' ? v : v && typeof v === 'object' ? [v.props?.children].flat(Infinity).map(text).join(' ') : ''
    assert.match(text(tree), /Starting… · 8 s/)
  } finally { Date.now = saved }
})

test('Tidy sends current DOM dimensions in world pixels, not zoom-scaled client rectangles or stale cached heights', () => {
  const ids = ['n_a', 'n_b', 'n_c']
  const el = (id, w, h) => ({ dataset: { fcNode: id }, offsetWidth: w, offsetHeight: h, getBoundingClientRect: () => ({ width: w / 4, height: h / 4 }) })
  const root = { querySelectorAll: () => [el('n_a', 240, 930), el('n_b', 480, 170), el('stale', 240, 999)] }
  assert.deepEqual(I.measureNodeSizes(root, { nodes: ids.map(id => ({ id })) }), {
    n_a: { width: 240, height: 930 }, n_b: { width: 480, height: 170 }
  })
  assert.deepEqual(I.measureNodeSizes(null, { nodes: [] }), {})
  assert.deepEqual(I.measureNodeSizes({ querySelectorAll: () => [el('n_a', Infinity, 20), el('n_b', 40, 0)] }, { nodes: ids.map(id => ({ id })) }), {})
})
