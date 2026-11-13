// Node card mini outputs: a finished node with several outputs shows every one of them as a compact entry
// (thumbnail / badge / one truncated text line), at most 4 plus "+N"; a broken medium becomes a placeholder
// entry; a node with one output or none looks exactly as before. Display only: the cards are rendered here
// with the hook stubs (no effects run, so nothing is fetched).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals

const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const c of node) walk(c, visit)
    return
  }
  visit(node)
  const ch = node.props && node.props.children
  if (ch !== undefined) walk(ch, visit)
}
const findAll = (tree, pred) => {
  const out = []
  walk(tree, (el) => {
    if (el.props && pred(el.props, el)) out.push(el)
  })
  return out
}
const textOf = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node !== 'object') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props && node.props.children)
}
/** Compact structure signature: element type + className, children nested; text leaves collapsed to `#`. */
const shape = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node !== 'object') return '#'
  if (Array.isArray(node)) return node.map(shape).filter(Boolean).join(',')
  const t = typeof node.type === 'string' ? node.type : (node.type && node.type.name) || 'C'
  const cls = node.props && typeof node.props.className === 'string' ? `.${node.props.className.replace(/ /g, '.')}` : ''
  const kids = shape(node.props && node.props.children)
  return `${t}${cls}${kids ? `(${kids})` : ''}`
}

const OUTPUTS = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name, type: 'any', label: `Out ${name.toUpperCase()}` }))
const SPEC = { type: 'tool:multi', kind: 'tool', title: 'Multi', category: 'Tools', inputs: [], outputs: OUTPUTS, params: [] }
const TYPES = I.indexTypes({ types: [SPEC], compat: { any: ['any'] }, port_types: { any: { color: '#999', label: 'Any' } } })
const NODE = { id: 'n1', type: 'tool:multi', x: 0, y: 0, params: {} }

const img = (n = 'a') => ({ $media: { kind: 'image', path: `C:/pics/${n}.png`, file: `${n}.png` } })
const aud = (n = 'a') => ({ $media: { kind: 'audio', path: `C:/snd/${n}.mp3`, file: `${n}.mp3` } })
const vid = (n = 'a') => ({ $media: { kind: 'video', path: `C:/vid/${n}.mp4`, file: `${n}.mp4` } })
const mdl = (n = 'a') => ({ $media: { kind: 'model3d', path: `C:/3d/${n}.glb`, file: `${n}.glb` } })

const card = (state, extra = {}) => {
  const spec = extra.spec || SPEC
  const props = {
    node: NODE, spec, layout: I.nodeLayout(NODE, spec, new Set(), false), types: TYPES, state, runId: 'r1', flowId: 'f1',
    selected: false, connectedIn: new Set(), connectedOut: new Set(), expanded: false, api: null, wires: {},
    onDown: () => {}, onPortDown: () => {}, onToggleExpand: () => {}, onOpenInspector: () => {}, nameOf: (id) => id,
    onOpenMedia: extra.onOpenMedia, ...extra.props
  }
  return I.NodeCard(props)
}
const done = (outputs, extra = {}) => ({ status: 'done', ms: 5, outputs, ...extra })
const minis = (tree) => findAll(tree, (p) => p['data-fc-mini'] !== undefined)
const more = (tree) => findAll(tree, (p) => p['data-fc-mini-more'] !== undefined)
const labelOf = (el) => textOf(findAll(el, (p) => p.className === 'fc-mini-label')[0])
const badgeOf = (el) => textOf(findAll(el, (p) => p.className === 'fc-mini-badge')[0])

test('three outputs become three mini entries, each with its own title and badge', () => {
  const tree = card(done({ a: img('cat'), b: aud('song'), c: 'a short caption' }, { preview: 'a short caption' }))
  const items = minis(tree)
  assert.equal(items.length, 3, 'one entry per output')
  assert.deepEqual(items.map((e) => e.props['data-fc-mini']), ['image', 'audio', 'text'])
  assert.deepEqual(items.map(labelOf), ['Out A', 'Out B', 'Out C'], 'every entry carries its port title')
  assert.deepEqual(items.map(badgeOf), ['Image', 'Audio', 'Text'])
  assert.ok(textOf(items[2]).includes('a short caption'), 'a text output shows a truncated line')
  assert.equal(more(tree).length, 0, 'no +N when everything fits')
  assert.equal(findAll(tree, (p) => typeof p.className === 'string' && /\bfc-preview\b/.test(p.className)).length, 0,
    'the single big preview is replaced by the entries, not stacked above them')
})

test('every media kind and JSON get a badge; long text becomes a short readable block', () => {
  const long = 'x'.repeat(400)
  const tree = card(done({ a: vid(), b: mdl(), c: { items: [1, 2, 3], ok: true }, d: long }))
  const items = minis(tree)
  assert.deepEqual(items.map((e) => e.props['data-fc-mini']), ['video', 'model3d', 'json', 'text'])
  assert.deepEqual(items.map(badgeOf), ['Video', '3D', 'JSON', 'Text'])
  assert.ok(textOf(items[2]).includes('"items":[1,2,3]'), 'JSON is shown compact')
  const longText = textOf(findAll(items[3], (p) => p.className === 'fc-mini-text')[0])
  assert.ok(longText.length <= 241, 'long text is truncated to a readable block')
  assert.ok(longText.endsWith('…'), 'the truncation is visible')
})

test('six outputs show four entries and "+2"', () => {
  const tree = card(done({ a: img('1'), b: img('2'), c: 'three', d: aud('4'), e: 'five', f: { six: 6 } }))
  assert.equal(minis(tree).length, 4)
  const rest = more(tree)
  assert.equal(rest.length, 1)
  assert.equal(textOf(rest[0]), '+2')
  assert.deepEqual(minis(tree).map(labelOf), ['Out A', 'Out B', 'Out C', 'Out D'], 'run order is kept; the rest is cut')
})

test('a list output counts one entry per file, titled with its position', () => {
  const tree = card(done({ a: [img('1'), img('2'), img('3')], b: 'tail', c: 'more', d: 'last' }))
  assert.equal(minis(tree).length, 4)
  assert.deepEqual(minis(tree).slice(0, 3).map(labelOf), ['Out A 1', 'Out A 2', 'Out A 3'])
  assert.equal(textOf(more(tree)[0]), '+2')
})

test('a broken medium becomes a placeholder and the other entries stay', () => {
  const broken = [
    ['no file', { $media: { kind: 'image' } }],
    ['unknown type', { $media: { kind: 'hologram', path: 'C:/x/h.bin', file: 'h.bin' } }]
  ]
  for (const [why, bad] of broken) {
    const tree = card(done({ a: img('ok'), b: bad, c: 'still here', d: { k: 1 } }), { onOpenMedia: () => {} })
    const items = minis(tree)
    assert.equal(items.length, 4, `${why}: no entry is dropped`)
    assert.deepEqual(items.map((e) => e.props['data-fc-mini']), ['image', 'broken', 'text', 'json'], why)
    assert.equal(labelOf(items[1]), 'Out B', `${why}: the placeholder keeps its title`)
    assert.equal(badgeOf(items[1]), 'Missing', why)
    assert.equal(items[1].props['data-fc-open-media'], undefined, `${why}: a placeholder does not open the lightbox`)
    assert.notEqual(items[0].props['data-fc-open-media'], undefined, `${why}: the healthy image still opens it`)
    assert.ok(textOf(items[2]).includes('still here'), why)
  }
})

test('odd values never throw', () => {
  const odd = { a: { $media: null }, b: { $media: 'nope' }, c: [], d: null, e: { $large: { chars: 90000, preview: 'head…', path: 'C:/p.txt' } }, f: [null, undefined, 3] }
  assert.doesNotThrow(() => card(done(odd)))
  assert.doesNotThrow(() => card(done({ a: { $media: {} }, b: { $media: { kind: 42 } }, c: 'x' })))
  const tree = card(done({ a: { $media: {} }, b: { $media: { kind: 42 } }, c: 'x' }))
  assert.deepEqual(minis(tree).map((e) => e.props['data-fc-mini']), ['broken', 'broken', 'text'])
})

test('mini thumbnail without a loaded image is a placeholder, never an exception', () => {
  assert.equal(typeof I.MiniThumb, 'function')
  let out
  assert.doesNotThrow(() => {
    out = I.MiniThumb({ api: null, runId: 'r1', nodeId: 'n1', port: 'a', index: 0, name: 'a.png' })
  })
  assert.ok(out, 'something is rendered in the thumbnail cell')
  assert.equal(findAll(out, (p, el) => el.type === 'img').length, 0, 'no <img> without data')
})

test('clicking an entry opens the lightbox through the existing handler', () => {
  const opened = []
  const tree = card(done({ a: img('1'), b: aud('2') }), { onOpenMedia: (o) => opened.push(o) })
  const items = minis(tree)
  assert.equal(items.length, 2)
  const click = (el) => el.props.onClick({ stopPropagation: () => {} })
  click(items[1])
  assert.deepEqual(opened, [{ nodeId: 'n1', port: 'b', index: 0, path: 'C:/snd/2.mp3' }])
  const textOnly = minis(card(done({ a: 'x', b: 'y' }), { onOpenMedia: () => {} }))
  assert.equal(textOnly.length, 2)
  assert.equal(textOnly[0].props.onClick, undefined, 'text entries are not clickable')
})

test('error state, running state and no outputs keep the card as it was', () => {
  const err = card({ status: 'error', error: 'boom', outputs: { a: img(), b: 'x' } })
  assert.equal(minis(err).length, 0, 'an error shows the error box only')
  assert.equal(findAll(err, (p) => p['data-fc-run-error'] === '1').length, 1)
  assert.equal(minis(card({ status: 'running' })).length, 0)
  assert.equal(minis(card(null)).length, 0)
})

test('a node without a preview renders the exact structure it had before', () => {
  const bare = card(done({}))
  assert.equal(minis(bare).length + more(bare).length, 0)
  assert.equal(findAll(bare, (p) => typeof p.className === 'string' && /fc-preview|fc-minis/.test(p.className)).length, 0,
    'no preview wrapper, no extra border or height')
  const sig = shape(bare)
  assert.equal(sig, shape(card(done({ a: undefined }))), 'undefined outputs add nothing')
  assert.equal(minis(card(done({ a: null }))).length, 1, 'a null output is shown, not dropped')
  assert.equal(minis(card(done({ a: '' }))).length, 1, 'an empty string output is shown, not dropped')
  assert.equal(sig, shape(card(done(undefined))), 'missing outputs add nothing')
  // the card's own children, in order: head, ports (rows) and nothing after them
  const row = 'div.fc-port-row(C.fc-tt-bubble(div.fc-port.fc-port-out(span.fc-port-label(#),span.fc-dot)))'
  assert.equal(sig,
    'div.fc-node(div.fc-node-head(span.fc-node-icon(Icon),span.fc-node-titles(span.fc-node-title(#),span.fc-node-sub(#)),StatusBadge),' +
    `div.fc-ports(${Array(6).fill(row).join(',')}))`)
})

test('every finished node lists its outputs, including a single text, image or file', () => {
  const text = card(done({ a: 'only text' }, { preview: 'only text' }))
  assert.equal(minis(text).length, 1, 'one text output is a row too')
  assert.equal(badgeOf(minis(text)[0]), 'Text')
  assert.ok(textOf(minis(text)[0]).includes('only text'))
  const image = card(done({ a: img('solo') }), { onOpenMedia: () => {} })
  assert.equal(minis(image).length, 1, 'a single image is a row with a thumbnail')
  assert.equal(minis(image)[0].props['data-fc-mini'], 'image')
  for (const [value, badge] of [[aud('solo'), 'Audio'], [vid('solo'), 'Video'], [mdl('solo'), '3D']]) {
    const one = card(done({ a: value }), { onOpenMedia: () => {} })
    assert.equal(minis(one).length, 1, `${badge}: one file still gets a readable row`)
    assert.equal(badgeOf(minis(one)[0]), badge)
  }
})

test('generated file names are replaced by the file type, uploaded names are kept', () => {
  const gen = card(done({ a: img('n_5d0a5f-1-0'), b: { $media: { kind: 'model3d', mime: 'model/gltf-binary', file: 'n_aa01a2-job0.glb', path: 'C:/o/n_aa01a2-job0.glb' } } }))
  const detailOf = (el) => String(el.props.title || '').split(': ').slice(1).join(': ')
  assert.deepEqual(minis(gen).map(detailOf), ['PNG', 'GLB'], 'auto names say nothing: show the type')
  const mine = card(done({ a: { $media: { kind: 'image', mime: 'image/jpeg', file: 'my dragon.jpg', path: 'C:/o/my dragon.jpg' } }, b: aud('x') }))
  assert.equal(detailOf(minis(mine)[0]), 'my dragon.jpg', 'a name the user chose is worth showing')
  const odd = card(done({ a: { $media: { kind: 'file', file: 'notes.xyz', path: 'C:/o/notes.xyz' } }, b: aud('x') }))
  assert.equal(detailOf(minis(odd)[0]), 'notes.xyz', 'an opaque file keeps the name the user gave it')
})

test('media wrapped inside an object still shows up, without a lightbox it cannot address', () => {
  const wrapped = card(done({ a: { images: [img('1'), img('2')], caption: 'two views' }, b: 'done' }))
  const items = minis(wrapped)
  assert.equal(items.length, 4, 'two wrapped pictures + the JSON row for the object + the text output')
  assert.deepEqual(items.slice(0, 2).map((e) => e.props['data-fc-mini']), ['image', 'image'])
  assert.equal(items[0].props['data-fc-open-media'], undefined, 'wrapped media is not addressable by the media route')
  assert.equal(items[0].props.onClick, undefined)
  assert.deepEqual(items.slice(0, 2).map(labelOf), ['Out A 1', 'Out A 2'])
  assert.equal(items.filter((e) => e.props['data-fc-mini'] === 'json').length, 1)
  assert.equal(items.filter((e) => e.props['data-fc-mini'] === 'text').length, 1)
  assert.equal(items.filter((e) => e.props['data-fc-mini'] === 'image').length, 2)
  const jsonRow = items.find((e) => e.props['data-fc-mini'] === 'json')
  assert.equal(labelOf(jsonRow), 'Out A')
  assert.match(textOf(jsonRow), /two views/)
})
test('output cards are visible: the menu icon rule of the same name must not hide them', () => {
  const css = readFileSync(new URL('../../desktop/plugin.js', import.meta.url), 'utf8')
  assert.match(css, /\.fc-minis \.fc-out \{ display: block;/,
    'without an explicit display the hidden menu icon rule (.fc-mini) would collapse every card to 0px')
  assert.ok(!/className: `fc-mini k-/.test(css), 'output cards use their own class, not the hidden menu icon class')
})
