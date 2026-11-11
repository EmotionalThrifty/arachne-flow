import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const init = async () => {
  const { generateInitial, generateReducer, generationBody, generationSummary } = (await loadPlugin())._internals
  return { generateInitial, generateReducer, generationBody, generationSummary }
}

test('generation uses the current Hermes model by default and selected provider/model only when chosen', async () => {
  const { generationBody } = await init()
  assert.deepEqual(generationBody({
    prompt: '  Build a flow  ', flow: { id: 'f_1234567890' }, baseRevision: 3, model: '', provider: '',
  }), { prompt: 'Build a flow', flow_id: 'f_1234567890', base_revision: 3, origin: 'ui' })
  assert.deepEqual(generationBody({ prompt: 'New', model: null, provider: null }), { prompt: 'New', origin: 'ui' })
  assert.deepEqual(generationBody({
    prompt: 'Picked', model: 'z-ai/glm-5.3-flash', provider: 'z-ai',
  }), { prompt: 'Picked', model: 'z-ai/glm-5.3-flash', provider: 'z-ai', origin: 'ui' })
})

test('generation UI failure keeps prompt and model; success resets the draft', async () => {
  const { generateInitial, generateReducer } = await init()
  let state = generateInitial()
  state = generateReducer(state, { type: 'open' })
  state = generateReducer(state, { type: 'edit', patch: { prompt: 'Keep me', model: 'z/model', provider: 'z' } })
  state = generateReducer(state, { type: 'start' })
  assert.equal(state.busy, true)
  state = generateReducer(state, { type: 'fail', error: 'Could not build' })
  assert.equal(state.busy, false)
  assert.equal(state.error, 'Could not build')
  assert.deepEqual(state.draft, { prompt: 'Keep me', model: 'z/model', provider: 'z' })
  assert.equal(state.open, true)
  state = generateReducer(state, { type: 'success' })
  assert.deepEqual(state, generateInitial())
})

test('generation summary names created nodes, connections and the single repair', async () => {
  const { generationSummary } = await init()
  assert.equal(generationSummary({ created: true, repaired: true, summary: { nodes: 2, connections: 1 } }),
    'Created flow · 2 nodes · 1 connection · repaired once')
  assert.equal(generationSummary({ created: false, repaired: false, summary: { nodes: 1, connections: 0 } }),
    'Updated flow · 1 node · 0 connections')
})
