// G10: If / Switch / Merge in the canvas — dynamic Switch outputs, untaken branches, skip tooltips.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals

const SWITCH = { type: 'logic.switch', inputs: [{ name: 'value', type: 'any', required: true }],
  outputs: [{ name: 'default', type: 'any', label: 'Default' }],
  params: [{ name: 'cases', kind: 'textarea', default: '' }], dynamic_outputs: 'cases' }

test('switchCases: one per non-empty trimmed line, at most 20', () => {
  assert.deepEqual(I.switchCases('red\n\n  green \nblue\r\n'), ['red', 'green', 'blue'])
  assert.deepEqual(I.switchCases(['a', ' ', 'b']), ['a', 'b'])
  assert.deepEqual(I.switchCases(null), [])
  assert.equal(I.switchCases('x\n'.repeat(40)).length, 20)
})

test('nodePorts: Switch gets case outputs before Default, same names as the engine', () => {
  const { outputs } = I.nodePorts({ type: 'logic.switch', params: { cases: 'red\ngreen' } }, SWITCH)
  assert.deepEqual(outputs.map((p) => [p.name, p.label]), [['case1', 'red'], ['case2', 'green'], ['default', 'Default']])
  assert.deepEqual(I.nodePorts({ type: 'logic.switch', params: {} }, SWITCH).outputs.map((p) => p.name), ['default'])
})

test('updateNode drops wires from Switch cases that no longer exist', () => {
  const flow = {
    nodes: [{ id: 'n_s', type: 'logic.switch', params: { cases: 'a\nb\nc' } }, { id: 'n_x', type: 'output.preview', params: {} }],
    edges: [
      { id: 'e1', from: { node: 'n_s', port: 'case3' }, to: { node: 'n_x', port: 'value' } },
      { id: 'e2', from: { node: 'n_s', port: 'default' }, to: { node: 'n_x', port: 'value' } }
    ]
  }
  const out = I.updateNode(flow, 'n_s', { params: { cases: 'a\nb' } }, { 'logic.switch': SWITCH })
  assert.deepEqual(out.edges.map((e) => e.id), ['e2'])
  const same = I.updateNode(flow, 'n_s', { params: { cases: 'a\nb\nC' } }, { 'logic.switch': SWITCH })
  assert.equal(same.edges.length, 2)
})

test('edgeDead: untaken branch outputs, failed sources and skipped targets', () => {
  assert.equal(I.edgeDead({ status: 'done', branch: 'true' }, null, 'false'), true)
  assert.equal(I.edgeDead({ status: 'cached', branch: 'true' }, null, 'true'), false)
  assert.equal(I.edgeDead({ status: 'done' }, null, 'text'), false)
  assert.equal(I.edgeDead({ status: 'error' }, null, 'text'), true)
  assert.equal(I.edgeDead(null, { status: 'skipped' }, 'text'), true)
  assert.equal(I.edgeDead({ status: 'skipped', skip: 'branch' }, { status: 'done' }, 'text'), true)   // into a Merge
  assert.equal(I.edgeDead({ status: 'running', branch: 'true' }, null, 'false'), false)
  assert.equal(I.edgeDead(null, null, 'x'), false)
})

test('branchPort: taken / untaken / unknown for output ports', () => {
  assert.equal(I.branchPort({ status: 'done', branch: 'case2' }, 'case2'), 'taken')
  assert.equal(I.branchPort({ status: 'done', branch: 'case2' }, 'default'), 'untaken')
  assert.equal(I.branchPort({ status: 'running', branch: 'case2' }, 'default'), '')
  assert.equal(I.branchPort({ status: 'done' }, 'text'), '')
  assert.equal(I.branchPort(null, 'text'), '')
})

test('statusTip: a skipped branch is not a failure', () => {
  const tip = I.statusTip({ status: 'skipped', skip: 'branch', reason: 'Is yes? took “True”, not “False”' }, null)
  assert.equal(tip.title, 'Skipped')
  assert.equal(tip.tone, '')
  assert.deepEqual(tip.lines, ['Not on the branch this run took.', 'Is yes? took “True”, not “False”'])
  const failed = I.statusTip({ status: 'skipped', error: 'upstream failed: n_a' }, null, 0, () => 'Image')
  assert.deepEqual(failed.lines, ['An earlier step failed: Image'])
})

test('statusTip and portTip for If/Switch nodes name the taken output', () => {
  const done = I.statusTip({ status: 'done', ms: 2, branch: 'false' }, null, 0, () => '', 'False')
  assert.deepEqual(done.lines, ['Took 2 ms', 'Took the “False” output'])
  const taken = I.portTip({ name: 'true', label: 'True', type: 'any' }, 'out', { wires: 1, branch: 'taken' })
  assert.deepEqual(taken.lines, ['Feeds 1 input', 'Taken in this run'])
  const untaken = I.portTip({ name: 'false', label: 'False', type: 'any' }, 'out', { wires: 2, branch: 'untaken' })
  assert.deepEqual(untaken.lines, ['Feeds 2 inputs', 'Not taken in this run: the steps after it were skipped'])
})

test('typeTip mentions dynamic Switch outputs; Logic has its own colour', () => {
  const tip = I.typeTip(SWITCH)
  assert.match(tip.moreOutputsText, /one output per case line/)
  assert.notEqual(I.categoryColor('Logic'), I.categoryColor('Nope'))
})
