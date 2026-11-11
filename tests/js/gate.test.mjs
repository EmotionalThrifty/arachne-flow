// scripts/validate_gate.mjs: a clean report passes; any warning (including a raw-bridge cue) or failed check is red.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judge } from '../../scripts/validate_gate.mjs'

const REVIEW = 'desktop surface review (catalog rule 8: SDK surface only): '
const TAIL = '. Use ctx.files / ctx.os / host.request and SDK slots, or open an issue for the hook you need.'
const report = (warnings, ok = true) => ({ ok, checks: [{ name: 'manifest', ok: true, detail: 'ok' }], warnings })

test('clean report passes', () => {
  const r = judge(report([]))
  assert.equal(r.ok, true)
  assert.ok(r.lines.includes('Validation passed.'))
})

test('every warning or failed check keeps the gate red', () => {
  assert.equal(judge(report([REVIEW + 'raw bridge window.hermesDesktop (desktop/plugin.js:2)' + TAIL])).ok, false)
  assert.equal(judge(report(['another warning'])).ok, false)
  const failed = judge({ ok: false, checks: [{ name: 'desktop surface', ok: false, detail: 'eval (desktop/plugin.js:9)' }], warnings: [] })
  assert.equal(failed.ok, false)
  assert.ok(failed.lines.some((l) => l.startsWith('✗ desktop surface')))
})
