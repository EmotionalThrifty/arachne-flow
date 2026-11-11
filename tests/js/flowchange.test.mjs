// R2-04: a save that failed must cancel the flow switch/new/duplicate instead of discarding unsaved edits.
// The test drives the pure helper behaviorally (no source grep): persist first, then re-check the save
// blocker, and only then run the change. The UI paths openFlow/createAndOpen/duplicateFlow use it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals

const REASON = 'The flow could not be saved, so it cannot run yet.'

test('a failed save blocks open, new and duplicate before they run (R2-04)', async () => {
  assert.equal(typeof I.persistForFlowChange, 'function',
    'default export _internals must expose the pure persistForFlowChange helper')
  for (const action of ['getFlow (open)', 'createFlow (new)', 'duplicate']) {
    const log = []
    const res = await I.persistForFlowChange(
      async () => { log.push('persist') },
      () => { log.push('check'); return REASON },
      async () => { log.push(action); return 'changed' },
      (reason) => log.push('blocked:' + reason),
    )
    assert.deepEqual(log, ['persist', 'check', 'blocked:' + REASON],
      `${action} must not run after a blocked save`)
    assert.equal(res.ok, false, action)
    assert.equal(res.reason, REASON, action)
  }
})

test('a successful save runs the flow change exactly once (R2-04)', async () => {
  const log = []
  const res = await I.persistForFlowChange(
    async () => { log.push('persist') },
    () => { log.push('check'); return null },
    async () => { log.push('change'); return { id: 'f_2' } },
    (reason) => log.push('blocked:' + reason),
  )
  assert.deepEqual(log, ['persist', 'check', 'change'])
  assert.equal(res.ok, true)
  assert.deepEqual(res.value, { id: 'f_2' })
})
