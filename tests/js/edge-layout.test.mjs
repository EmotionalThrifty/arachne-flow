// Edge layout A (18.11.2026): backward wires run around below the cards; the focused node's wires light up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals
const nums = (d) => d.match(/-?\d+(\.\d+)?/g).map(Number)

test('edgeRouteWorld: forward wires keep the curve', () => {
  const a = { x: 300, y: 80 }
  const b = { x: 600, y: 140 }
  assert.equal(I.edgeRouteWorld(a, b, { x: 40, y: 40, w: 260, h: 120 }, { x: 600, y: 100, w: 260, h: 120 }), I.edgePathWorld(a, b))
  assert.equal(I.edgeRouteWorld(a, b), I.edgePathWorld(a, b), 'without boxes nothing changes')
})

test('edgeRouteWorld: a backward wire runs below both cards and never inside them', () => {
  const boxA = { x: 400, y: 40, w: 260, h: 150 }
  const boxB = { x: 100, y: 120, w: 260, h: 200 }
  const a = { x: 660, y: 100 }
  const b = { x: 100, y: 180 }
  const d = I.edgeRouteWorld(a, b, boxA, boxB)
  assert.ok(!d.includes(' C '), 'no bezier for a backward wire')
  assert.ok(d.startsWith('M 660.0 100.0') && d.endsWith('L 100.0 180.0'), 'starts at the output, ends at the input')
  const v = nums(d)
  const ys = v.filter((_, i) => i % 2 === 1)
  const below = Math.max(boxA.y + boxA.h, boxB.y + boxB.h)
  assert.equal(Math.max(...ys), below + 24, 'the horizontal run sits 24 px under the lower card')
  // every corner point lies outside both cards (left of B, right of A, or under both)
  for (let i = 0; i < v.length; i += 2) {
    const [x, y] = [v[i], v[i + 1]]
    for (const r of [boxA, boxB]) {
      assert.ok(!(x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h), `point ${x},${y} is inside a card`)
    }
  }
})

test('edgeRouteWorld: cards stacked in one column also go around instead of an S behind them', () => {
  const d = I.edgeRouteWorld({ x: 360, y: 80 }, { x: 100, y: 300 }, { x: 100, y: 40, w: 260, h: 120 }, { x: 100, y: 260, w: 260, h: 120 })
  assert.ok(d.includes(' Q ') && !d.includes(' C '))
})

test('roundedPath: degenerate segments are skipped instead of producing NaN', () => {
  const d = I.roundedPath([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }], 12)
  assert.ok(!d.includes('NaN'))
  assert.ok(d.includes(' Q 50.0 0.0 '))
})

test('edgeFocus: hover wins, a single selection lights its wires, many selected or dragging lights nothing', () => {
  const edges = [
    { id: 'e1', from: { node: 'a' }, to: { node: 'b' } },
    { id: 'e2', from: { node: 'b' }, to: { node: 'c' } },
    { id: 'e3', from: { node: 'x' }, to: { node: 'y' } }
  ]
  assert.equal(I.edgeFocus(edges, {}), null)
  assert.deepEqual([...I.edgeFocus(edges, { hover: 'b' })].sort(), ['e1', 'e2'])
  assert.deepEqual([...I.edgeFocus(edges, { hover: 'c', selection: ['a'] })], ['e2'])
  assert.deepEqual([...I.edgeFocus(edges, { selection: ['a'] })], ['e1'])
  assert.equal(I.edgeFocus(edges, { selection: ['a', 'b'] }), null, 'select-all must not light every wire')
  assert.deepEqual([...I.edgeFocus(edges, { selectedEdge: 'e3' })], ['e3'])
  assert.equal(I.edgeFocus(edges, { hover: 'b', dragging: true }), null)
})

test('canvas draws lit wires in a second layer above the cards and fades the rest', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../../desktop/src/11-canvas.js', import.meta.url), 'utf8')
  const top = src.indexOf("className: 'fc-edges fc-edges-top'")
  assert.ok(top > src.indexOf("className: 'fc-world'"), 'the lit layer comes after the node layer')
  assert.ok(src.includes("lit && !on && 'faded'"))
  const css = fs.readFileSync(new URL('../../desktop/src/05-status-styles.js', import.meta.url), 'utf8')
  assert.ok(/\.fc-edge\.faded \{ opacity: \.16; \}/.test(css))
})
