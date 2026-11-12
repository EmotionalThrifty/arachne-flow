// Trigger nodes in the inspector: status lines, relative times, the old Schedule-with-Hermes path is gone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals
const SRC = readFileSync(new URL('../../desktop/plugin.js', import.meta.url), 'utf8')
const NOW = new Date(2026, 10, 12, 10, 0, 0).getTime()
const at = (min) => (NOW + min * 60000) / 1000

test('trigger times read as now / in N min / today HH:MM / weekday', () => {
  assert.equal(I.triggerWhen(at(0.2), NOW), 'now')
  assert.equal(I.triggerWhen(at(5), NOW), 'in 5 min')
  assert.equal(I.triggerWhen(at(-12), NOW), '12 min ago')
  assert.equal(I.triggerWhen(at(120), NOW), 'today 12:00')
  assert.match(I.triggerWhen(at(24 * 60 + 30), NOW), /^Fri 13 Nov 10:30$/)
  assert.equal(I.triggerWhen(null, NOW), '')
})

test('status lines: off, waiting for a runner, schedule + next + last start, webhook', () => {
  const sched = { id: 'n_1', type: 'trigger.schedule' }
  assert.match(I.triggerLines(sched, { active: false }, 1, NOW)[0], /^Off\. Activate it/)
  assert.match(I.triggerLines({ ...sched, type: 'trigger.webhook' }, { active: false }, 1, NOW)[0], /local URL/)
  const lines = I.triggerLines(sched, { active: true, schedule: 'weekdays 08:00', next: at(5), last_fire: at(-50), fires: 3 }, 1234, NOW)
  assert.deepEqual(lines, ['Schedule: weekdays 08:00', 'Next: in 5 min', 'Last start: 50 min ago · 3 runs so far'])
  const waiting = I.triggerLines(sched, { active: true, schedule: 'every 1h' }, null, NOW)
  assert.match(waiting[0], /Waiting for Hermes/)
  const hook = I.triggerLines({ id: 'n_2', type: 'trigger.webhook' }, { active: true, last_event_at: '2026-11-12T09:58:00+01:00' }, 7, NOW)
  assert.deepEqual(hook, ['Runs on every POST to its URL.', 'Last request: 2026-11-12 09:58'])
  assert.deepEqual(I.triggerLines(sched, null, null, NOW), ['Loading status…'])
  const folder = I.triggerLines({ id: 'n_3', type: 'trigger.folder' }, { active: true, watching: 'C:\\Inbox' }, 7, NOW)
  assert.deepEqual(folder, ['Watching: C:\\Inbox', 'Checks every 15 s; a file starts the flow once it is fully written.'])
  const after = I.triggerLines({ id: 'n_4', type: 'trigger.flow' }, { active: true, source: 'Digest' }, 7, NOW)
  assert.deepEqual(after, ['After: Digest'])
})

test('folder fields open a folder dialog and sign the pick as a folder', () => {
  assert.match(SRC, /spec\.browse === 'file' \|\| spec\.browse === 'folder'/)
  assert.match(SRC, /directories: true/)
  assert.match(SRC, /folder: folder === true/)
})

test('trigger nodes get their own inspector section; Schedule with Hermes (agent cron turn) is gone', () => {
  assert.equal(I.isTriggerType('trigger.rss'), true)
  assert.equal(I.isTriggerType('input.text'), false)
  assert.match(SRC, /isTriggerType\(node\.type\) \? h\(TriggerGuard,/)
  assert.ok(!SRC.includes('Schedule with Hermes'), 'the old chat-cron menu entry is removed')
  assert.ok(!SRC.includes('cronjob_manage'), 'no agent cron prompt is built any more')
  assert.match(SRC, /triggerSwitch: \(id, nodeId, active, base, rotate = false\) => call\('POST', `flows\/\$\{encodeURIComponent\(id\)\}\/trigger`/)
})
