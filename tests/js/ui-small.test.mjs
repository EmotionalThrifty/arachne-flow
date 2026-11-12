// Small review findings (E0): WSLg z-order (U-6), per-window focus flag (U-13), pop-out hand-off ownership
// (U-14), inline-only markdown images (U-17), honest copy feedback and unique node-card keys (U-18).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadPlugin, loadSdkStub } from './load.mjs'

const I = (await loadPlugin())._internals
const SRC = readFileSync(new URL('../../desktop/plugin.js', import.meta.url), 'utf8')

/** A stand-in ctx.storage backed by a Map (the shape the plugin gets from the host). */
function storageOf(store) {
  return { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v), remove: (k) => store.delete(k) }
}

test('only a window that is NOT the opener takes the pop-out hand-off (U-14)', () => {
  const now = 1_000_000
  const fresh = { flowId: 'f_1', at: now - 1000, from: 'win-a' }
  assert.equal(I.shouldConsumeHandoff(fresh, 'win-b', now), true, 'the newly opened window takes it')
  assert.equal(I.shouldConsumeHandoff(fresh, 'win-a', now), false, 'a hot reload of the source window must not turn it into the plugin-only window')
  assert.equal(I.shouldConsumeHandoff(fresh, null, now), true, 'no window id: fall back to taking it')
  assert.equal(I.shouldConsumeHandoff({ flowId: 'f_1', at: now - 1000 }, 'win-a', now), true, 'a hand-off without an opener id is still honoured')
  assert.equal(I.shouldConsumeHandoff({ flowId: 'f_1', at: now - 60000, from: 'win-b' }, 'win-a', now), false, 'stale')
  assert.equal(I.shouldConsumeHandoff({ flowId: 'f_1', at: now + 5000, from: 'win-b' }, 'win-a', now), false, 'from the future')
  assert.equal(I.shouldConsumeHandoff({ flowId: '', at: now, from: 'win-b' }, 'win-a', now), false)
  assert.equal(I.shouldConsumeHandoff(null, 'win-a', now), false)
  assert.equal(I.shouldConsumeHandoff('f_1', 'win-a', now), false)
})

test('a reloaded source window leaves the hand-off for the peer and stays a normal window (U-14)', async () => {
  const sdk = await loadSdkStub()
  const mind = new Map()
  globalThis.sessionStorage = {
    getItem: (k) => (mind.has(k) ? mind.get(k) : null),
    setItem: (k, v) => mind.set(k, String(v)),
    removeItem: (k) => mind.delete(k)
  }
  try {
    const myId = I.windowIdGet()
    assert.equal(typeof myId, 'string')
    assert.ok(myId.length > 0, 'a window gets an id')
    assert.equal(I.windowIdGet(), myId, 'the id is stable for the life of the window')
    assert.equal(I.windowIdGet('win-other'), 'win-other', 'an explicit id wins (tests, future callers)')
    assert.equal(I.windowIdGet(), myId, 'an explicit id is not remembered')

    const plugin = await loadPlugin()
    const store = new Map([[I.POPOUT_KEY, { flowId: 'f_9', at: Date.now(), from: myId }]])
    const disposers = []
    sdk.host.navigated.length = 0
    I.SHARED.focusWindow = false
    plugin.register({ register: () => {}, storage: storageOf(store), onDispose: (fn) => disposers.push(fn) })
    assert.deepEqual(sdk.host.navigated, [], 'the opener does not navigate to the page')
    assert.equal(I.SHARED.focusWindow, false, 'the opener keeps the whole app')
    assert.equal(store.has(I.POPOUT_KEY), true, 'the hand-off is left for the window that was opened')
    disposers.forEach((fn) => fn())

    store.set(I.POPOUT_KEY, { flowId: 'f_9', at: Date.now(), from: 'win-other' })
    sdk.host.navigated.length = 0
    plugin.register({ register: () => {}, storage: storageOf(store), onDispose: (fn) => disposers.push(fn) })
    assert.deepEqual(sdk.host.navigated, ['/arachne-flow'], 'a peer window still takes it and shows the page')
    assert.equal(store.has(I.POPOUT_KEY), false, 'taken exactly once')
    assert.equal(I.SHARED.focusWindow, true)
    disposers.forEach((fn) => fn())
    I.SHARED.focusWindow = false
  } finally {
    delete globalThis.sessionStorage
  }
})

test('navigation retries stop once the page has mounted (U-14)', () => {
  assert.equal(I.shouldRetryNavigate(false, 0), true, 'nothing mounted yet: keep trying')
  assert.equal(I.shouldRetryNavigate(true, 1), false, 'route reached: stop')
  assert.equal(I.shouldRetryNavigate(true, 0), false, 'the page mounted once and the user left: do not yank them back')
  assert.equal(I.shouldRetryNavigate(false, 1), false, 'a page is live: nothing to retry')
  const reg = SRC.slice(SRC.indexOf('const takeIt = shouldConsumeHandoff'))
  assert.match(reg, /later\(\(\) => \{\s*if \(shouldRetryNavigate\(SHARED\.pageMounted, SHARED\.listeners\.size\)\) navigate\(\)/, 'the retries go through the helper')
})

test('the plugin-only window stays below the app window buttons (U-6)', () => {
  const rule = /\.fc-root\.fc-focus\s*\{[^}]*z-index:\s*(-?\d+)/.exec(SRC)
  assert.ok(rule, '.fc-root.fc-focus sets a z-index')
  const z = Number(rule[1])
  assert.ok(z > 0, `z-index ${z} must be positive`)
  assert.ok(z < 80, `z-index ${z} must stay below the WSLg window buttons at 80`)
  const css = SRC.slice(Math.max(0, SRC.indexOf('.fc-root.fc-focus {') - 400), SRC.indexOf('.fc-root.fc-focus {'))
  assert.match(css, /window buttons/, 'the z-index has a comment saying what it must stay below')
})

test('markdown output only loads inline data: images (U-17)', () => {
  assert.match(SRC, /allowedImagePrefixes:\s*\[\s*'data:'\s*\]/, 'only inline images are allowed')
  assert.doesNotMatch(SRC, /allowedImagePrefixes:\s*\[[^\]]*['"]\*['"]/, 'no wildcard image sources')
  const call = SRC.slice(SRC.indexOf('h(sdk.Streamdown'), SRC.indexOf('h(sdk.Streamdown') + 400)
  assert.match(call, /allowedImagePrefixes/, 'the restriction is on the Streamdown call itself')
})

test('copy feedback only shows a check when the clipboard write succeeded (U-18)', () => {
  assert.equal(I.clipboardOk(true), true)
  assert.equal(I.clipboardOk(undefined), true, 'the app resolves undefined on success')
  assert.equal(I.clipboardOk(false), false, 'the host refused')
  const btn = SRC.slice(SRC.indexOf('function CopyBtn'), SRC.indexOf('function NameInput'))
  assert.doesNotMatch(btn, /setDone\(true\)/, 'the check mark is not set before the write resolves')
  assert.match(btn, /setDone\(ok\)/, 'the check mark follows the write result')
})

test('node-card summary rows get unique React keys (U-18)', () => {
  assert.ok(!SRC.includes('`k:${k}`'), 'the label key repeated when two params share a label')
  assert.ok(!SRC.includes('`v:${k}`'), 'the value key had the same problem')
  assert.match(SRC, /summary\.map\(\(\[k, v\], i\) =>/, 'the row index makes the keys unique')
})

test('pointer drags capture the pointer so they survive leaving the element (U-18)', () => {
  const begin = /const begin = (?:useCallback\()?\(kind, e, data\) => \{[\s\S]{0,900}?\n  \}/.exec(SRC)   // U-4 wraps it in useCallback
  assert.ok(begin, 'the shared drag start helper')
  assert.match(begin[0], /setPointerCapture\(e\.pointerId\)/, 'every canvas drag captures the pointer')
  assert.match(begin[0], /catch/, 'browsers without capture must not break the drag')
})

test('UI-7: lightbox pan listeners are cleaned up on unmount as well as pointerup/pointercancel', () => {
  assert.equal(typeof I.bindLightboxPan, 'function', 'bindLightboxPan is exported in _internals')
  const listeners = new Map()
  const fakeWin = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    emit(type, ev = {}) {
      for (const fn of [...(listeners.get(type) || [])]) fn(ev)
    },
    count(type) {
      return listeners.get(type)?.size || 0
    }
  }
  const moves = []
  let ended = 0
  const stop = I.bindLightboxPan(fakeWin, {
    onMove: (ev) => moves.push([ev.clientX, ev.clientY]),
    onEnd: () => { ended++ }
  })
  assert.equal(fakeWin.count('pointermove'), 1)
  assert.equal(fakeWin.count('pointerup'), 1)
  assert.equal(fakeWin.count('pointercancel'), 1)

  fakeWin.emit('pointermove', { clientX: 12, clientY: 34 })
  assert.deepEqual(moves, [[12, 34]])

  // Unmount while dragging: stop() removes all window listeners idempotently WITHOUT calling onEnd
  stop()
  stop()
  assert.equal(ended, 0, 'unmount cleanup must not invoke onEnd on an unmounted component')
  assert.equal(fakeWin.count('pointermove'), 0, 'pointermove listener removed on unmount')
  assert.equal(fakeWin.count('pointerup'), 0, 'pointerup listener removed on unmount')
  assert.equal(fakeWin.count('pointercancel'), 0, 'pointercancel listener removed on unmount')

  fakeWin.emit('pointermove', { clientX: 99, clientY: 99 })
  assert.deepEqual(moves, [[12, 34]], 'no move events fire after unmount cleanup')

  // Normal pointerup and pointercancel DO invoke onEnd once and remove listeners
  for (const endEvent of ['pointerup', 'pointercancel']) {
    let normalEnded = 0
    const stopNormal = I.bindLightboxPan(fakeWin, {
      onMove: (ev) => moves.push([ev.clientX, ev.clientY]),
      onEnd: () => { normalEnded++ }
    })
    fakeWin.emit(endEvent)
    assert.equal(normalEnded, 1, `${endEvent} invokes onEnd`)
    assert.equal(fakeWin.count('pointermove'), 0, `${endEvent} removes pointermove`)
    assert.equal(fakeWin.count('pointerup'), 0, `${endEvent} removes pointerup`)
    assert.equal(fakeWin.count('pointercancel'), 0, `${endEvent} removes pointercancel`)
    stopNormal()
    assert.equal(normalEnded, 1, 'subsequent cleanup after pointer end does not call onEnd again')
  }
})

test('UI-10: FileChip uses .fc-file-chip and does not collide with multi-select .fc-chip', () => {
  const chipRules = SRC.match(/^\.fc-chip\s*\{[^\n]+/gm) || []
  assert.equal(chipRules.length, 1, '.fc-chip must have a single CSS rule (for multi-select chips)')
  assert.match(chipRules[0], /display:\s*inline-flex/, '.fc-chip stays an inline-flex pill')
  assert.match(SRC, /^\.fc-file-chip\s*\{[^\n]*display:\s*flex/m, '.fc-file-chip has the file-chip flex rule')
  const fileChipFn = SRC.slice(SRC.indexOf('function FileChip('), SRC.indexOf('function MediaView('))
  assert.match(fileChipFn, /className:\s*'fc-file-chip'/, 'FileChip renders .fc-file-chip')
  assert.doesNotMatch(fileChipFn, /className:\s*'fc-chip'/, 'FileChip no longer uses .fc-chip')
})
