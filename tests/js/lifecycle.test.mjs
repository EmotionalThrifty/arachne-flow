// Plugin lifecycle (U-12): ctx lifecycle helpers, caches emptied on dispose, media cache capped by bytes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const dataUrl = (bytes) => 'data:image/png;base64,' + 'a'.repeat(bytes)
const entry = (bytes) => ({ promise: Promise.resolve(), value: { data_url: dataUrl(bytes) } })

test('media cache eviction: oldest first until the byte budget fits (U-12)', async () => {
  const I = (await loadPlugin())._internals
  const map = new Map([['a', entry(100)], ['b', entry(100)], ['c', entry(100)]])
  assert.equal(I.mediaCacheBytes(map), 3 * dataUrl(100).length)
  const evicted = I.evictMediaCache(map, { maxBytes: 130, maxCount: 10 })
  assert.deepEqual(evicted, ['a', 'b'], 'oldest entries go first')
  assert.deepEqual([...map.keys()], ['c'])
  assert.ok(I.mediaCacheBytes(map) <= 130)
})

test('media cache eviction: the entry count is still capped, and entries without a data URL cost nothing', async () => {
  const I = (await loadPlugin())._internals
  const map = new Map([
    ['a', { promise: Promise.resolve(), value: { path: '/x/a.png' } }],
    ['b', { promise: Promise.resolve(), value: { path: '/x/b.png' } }],
    ['c', { promise: Promise.resolve(), value: null }]
  ])
  assert.equal(I.mediaCacheBytes(map), 0)
  assert.deepEqual(I.evictMediaCache(map, { maxBytes: 10, maxCount: 2 }), ['a'])
  assert.deepEqual([...map.keys()], ['b', 'c'])
  assert.deepEqual(I.evictMediaCache(map, { maxBytes: 10, maxCount: 2 }), [], 'inside the limits: nothing to do')
})

test('media cache eviction: one oversized entry survives instead of thrashing the cache', async () => {
  const I = (await loadPlugin())._internals
  const map = new Map([['old', entry(50)], ['huge', entry(500)]])
  assert.deepEqual(I.evictMediaCache(map, { maxBytes: 100, maxCount: 10, keep: 'huge' }), ['old'])
  assert.deepEqual([...map.keys()], ['huge'], 'the entry just written is not dropped again and again')
})

test('fetchMedia enforces the byte budget, not just the entry count (U-12)', async () => {
  const I = (await loadPlugin())._internals
  I.clearCaches()
  const huge = 24 * 1024 * 1024 // one 24 MB data URL: three of them pass the 64 MB budget
  const api = { media: async () => ({ data_url: dataUrl(huge) }) }
  for (const id of ['n1', 'n2', 'n3']) await I.fetchMedia(api, `run|${id}`, 'run', id, 'media', 0, 0)
  assert.ok(I.cacheSizes().media <= 2, 'the oldest media entry was evicted to stay inside 64 MB')
  assert.ok(I.mediaCacheBytes(I.caches.media) <= I.MEDIA_CACHE_MAX_BYTES)
  assert.ok(I.caches.media.has('run|n3'), 'the newest entry is kept')
  I.clearCaches()
})

test('register() clears the module caches when the plugin is disposed (U-12)', async () => {
  const plugin = await loadPlugin()
  const I = plugin._internals
  I.clearCaches()
  I.caches.media.set('k', entry(10))
  I.caches.fileNode.set('k', { path: '/x.png' })
  I.caches.llmInfo.set('k', { data: {} })
  I.caches.modelInfo.set('k', { data: {} })
  I.caches.toolOptions.set('k', Promise.resolve({}))
  assert.deepEqual(I.cacheSizes(), { media: 1, fileNode: 1, llmInfo: 1, modelInfo: 1, toolOptions: 1 })

  const ctx = fakeCtx()
  plugin.register(ctx)
  assert.ok(ctx.disposers.length >= 1, 'onDispose is wired')
  ctx.dispose()
  assert.deepEqual(I.cacheSizes(), { media: 0, fileNode: 0, llmInfo: 0, modelInfo: 0, toolOptions: 0 },
    'no media / file-node / model data survives a reload')
})

test('register() uses ctx.setTimeout and ctx.onEvent when the host offers them (U-12)', async () => {
  const plugin = await loadPlugin()
  const I = plugin._internals
  const saved = globalThis.sessionStorage
  // A Arachne Flow window re-navigates through short timers and listens for "open flow" from /flow.
  globalThis.sessionStorage = { getItem: () => '1', setItem() {}, removeItem() {} }
  try {
    const ctx = fakeCtx({ setTimeout: true, onEvent: true })
    plugin.register(ctx)
    assert.deepEqual(ctx.timers.map((t) => t.ms), [700, 2000, 4500], 'timers are scoped to the plugin')
    assert.deepEqual(ctx.events.map((e) => e.type), ['plugin.flowcanvas.ui.open'])
    ctx.dispose()
    assert.ok(ctx.timers.every((t) => t.cleared), 'every scoped timer is cleared on dispose')
    assert.equal(ctx.events[0].off, true, 'the subscription went through ctx.onEvent, which the host disposes')
  } finally {
    globalThis.sessionStorage = saved
    I.SHARED.focusWindow = false
  }
})

/** Minimal host ctx: records disposers; `setTimeout`/`onEvent` only when asked, like an older host.
 *  `dispose()` runs the plugin's onDispose callbacks and, like a real host, the subscriptions it tracked itself. */
function fakeCtx({ setTimeout = false, onEvent = false } = {}) {
  const disposers = []
  const timers = []
  const events = []
  const ctx = {
    disposers,
    timers,
    events,
    register: () => () => {},
    storage: { get: (k, d) => d, set() {}, remove() {} },
    onDispose: (fn) => { disposers.push(fn) },
    dispose: () => {
      disposers.splice(0).forEach((fn) => fn())
      events.forEach((rec) => { if (!rec.off) { rec.off = true; rec.offFn() } })
    }
  }
  if (setTimeout) {
    ctx.setTimeout = (fn, ms) => {
      const rec = { fn, ms, cleared: false }
      timers.push(rec)
      return () => { rec.cleared = true }
    }
  }
  if (onEvent) {
    ctx.onEvent = (type, fn) => {
      const offFn = () => { rec.off = true }
      const rec = { type, fn, off: false, offFn }
      events.push(rec)
      return offFn
    }
  }
  return ctx
}
