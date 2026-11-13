// Render the actual picker with persistent hooks; keyboard selection and failed-refresh recovery.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin, loadReactStub } from './load.mjs'

const { withHookState } = await loadReactStub()
const I = (await loadPlugin())._internals
function nodes(v, pred) {
  if (!v || typeof v !== 'object') return []
  const children = [v.props?.children].flat(Infinity)
  return [...(pred(v) ? [v] : []), ...children.flatMap((x) => nodes(x, pred))]
}
const by = (tree, key) => nodes(tree, (v) => v.props?.[key] !== undefined)
const keyEvent = (key) => ({ key, preventDefault() {}, stopPropagation() {} })
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
const flows = [
  { id: 'f_self', name: 'This flow', updated_at: '2026-11-12T10:00:00Z', node_count: 1 },
  { id: 'f_first', name: 'Morning digest', updated_at: '2026-11-12T09:00:00Z', node_count: 2 },
  { id: 'f_second', name: 'Vault inbox', updated_at: '2026-11-12T08:00:00Z', node_count: 3 }
]
function fixture(api) {
  const store = {}, picked = []
  const render = () => withHookState(store, () => I.FlowPicker({ api, ownId: 'f_self', value: '', onChange: (v) => picked.push(v) }))
  const open = async () => {
    render()
    // Seed the state normally filled by useEffect (the Node React stub does not run effects).
    try { store.list[2].set((await api.flows()).flows) }
    catch (error) { store.list[3].set(error.message) }
    nodes(render(), (v) => v.type === 'button')[0].props.onClick()
    await settle()
    return render()
  }
  return { render, open, picked }
}

test('After flow lists all other flows as accessible options; ArrowDown + Enter selects the second by id', async () => {
  const f = fixture({ flows: async () => ({ flows }) })
  let tree = await f.open()
  const options = by(tree, 'data-fc-flow-option')
  assert.deepEqual(options.map((v) => v.props['data-fc-flow-option']), ['f_first', 'f_second'])
  assert.ok(options.every((v) => v.props.role === 'option'))
  let search = by(tree, 'data-fc-flow-search')[0]
  search.props.onKeyDown(keyEvent('ArrowDown'))
  tree = f.render()
  by(tree, 'data-fc-flow-search')[0].props.onKeyDown(keyEvent('Enter'))
  assert.deepEqual(f.picked, ['f_second'])
  assert.equal(by(f.render(), 'data-fc-flow-option').length, 0)
})

test('search then Enter picks the matching flow, not a hidden result', async () => {
  const f = fixture({ flows: async () => ({ flows }) })
  let tree = await f.open()
  by(tree, 'data-fc-flow-search')[0].props.onChange({ target: { value: 'vault' } })
  tree = f.render()
  assert.deepEqual(by(tree, 'data-fc-flow-option').map((v) => v.props['data-fc-flow-option']), ['f_second'])
  by(tree, 'data-fc-flow-search')[0].props.onKeyDown(keyEvent('Enter'))
  assert.deepEqual(f.picked, ['f_second'])
})

test('refresh after a failed list request clears the error and shows the recovered list', async () => {
  let fail = true
  const f = fixture({ flows: async () => { if (fail) throw new Error('offline'); return { flows } } })
  let tree = await f.open()
  assert.equal(by(tree, 'data-fc-flow-error').length, 1)
  fail = false
  by(tree, 'data-fc-flow-refresh')[0].props.onClick()
  await settle()
  tree = f.render()
  assert.equal(by(tree, 'data-fc-flow-error').length, 0)
  assert.equal(by(tree, 'data-fc-flow-option').length, 2)
})
