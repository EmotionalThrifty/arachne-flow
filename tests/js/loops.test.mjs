// G11: For each / Collect in the canvas — loop bodies, item progress, item tooltips.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals

const node = (id, type, title) => ({ id, type, title, params: {} })
const edge = (id, a, ap, b, bp) => ({ id, from: { node: a, port: ap }, to: { node: b, port: bp } })
const FLOW = {
  nodes: [node('n_src', 'input.text'), node('n_each', 'logic.foreach', 'Each name'), node('n_greet', 'tool:echo'),
    node('n_side', 'output.preview'), node('n_all', 'logic.collect'), node('n_show', 'output.preview'), node('n_free', 'note')],
  edges: [edge('e1', 'n_src', 'text', 'n_each', 'list'), edge('e2', 'n_each', 'item', 'n_greet', 'text'),
    edge('e3', 'n_greet', 'text', 'n_side', 'value'), edge('e4', 'n_greet', 'text', 'n_all', 'value'),
    edge('e5', 'n_all', 'list', 'n_show', 'value')]
}

test('loopBodies: nodes between For each and Collect, same rule as engine/graph.py loops', () => {
  const owner = I.loopBodies(FLOW)
  assert.deepEqual(Object.keys(owner).sort(), ['n_greet', 'n_side'])
  assert.equal(owner.n_greet, 'n_each')
  assert.deepEqual(I.loopBodies({ nodes: [node('a', 'input.text')], edges: [] }), {})
  // a cycle never hangs
  const cyc = { nodes: [node('f', 'logic.foreach'), node('x', 'tool:a'), node('y', 'tool:b')],
    edges: [edge('1', 'f', 'item', 'x', 'in'), edge('2', 'x', 'out', 'y', 'in'), edge('3', 'y', 'out', 'x', 'in2')] }
  assert.deepEqual(Object.keys(I.loopBodies(cyc)).sort(), ['x', 'y'])
})

test('itemCounts / itemsLine: progress and the mix of item results', () => {
  const items = { total: 5, done: 2, cached: 1, skipped: 1, error: 0 }
  assert.equal(I.itemsFinished(items), 4)
  assert.equal(I.itemsLine(items), '5 items: 2 done · 1 cached · 1 skipped')
  assert.equal(I.itemsLine({ total: 1, done: 1, cached: 0, skipped: 0, error: 0 }), '1 item: 1 done')
  assert.equal(I.itemsLine({ total: 0, done: 0, cached: 0, skipped: 0, error: 0 }), 'The list was empty: nothing ran')
  assert.equal(I.itemsLine(null), '')
})

test('statusTip for a loop body node: items first, then the usual lines', () => {
  const running = I.statusTip({ status: 'running', started_at: '2026-11-06T12:00:00Z', items: { total: 4, done: 1, cached: 0, skipped: 0, error: 0 } },
    null, Date.parse('2026-11-06T12:00:10Z'))
  assert.deepEqual(running.lines, ['Running for 10 s', '1 of 4 items finished'])
  const done = I.statusTip({ status: 'done', ms: 900, items: { total: 3, done: 2, cached: 0, skipped: 1, error: 0 } }, null)
  assert.deepEqual(done.lines, ['3 items: 2 done · 1 skipped', 'Took 900 ms in total'])
  const failed = I.statusTip({ status: 'error', ms: 50, error: 'item 2 of 3: boom', items: { total: 3, done: 2, cached: 0, skipped: 0, error: 1 } }, null)
  assert.deepEqual(failed.lines, ['3 items: 2 done · 1 failed', 'item 2 of 3: boom'])
})

test('statusTip for For each: count and the limit note', () => {
  const tip = I.statusTip({ status: 'done', ms: 20, count: 4, note: 'Ran the first 4 of 7 items (Limit).' }, null)
  assert.deepEqual(tip.lines, ['Took 20 ms', 'Ran 4 items', 'Ran the first 4 of 7 items (Limit).'])
})

test('itemRows: one row per item, skipped and failed items say why', () => {
  const state = { status: 'error', items: { total: 3, done: 1, cached: 0, skipped: 1, error: 1 },
    outputs: { text: ['Hi anna', null, null] },
    iterations: [{ status: 'done', ms: 1 }, { status: 'skipped', skip: 'branch', reason: 'Not Bob took “False”, not “True”' },
      { status: 'error', error: 'boom' }] }
  assert.deepEqual(I.itemRows(state, 'text'), [
    { n: 1, kind: 'value', value: 'Hi anna' },
    { n: 2, kind: 'skipped', text: 'skipped: Not Bob took “False”, not “True”' },
    { n: 3, kind: 'error', text: 'boom' }])
  assert.equal(I.itemRows({ ...state, outputs: { media: [{ $media: { path: 'a.png' } }] } }, 'media'), null)
  assert.equal(I.itemRows({ status: 'done', outputs: { text: ['a'] } }, 'text'), null)   // not a loop body
  assert.equal(I.itemRows({ ...state, outputs: { text: 'x' } }, 'text'), null)
})

test('badgeLabel: item progress while running, item count when finished', () => {
  assert.equal(I.badgeLabel({ status: 'running', items: { total: 5, done: 2, cached: 1, skipped: 0, error: 0 } }, ''), '3/5')
  assert.equal(I.badgeLabel({ status: 'running', items: { total: 5, done: 2, cached: 1, skipped: 0, error: 0 } }, '4 s'), '3/5 · 4 s')
  assert.equal(I.badgeLabel({ status: 'done', ms: 1200, items: { total: 5, done: 5, cached: 0, skipped: 0, error: 0 } }, ''), '5× · 1.2 s')
  assert.equal(I.badgeLabel({ status: 'done', ms: 1200 }, ''), '1.2 s')
  assert.equal(I.badgeLabel({ status: 'running' }, '3 s'), '3 s')
  assert.equal(I.badgeLabel({ status: 'cached' }, ''), 'cached')
  assert.equal(I.badgeLabel({ status: 'cached', items: { total: 2, done: 0, cached: 2, skipped: 0, error: 0 } }, ''), '2× cached')
})
