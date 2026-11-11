// scripts/validate_gate.mjs: only the approved openWindow raw-bridge warning may pass.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judge } from '../../scripts/validate_gate.mjs'

const REVIEW = 'desktop surface review (catalog rule 8: SDK surface only): '
const TAIL = '. Use ctx.files / ctx.os / host.request and SDK slots, or open an issue for the hook you need.'
const SRC = ['const a = 1', "const opener = () => window.hermesDesktop.openWindow()", "const b = window.hermesDesktop.selectPaths()"].join('\n')
const report = (warnings, ok = true) => ({ ok, checks: [{ name: 'manifest', ok: true, detail: 'ok' }], warnings })
const cue = (line) => `raw bridge window.hermesDesktop (desktop/plugin.js:${line})`

test('clean report passes', () => {
  const r = judge(report([]), SRC)
  assert.equal(r.ok, true)
  assert.ok(r.lines.includes('Validation passed.'))
})

test('the single openWindow raw-bridge warning is allowed', () => {
  const r = judge(report([REVIEW + cue(2) + TAIL]), SRC)
  assert.equal(r.ok, true)
  assert.equal(r.allowed, 2)
})

test('raw bridge on any other line, a second cue, other warnings or a failed check stay red', () => {
  assert.equal(judge(report([REVIEW + cue(3) + TAIL]), SRC).ok, false)          // selectPaths line
  assert.equal(judge(report([REVIEW + cue(2) + '; ' + cue(3) + TAIL]), SRC).ok, false)
  assert.equal(judge(report([REVIEW + 'app markup selector (desktop/plugin.js:1)' + TAIL]), SRC).ok, false)
  assert.equal(judge(report([REVIEW + cue(2) + TAIL, 'another warning']), SRC).ok, false)
  assert.equal(judge(report([REVIEW + cue(2) + TAIL, REVIEW + cue(2) + TAIL]), SRC).ok, false)
  const failed = judge({ ok: false, checks: [{ name: 'desktop surface', ok: false, detail: 'eval (desktop/plugin.js:9)' }], warnings: [] }, SRC)
  assert.equal(failed.ok, false)
  assert.ok(failed.lines.some((l) => l.startsWith('✗ desktop surface')))
})
