// Contract tests for the page walk behind I.loadRunValue. The shape is not invented here: it is
// engine/api.py::_run_value (lines 400-412), where
//
//   total_chars = len(source)                         Python len() counts code points
//   chunk       = source[offset:offset + limit]       slicing is by code point
//   next_offset = offset + len(chunk)                 only while that end is < total_chars
//   next_offset = None                                exactly when the value is complete
//
// and every page is a slice of the same value, so page.offset must be the offset that was asked
// for and next_offset must equal offset + code-point length of the chunk. A JS loader that uses
// String#length counts UTF-16 units and therefore requests the wrong offset as soon as an emoji
// sits on a page edge. The API may serve a value of up to MAX_VALUE_BYTES = 16 * 1024 * 1024
// (engine/api.py:185), so the reader must not impose a smaller text cap.
//
// A page that breaks one of those invariants is not repaired or trimmed: the loader reports an
// error. Silent truncation (a short value shown as ready) is the failure these tests exist for.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals

const page = (over) => ({ kind: 'text', chunk: '', offset: 0, next_offset: null, total_chars: 0, version: 'a'.repeat(64), ...over })
const callsOf = (api) => api.calls.map((c) => [c[1], c[2], c[3]])

/** Python len(): code points, not UTF-16 units. */
const chars = (s) => (/[\uD800-\uDFFF]/.test(s) ? Array.from(s).length : s.length)

/** Python str slicing, without ever splitting a surrogate pair. */
const sliceChars = (text, offset, limit) =>
  /[\uD800-\uDFFF]/.test(text) ? Array.from(text).slice(offset, offset + limit).join('') : text.slice(offset, offset + limit)

/** A server that behaves like _run_value: an honest page source for the happy paths. */
const pagedApi = (text, kind) => {
  const total = chars(text)
  const calls = []
  return {
    calls,
    async runValue(runId, nodeId, port, offset, limit) {
      calls.push([runId, nodeId, port, offset, limit])
      if (!Number.isInteger(offset) || offset < 0 || offset > total) {
        throw new Error('400: {"detail":"offset exceeds value length"}')
      }
      const chunk = sliceChars(text, offset, limit)
      const end = offset + chars(chunk)
      return { kind, chunk, offset, next_offset: end < total ? end : null, total_chars: total, version: 'a'.repeat(64) }
    }
  }
}

/** A server that returns these pages in order; an Error entry is thrown like an HTTP failure. */
const fakeApi = (pages) => {
  const calls = []
  return {
    calls,
    async runValue(...args) {
      calls.push(args)
      const next = pages[calls.length - 1]
      if (!next) throw new Error(`unexpected page ${calls.length}`)
      if (next instanceof Error) throw next
      return next
    }
  }
}

test('loadRunValue forwards the first page version and returns ready for stable pages', async () => {
  const versionDigest = '0123456789abcdef'.repeat(4)
  const api = fakeApi([
    page({ chunk: 'abc', offset: 0, next_offset: 3, total_chars: 6, version: versionDigest }),
    page({ chunk: 'def', offset: 3, next_offset: null, total_chars: 6, version: versionDigest })
  ])
  const out = await I.loadRunValue(api, 'run-1', 'node-1', 'out')
  assert.equal(out.status, 'ready')
  assert.equal(out.text, 'abcdef')
  assert.equal(api.calls.length, 2)
  assert.equal(api.calls[0][0], 'run-1')
  assert.deepEqual(callsOf(api), [['node-1', 'out', 0], ['node-1', 'out', 3]])
  assert.equal(api.calls[1][5], versionDigest)
})

test('loadRunValue does not return ready when a later page reports a different version', async () => {
  const first = '0123456789abcdef'.repeat(4)
  const second = 'fedcba9876543210'.repeat(4)
  const api = fakeApi([
    page({ chunk: 'abc', offset: 0, next_offset: 3, total_chars: 6, version: first }),
    page({ chunk: 'def', offset: 3, next_offset: null, total_chars: 6, version: second })
  ])
  const out = await I.loadRunValue(api, 'run-1', 'node-1', 'out').catch((error) => ({ status: 'error', error }))
  assert.notEqual(out.status, 'ready')
  assert.equal(api.calls[1][5], first)
})

test('loadRunValue does not return ready when a page has no version', async () => {
  const versionDigest = '0123456789abcdef'.repeat(4)
  const api = fakeApi([
    page({ chunk: 'abc', offset: 0, next_offset: 3, total_chars: 6, version: undefined }),
    page({ chunk: 'def', offset: 3, next_offset: null, total_chars: 6, version: versionDigest })
  ])
  const out = await I.loadRunValue(api, 'run-1', 'node-1', 'out').catch((error) => ({ status: 'error', error }))
  assert.notEqual(out.status, 'ready')
})

test('loadRunValue reports unavailable when the server answers HTTP 409', async () => {
  const api = fakeApi([new Error('409: {"detail":"value version changed"}')])
  const out = await I.loadRunValue(api, 'run-1', 'node-1', 'out')
  assert.equal(out.status, 'unavailable')
  assert.equal(api.calls.length, 1)
})

test('loadRunValue follows Python code-point offsets when an emoji ends a page', async () => {
  // Page 1 is '{"a":"🌍' : 7 code points but 9 UTF-16 units. A reader that advances by
  // chunk.length asks for offset 9 and silently skips '","b":"'. Python serves 0, 7, 14.
  const value = '{"a":"🌍","b":"🌍"}'
  assert.equal(chars(value), 17)
  assert.equal(value.length, 19, 'fixture must exercise the UTF-16 difference')
  const api = pagedApi(value, 'json')

  const out = await I.loadRunValue(api, 'r1', 'n1', 'nested', { limit: 7 })
  assert.equal(out.status, 'ready')
  assert.equal(out.kind, 'json')
  assert.equal(out.text, value, 'the pages are joined exactly')
  assert.equal(out.totalChars, 17, 'totalChars is the API total_chars in code points')
  assert.equal(out.pages, 3)
  assert.deepEqual(api.calls.map((c) => c[3]), [0, 7, 14], 'each page is requested at the previous code-point next_offset')
  assert.deepEqual(callsOf(api), [['n1', 'nested', 0], ['n1', 'nested', 7], ['n1', 'nested', 14]])
})

test('loadRunValue rejects a page that rewinds or overlaps the requested offset', async () => {
  const overlap = fakeApi([
    page({ chunk: 'abc', offset: 0, next_offset: 3, total_chars: 9 }),
    page({ chunk: 'cde', offset: 2, next_offset: 5, total_chars: 9 })
  ])
  const first = await I.loadRunValue(overlap, 'r1', 'n1', 'text')
  assert.equal(first.status, 'error', 'a page that starts before the requested offset is not stitched in')
  assert.match(first.reason, /offset|overlap|page|contract|invalid/i)
  assert.equal(overlap.calls.length, 2)

  const rewind = fakeApi([
    page({ chunk: 'abc', offset: 0, next_offset: 3, total_chars: 9 }),
    page({ chunk: 'def', offset: 3, next_offset: 2, total_chars: 9 })
  ])
  const second = await I.loadRunValue(rewind, 'r1', 'n1', 'text')
  assert.equal(second.status, 'error', 'a next_offset behind the page is not a finished value')
  assert.match(second.reason, /advanc|progress|offset|repeat|loop|stuck/i)
  assert.equal(rewind.calls.length, 2)
})

test('loadRunValue rejects a page that skips code points, including a UTF-16 length advance', async () => {
  const value = '{"a":"🌍","b":false}'
  // next_offset 8 is the UTF-16 length of the chunk '{"a":"🌍', but the chunk is 7 code points.
  const utf16 = fakeApi([page({ kind: 'json', chunk: '{"a":"🌍', offset: 0, next_offset: 8, total_chars: chars(value) })])
  const first = await I.loadRunValue(utf16, 'r1', 'n1', 'json')
  assert.equal(first.status, 'error', 'an advance counted in UTF-16 units skips a character')
  assert.match(first.reason, /offset|skip|gap|advanc|page|contract|invalid/i)
  assert.equal(utf16.calls.length, 1, 'the gap is detected before another page is read')

  const jump = fakeApi([page({ chunk: 'abc', offset: 0, next_offset: 12, total_chars: 20 })])
  const second = await I.loadRunValue(jump, 'r1', 'n1', 'text')
  assert.equal(second.status, 'error', 'a next_offset beyond the chunk is a gap, not a page')
  assert.equal(jump.calls.length, 1)
})

test('loadRunValue rejects a value whose total_chars changes between pages', async () => {
  const api = fakeApi([
    page({ chunk: 'abc', offset: 0, next_offset: 3, total_chars: 9 }),
    page({ chunk: 'def', offset: 3, next_offset: 6, total_chars: 10 })
  ])
  const out = await I.loadRunValue(api, 'r1', 'n1', 'text')
  assert.equal(out.status, 'error', 'a moving total means the pages are not one value')
  assert.match(out.reason, /total/i)
})

test('loadRunValue rejects a value whose kind changes between pages', async () => {
  const api = fakeApi([
    page({ kind: 'text', chunk: 'abc', offset: 0, next_offset: 3, total_chars: 6 }),
    page({ kind: 'json', chunk: 'def', offset: 3, next_offset: null, total_chars: 6 })
  ])
  const out = await I.loadRunValue(api, 'r1', 'n1', 'text')
  assert.equal(out.status, 'error', 'a text page cannot turn into a json page mid-value')
  assert.match(out.reason, /kind|type/i)
})

test('loadRunValue refuses to finalize a page that stops before total_chars', async () => {
  const api = fakeApi([page({ kind: 'json', chunk: '{"a":"🌍', offset: 0, next_offset: null, total_chars: 19 })])
  const out = await I.loadRunValue(api, 'r1', 'n1', 'json')
  assert.equal(out.status, 'error', 'a short page reported as final is silent truncation')
  assert.match(out.reason, /incomplete|truncat|final|total|short|premature|page/i)
  assert.equal(api.calls.length, 1, 'the loader does not try to guess the missing pages')
})

test('loadRunValue rejects malformed page shapes instead of guessing', async () => {
  const cases = [
    ['missing total_chars', { kind: 'text', chunk: 'abc', offset: 0, next_offset: null }],
    ['chunk is not a string', page({ chunk: 42 })],
    ['offset is a string', page({ chunk: 'abc', offset: '0' })],
    ['offset is negative', page({ chunk: 'abc', offset: -1 })],
    ['offset does not answer the request', page({ chunk: 'abc', offset: 1, next_offset: null, total_chars: 4 })],
    ['total_chars is negative', page({ chunk: '', offset: 0, next_offset: null, total_chars: -1 })],
    ['next_offset is a boolean', page({ chunk: 'abc', offset: 0, next_offset: false, total_chars: 3 })],
    ['next_offset is fractional', page({ chunk: 'abc', offset: 0, next_offset: 1.5, total_chars: 3 })],
    ['chunk runs past total_chars', page({ chunk: 'abcd', offset: 0, next_offset: null, total_chars: 3 })],
    ['next_offset runs past total_chars', page({ chunk: 'ab', offset: 0, next_offset: 9, total_chars: 4 })],
    ['empty page claims more', page({ chunk: '', offset: 0, next_offset: 1, total_chars: 5 })]
  ]
  for (const [label, bad] of cases) {
    const api = fakeApi([bad])
    const out = await I.loadRunValue(api, 'r1', 'n1', 'text')
    assert.equal(out.status, 'error', `${label} was accepted as a page`)
    assert.match(out.reason, /page|contract|malformed|invalid|offset|total|kind|shape/i, label)
  }
})

test('loadRunValue loads a full 16 MiB API value without a 4 MiB cap', async () => {
  const total = 16 * 1024 * 1024
  const value = '{"blob":"' + 'x'.repeat(total - 11) + '"}' // exactly MAX_VALUE_BYTES characters
  assert.equal(chars(value), total)
  const api = pagedApi(value, 'json')

  const out = await I.loadRunValue(api, 'r1', 'n1', 'blob', { limit: 65536 })
  assert.equal(out.status, 'ready', 'the reader applied a text cap below the API maximum')
  assert.equal(out.kind, 'json')
  assert.equal(out.totalChars, total)
  assert.equal(out.text.length, value.length)
  assert.ok(out.text === value, 'the 16 MiB value came back changed')
  assert.equal(out.pages, 256)
  assert.equal(api.calls.length, 256)
  assert.deepEqual([api.calls[0][3], api.calls[0][4]], [0, 65536])
  assert.deepEqual([api.calls[255][3], api.calls[255][4]], [255 * 65536, 65536])
})

test('loadRunValue reports a page-budget overrun instead of returning a prefix', async () => {
  const value = 'abcdefghijklmnopqrstuvwxyz' // 26 code points: 10 + 10 + 6
  const budget = pagedApi(value, 'text')
  const short = await I.loadRunValue(budget, 'r1', 'n1', 'text', { limit: 10, maxPages: 2 })
  assert.equal(short.status, 'error', 'a value cut off by the page budget is not ready')
  assert.match(short.reason, /page|limit|bound|cap|too (many|long)|budget/i)
  assert.equal(budget.calls.length, 2, 'exactly the allowed pages are read')

  const exact = pagedApi(value, 'text')
  const out = await I.loadRunValue(exact, 'r1', 'n1', 'text', { limit: 10, maxPages: 3 })
  assert.equal(out.status, 'ready', 'a value that needs exactly maxPages pages still loads')
  assert.equal(out.text, value)
  assert.equal(out.pages, 3)
  assert.equal(exact.calls.length, 3)
})


test('loader preserves expansion provenance and rejects changes between pages', async () => {
  const good = await I.loadRunValue(fakeApi([page({expanded:true})]),'r','n','out')
  assert.equal(good.status,'ready')
  assert.equal(good.expanded,true)
  const bad = await I.loadRunValue(fakeApi([
    page({chunk:'a',next_offset:1,total_chars:2,expanded:true}),
    page({chunk:'b',offset:1,total_chars:2,expanded:false})
  ]),'r','n','out')
  assert.notEqual(bad.status,'ready')
})
