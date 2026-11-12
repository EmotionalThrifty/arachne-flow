// UI-5/UI-6: the real closures loadTheirs / keepMine / openFlow / recoverConnection from desktop/plugin.js,
// evaluated in a vm with synthetic refs, setters, API fakes and a storage map. Nothing here mirrors a fix:
// the functions are sliced out of the product by name only, so a stale answer / a reconnect has to prove
// its behaviour against whatever the plugin currently does.
//
// UI-5  a deferred answer or error for flow A must not touch doc/loaded/baseRev/conflict/saveState/
//       validate/persist/notify of the flow B the user opened while A was in flight (also A->B->A).
// UI-6  reconnecting to the same graph keeps undo/redo, selection, selected edge, folds and view (no fit
//       reset) while the run history still refreshes; a real remote change drops undo (U-15).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals
const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(here, '..', '..', 'desktop', 'plugin.js'), 'utf8')

// Only the function names are contractual; the next declaration is the end marker.
const NEXT = {
  reportConnection: 'recoverConnection',
  recoverConnection: 'retryConnection',
  openFlow: 'bootUp',
  loadTheirs: 'keepMine',
  keepMine: 'askHermes'
}
function cut(name) {
  const from = SOURCE.indexOf(`  const ${name} = `)
  assert.ok(from > 0, `${name} exists in desktop/plugin.js`)
  const to = SOURCE.indexOf(`  const ${NEXT[name]} = `, from)
  assert.ok(to > from, `${NEXT[name]} follows ${name}`)
  return SOURCE.slice(from, to)
}
const CLOSURES = ['reportConnection', 'recoverConnection', 'openFlow', 'loadTheirs', 'keepMine']
const SCRIPT = new vm.Script(`${CLOSURES.map(cut).join('\n')}\n;({ ${CLOSURES.join(', ')} })`, {
  filename: 'plugin-closures.vm.js'
})

const tick = () => new Promise((r) => setTimeout(r, 0))
const flow = (over = {}) => ({
  id: 'fa', name: 'A', revision: 1,
  nodes: [{ id: 'n1', type: 'input.text' }, { id: 'n2', type: 'llm.call' }],
  edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
  ...over
})

function world(opts = {}) {
  const fa = opts.flow || flow()
  const calls = {
    notify: [], setSaveState: [], setConflict: [], validate: [], setDoc: [], setView: [],
    setSelection: [], setSelectedEdge: [], setExpanded: [], setRun: [],
    persist: 0, getFlow: [], loadLastRun: [], refreshRun: [], setConnLost: []
  }
  const state = {
    doc: opts.doc || { flow: fa, undo: [], redo: [], key: null, at: 0 },
    saveState: opts.saveState || 'saved',
    saveError: '',
    conflict: opts.conflict || null,
    run: opts.run || null,
    selection: opts.selection || [],
    selectedEdge: opts.selectedEdge || null,
    expanded: opts.expanded || new Set(),
    view: opts.view || { zoom: 1.5, x: 12, y: 34 },
    issues: [],
    menuOpen: true,
    connLost: false
  }
  const refs = {
    flowRef: { current: opts.flowRef || fa },
    loadedRef: { current: 'loaded' in opts ? opts.loaded : fa },
    baseRevRef: { current: 'baseRev' in opts ? opts.baseRev : fa.revision },
    conflictRef: { current: opts.conflict || null },
    docRef: { current: state.doc },
    openTokenRef: { current: 0 },
    heightsRef: { current: {} },
    needFitRef: { current: !!opts.needFit },
    runRef: { current: opts.runRef || null },
    connRef: { current: opts.conn || { fails: 0, lost: false } }
  }
  const storage = new Map(Object.entries(opts.storage || {}))
  const pending = new Map()
  const w = {
    refs, state, calls, storage, latest: null,
    pending,
    resolve(id, value, index = 0) { pending.get(id)[index].resolve(value) },
    reject(id, err, index = 0) { pending.get(id)[index].reject(err) }
  }
  const put = (v, prev) => (typeof v === 'function' ? v(prev) : v)
  const setDoc = (v) => {
    state.doc = put(v, state.doc)
    refs.docRef.current = state.doc
    // React derives flowRef from the rendered document; keep the synthetic refs consistent with that.
    refs.flowRef.current = state.doc && state.doc.flow ? state.doc.flow : null
    calls.setDoc.push(state.doc)
  }
  const setRun = (v) => {
    state.run = put(v, state.run)
    calls.setRun.push(state.run)
  }
  const setSaveState = (v) => {
    state.saveState = put(v, state.saveState)
    calls.setSaveState.push(state.saveState)
  }
  const setSaveError = (v) => { state.saveError = put(v, state.saveError) }
  const setConflict = (v) => {
    state.conflict = put(v, state.conflict)
    calls.setConflict.push(state.conflict)
  }
  const setSelection = (v) => {
    state.selection = put(v, state.selection)
    calls.setSelection.push(state.selection)
  }
  const setSelectedEdge = (v) => {
    state.selectedEdge = put(v, state.selectedEdge)
    calls.setSelectedEdge.push(state.selectedEdge)
  }
  const setExpanded = (v) => {
    state.expanded = put(v, state.expanded)
    calls.setExpanded.push(state.expanded)
  }
  const setView = (v) => {
    state.view = put(v, state.view)
    calls.setView.push(state.view)
  }
  const setMenuOpen = (v) => { state.menuOpen = put(v, state.menuOpen) }
  const setIssues = (v) => { state.issues = put(v, state.issues) }
  const setConnLost = (v) => {
    state.connLost = put(v, state.connLost)
    calls.setConnLost.push(state.connLost)
  }
  const sget = (k, d) => (storage.has(k) ? storage.get(k) : d)
  const sset = (k, v) => { storage.set(k, v) }
  const getFlow = (id) => {
    calls.getFlow.push(id)
    if (opts.defer && opts.defer.includes(id)) {
      const d = {}
      d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject })
      if (!pending.has(id)) pending.set(id, [])
      pending.get(id).push(d)
      return d.promise
    }
    const flows = opts.flows || {}
    return Promise.resolve({ flow: flows[id] || fa })
  }
  const persist = async () => {
    calls.persist++
    if (opts.onPersist) await opts.onPersist(w)
  }
  w.latest = {
    current: {
      persist,
      notify: (text, tone) => calls.notify.push({ text, tone }),
      validateNow: async (id) => { calls.validate.push(id) },
      loadLastRun: async (id, token) => {
        calls.loadLastRun.push([id, token])
        setRun({ id: 'r_recovered', status: 'done' })
      },
      refreshRun: async (id) => { calls.refreshRun.push(id); return true },
      openFlow: null
    }
  }
  // A completed external switch/reopen, not a product call: the user already sees `next` when an older
  // request answers. It advances the same token a real open would and mirrors the state a render produces.
  const activateFlow = (next) => {
    refs.openTokenRef.current++
    refs.loadedRef.current = next
    refs.baseRevRef.current = next.revision
    refs.conflictRef.current = null
    setConflict(null)
    setSaveState('saved')
    setSaveError('')
    setDoc({ flow: next, undo: [], redo: [], key: null, at: 0 })
    setSelection([])
    setSelectedEdge(null)
    setExpanded(new Set())
    setRun(null)
    setIssues([])
    setMenuOpen(false)
    refs.heightsRef.current = {}
    refs.needFitRef.current = true
    sset('flowId', next.id)
  }
  const ctx = vm.createContext({
    api: {
      getFlow,
      saveFlow: async () => ({ flow: fa }),
      runs: async () => ({ runs: [] }),
      run: async () => ({ run: {} })
    },
    latest: w.latest,
    flowRef: refs.flowRef,
    loadedRef: refs.loadedRef,
    baseRevRef: refs.baseRevRef,
    conflictRef: refs.conflictRef,
    docRef: refs.docRef,
    openTokenRef: refs.openTokenRef,
    heightsRef: refs.heightsRef,
    needFitRef: refs.needFitRef,
    runRef: refs.runRef,
    connRef: refs.connRef,
    conflict: state.conflict,
    setDoc,
    setRun,
    setSaveState,
    setSaveError,
    setConflict,
    setSelection,
    setSelectedEdge,
    setExpanded,
    setView,
    setMenuOpen,
    setIssues,
    setConnLost,
    notify: (text, tone) => calls.notify.push({ text, tone }),
    sget,
    sset,
    EMPTY_DOC: { flow: null, undo: [], redo: [], key: null, at: 0 },
    SHARED: { session: null, pendingOpen: null, pendingRun: false },
    applyRemote: I.applyRemote,
    persistForFlowChange: I.persistForFlowChange,
    saveBlocker: I.saveBlocker,
    recoveryPlan: I.recoveryPlan,
    connectionState: I.connectionState,
    LOST_CONTACT_AFTER: I.LOST_CONTACT_AFTER,
    parseRestError: I.parseRestError
  })
  Object.assign(w, SCRIPT.runInContext(ctx))
  w.latest.current.openFlow = w.openFlow
  w.activateFlow = activateFlow
  w.ctx = ctx
  return w
}

// Observable side effects of answering an in-flight request. Fixture setup happens before the baseline.
const effects = (w) => ({
  validate: w.calls.validate.length,
  notify: w.calls.notify.length,
  conflict: w.calls.setConflict.length,
  saveState: w.calls.setSaveState.length,
  docs: w.calls.setDoc.length,
  persists: w.calls.persist
})
const assertQuiet = (w, at, message) => {
  assert.deepEqual(effects(w), at, message)
}
// The loops below are independent worlds: run every subcase, then fail once with all of them.
async function cases(label, entries) {
  const failures = []
  for (const [name, run] of entries) {
    try { await run() } catch (err) { failures.push(`${name}: ${err.message}`) }
  }
  assert.deepEqual(failures, [], `${label}\n${failures.join('\n')}`)
}

// ---- UI-5: stale answers must not touch the flow the user switched to
test('UI-5 openFlow: a stale answer cannot touch the flow a newer open already shows', async () => {
  const fa = flow({ id: 'fa', revision: 1 })
  const fb = flow({ id: 'fb', revision: 7 })
  const w = world({ flow: fa, flows: { fb }, defer: ['fa'] })
  const pendingA = w.openFlow('fa')
  await tick()
  assert.deepEqual(w.calls.getFlow, ['fa'], 'A is parked on its fetch')
  await w.openFlow('fb')
  const tokenB = w.refs.openTokenRef.current
  assert.equal(w.state.doc.flow, fb, 'B is already the open document')
  assert.equal(w.refs.flowRef.current, fb)
  assert.equal(w.refs.loadedRef.current, fb)
  assert.equal(w.refs.baseRevRef.current, 7)
  assert.equal(w.state.conflict, null)
  assert.equal(w.state.saveState, 'saved')
  const at = effects(w)
  w.resolve('fa', { flow: { ...fa, revision: 2, name: 'A elsewhere' } })
  await pendingA
  assert.equal(w.state.doc.flow, fb, 'B stays the open document')
  assert.equal(w.refs.flowRef.current, fb)
  assert.equal(w.refs.loadedRef.current.id, 'fb')
  assert.equal(w.refs.baseRevRef.current, 7)
  assert.equal(w.refs.openTokenRef.current, tokenB, 'a stale answer starts no new open')
  assert.equal(w.state.conflict, null)
  assert.equal(w.state.saveState, 'saved')
  assertQuiet(w, at, 'no notice/validation/save-state from the stale answer')

  // A->B->A: the second A open owns the view. Even when the stale answer is the very object the
  // document now shows, the old token must win over identity.
  const fa2 = flow({ id: 'fa', revision: 1 })
  const fb2 = flow({ id: 'fb', revision: 7 })
  const w2 = world({ flow: fa2, flows: { fb: fb2 }, defer: ['fa'] })
  const firstA = w2.openFlow('fa')
  await tick()
  await w2.openFlow('fb')
  const secondA = w2.openFlow('fa')
  await tick()
  const reopened = flow({ id: 'fa', revision: 2, name: 'A reopened' })
  w2.resolve('fa', { flow: reopened }, 1)
  await secondA
  assert.equal(w2.state.doc.flow, reopened, 'the second open of A owns the document')
  const tokenA2 = w2.refs.openTokenRef.current
  const at2 = effects(w2)
  w2.resolve('fa', { flow: reopened }, 0)
  await firstA
  assert.equal(w2.state.doc.flow, reopened, 'the first answer cannot replace the second A')
  assert.equal(w2.refs.openTokenRef.current, tokenA2)
  assertQuiet(w2, at2, 'a stale answer for the same object is still stale')
})

test('UI-5 openFlow: a stale error does not notify over the flow B already shows', async () => {
  const fa = flow({ id: 'fa', revision: 1 })
  const fb = flow({ id: 'fb', revision: 7 })
  const w = world({ flow: fa, flows: { fb }, defer: ['fa'] })
  const pendingA = w.openFlow('fa')
  await tick()
  await w.openFlow('fb')
  const tokenB = w.refs.openTokenRef.current
  assert.equal(w.state.doc.flow, fb)
  const at = effects(w)
  w.reject('fa', Object.assign(new Error('network down'), { status: 503 }))
  const result = await pendingA
  assert.equal(result, false, 'a failed open still reports that it failed')
  assert.equal(w.state.doc.flow, fb)
  assert.equal(w.refs.flowRef.current, fb)
  assert.equal(w.refs.loadedRef.current.id, 'fb')
  assert.equal(w.refs.baseRevRef.current, 7)
  assert.equal(w.refs.openTokenRef.current, tokenB)
  assert.equal(w.state.saveState, 'saved')
  assertQuiet(w, at, 'the old failure belongs to the old open')
})

test('UI-5 loadTheirs/keepMine: a late GET must not replace the flow opened while it waited', async () => {
  await cases('late GET over B', ['loadTheirs', 'keepMine'].map((kind) => [kind, async () => {
    const fa = flow({ id: 'fa', revision: 1 })
    const faLatest = flow({ id: 'fa', revision: 2, name: 'A latest' })
    const fb = flow({ id: 'fb', revision: 5 })
    const w = world({
      flow: fa, flows: { fa: faLatest, fb }, defer: ['fa'],
      conflict: { revision: kind === 'keepMine' ? null : 4 },
      doc: { flow: fa, undo: [flow({ id: 'fa', revision: 0 })], redo: [], key: null, at: 0 }
    })
    const pendingLoad = w[kind]()
    await tick()
    assert.deepEqual(w.calls.getFlow, ['fa'], 'A is parked on its fetch')
    w.activateFlow(fb) // the conflict dialog was still up, so a normal openFlow would be blocked
    const tokenB = w.refs.openTokenRef.current
    assert.equal(w.state.doc.flow, fb, 'B is the open document before the answer arrives')
    assert.equal(w.refs.flowRef.current, fb)
    assert.equal(w.refs.loadedRef.current, fb)
    assert.equal(w.refs.baseRevRef.current, 5)
    assert.equal(w.state.conflict, null)
    const at = effects(w)
    w.resolve('fa', { flow: faLatest })
    await pendingLoad
    assert.equal(w.state.doc.flow, fb, 'B is not replaced by the late A revision')
    assert.equal(w.refs.flowRef.current, fb)
    assert.equal(w.refs.loadedRef.current, fb)
    assert.equal(w.refs.baseRevRef.current, 5, 'B keeps its own base revision')
    assert.equal(w.refs.openTokenRef.current, tokenB)
    assert.equal(w.state.conflict, null)
    assert.equal(w.state.saveState, 'saved')
    assertQuiet(w, at, 'the late A answer has no effect on B')
  }]))
})

test('UI-5 loadTheirs/keepMine: a stale GET failure stays with the flow it was started for', async () => {
  await cases('stale GET failure', ['loadTheirs', 'keepMine'].map((kind) => [kind, async () => {
    const fa = flow({ id: 'fa', revision: 1 })
    const fb = flow({ id: 'fb', revision: 5 })
    const w = world({
      flow: fa, flows: { fb }, defer: ['fa'],
      conflict: { revision: kind === 'keepMine' ? null : 4 },
      doc: { flow: fa, undo: [], redo: [], key: null, at: 0 }
    })
    const pendingLoad = w[kind]()
    await tick()
    w.activateFlow(fb)
    const tokenB = w.refs.openTokenRef.current
    assert.equal(w.refs.flowRef.current, fb)
    assert.equal(w.refs.loadedRef.current, fb)
    assert.equal(w.refs.baseRevRef.current, 5)
    const at = effects(w)
    w.reject('fa', Object.assign(new Error('network down'), { status: 503 }))
    await pendingLoad
    assert.equal(w.state.doc.flow, fb, 'a failed GET for A cannot close or replace B')
    assert.equal(w.refs.flowRef.current, fb)
    assert.equal(w.refs.loadedRef.current, fb, 'B is still loaded')
    assert.equal(w.refs.baseRevRef.current, 5, 'B keeps its base revision')
    assert.equal(w.refs.openTokenRef.current, tokenB)
    assert.equal(w.state.conflict, null)
    assert.equal(w.state.saveState, 'saved')
    assertQuiet(w, at, 'the old failure does not notify or save over B')
  }]))
})

test('UI-5 loadTheirs/keepMine: the same flow still loads latest / keeps mine', async () => {
  const fa = flow({ id: 'fa', revision: 1 })
  const wLoad = world({
    flow: fa, flows: { fa: { ...fa, revision: 4, name: 'A latest' } },
    conflict: { revision: 3 },
    doc: { flow: fa, undo: [flow({ id: 'fa', revision: 0 })], redo: [], key: 'p', at: 3 }
  })
  await wLoad.loadTheirs()
  assert.equal(wLoad.state.doc.flow.revision, 4)
  assert.equal(wLoad.state.doc.flow.name, 'A latest')
  assert.equal(wLoad.state.doc.undo.length, 0, 'a remote revision is not undoable (U-15)')
  assert.equal(wLoad.state.doc.redo.length, 0)
  assert.equal(wLoad.refs.loadedRef.current.revision, 4)
  assert.equal(wLoad.refs.baseRevRef.current, 4)
  assert.equal(wLoad.state.conflict, null)
  assert.equal(wLoad.state.saveState, 'saved')
  assert.deepEqual(wLoad.calls.validate, ['fa'])
  assert.equal(wLoad.calls.notify.length, 1)
  assert.match(wLoad.calls.notify[0].text, /undo history cleared/)

  const wKeep = world({
    flow: fa, flows: { fa: { ...fa, revision: 7 } }, conflict: { revision: null }
  })
  await wKeep.keepMine()
  assert.equal(wKeep.refs.baseRevRef.current, 7, 'the fetched revision becomes the base for mine')
  assert.equal(wKeep.refs.loadedRef.current, null, 'mine is dirty and will be saved')
  assert.equal(wKeep.state.conflict, null)
  assert.equal(wKeep.calls.persist, 1)
  assert.equal(wKeep.refs.flowRef.current, fa, 'my document is kept')

  // A->B->A: the second A is a new open with a new token. The first A answer is stale even when the
  // final A is the same object reference the first request captured.
  const triples = []
  for (const kind of ['loadTheirs', 'keepMine']) {
    for (const sameRef of [true, false]) {
      triples.push([`${kind}${sameRef ? ' same-ref' : ' new-ref'}`, async () => {
        const before = flow({ id: 'fa', revision: 1 })
        const latestA = flow({ id: 'fa', revision: 2, name: 'A latest' })
        const fb = flow({ id: 'fb', revision: 5 })
        const w = world({
          flow: before, flows: { fa: latestA, fb }, defer: ['fa'],
          conflict: { revision: kind === 'keepMine' ? null : 4 },
          doc: { flow: before, undo: [flow({ id: 'fa', revision: 0 })], redo: [], key: null, at: 0 }
        })
        const pendingLoad = w[kind]()
        await tick()
        const finalA = sameRef ? before : { ...before }
        w.activateFlow(fb)
        w.activateFlow(finalA)
        const tokenA = w.refs.openTokenRef.current
        assert.equal(w.state.doc.flow, finalA, 'the second A is the open document')
        assert.equal(w.refs.flowRef.current, finalA)
        assert.equal(w.refs.loadedRef.current, finalA)
        assert.equal(w.refs.baseRevRef.current, finalA.revision)
        assert.equal(w.state.conflict, null)
        const at = effects(w)
        w.resolve('fa', { flow: latestA })
        await pendingLoad
        assert.equal(w.state.doc.flow, finalA, 'A->B->A: the newer A open owns the document')
        assert.equal(w.refs.flowRef.current, finalA)
        assert.equal(w.refs.loadedRef.current, finalA)
        assert.equal(w.refs.baseRevRef.current, finalA.revision, 'the stale fetch is not the new base')
        assert.equal(w.refs.openTokenRef.current, tokenA)
        assert.equal(w.state.conflict, null)
        assert.equal(w.state.saveState, 'saved')
        assertQuiet(w, at, 'the first A answer cannot touch the reopened A')
      }])
    }
  }
  await cases('A->B->A stale answer', triples)
})

// ---- UI-6: reconnect through the real recoverConnection + openFlow
test('UI-6 recoverConnection: unchanged graph keeps undo, selection, edge, folds and view', async () => {
  const fa = flow({ id: 'fa', revision: 1 })
  const sameGraph = {
    id: 'fa', name: 'A', revision: 2, updated_at: '2026-11-08T10:00:00Z',
    nodes: fa.nodes.map((n) => ({ ...n })), edges: fa.edges.map((e) => ({ ...e }))
  }
  const older = flow({ id: 'fa', revision: 0, name: 'older' })
  const w = world({
    flow: fa, flows: { fa: sameGraph }, loaded: fa,
    doc: { flow: fa, undo: [older], redo: [], key: null, at: 0 },
    selection: ['n1', 'n2'], selectedEdge: 'e1', expanded: new Set(['n1']),
    view: { zoom: 2, x: 5, y: 6 }, needFit: false
  })
  assert.equal(w.refs.flowRef.current, fa)
  assert.equal(w.refs.loadedRef.current, fa)
  const ok = await w.recoverConnection()
  assert.equal(ok, true)
  assert.equal(w.state.doc.flow.revision, 2, 'the newer revision is adopted')
  assert.equal(w.state.doc.undo.length, 1, 'same graph: undo must survive a reconnect')
  assert.equal(w.state.doc.undo[0], older)
  assert.deepEqual([...w.state.selection], ['n1', 'n2'])
  assert.equal(w.state.selectedEdge, 'e1')
  assert.deepEqual([...w.state.expanded], ['n1'])
  assert.deepEqual(w.state.view, { zoom: 2, x: 5, y: 6 }, 'the view is not reset')
  assert.equal(w.refs.needFitRef.current, false, 'no fit reset on a reconnect')
  assert.deepEqual(w.calls.loadLastRun.map(([id]) => id), ['fa'], 'the run history still refreshes')
  assert.ok(w.state.run && w.state.run.id, 'the last run is reloaded')
  assert.equal(w.refs.loadedRef.current.revision, 2)
  assert.equal(w.refs.baseRevRef.current, 2)
})

test('UI-6 recoverConnection: a real remote change drops undo and trims selection/folds', async () => {
  const before = flow({ id: 'fa', revision: 1 })
  const changed = {
    id: 'fa', name: 'A', revision: 3, updated_at: '2026-11-08T11:00:00Z',
    nodes: [{ id: 'n1', type: 'input.text' }, { id: 'n3', type: 'image.gen' }], edges: []
  }
  const older = flow({ id: 'fa', revision: 0, name: 'older' })
  const redone = flow({ id: 'fa', revision: 1, name: 'redone' })
  const w = world({
    flow: before, flows: { fa: changed }, loaded: before,
    doc: { flow: before, undo: [older], redo: [redone], key: 'params', at: 9 },
    selection: ['n1', 'n2'], selectedEdge: 'e1', expanded: new Set(['n1', 'n2'])
  })
  const ok = await w.recoverConnection()
  assert.equal(ok, true)
  assert.equal(w.state.doc.undo.length, 0, 'U-15: Ctrl+Z must not revert a real remote change')
  assert.equal(w.state.doc.redo.length, 0)
  assert.equal(w.state.doc.flow.revision, 3)
  assert.equal(w.state.doc.key, null)
  assert.deepEqual([...w.state.selection], ['n1'], 'only ids that still exist stay selected')
  assert.deepEqual([...w.state.expanded], ['n1'], 'folds for removed nodes are dropped')
  assert.equal(w.state.selectedEdge, null, 'an edge that no longer exists is not kept selected')
  assert.deepEqual(w.calls.loadLastRun.map(([id]) => id), ['fa'])
})

test('UI-6 recoverConnection: dirty local edits are saved, never reloaded over', async () => {
  const saved = flow({ id: 'fa', revision: 1 })
  const local = { ...saved, name: 'edited here', nodes: saved.nodes.map((n) => ({ ...n })) }
  const w = world({
    flow: local, flowRef: local, loaded: saved, baseRev: 1,
    doc: { flow: local, undo: [saved], redo: [], key: null, at: 0 },
    runRef: { id: 'r1', status: 'running' },
    onPersist: (world) => { world.refs.loadedRef.current = world.refs.flowRef.current }
  })
  assert.equal(w.refs.flowRef.current, local)
  assert.equal(w.refs.loadedRef.current, saved)
  const ok = await w.recoverConnection()
  assert.equal(ok, true)
  assert.equal(w.calls.getFlow.length, 0, 'no reload while the local flow is ahead')
  assert.equal(w.calls.persist, 1, 'the dirty flow is saved')
  assert.equal(w.state.doc.flow, local, 'the local document is not replaced')
  assert.equal(w.state.doc.undo.length, 1, 'the local undo stack is untouched')
  assert.deepEqual(w.calls.validate, [], 'no validation of a flow that was not reloaded')
  assert.deepEqual(w.calls.refreshRun, ['r1'], 'the run chip is refreshed')
})
