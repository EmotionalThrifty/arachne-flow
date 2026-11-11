// Scheduling a flow with Hermes cron: the menu prompt + the dialog draft.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals
const flow = { id: 'f_ab12', name: 'Daily digest', nodes: [] }
const inputNode = { id: 'n_q', type: 'input.text', title: 'Query', params: { value: 'ai news' } }
const fileNode = { id: 'n_f', type: 'input.file', title: 'Photo', params: { path: 'C:/pics/cat.png' } }
const numNode = { id: 'n_n', type: 'input.number', title: 'Count', params: { value: 3 } }

test('schedulePrompt names the flow id and the exact scheduling request', () => {
  const p = I.schedulePrompt({ ...flow, nodes: [inputNode] }, { schedule: 'every weekday at 8am', fresh: true })
  assert.match(p, /Create a recurring cron job with cronjob_manage \(action: 'create'\)/)
  assert.match(p, /schedule: "every weekday at 8am"/)
  assert.match(p, /flow_run\(flow="f_ab12", fresh=true, inputs=/)
  assert.match(p, /"Query": "ai news"/)
  assert.match(p, /afterwards report only failures/)
  assert.match(p, /Do not change the flow|Do not edit the flow/)
  assert.doesNotMatch(p, /fresh=false/)
})

test('schedulePrompt: no inputs -> plain run, one-shot keeps its wording', () => {
  const p = I.schedulePrompt({ ...flow, nodes: [] }, { schedule: 'in 30m' })
  assert.match(p, /flow_run\(flow="f_ab12"\)/)
  assert.doesNotMatch(p, /inputs=/)
  assert.match(p, /Create a one-shot cron job/)
  assert.doesNotMatch(p, /fresh=true/)
})

test('schedulePrompt keeps file paths out; inputs by title fall back to node ids', () => {
  const p = I.schedulePrompt({ ...flow, nodes: [inputNode, fileNode, numNode, { id: 'n_2', type: 'input.text', title: 'Query', params: {} }] },
    { schedule: '0 9 * * *' })
  assert.doesNotMatch(p, /cat\.png/)
  assert.match(p, /its file input needs a value at run time/)
  assert.match(p, /"n_q": "ai news"/)       // duplicate title Query -> id
  assert.match(p, /"Count": 3/)
})

test('schedulePrompt: the tool argument is flow (not flow_id); quotes in names cannot break it', () => {
  const p = I.schedulePrompt({ id: 'f_x', name: 'My "best"\nflow', nodes: [] }, { schedule: 'every day at 9am' })
  assert.doesNotMatch(p, /flow_id=/)
  assert.match(p, /flow "My \\"best\\" flow" \(id f_x\)/)
  assert.equal(p.split('\n')[0].includes('\nflow'), false)
})

test('applyNodeStatus: live loop counts arrive, a new start clears the last run', () => {
  const prev = { status: 'done', ms: 900, branch: 'true', items: { total: 3, done: 3 }, count: 3, note: 'x', iterations: [1], started_at: 'old' }
  const run = I.applyNodeStatus(prev, { status: 'running', started_at: 'T1', items: { total: 2, done: 0 } })
  assert.equal(run.started_at, 'T1')
  assert.deepEqual(run.items, { total: 2, done: 0 })
  for (const k of ['branch', 'count', 'note', 'iterations']) assert.equal(k in run, false, k)
  const old = I.applyNodeStatus(prev, { status: 'running' }, () => 'NOW')
  assert.equal(old.started_at, 'NOW')
  const all = I.applyNodeStatus({}, { status: 'done', ms: 5, branch: 'b', skip: 's', reason: 'r', started_at: 'S', items: { total: 1 }, count: 1, note: 'n' })
  assert.deepEqual(all, { status: 'done', ms: 5, branch: 'b', skip: 's', reason: 'r', started_at: 'S', items: { total: 1 }, count: 1, note: 'n' })
})

test('applyNodeStatus: a job progress line arrives live and a new start clears it (E-1)', () => {
  const live = I.applyNodeStatus({ status: 'running', started_at: 'T1' }, { status: 'running', started_at: 'T1', progress: '3D job: IN_PROGRESS' })
  assert.equal(live.progress, '3D job: IN_PROGRESS')
  const again = I.applyNodeStatus({ status: 'done', progress: '3D job: IN_PROGRESS' }, { status: 'running', started_at: 'T2' })
  assert.equal('progress' in again, false)
})

test('statusTip: a running job shows its progress line, a finished one does not (E-1)', () => {
  const now = Date.parse('2026-11-06T12:00:10Z')
  const tip = I.statusTip({ status: 'running', started_at: '2026-11-06T12:00:00Z', progress: '3D job: IN_PROGRESS' }, null, now)
  assert.deepEqual(tip.lines, ['Running for 10 s', '3D job: IN_PROGRESS'])
  const done = I.statusTip({ status: 'done', ms: 5000, progress: '3D job: IN_PROGRESS' }, null, now)
  assert.equal(done.lines.includes('3D job: IN_PROGRESS'), false)
})

test('setMediaItem: trims, appends, never drops a row while typing', () => {
  const items = ['a.png', 'b.png']
  assert.deepEqual(I.setMediaItem(items, 0, ' my file.png '), ['my file.png', 'b.png'])
  assert.deepEqual(I.setMediaItem(items, 2, 'c.png'), ['a.png', 'b.png', 'c.png'])
  assert.equal(I.setMediaItem(items, 0, '   '), items)
  assert.equal(I.setMediaItem(items, 2, ''), items)
})

test('scheduleDraft pre-fills the dialog and refuses an empty schedule', () => {
  assert.equal(I.scheduleDraft('every day at 9am', null).schedule, 'every day at 9am')
  assert.equal(I.scheduleError('   '), 'Enter when to run it, e.g. "every weekday at 8am" or "in 30m".')
  assert.equal(I.scheduleError('every day at 9am'), '')
})
