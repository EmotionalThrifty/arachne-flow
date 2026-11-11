// Review U-15/U-16/U-10: a remote revision must not sit in the undo stack, a stale run fetch must not undo a
// live node.status event, and canvas drops go up as multipart instead of base64-in-JSON.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals

const flowA = { id: 'f_1', name: 'A', revision: 1, nodes: [{ id: 'n_a', type: 'input.text', params: {} }], edges: [] }
const flowB = { id: 'f_1', name: 'A', revision: 2, nodes: [], edges: [] }

test('applyRemote: a revision from elsewhere replaces the flow and empties the undo stack (U-15)', () => {
  const doc = { flow: flowA, undo: [flowB], redo: [flowB], key: 'params', at: 1000 }
  const out = I.applyRemote(doc, flowB)
  assert.deepEqual(out.undo, [], 'Ctrl+Z must not be able to revert Hermes\' change')
  assert.deepEqual(out.redo, [])
  assert.equal(out.key, null)
  assert.equal(out.at, 0)
  assert.equal(out.flow, flowB)
  assert.equal(out.undo.length + out.redo.length, 0)
})

test('applyRemote: nothing to apply when no flow is open or the flow is already this one', () => {
  const doc = { flow: flowA, undo: [flowB], redo: [], key: null, at: 0 }
  assert.equal(I.applyRemote(doc, flowA), doc, 'the same flow is not a remote revision')
  const empty = { flow: null, undo: [], redo: [], key: null, at: 0 }
  assert.equal(I.applyRemote(empty, flowB), empty, 'no open flow: nothing to replace')
  assert.equal(I.applyRemote(doc, null), doc)
})

test('mergeRun: a fetch sent before the last events never walks a node or the run backwards (U-16)', () => {
  const live = {
    id: 'r_1', status: 'running',
    nodes: {
      n_a: { status: 'done', ms: 1200, preview: '/out/a.png', started_at: '2026-01-01T00:00:01Z' },
      n_b: { status: 'running', started_at: '2026-01-01T00:00:02Z' },
      n_c: { status: 'queued' }
    }
  }
  const fetched = {
    id: 'r_1', status: 'running',
    nodes: {
      n_a: { status: 'running', started_at: '2026-01-01T00:00:01Z' },   // stale: the node finished after the fetch
      n_b: { status: 'queued' },                                        // stale placeholder
      n_c: { status: 'running', started_at: '2026-01-01T00:00:03Z' }    // the fetch knows more than the events
    }
  }
  const out = I.mergeRun(live, fetched)
  assert.equal(out.nodes.n_a.status, 'done')
  assert.equal(out.nodes.n_a.ms, 1200)
  assert.equal(out.nodes.n_a.preview, '/out/a.png')
  assert.equal(out.nodes.n_b.status, 'running')
  assert.equal(out.nodes.n_c.status, 'running', 'queued -> running from the record is forward, not backward')
})

test('mergeRun: the record fills in nodes and outputs the live state has not seen', () => {
  const live = { id: 'r_1', status: 'running', nodes: { n_a: { status: 'queued' } } }
  const fetched = {
    id: 'r_1', status: 'running',
    nodes: {
      n_a: { status: 'done', ms: 40, started_at: '2026-01-01T00:00:01Z', preview: '/out/a.png' },
      n_b: { status: 'done', ms: 10 }
    }
  }
  const out = I.mergeRun(live, fetched)
  assert.equal(out.nodes.n_a.status, 'done')
  assert.equal(out.nodes.n_a.ms, 40)
  assert.deepEqual(out.nodes.n_b, { status: 'done', ms: 10 })
})

test('mergeRun: same status keeps the live fields and takes the record\'s extras', () => {
  const live = { id: 'r_1', status: 'running', nodes: { n_a: { status: 'done', ms: 40, started_at: 't', error: 'kept' } } }
  const fetched = { id: 'r_1', status: 'running', nodes: { n_a: { status: 'done', ms: 39, started_at: 't', preview: 'p', items: 3 } } }
  const out = I.mergeRun(live, fetched)
  assert.equal(out.nodes.n_a.ms, 40, 'the live event is the newer word on the node')
  assert.equal(out.nodes.n_a.error, 'kept')
  assert.equal(out.nodes.n_a.preview, 'p')
  assert.equal(out.nodes.n_a.items, 3)
})

test('mergeRun: a node that started again (loop iteration) takes its later start over a finished record', () => {
  const live = { id: 'r_1', status: 'running', nodes: { n_a: { status: 'running', started_at: '2026-01-01T00:00:09Z' } } }
  const fetched = { id: 'r_1', status: 'running', nodes: { n_a: { status: 'done', ms: 500, started_at: '2026-01-01T00:00:02Z' } } }
  const out = I.mergeRun(live, fetched)
  assert.equal(out.nodes.n_a.status, 'running')
  assert.equal(out.nodes.n_a.ms, undefined, 'the finished iteration\'s numbers do not describe this one')
})

test('mergeRun: the run status follows the same rule and other runs are not touched', () => {
  const ended = { id: 'r_1', status: 'done', ms: 900, nodes: { n_a: { status: 'done' } } }
  const stale = { id: 'r_1', status: 'running', nodes: { n_a: { status: 'running' } } }
  assert.equal(I.mergeRun(ended, stale).status, 'done')
  assert.equal(I.mergeRun(ended, stale).ms, 900)
  assert.equal(I.mergeRun({ id: 'r_1', status: 'running', nodes: {} }, { id: 'r_1', status: 'done', ms: 5, nodes: {} }).status, 'done')
  assert.equal(I.mergeRun(null, stale), stale)
  assert.equal(I.mergeRun({ id: 'r_2', status: 'running', nodes: {} }, stale), stale, 'a run for another id wins')
  assert.equal(I.mergeRun(ended, null), ended)
})

test('makeApi.upload sends the file as multipart bytes, not base64 in JSON (U-10)', async () => {
  const calls = []
  const api = I.makeApi({ rest: async (path, opts) => { calls.push([path, opts]); return { path: 'p', name: 'cat.png' } } })
  const bytes = Uint8Array.from([1, 2, 3, 4])
  const file = { name: 'cat.png', type: 'image/png', size: 4, arrayBuffer: async () => bytes.buffer.slice(0) }
  await api.upload(file.name, file)
  assert.equal(calls.length, 1)
  const [path, opts] = calls[0]
  assert.equal(path, '/x/uploads')
  assert.equal(opts.method, 'POST')
  assert.equal(opts.body, undefined, 'no JSON body next to the upload')
  assert.equal(opts.upload.filename, 'cat.png')
  assert.equal(opts.upload.contentType, 'image/png')
  assert.deepEqual([...new Uint8Array(opts.upload.bytes)], [1, 2, 3, 4])
  assert.ok(opts.timeoutMs > 0)
})

// node has no FileReader; the data-URL fallback reads through one, so stand one in (Blob -> base64).
class FakeFileReader {
  readAsDataURL(file) {
    file.arrayBuffer().then((b) => {
      this.result = `data:${file.type || 'application/octet-stream'};base64,${Buffer.from(new Uint8Array(b)).toString('base64')}`
      if (this.onload) this.onload()
    }, (err) => {
      this.error = err
      if (this.onerror) this.onerror()
    })
  }
}

test('makeApi.upload: a host that cannot send multipart falls back to the JSON data URL (U-10)', async () => {
  globalThis.FileReader = FakeFileReader
  const calls = []
  const api = I.makeApi({
    rest: async (path, opts) => {
      calls.push([path, opts])
      if (opts.upload) throw new Error('Error invoking remote method \'hermes:api\': Error: File uploads are not supported against OAuth-gated remote backends yet.')
      return { path: 'p', name: 'cat.png' }
    }
  })
  const bytes = Uint8Array.from([1, 2, 3, 4])
  const file = { name: 'cat.png', type: 'image/png', size: 4, arrayBuffer: async () => bytes.buffer.slice(0) }
  await api.upload(file.name, file)
  assert.equal(calls.length, 2)
  assert.ok(calls[0][1].upload)
  assert.deepEqual(calls[1], ['/x/uploads', { method: 'POST', body: { name: 'cat.png', data_url: 'data:image/png;base64,AQIDBA==' }, timeoutMs: 180000 }])
})

test('makeApi.upload: a refusal from the route itself is final, no second upload (U-10)', async () => {
  const calls = []
  const api = I.makeApi({
    rest: async (path, opts) => {
      calls.push([path, opts])
      throw new Error('Error invoking remote method \'hermes:api\': Error: 413: {"detail":{"code":"too_large","message":"file is larger than 25 MB"}}')
    }
  })
  const file = { name: 'big.png', type: 'image/png', size: 4, arrayBuffer: async () => new ArrayBuffer(4) }
  await assert.rejects(() => api.upload(file.name, file), /too_large/)
  assert.equal(calls.length, 1)
})
