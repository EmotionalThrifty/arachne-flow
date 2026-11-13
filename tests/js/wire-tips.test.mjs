// While a wire is being pulled no tooltip may show, and the page is exactly as helpful afterwards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'
const I = (await loadPlugin())._internals

function titled(text) {
  let value = text
  return { isConnected: true, getAttribute: () => value, setAttribute: (_n, v) => { value = v }, read: () => value }
}
const scopeOf = (els) => ({ querySelectorAll: () => els.filter((el) => el.getAttribute() !== '') })

test('the drag rule hides only Arachne bubbles and never selects app markup', () => {
  assert.match(I.WIRE_TIP_CSS, /\.fc-tt-bubble/)
  assert.match(I.WIRE_TIP_CSS, /\.fc-tip-bubble/)
  assert.match(I.WIRE_TIP_CSS, /display: none !important/)
  assert.doesNotMatch(I.WIRE_TIP_CSS, /data-slot|tooltip-content|tooltip-bubble\b|html|body/)
})

test('every rich tip Arachne renders carries a bubble class the drag rule hides', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const src = readFileSync(fileURLToPath(new URL('../../desktop/plugin.js', import.meta.url)), 'utf8')
  const tips = src.match(/h\(sdk\.Tip, \{[^\n]*/g) || []
  assert.ok(tips.length >= 3, 'all sdk.Tip call sites were found')
  for (const call of tips) assert.match(call, /className: 'fc-(tt|tip)-bubble'/, call)
})

test('titles inside the plugin are muted for the drag and restored verbatim', () => {
  const port = titled('Text · text'), zoom = titled('Zoom in'), empty = titled('')
  const restore = I.muteTitles(scopeOf([port, zoom, empty]))
  assert.deepEqual([port, zoom, empty].map((el) => el.read()), ['', '', ''])
  restore()
  assert.deepEqual([port, zoom, empty].map((el) => el.read()), ['Text · text', 'Zoom in', ''])
})

test('a title the page re-rendered during the drag is not overwritten by the stale one', () => {
  const badge = titled('Running for 0:03')
  const restore = I.muteTitles(scopeOf([badge]))
  badge.setAttribute('title', 'Done in 4 s')
  restore()
  assert.equal(badge.read(), 'Done in 4 s')
})

test('no page element: muting is a no-op', () => {
  assert.doesNotThrow(() => I.muteTitles(null)())
})
