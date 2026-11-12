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

const jobApi = (script) => {
  const calls = []
  return {
    calls,
    generateStart: async (body) => { calls.push(['start', body]); return script.shift()() },
    generateJob: async (id) => { calls.push(['poll', id]); return script.shift()() },
  }
}
const noSleep = async () => {}

test('a build job is polled until done, with progress, and no time limit of its own', async () => {
  const { runGenerationJob } = (await loadPlugin())._internals
  const running = (elapsed, phase = 'thinking') => () => ({ id: 'g_1', status: 'running', phase, elapsed_s: elapsed })
  const script = [running(0, 'starting')]
  for (let i = 1; i <= 400; i++) script.push(running(i * 2))   // ~13 minutes of polls
  script.push(() => ({ id: 'g_1', status: 'done', result: { created: true, flow: { id: 'f_1' } } }))
  const api = jobApi(script)
  const seen = []
  const result = await runGenerationJob(api, { prompt: 'Big' }, { onProgress: (j) => seen.push(j.elapsed_s), sleep: noSleep })
  assert.equal(result.flow.id, 'f_1')
  assert.equal(seen.length, 401)
  assert.equal(seen.at(-1), 800)
  assert.deepEqual(api.calls[0], ['start', { prompt: 'Big' }])
})

test('a build job survives a few failed polls but not a lost job', async () => {
  const { runGenerationJob } = (await loadPlugin())._internals
  const blip = () => { throw new Error('502: {"detail":"Gateway starting"}') }
  const api = jobApi([
    () => ({ id: 'g_2', status: 'running', phase: 'thinking' }), blip, blip,
    () => ({ id: 'g_2', status: 'done', result: { created: false } }),
  ])
  assert.deepEqual(await runGenerationJob(api, {}, { sleep: noSleep }), { created: false })
  const lost = jobApi([() => ({ id: 'g_3', status: 'running' }), () => { throw new Error('404: {"detail":"This build is unknown or expired."}') }])
  await assert.rejects(runGenerationJob(lost, {}, { sleep: noSleep }), /unknown or expired/)
})

test('job errors keep the REST shape: conflicts stay 409, cancel keeps a clear message', async () => {
  const { runGenerationJob, parseRestError } = (await loadPlugin())._internals
  const conflict = jobApi([() => ({ id: 'g_4', status: 'error', error: { status: 409, code: 'conflict', message: 'changed', current_revision: 7 } })])
  const err = await runGenerationJob(conflict, {}, { sleep: noSleep }).catch((e) => e)
  const parsed = parseRestError(err)
  assert.equal(parsed.status, 409)
  assert.equal(parsed.detail.current_revision, 7)
  const bad = jobApi([() => ({ id: 'g_5', status: 'error', error: { status: 400, message: 'Hermes could not build a valid flow after one repair: x' } })])
  const e2 = parseRestError(await runGenerationJob(bad, {}, { sleep: noSleep }).catch((e) => e))
  assert.equal(e2.status, 400)
  assert.match(e2.message, /after one repair/)
  const stopped = jobApi([() => ({ id: 'g_6', status: 'cancelled' })])
  await assert.rejects(runGenerationJob(stopped, {}, { sleep: noSleep }), /cancelled\. Nothing was saved/)
})

test('progress shows phase and elapsed time; a finished build drops the job id', async () => {
  const { generateInitial, generateReducer, generationStatus } = (await loadPlugin())._internals
  let s = generateReducer(generateInitial(), { type: 'start' })
  s = generateReducer(s, { type: 'progress', jobId: 'g_7', phase: 'repairing', elapsed: 125.4 })
  assert.equal(s.jobId, 'g_7')
  assert.equal(generationStatus(s.phase, s.elapsed), 'Fixing a validation error (one repair) · 2 min 05 s')
  assert.equal(generationStatus('thinking', 9), 'Hermes is designing the flow · 9 s')
  s = generateReducer(s, { type: 'fail', error: 'x' })
  assert.equal(s.jobId, null)
  assert.equal(generateReducer(generateInitial(), { type: 'progress', jobId: 'late' }).jobId, null)   // not busy: ignored
})
