// The output viewer modal: one dialog that shows any finished node output as inert text/JSON, lets the
// reader reach every public output port, and says plainly when a value cannot be served. Nothing here is
// fetched by the hook stubs (effects never run), so the data path is pinned on two pure seams:
//
//   I.valuePorts(nodeState) -> [{port, kind}]        every public output port, in stored order
//   I.loadRunValue(api, runId, nodeId, port, opts)   page-by-page assembly of one value, never throws
//
// and the modal takes the loader's outcome as an optional `state` so every visual state (loading, ready,
// empty, unavailable, error) is reachable without effects. The contract these tests demand:
//
//   1. the modal is a labelled dialog (role=dialog, aria-modal), closes on Escape and on its Close button;
//   2. with port=null it lists one pressable control per public output port (no `_`-private keys), including
//      ports whose value is null, false, '' or 0, and a nested mixed JSON object as one JSON port; pressing a
//      normal port reports it through `onSelectPort({nodeId, port})`, pressing a media port opens the medium
//      through `onOpenMedia({nodeId, port, index, path})` and never routes media through the value loader;
//   3. while a value is loading it says so; a ready value is rendered as literal text in a <pre>-like node
//      (markdown and HTML stay text, nothing is injected through dangerouslySetInnerHTML), JSON keeps its
//      bytes, an empty value says "empty" instead of pretending to load or to be unavailable;
//   4. an unavailable outcome (the reader refused, e.g. HTTP 409) is an explicit "unavailable" message, and a
//      transport/parse failure is a separate error message — neither is shown as an empty or completed value;
//   5. I.loadRunValue follows the reader contract {kind, chunk, offset, next_offset, total_chars}, calls
//      api.runValue(runId, nodeId, port, offset, limit), reassembles pages (Unicode, empty values), maps 409 to
//      unavailable and other failures to error, and refuses to loop on a non-advancing next_offset or to run
//      past its page bound; I.makeApi.runValue requests `runs/<runId>/value` with node/port/offset/limit.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals

// DialogFrame reads document.activeElement at render time; the viewer tests expand real components, so give
// the module-level render the tiny piece of a document it touches. No DOM is simulated beyond that.
globalThis.document = globalThis.document || {
  activeElement: null,
  body: {},
  addEventListener() {},
  removeEventListener() {}
}

// ---------------------------------------------------------------- static render helpers
/** Render function components down to host elements; hooks stay in the stub's default (static) state. */
const render = (el, depth = 0) => {
  if (el === null || el === undefined || el === false || el === true) return null
  if (typeof el === 'string' || typeof el === 'number') return el
  if (Array.isArray(el)) return el.map((c) => render(c, depth + 1))
  if (typeof el !== 'object') return el
  const props = el.props || {}
  if (typeof el.type === 'function' && depth < 12) return render(el.type(props), depth + 1)
  return { type: el.type, props: { ...props, children: render(props.children, depth + 1) } }
}
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const c of node) walk(c, visit)
    return
  }
  visit(node)
  if (node.props && node.props.children !== undefined) walk(node.props.children, visit)
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
const accessibleName = (el) => String((el.props && (el.props['aria-label'] || el.props.title)) || textOf(el)).trim()
const event = () => ({ stopped: 0, prevented: 0, stopPropagation() { this.stopped += 1 }, preventDefault() { this.prevented += 1 } })
const keyEvent = (key) => ({ key, shiftKey: false, defaultPrevented: false, stopped: 0, prevented: 0, stopPropagation() { this.stopped += 1 }, preventDefault() { this.prevented += 1 } })
const click = (el) => {
  assert.equal(typeof el.props.onClick, 'function', `"${accessibleName(el) || el.type}" is pressable`)
  const e = event()
  el.props.onClick(e)
  return e
}
const dialogOf = (tree) => findAll(tree, (p) => p.role === 'dialog')
const preformatted = (tree) => findAll(tree, (p, el) =>
  el.type === 'pre' || (p.style && /pre/.test(String(p.style.whiteSpace || ''))))
const trusted = (tree) => findAll(tree, (p, el) =>
  p.dangerouslySetInnerHTML !== undefined || ['script', 'iframe', 'object', 'embed', 'img', 'a', 'style', 'link'].includes(el.type))
const isCurrent = (el) => el.props['aria-current'] === 'true' || el.props['aria-current'] === true || el.props['aria-pressed'] === 'true' || el.props['aria-pressed'] === true

// ---------------------------------------------------------------- fixture: one node, every kind of output
const img = (n = 'a') => ({ $media: { kind: 'image', path: `C:/pics/${n}.png`, file: `${n}.png` } })
const OUTPUTS = {
  text: 'line one\nline two – üñï 🌍',
  flag: false,
  none: null,
  empty: '',
  zero: 0,
  nested: {
    items: [null, false, 0, {}, [], { name: 'Ä\nZeile', pic: img('in') }],
    nested: { x: [1, 2.5, true], empty: '' }
  },
  pic: img('cat'),
  album: [img('1'), img('2')],
  _media: [img('hidden')],
  _note: 'private transport detail'
}
const PORTS = ['text', 'flag', 'none', 'empty', 'zero', 'nested', 'pic', 'album']
const KINDS = ['text', 'json', 'json', 'text', 'json', 'json', 'media', 'media']
const NODE = { id: 'n1', type: 'tool:multi', title: 'Multi out', x: 0, y: 0, params: {} }
const FLOW = { id: 'f1', name: 'F', revision: 1, nodes: [NODE], edges: [] }
const NODE_STATE = { status: 'done', ms: 5, outputs: OUTPUTS }
const RUN = { id: 'r1', status: 'done', nodes: { n1: NODE_STATE } }

const opened = () => {
  const calls = []
  const fn = (arg) => calls.push(arg)
  fn.calls = calls
  return fn
}
const viewer = (extra = {}) => {
  const props = {
    api: null, run: RUN, flow: FLOW, node: NODE, port: null,
    onClose: () => {}, onOpenMedia: () => {}, onSelectPort: () => {},
    ...extra
  }
  return render(I.ValueViewer(props))
}
const portControls = (tree) => findAll(tree, (p) => p['data-fc-value-port'] !== undefined)
const controlFor = (tree, port) => portControls(tree).find((el) => el.props['data-fc-value-port'] === port) || null

const ready = (kind, text) => ({ status: 'ready', kind, text, totalChars: text.length })

// ---------------------------------------------------------------- 1. dialog shell
test('the viewer is a dialog labelled with the node, and it fetches nothing until a port is chosen', () => {
  const api = { calls: [], async runValue(...args) { this.calls.push(args) } }
  const tree = viewer({ api })
  const dialogs = dialogOf(tree)
  assert.equal(dialogs.length, 1, 'exactly one modal dialog')
  assert.equal(dialogs[0].props['aria-modal'], 'true', 'the dialog is modal')
  assert.match(String(dialogs[0].props['aria-label'] || ''), /Multi out/, 'the dialog is named after the node')
  assert.equal(typeof dialogs[0].props.onKeyDown, 'function', 'the dialog handles keys')
  assert.deepEqual(api.calls, [], 'opening the all-outputs view does not read a value on its own')
})

test('Escape and the Close button both close the view once', () => {
  const onClose = opened()
  let tree = viewer({ onClose })
  const shell = dialogOf(tree)[0]
  const escape = keyEvent('Escape')
  shell.props.onKeyDown(escape)
  assert.deepEqual(onClose.calls, [undefined], 'Escape closes the dialog')

  tree = viewer({ onClose })
  const close = findAll(tree, (p, el) => el.type === 'button' && /clos/i.test(accessibleName(el)))[0]
  assert.ok(close, 'the dialog has a Close button')
  click(close)
  assert.equal(onClose.calls.length, 2, 'the button closes it as well')
})

// ---------------------------------------------------------------- 2. ports
test('valuePorts lists every public output port in stored order, including falsy values and one JSON port per object', () => {
  const ports = I.valuePorts(NODE_STATE)
  assert.deepEqual(ports.map((p) => p.port), PORTS,
    'null, false, empty string, zero and nested objects are outputs; `_`-keys are private transport')
  assert.deepEqual(ports.map((p) => p.kind), KINDS,
    'a string is text, a media value is media, everything else is JSON')
  assert.deepEqual(I.valuePorts({ status: 'running' }), [], 'a running node has no readable outputs yet')
  assert.deepEqual(I.valuePorts(null), [], 'no state, no ports')
  assert.deepEqual(ports.map((p) => p.port).filter((p) => p.startsWith('_')), [], 'no private port leaks')
})

test('with port=null the dialog lists one control per public output port and marks none as current', () => {
  const tree = viewer()
  const controls = portControls(tree)
  assert.deepEqual(controls.map((el) => el.props['data-fc-value-port']), PORTS, 'every output is reachable, in order')
  const names = controls.map((el) => accessibleName(el).toLowerCase())
  PORTS.forEach((port) => {
    assert.ok(names.some((n) => n.includes(port.toLowerCase())), `${port}: the control names its port`)
  })
  assert.equal(controls.filter(isCurrent).length, 0, 'no port is selected in the all-outputs view')
  assert.equal(trusted(tree).length, 0, 'the shell injects nothing')
})

test('with a port selected the same selector stays available and marks that port current', () => {
  const tree = viewer({ port: 'nested', state: ready('json', JSON.stringify(OUTPUTS.nested)) })
  const controls = portControls(tree)
  assert.equal(controls.length, PORTS.length, 'the reader can still switch ports')
  const current = controls.filter(isCurrent)
  assert.equal(current.length, 1, 'exactly one current port')
  assert.equal(current[0].props['data-fc-value-port'], 'nested')
})

test('choosing null, false and empty ports reports them as real outputs, not as missing data', () => {
  const onSelectPort = opened()
  const tree = viewer({ onSelectPort })
  for (const port of ['none', 'flag', 'empty', 'zero']) {
    const el = controlFor(tree, port)
    assert.ok(el, `${port}: the port is offered`)
    click(el)
    assert.deepEqual(onSelectPort.calls[onSelectPort.calls.length - 1], { nodeId: 'n1', port },
      `${port}: the page is asked for that port`)
  }
  assert.equal(new Set(onSelectPort.calls.map((c) => c.port)).size, 4, 'no two ports collapse into one')
})

test('a media port opens the medium, a JSON object wrapping media stays a value', () => {
  const onSelectPort = opened()
  const onOpenMedia = opened()
  const tree = viewer({ onSelectPort, onOpenMedia })
  click(controlFor(tree, 'pic'))
  assert.deepEqual(onOpenMedia.calls, [{ nodeId: 'n1', port: 'pic', index: 0, path: 'C:/pics/cat.png' }],
    'a picture output opens the lightbox at its first file')
  assert.deepEqual(onSelectPort.calls, [], 'media is not sent to the value reader')

  click(controlFor(tree, 'album'))
  assert.deepEqual(onOpenMedia.calls[1], { nodeId: 'n1', port: 'album', index: 0, path: 'C:/pics/1.png' },
    'a list of pictures opens at its first file')

  click(controlFor(tree, 'nested'))
  assert.deepEqual(onSelectPort.calls, [{ nodeId: 'n1', port: 'nested' }],
    'an object that merely contains media is shown as one JSON value')
  assert.equal(onOpenMedia.calls.length, 2, 'the nested picture is not hijacked into the lightbox')
})

// ---------------------------------------------------------------- 3. body states
test('before a value arrives the body says it is loading and claims nothing else', () => {
  const tree = viewer({ port: 'text' })
  const text = textOf(tree)
  assert.match(text, /load|read|fetch|opening/i, 'the reader is told the value is being fetched')
  assert.doesNotMatch(text, /unavailable|not available|no outputs?/i, 'loading is not presented as unavailable')
  assert.equal(findAll(tree, (p) => p.role === 'alert').length, 0, 'loading is not an error')
  const busy = findAll(tree, (p) => p.role === 'status' || p['aria-busy'] === 'true' || p['aria-busy'] === true)
  assert.ok(busy.length >= 1, 'the loading placeholder is announced (role=status or aria-busy)')
})

test('a ready text value is rendered literally: markdown and HTML stay text, in a preformatted node', () => {
  const hostile = '# Heading\n<img src=x onerror="alert(1)">\n[a link](javascript:alert(1))\n```js\nconst a = 1\n```\nEnde – üñï 🌍'
  const tree = viewer({ port: 'text', state: ready('text', hostile) })
  assert.ok(textOf(tree).includes(hostile), 'the exact stored text is visible, character for character')
  assert.ok(textOf(tree).includes('<img src=x onerror="alert(1)">'), 'the tag is not parsed away')
  assert.deepEqual(trusted(tree), [], 'no img/a/script element and no dangerouslySetInnerHTML')
  const pre = preformatted(tree).filter((el) => textOf(el).includes('Heading'))
  assert.ok(pre.length >= 1, 'the value sits in a <pre> or a white-space: pre-wrap node')
  assert.equal(findAll(tree, (p) => p.role === 'alert').length, 0, 'a readable value is not an error')
})

test('a ready JSON value keeps its bytes, Unicode and structure as one inert block', () => {
  const text = JSON.stringify(OUTPUTS.nested)
  const tree = viewer({ port: 'nested', state: ready('json', text) })
  const shown = textOf(tree)
  assert.ok(shown.includes(text), 'the serialized JSON is shown verbatim')
  assert.ok(shown.includes('Ä'), 'Unicode survives')
  assert.match(shown, /"b":false|"flag":false|"items"/, 'the structure is still readable')
  assert.deepEqual(trusted(tree), [], 'JSON is text, never markup')
  assert.ok(preformatted(tree).length >= 1, 'JSON keeps its line structure in a preformatted node')
})

test('an empty value is shown as empty, not as loading or unavailable', () => {
  const tree = viewer({ port: 'empty', state: ready('text', '') })
  const text = textOf(tree)
  assert.match(text, /empty|blank|nothing/i, 'an empty stored value is named as such')
  assert.doesNotMatch(text, /loading|fetching|unavailable|not available/i, 'empty is a real, served value')
  assert.equal(findAll(tree, (p) => p.role === 'alert').length, 0, 'empty is not an error')
})

test('a refused value (the reader answers 409) is an explicit unavailable message with its reason', () => {
  const tree = viewer({ port: 'text', state: { status: 'unavailable', code: 409, reason: 'the output is too large to serve inline' } })
  const text = textOf(tree)
  assert.match(text, /unavailable|not available|cannot be (shown|displayed)/i, 'the page says the value is unavailable')
  assert.match(text, /too large/i, 'the reason from the reader reaches the reader of the dialog')
  assert.doesNotMatch(text, /^$/, 'not an empty body')
  assert.doesNotMatch(text, /empty output|no output/i, 'unavailable is not presented as an empty value')
  assert.ok(findAll(tree, (p) => p.role === 'alert' || p.role === 'status').length >= 1, 'the state is announced')
})

test('a transport failure is an error, distinct from an unavailable value', () => {
  const tree = viewer({ port: 'text', state: { status: 'error', code: 500, reason: 'backend exploded' } })
  const text = textOf(tree)
  assert.match(text, /error|failed|failed to load/i, 'the body reports a failure')
  assert.match(text, /backend exploded/, 'the failure reason is shown')
  assert.doesNotMatch(text, /unavailable|not available/i, 'a failure is not disguised as an unavailable value')
  assert.ok(findAll(tree, (p) => p.role === 'alert').length >= 1, 'the error is announced')
})

test('a node without stored outputs opens an explicit empty view instead of a blank dialog', () => {
  let tree
  assert.doesNotThrow(() => {
    tree = viewer({ run: { id: 'r1', status: 'done', nodes: {} } })
  }, 'a node the run never recorded does not crash the viewer')
  assert.equal(portControls(tree).length, 0, 'there is nothing to choose')
  assert.match(textOf(tree), /no outputs?|nothing|no value|unavailable/i, 'the dialog explains there is nothing to show')
  assert.equal(dialogOf(tree).length, 1, 'the dialog shell is still there')
})

// ---------------------------------------------------------------- 4. loader
const page = (over) => ({ kind: 'text', chunk: '', offset: 0, next_offset: null, total_chars: 0, version: 'a'.repeat(64), ...over })
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

test('loadRunValue walks the pages with the reader contract and reassembles the value', async () => {
  const api = fakeApi([
    page({ kind: 'json', chunk: '{"a":"🌍",', offset: 0, next_offset: 9, total_chars: 19 }),
    page({ kind: 'json', chunk: '"b":false}', offset: 9, next_offset: null, total_chars: 19 })
  ])
  const out = await I.loadRunValue(api, 'r1', 'n1', 'nested', { limit: 9 })
  assert.equal(out.status, 'ready')
  assert.equal(out.kind, 'json')
  assert.equal(out.text, '{"a":"🌍","b":false}', 'the pages are joined in order')
  assert.equal(out.totalChars, 19)
  assert.equal(out.pages, 2)
  assert.deepEqual(api.calls.map((c) => c.slice(1, 4)), [['n1', 'nested', 0], ['n1', 'nested', 9]], 'node/port/offset follow the reader')
  assert.ok(api.calls.every((c) => c[0] === 'r1'), 'every page is read from the same run')
  assert.ok(api.calls.every((c) => Number.isInteger(c[4]) && c[4] > 0), 'a positive page size is always sent')
  assert.equal(api.calls[0][4], 9, 'the caller page size is forwarded')
})

test('loadRunValue keeps an empty value empty and stops after one page', async () => {
  const api = fakeApi([page({ kind: 'text', chunk: '', offset: 0, next_offset: null, total_chars: 0 })])
  const out = await I.loadRunValue(api, 'r1', 'n1', 'empty')
  assert.equal(out.status, 'ready')
  assert.equal(out.kind, 'text')
  assert.equal(out.text, '')
  assert.equal(out.totalChars, 0)
  assert.equal(out.pages, 1)
  assert.equal(api.calls.length, 1, 'no extra request for an empty value')
})

test('loadRunValue keeps Unicode intact across single-character pages', async () => {
  const value = 'a🌍b\n'
  const pages = [...value].map((ch, i) => page({ chunk: ch, offset: i, next_offset: i + 1 < [...value].length ? i + 1 : null, total_chars: [...value].length }))
  const out = await I.loadRunValue(fakeApi(pages), 'r1', 'n1', 'unicode')
  assert.equal(out.status, 'ready')
  assert.equal(out.text, value)
  assert.equal(out.pages, pages.length)
})

test('loadRunValue maps a 409 to unavailable, keeps the reason, and never throws', async () => {
  const api = fakeApi([new Error('409: {"detail":"the output is too large to serve inline"}')])
  let out
  await assert.doesNotReject(async () => {
    out = await I.loadRunValue(api, 'r1', 'n1', 'text')
  }, 'a refusal is an outcome, not an exception')
  assert.equal(out.status, 'unavailable')
  assert.equal(out.code, 409)
  assert.match(out.reason, /too large/, 'the reader detail is kept for the dialog')
  assert.equal(api.calls.length, 1, 'a refusal is final: no retry loop')
})

test('loadRunValue maps other failures to an error outcome with the server detail', async () => {
  const out = await I.loadRunValue(fakeApi([new Error('500: {"detail":"backend exploded"}')]), 'r1', 'n1', 'text')
  assert.equal(out.status, 'error')
  assert.equal(out.code, 500)
  assert.match(out.reason, /backend exploded/)
})

test('loadRunValue refuses a page that does not advance instead of looping forever', async () => {
  const api = fakeApi([
    page({ chunk: 'x', offset: 0, next_offset: 0, total_chars: 10 }),
    page({ chunk: 'x', offset: 0, next_offset: 0, total_chars: 10 })
  ])
  const out = await I.loadRunValue(api, 'r1', 'n1', 'text')
  assert.equal(out.status, 'error', 'a stuck offset is a failure, not a finished value')
  assert.match(out.reason, /advanc|progress|repeat|loop|stuck/i)
  assert.ok(api.calls.length <= 2, 'at most the offending page is read twice')
})

test('loadRunValue stops at its page bound and reports it instead of paging forever', async () => {
  const pages = Array.from({ length: 10 }, (_, i) => page({ chunk: 'x', offset: i, next_offset: i + 1, total_chars: 10 }))
  const api = fakeApi(pages)
  const out = await I.loadRunValue(api, 'r1', 'n1', 'text', { maxPages: 3 })
  assert.equal(out.status, 'error', 'a value beyond the bound is not silently truncated')
  assert.match(out.reason, /too (many|long)|limit|bound|cap/i)
  assert.equal(api.calls.length, 3, 'exactly the allowed number of pages')
})

test('loadRunValue rejects a malformed page as an error rather than fabricating content', async () => {
  const out = await I.loadRunValue(fakeApi([{ kind: 'text', chunk: 'partial' }]), 'r1', 'n1', 'text')
  assert.equal(out.status, 'error', 'a page missing offset/next_offset/total_chars is not a valid value')
  assert.match(out.reason, /page|contract|malformed|invalid/i)
})

// ---------------------------------------------------------------- 5. the HTTP seam
test('makeApi.runValue asks the run-value route with node, port, offset and limit', async () => {
  const calls = []
  const api = I.makeApi({ rest: async (path, opts) => { calls.push([path, opts]); return page({}) } })
  await api.runValue('r_1', 'n 1', 'out/a', 10, 100)
  assert.equal(calls[0][0], '/x/runs/r_1/value?node=n%201&port=out%2Fa&offset=10&limit=100&consistent=1',
    'the route is GET /x/runs/<id>/value and every query value is encoded')
  assert.equal(calls[0][1].method, 'GET')
})


test('expanded JSON tree warns about server normalization and browser rounding', () => {
  const tree = viewer({port:'nested',state:{...ready('json','{"precise":1}'),expanded:true}})
  assert.match(textOf(tree), /expanded/i)
  assert.match(textOf(tree), /normaliz/i)
  assert.match(textOf(tree), /round/i)
  assert.doesNotMatch(textOf(tree), /Raw JSON is exact/i)
})
