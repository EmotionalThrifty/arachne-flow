// Flows menu: search, tabs, recent-first with "Show all"; After flow picker resolves ids and names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals
const flows = Array.from({ length: 12 }, (_, i) => ({
  id: `f_${i}`, name: i === 3 ? 'Vault inbox tagger' : `Flow ${i}`, node_count: i, updated_at: `2026-11-${String(10 + (i % 3)).padStart(2, '0')}T0${i % 10}:00:00Z`
}))
const templates = [
  { id: 'u-mine', name: 'My pipeline', source: 'user' },
  { id: 'blog', name: 'Blog post writer', source: 'builtin', description: 'Draft an article' },
  { id: 'tts', name: 'Text → speech', source: 'builtin' }
]

test('search matches every word, case-insensitive, in any of the texts', () => {
  assert.equal(I.menuMatch('', 'x'), true)
  assert.equal(I.menuMatch('VAULT tag', 'Vault inbox tagger'), true)
  assert.equal(I.menuMatch('vault blog', 'Vault inbox tagger'), false)
  assert.equal(I.menuMatch('article', 'Blog post writer', 'Draft an article'), true)
})

test('the flows tab shows the 8 most recent flows, then Show all; templates stay on their own tab', () => {
  const m = I.flowMenuModel({ flows, templates })
  assert.equal(m.flows.length, 8)
  assert.equal(m.moreFlows, 4)
  assert.deepEqual(m.counts, { flows: 12, templates: 3 })
  assert.deepEqual([m.own.length, m.builtin.length], [0, 0])
  const sorted = flows.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  assert.deepEqual(m.flows.map((f) => f.id), sorted.slice(0, 8).map((f) => f.id))
  assert.equal(I.flowMenuModel({ flows, templates, showAll: true }).flows.length, 12)
  const t = I.flowMenuModel({ flows, templates, tab: 'templates' })
  assert.deepEqual([t.flows.length, t.own.length, t.builtin.length], [0, 1, 2])
})

test('a search covers flows and templates at once, with no cut-off', () => {
  const m = I.flowMenuModel({ flows, templates, query: 'flow', tab: 'templates' })
  assert.equal(m.flows.length, 11)
  assert.equal(m.moreFlows, 0)
  const blog = I.flowMenuModel({ flows, templates, query: 'blog' })
  assert.deepEqual([blog.flows.length, blog.builtin.map((x) => x.id)], [0, ['blog']])
  assert.equal(I.flowMenuModel({ flows, templates, query: 'zzz' }).empty, true)
})

test('the After flow picker finds the stored flow by id or by unique name', () => {
  assert.equal(I.flowPickerChoice(flows, 'f_3').name, 'Vault inbox tagger')
  assert.equal(I.flowPickerChoice(flows, 'vault inbox tagger').id, 'f_3')
  assert.equal(I.flowPickerChoice([...flows, { id: 'f_x', name: 'Flow 1' }], 'Flow 1'), null)
  assert.equal(I.flowPickerChoice(flows, ''), null)
  assert.equal(I.flowPickerChoice(null, 'f_1'), null)
})
