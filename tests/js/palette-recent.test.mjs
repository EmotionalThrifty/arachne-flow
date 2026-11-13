import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin, loadReactStub } from './load.mjs'
const I = (await loadPlugin())._internals
const { withHookState } = await loadReactStub()
const list = [
  { type: 'preset.image', title: 'Image preset', category: 'Presets' },
  { type: 'input.text', title: 'Text', category: 'Inputs' },
  { type: 'llm.complete', title: 'LLM', category: 'AI' }
]
const recent = ['llm.complete', 'input.text']
function nodes(v, pred) {
  if (!v || typeof v !== 'object') return []
  return [...(pred(v) ? [v] : []), ...[v.props?.children].flat(Infinity).flatMap(x => nodes(x, pred))]
}
const section = (tree, id = 'recent') => nodes(tree, v => v.props?.['data-fc-section'] === id)[0]
const head = tree => nodes(tree, v => v.props?.className === 'fc-pal-sec-head')[0]
const entries = tree => nodes(tree, v => v.props?.spec?.type).map(v => v.props.spec.type)
function fixture(initialFolds = {}, recentIds = recent) {
  let folds = initialFolds
  const state = {}, added = []
  const render = () => withHookState(state, () => I.Palette({ types: { list, portTypes: {} }, recent: recentIds,
    folds, onFolds: next => { folds = next }, onAdd: type => added.push(type) }))
  return { render, added, folds: () => folds }
}

test('recent nodes are a flat standard palette section before Ready-made, retaining usage order', () => {
  const recents = I.resolveRecentTypes(list, recent)
  const sections = I.paletteSections(I.groupByCategory(list), recents)
  assert.deepEqual(sections.map(s => s.id), ['recent', 'ready', 'basic'])
  assert.equal(sections[0].flat, true)
  assert.equal(sections[0].icon, 'history')
  assert.equal(sections[0].count, 2)
  assert.deepEqual(sections[0].groups[0].items.map(t => t.type), recent)
  assert.ok(I.paletteFolds(sections).some(f => f.key === '§recent' && f.def === true))
})

test('Recently used has the same header as Ready-made and toggles with click, Enter and Space', () => {
  const f = fixture()
  let tree = f.render(), current = section(tree)
  assert.ok(current, 'Recently used must use a standard section wrapper')
  assert.equal(current.props['data-fc-recent'], '1')
  assert.equal(head(current).props.className, head(section(tree, 'ready')).props.className)
  assert.equal(head(current).props['aria-expanded'], true)
  assert.equal(head(current).props.tabIndex, 0)
  assert.deepEqual(entries(current), recent)
  head(current).props.onClick()
  assert.equal(f.folds()['§recent'], false)
  assert.deepEqual(entries(section(f.render())), [])
  let prevented = 0
  head(section(f.render())).props.onKeyDown({ key: 'Enter', preventDefault() { prevented++ } })
  assert.deepEqual(entries(section(f.render())), recent)
  head(section(f.render())).props.onKeyDown({ key: ' ', preventDefault() { prevented++ } })
  assert.equal(head(section(f.render())).props['aria-expanded'], false)
  assert.equal(prevented, 2)
})

test('Collapse all and Expand all include Recently used; an empty history has no section', () => {
  const f = fixture()
  const bulk = tree => nodes(tree, v => v.props?.['data-fc-fold'])[0]
  bulk(f.render()).props.onClick()
  assert.equal(f.folds()['§recent'], false)
  assert.deepEqual(entries(section(f.render())), [])
  bulk(f.render()).props.onClick()
  assert.equal(f.folds()['§recent'], true)
  assert.deepEqual(entries(section(f.render())), recent)
  assert.equal(section(fixture({}, []).render()), undefined)
})

test('search reveals matching recent nodes without overwriting their saved collapsed state', () => {
  const f = fixture({ '§recent': false })
  const search = tree => nodes(tree, v => v.type === 'input' && v.props.placeholder === 'Search nodes, ports…')[0]
  assert.deepEqual(entries(section(f.render())), [])
  search(f.render()).props.onChange({ target: { value: 'Text' } })
  assert.deepEqual(entries(section(f.render())), ['input.text'])
  assert.equal(f.folds()['§recent'], false)
  search(f.render()).props.onChange({ target: { value: '' } })
  assert.deepEqual(entries(section(f.render())), [])
})
