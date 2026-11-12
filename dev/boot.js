// Boots desktop/plugin.js in the dev harness: a fake plugin ctx (register/rest/storage), then renders
// the contributed route. URL params: ?flow=<id>&select=<node_id> seed ctx.storage like a reopened app.
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'

// Diagnostics for dev/probe.py: console errors + node rectangles, written into the DOM.
const diag = { errors: [], runRequests: [], cancelRequests: [], runFetches: 0 }
// Does the inspector's selected tool label fit its select (minus padding and the arrow)? Canvas text metrics.
function toolFit(insp) {
  const s = insp && insp.querySelector('.fc-tool-pick select')
  if (!s) return null
  const cs = getComputedStyle(s)
  const ctx = document.createElement('canvas').getContext('2d')
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  const text = s.selectedOptions[0]?.textContent || ''
  return { text, textW: Math.ceil(ctx.measureText(text).width),
    room: Math.floor(s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 20), hover: s.title || '' }
}
window.addEventListener('error', (e) => diag.errors.push(String(e.message || e)))
window.addEventListener('unhandledrejection', (e) => diag.errors.push('unhandled: ' + String(e.reason && e.reason.message || e.reason)))
const origError = console.error
console.error = (...args) => { diag.errors.push(args.map(String).join(' ').slice(0, 500)); origError(...args) }
setTimeout(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  diag.nodes = [...document.querySelectorAll('[data-fc-node]')].map((el) => ({ id: el.dataset.fcNode, title: el.querySelector('.fc-node-title')?.textContent, ...rect(el) }))
  diag.root = document.querySelector('.fc-root') ? rect(document.querySelector('.fc-root')) : null
  diag.canvas = document.querySelector('.fc-canvas') ? rect(document.querySelector('.fc-canvas')) : null
  diag.edges = document.querySelectorAll('.fc-edge').length
  diag.badges = [...document.querySelectorAll('.fc-node .fc-badge')].map((b) => b.textContent)
  diag.images = [...document.querySelectorAll('.fc-node img')].length
  diag.runChip = document.querySelector('.fc-runchip')?.textContent || null
  diag.runButtons = [...document.querySelectorAll('.fc-header button')]
    .map((el) => el.textContent.trim()).filter((text) => ['Run', 'Running…', 'Fresh', 'Stop'].includes(text))
  diag.logRows = [...document.querySelectorAll('.fc-log-body .fc-log-row')].map((el) => el.textContent)
  const quick = document.querySelector('.fc-quick')
  diag.quick = quick ? {
    ...rect(quick),
    focused: document.activeElement === quick.querySelector('input'),
    items: [...quick.querySelectorAll('[data-fc-type]')].map((el) => el.dataset.fcType),
    recent: [...quick.querySelectorAll('[data-fc-recent] [data-fc-type]')].map((el) => el.dataset.fcType),
    footer: quick.querySelector('.fc-quick-foot') ? rect(quick.querySelector('.fc-quick-foot')) : null,
    listClient: quick.querySelector('.fc-quick-list')?.clientHeight,
    listScroll: quick.querySelector('.fc-quick-list')?.scrollHeight
  } : null
  diag.paletteRecent = [...document.querySelectorAll('.fc-palette [data-fc-recent] [data-fc-type]')].map((el) => el.dataset.fcType)
  const insp = document.querySelector('[data-fc-inspector]')
  diag.inspector = insp ? {
    node: insp.dataset.fcInspector,
    title: insp.querySelector('.fc-insp-title')?.value ?? null,
    tool: insp.querySelector('.fc-tool-pick select')?.value ?? null,
    toolFit: toolFit(insp),
    toolOptions: insp.querySelectorAll('.fc-tool-pick option').length,
    sections: [...insp.querySelectorAll('.fc-section h4')].map((el) => el.textContent),
    fields: [...insp.querySelectorAll('.fc-field > label')].map((el) => el.textContent),
    images: insp.querySelectorAll('.fc-media img').length,
    chips: [...insp.querySelectorAll('.fc-chip-name')].map((el) => el.textContent),
    error: insp.querySelector('.fc-insp-error .fc-node-error')?.textContent || null,
    errorCopy: !!insp.querySelector('.fc-insp-error .fc-copy'),
    issues: [...insp.querySelectorAll('.fc-insp-issues .fc-issue')].map((el) => el.textContent),
    deleteBtn: [...insp.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Delete node'),
    ...rect(insp), scrollW: insp.scrollWidth, clientW: insp.clientWidth, scrollH: insp.scrollHeight, clientH: insp.clientHeight,
    overflowY: getComputedStyle(insp).overflowY
  } : null
  const scroller = document.getElementById('__pane') || document.scrollingElement
  diag.pageOverflow = scroller ? scroller.scrollHeight - scroller.clientHeight : null
  diag.logVisible = (() => {
    const log = document.querySelector('.fc-log')
    if (!log) return null
    const r = log.getBoundingClientRect()
    return r.bottom <= window.innerHeight + 0.5
  })()
  const pre = document.createElement('pre')
  pre.id = '__diag'
  pre.style.display = 'none'
  pre.textContent = JSON.stringify(diag)
  document.body.appendChild(pre)
}, Number(new URLSearchParams(location.search).get('diag_ms') || 4500))

const params = new URLSearchParams(location.search)
const memory = new Map()
if (params.get('flow')) memory.set('flowId', params.get('flow'))
// G4: ?popin=1 boots like a window that finds a hand-off in storage, no remembered flow of its own.
if (params.get('popin') && params.get('flow')) {
  // Desktop's shell sets this on an ancestor: width of the native min/max/close buttons (Windows)
  document.documentElement.style.setProperty('--titlebar-tools-right', '138px')
  memory.delete('flowId')
  memory.set('popout', { flowId: params.get('flow'), at: Date.now() - 1500 })
}
if (params.get('select')) memory.set('selection', [params.get('select')])
if (params.get('inspector')) memory.set('inspectorOpen', params.get('inspector') !== '0')
if (params.get('recent')) memory.set('recentTypes', params.get('recent').split(',').filter(Boolean))

const contributions = []
const ctx = {
  id: 'arachne-flow',
  register(c) { contributions.push(c); return () => {} },
  registerMany(list) { list.forEach((c) => contributions.push(c)); return () => {} },
  async rest(path, opts = {}) {
    const method = opts.method || 'GET'
    if (path === '/x/runs' && method === 'POST') diag.runRequests.push(opts.body || {})
    if ((path === '/x/generate' || path === '/x/generate/jobs') && method === 'POST') (diag.generateRequests = diag.generateRequests || []).push(opts.body || {})
    if (path.startsWith('/x/runs/') && method === 'GET') diag.runFetches += 1
    if (path.startsWith('/x/runs/') && path.endsWith('/cancel') && method === 'POST') diag.cancelRequests.push(path)
    // U-10: Desktop's bridge sends a plugin `upload` as one multipart part named "file" (electron main.ts,
    // multipartBody) — mirror that instead of a JSON body so the harness exercises the same route.
    const res = opts.upload
      ? await fetch('/api/plugins/arachne-flow' + path, {
        method,
        body: (() => {
          const form = new FormData()
          form.append('file', new File([opts.upload.bytes], opts.upload.filename || 'file',
            { type: opts.upload.contentType || 'application/octet-stream' }))
          return form
        })()
      })
      : await fetch('/api/plugins/arachne-flow' + path, {
        method,
        headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
      })
    const text = await res.text()
    let data
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    if (!res.ok) {
      // Same shape as the Desktop bridge: "Error invoking remote method 'hermes:api': Error: <status>: <body>"
      throw new Error(`Error invoking remote method 'hermes:api': Error: ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
    }
    return data
  },
  storage: {
    get: (k) => memory.get(k),
    set: (k, v) => { memory.set(k, v) },
    remove: (k) => { memory.delete(k) }
  },
  // ctx.os door (Desktop contrib/plugin.ts): record calls instead of touching the OS
  os: {
    revealPath: async (path) => { (window.__devReveals = window.__devReveals || []).push(path); return params.get('reveal') !== 'fail' },
    writeClipboard: async (text) => { window.__devClipboard = text; return true },
    openExternal: async () => false,
    // one file per dialog like Desktop; ?pick=<path> is the "chosen" file, otherwise the user cancelled (null)
    pickOpenPath: async (options) => { (window.__devPicks = window.__devPicks || []).push(options || {}); return params.get('pick') || null }
  },
  runAction: (id) => console.info('[dev] runAction', id),
  onDispose: () => {}
}

const mod = await import('/plugin.js?t=' + Date.now())
mod.default.register(ctx)
const route = contributions.find((c) => c.area === 'routes')
window.__fc = { ctx, contributions }
// ?shell=desktop mimics Desktop's page mount: a scrolling pane with padding, the page in a `display: contents`
// wrapper, and a status bar below — the setup in which the page used to scroll (F1).
let mount = document.getElementById('root')
if (params.get('shell') === 'desktop') {
  mount.style.cssText = 'display:flex;flex-direction:column;height:100%'
  const pane = document.createElement('div')
  pane.id = '__pane'
  pane.style.cssText = 'flex:1;min-height:0;overflow:auto;padding:6px 0 4px'
  const contents = document.createElement('div')
  contents.style.display = 'contents'
  pane.appendChild(contents)
  const status = document.createElement('div')
  status.style.cssText = 'flex:none;height:26px;border-top:1px solid #333'
  mount.appendChild(pane)
  mount.appendChild(status)
  mount = contents
}
createRoot(mount).render(route ? route.render() : h('div', null, 'no route registered'))

// C4 browser probe: exercise the real double-click handler at a known canvas position.
if (params.get('quick')) {
  const openQuick = () => {
    const canvas = document.querySelector('.fc-canvas')
    if (!canvas) return setTimeout(openQuick, 100)
    const r = canvas.getBoundingClientRect()
    const adding = params.get('quick') === 'add'
    const candidates = adding ? [[0.45, 0.82]] : [[0.55, 0.35], [0.45, 0.82], [0.2, 0.8], [0.8, 0.8]]
    let point = null
    for (const [fx, fy] of candidates) {
      const clientX = Math.round(r.left + r.width * fx)
      const clientY = Math.round(r.top + r.height * fy)
      const hit = document.elementFromPoint(clientX, clientY)
      if (hit && canvas.contains(hit) && !hit.closest('[data-fc-node], .fc-zoombar')) {
        point = { clientX, clientY, target: hit }
        break
      }
    }
    if (!point) {
      diag.errors.push('quick probe found no empty canvas point')
      return
    }
    point.target.dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true, clientX: point.clientX, clientY: point.clientY, button: 0
    }))
    if (adding) {
      setTimeout(() => {
        const input = document.querySelector('.fc-quick input')
        if (!input) return
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
        setTimeout(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), 80)
      }, 150)
    }
  }
  setTimeout(openQuick, 1200)
}

// C5 browser probe: select a node the way a person does (pointerdown + pointerup on the card).
if (params.get('select_node')) {
  const want = params.get('select_node')
  const clickNode = () => {
    const el = document.querySelector(`[data-fc-node="${want}"]`)
    if (!el) return setTimeout(clickNode, 100)
    const r = el.getBoundingClientRect()
    const opts = { bubbles: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 12), pointerId: 1, isPrimary: true, button: 0 }
    el.dispatchEvent(new PointerEvent('pointerdown', opts))
    window.dispatchEvent(new PointerEvent('pointerup', opts))
    diag.selected = [...document.querySelectorAll('.fc-node.selected')].map((n) => n.dataset.fcNode)
  }
  setTimeout(clickNode, 900)
}

// F4 browser probe: open the LLM node's model dropdown and record what it lists.
if (params.get('model_picker')) {
  const open = () => {
    const btn = document.querySelector('.fc-model-btn')
    if (!btn) return setTimeout(open, 100)
    btn.click()
    setTimeout(() => {
      diag.modelPicker = {
        groups: [...document.querySelectorAll('.fc-model-head')].map((e) => e.textContent),
        items: document.querySelectorAll('.fc-model-item').length,
        labels: [...document.querySelectorAll('.fc-model-item > span:first-child')].map((e) => e.textContent),
        error: document.querySelector('.fc-model-pop .fc-bad')?.textContent || null
      }
    }, 1500)
  }
  setTimeout(open, 1200)
}

// C5 browser probe: pick another tool in the inspector's real <select> (React listens to 'change').
if (params.get('tool_swap')) {
  const swap = () => {
    const select = document.querySelector('[data-fc-inspector] .fc-tool-pick select')
    if (!select) return setTimeout(swap, 100)
    diag.toolBefore = { tool: select.value, edges: document.querySelectorAll('.fc-edge').length }
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, params.get('tool_swap'))
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }
  setTimeout(swap, 1200)
}

// C7 browser probe: keyboard shortcuts and context menus on the template flow, one step at a time.
if (params.get('edit_keys')) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const root = () => document.querySelector('.fc-root')
  const count = () => ({
    nodes: document.querySelectorAll('[data-fc-node]').length,
    edges: document.querySelectorAll('.fc-edge-hit').length,
    selected: document.querySelectorAll('.fc-node.selected').length,
    edgeSelected: document.querySelectorAll('.fc-edge.selected').length
  })
  const key = (k, mods = {}) => root()?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }))
  const menuLabels = () => [...document.querySelectorAll('.fc-menu-item')].map((el) => el.querySelector('.fc-menu-name')?.textContent)
  const menuInside = () => {
    const m = document.querySelector('.fc-menu-item')?.parentElement
    const c = document.querySelector('.fc-canvas')
    if (!m || !c) return false
    const a = m.getBoundingClientRect()
    const b = c.getBoundingClientRect()
    return a.left >= b.left && a.top >= b.top && a.right <= b.right + 1 && a.bottom <= b.bottom + 1
  }
  const clickMenu = (label) => [...document.querySelectorAll('.fc-menu-item')].find((el) => el.querySelector('.fc-menu-name')?.textContent === label)?.click()
  const nodeEl = (title) => [...document.querySelectorAll('[data-fc-node]')].find((el) => el.querySelector('.fc-node-title')?.textContent === title)
  const context = (el, x, y) => el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: Math.round(x), clientY: Math.round(y) }))
  const contextNode = (title) => {
    const el = nodeEl(title)
    const r = el?.getBoundingClientRect()
    if (r) context(el, r.left + 30, r.top + 15)
  }
  const steps = []
  const log = (label, extra = {}) => steps.push({ label, ...count(), ...extra })
  diag.editSteps = steps
  ;(async () => {
    while (document.querySelectorAll('[data-fc-node]').length < 7) await sleep(100)
    await sleep(300)
    log('start')
    key('a', { ctrlKey: true }); await sleep(150); log('ctrl+a')
    key('Escape'); await sleep(150); log('escape')
    contextNode('Idea'); await sleep(150); log('node menu', { menu: menuLabels(), inside: menuInside() })
    clickMenu('Copy'); await sleep(150); log('copy')
    key('v', { ctrlKey: true }); await sleep(150); log('ctrl+v')
    key('d', { ctrlKey: true }); await sleep(150); log('ctrl+d')
    key('Delete'); await sleep(150); log('delete')
    key('z', { ctrlKey: true }); await sleep(150); log('undo delete')
    key('z', { ctrlKey: true }); await sleep(150); log('undo duplicate')
    key('z', { ctrlKey: true }); await sleep(150); log('undo paste')
    key('y', { ctrlKey: true }); await sleep(150); log('redo paste')
    key('z', { ctrlKey: true }); await sleep(150); log('undo paste again')
    contextNode('Idea'); await sleep(150)
    clickMenu('Cut'); await sleep(150); log('cut idea')
    const canvas = document.querySelector('.fc-canvas')
    const cr = canvas.getBoundingClientRect()
    let spot = null
    for (const [fx, fy] of [[0.5, 0.85], [0.2, 0.85], [0.8, 0.85], [0.5, 0.1]]) {
      const x = cr.left + cr.width * fx
      const y = cr.top + cr.height * fy
      const hit = document.elementFromPoint(x, y)
      if (hit && canvas.contains(hit) && !hit.closest('[data-fc-node], .fc-zoombar, [data-fc-edge]')) { spot = { x, y, hit }; break }
    }
    if (spot) {
      context(spot.hit, spot.x, spot.y); await sleep(150)
      const menu = menuLabels()
      const before = new Set([...document.querySelectorAll('[data-fc-node]')].map((el) => el.dataset.fcNode))
      clickMenu('Paste here'); await sleep(200)
      const added = [...document.querySelectorAll('[data-fc-node]')].find((el) => !before.has(el.dataset.fcNode))
      const ar = added?.getBoundingClientRect()
      log('paste here', { menu, click: { x: Math.round(spot.x), y: Math.round(spot.y) }, pasted: ar ? { x: Math.round(ar.left), y: Math.round(ar.top) } : null })
    } else log('paste here', { error: 'no empty canvas spot' })
    const hitPath = document.querySelector('[data-fc-edge]')
    if (hitPath) {
      const mid = hitPath.getPointAtLength(hitPath.getTotalLength() / 2)
      const pt = new DOMPoint(mid.x, mid.y).matrixTransform(hitPath.getScreenCTM())
      context(hitPath, pt.x, pt.y); await sleep(150)
      log('edge menu', { menu: menuLabels(), inside: menuInside() })
      clickMenu('Remove connection'); await sleep(150); log('remove connection')
    } else log('edge menu', { error: 'no edge' })
    log('end')
  })().catch((err) => diag.errors.push('edit_keys: ' + (err && err.message || err)))
}

// Screenshot helper: open the context menu of a node (by title) or of the first edge (`context_menu=edge`).
if (params.get('context_menu')) {
  setTimeout(() => {
    const want = params.get('context_menu')
    let el = null
    let x = 0
    let y = 0
    if (want === 'edge') {
      el = document.querySelector('[data-fc-edge]')
      if (el) {
        const mid = el.getPointAtLength(el.getTotalLength() / 2)
        const pt = new DOMPoint(mid.x, mid.y).matrixTransform(el.getScreenCTM())
        x = pt.x
        y = pt.y
      }
    } else {
      el = [...document.querySelectorAll('[data-fc-node]')].find((n) => n.querySelector('.fc-node-title')?.textContent === want)
      if (el) {
        const r = el.getBoundingClientRect()
        x = r.left + 30
        y = r.top + 15
      }
    }
    el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: Math.round(x), clientY: Math.round(y) }))
  }, 1500)
}

// C8 browser probes. agent_sync=clean|dirty: an outside edit (REST ops, origin agent) lands on the server and
// its flow.changed event is delivered via __devEmit (probes run with events=0); dirty makes an unsaved local
// edit first. ask=1: press "Discuss in chat".
if (params.get('agent_sync')) {
  const mode = params.get('agent_sync')
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ;(async () => {
    while (document.querySelectorAll('[data-fc-node]').length < 7) await sleep(100)
    await sleep(400)
    const flowId = params.get('flow')
    if (mode === 'dirty') {
      // unsaved local edit: select "Result" like a click, then Delete (autosave is still 600 ms away)
      const el = [...document.querySelectorAll('[data-fc-node]')].find((n) => n.querySelector('.fc-node-title')?.textContent === 'Result')
      const r = el?.getBoundingClientRect()
      if (r) {
        const at = { bubbles: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 12), pointerId: 1, isPrimary: true, button: 0 }
        el.dispatchEvent(new PointerEvent('pointerdown', at))
        window.dispatchEvent(new PointerEvent('pointerup', at))
      }
      await sleep(50)
      document.querySelector('.fc-root')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
      await sleep(50)
    }
    const res = await fetch(`/api/plugins/arachne-flow/x/flows/${flowId}/ops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: 'agent', ops: [{ op: 'add_node', type: 'note', title: 'From Hermes', x: 40, y: 700 }] })
    })
    diag.agentEdit = res.status
    const body = await res.json()
    diag.agentListeners = window.__devEmit('plugin.arachne-flow.flow.changed',
      { flow_id: flowId, revision: body.flow && body.flow.revision, origin: 'agent' })
    await sleep(1500)
    diag.sync = {
      nodes: document.querySelectorAll('[data-fc-node]').length,
      titles: [...document.querySelectorAll('.fc-node-title')].map((el) => el.textContent),
      notice: document.querySelector('.fc-notice')?.textContent || null,
      banner: document.querySelector('.fc-banner')?.textContent || null
    }
  })().catch((err) => diag.errors.push('agent_sync: ' + (err && err.message || err)))
}
// U-15: a saved local edit leaves undo history behind; an agent revision must clear it, so Ctrl+Z cannot quietly
// revert Hermes' change and save that back. agent_undo=1
if (params.get('agent_undo')) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const root = () => document.querySelector('.fc-root')
  const titles = () => [...document.querySelectorAll('.fc-node-title')].map((el) => el.textContent)
  const count = () => document.querySelectorAll('[data-fc-node]').length
  const key = (k, mods = {}) => root()?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }))
  ;(async () => {
    while (count() < 7) await sleep(100)
    await sleep(400)
    const el = [...document.querySelectorAll('[data-fc-node]')].find((n) => n.querySelector('.fc-node-title')?.textContent === 'Idea')
    const r = el?.getBoundingClientRect()
    if (r) {
      const at = { bubbles: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 12), pointerId: 1, isPrimary: true, button: 0 }
      el.dispatchEvent(new PointerEvent('pointerdown', at))
      window.dispatchEvent(new PointerEvent('pointerup', at))
    }
    await sleep(80)
    key('Delete')       // a local edit that leaves an undo/redo history behind...
    await sleep(150)
    key('z', { ctrlKey: true })   // ...and is undone again, so the flow stays the one on the server
    await sleep(1300)
    const flowId = params.get('flow')
    const out = { before: count() }
    diag.undo = out
    const res = await fetch(`/api/plugins/arachne-flow/x/flows/${flowId}/ops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: 'agent', ops: [{ op: 'add_node', type: 'note', title: 'From Hermes', x: 40, y: 700 }] })
    })
    diag.agentEdit = res.status
    const body = await res.json()
    window.__devEmit('plugin.arachne-flow.flow.changed',
      { flow_id: flowId, revision: body.flow && body.flow.revision, origin: 'agent' })
    await sleep(1500)
    out.afterSync = count()
    out.titles = titles()
    out.notice = document.querySelector('.fc-notice')?.textContent || null
    key('z', { ctrlKey: true })   // must do nothing: the history was dropped with the remote revision
    await sleep(1300)             // long enough for a wrong undo to autosave
    out.afterUndo = count()
    out.titlesAfterUndo = titles()
  })().catch((err) => diag.errors.push('agent_undo: ' + (err && err.message || err)))
}

// Scheduling a flow with Hermes cron: Flows > Schedule with Hermes… -> dialog -> composer draft
if (params.get('schedule')) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ;(async () => {
    for (let i = 0; i < 80 && !document.querySelector('.fc-menu-toggle'); i++) await sleep(100)
    await sleep(300)
    const out = {}
    diag.schedule = out
    document.querySelector('.fc-menu-toggle').click(); await sleep(200)
    const item = document.querySelector('[data-fc-schedule]')
    out.menuItem = !!item
    if (!item) return
    item.click(); await sleep(200)
    out.dialog = !!document.querySelector('[aria-label="Schedule with Hermes"]')
    const when = document.querySelector('[data-fc-schedule-when]')
    if (!when) return
    // empty -> no submit, an error instead
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(when, '   ')
    when.dispatchEvent(new Event('input', { bubbles: true })); await sleep(150)
    out.emptyError = document.querySelector('[data-fc-schedule-error]')?.textContent || ''
    out.emptyDisabled = !!document.querySelector('[data-fc-schedule-submit]:disabled')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(when, 'every weekday at 8am')
    when.dispatchEvent(new Event('input', { bubbles: true })); await sleep(150)
    const fresh = document.querySelector('[data-fc-schedule-fresh]')
    fresh.click(); await sleep(150)
    if (params.get('schedule') === 'shot') return   // leave the dialog open for the screenshot
    document.querySelector('[data-fc-schedule-submit]').click(); await sleep(400)
    out.draft = window.__devDraft || null
    out.calls = window.__devDraftCalls || []
    out.notice = document.querySelector('.fc-notice')?.textContent || ''
    out.closed = !document.querySelector('[aria-label="Schedule with Hermes"]')
  })().catch((err) => diag.errors.push('schedule: ' + (err && err.message || err)))
}

if (params.get('ask')) {
  setTimeout(async () => {
    const btn = [...document.querySelectorAll('.fc-header button')].find((el) => el.textContent.trim() === 'Discuss in chat')
    btn?.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
    diag.ask = {
      button: !!btn,
      calls: window.__devDraftCalls || [],
      draft: window.__devDraft || null,
      clipboard: window.__devClipboard || null,
      notice: document.querySelector('.fc-notice')?.textContent || null
    }
  }, 1500)
}

// C6 browser probes: drive the same buttons, menu and keyboard handlers as Desktop.
const runAction = params.get('run_action')
if (runAction) {
  setTimeout(() => {
    const root = document.querySelector('.fc-root')
    const headerButton = (label) => [...document.querySelectorAll('.fc-header button')]
      .find((el) => el.textContent.trim() === label)
    if (runAction === 'fresh') headerButton('Fresh')?.click()
    else if (runAction === 'shortcut') {
      root?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    } else if (runAction === 'stop') {
      headerButton('Run')?.click()
      setTimeout(() => headerButton('Stop')?.click(), 700)
    } else if (runAction === 'partial') {
      const node = [...document.querySelectorAll('[data-fc-node]')]
        .find((el) => el.querySelector('.fc-node-title')?.textContent === 'Idea')
      if (!node) return
      const r = node.getBoundingClientRect()
      node.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, button: 2, clientX: Math.round(r.left + 30), clientY: Math.round(r.top + 15)
      }))
      setTimeout(() => {
        const item = [...document.querySelectorAll('.fc-menu-item')]
          .find((el) => el.textContent.trim() === 'Run up to here')
        item?.click()
      }, 120)
    }
  }, 1500)
}

// G1 browser probe: open the lightbox from a node-card preview (lightbox=card) or the inspector image
// (lightbox=inspector), browse with →, check the canvas ignores Delete, reveal the file, close with Esc.
// lightbox=shot only opens it (for screenshots).
if (params.get('lightbox')) {
  const mode = params.get('lightbox')
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const state = () => {
    const lb = document.querySelector('[data-fc-lightbox]')
    if (!lb) return { open: false }
    const img = lb.querySelector('.fc-lb-img')
    return {
      open: true, key: lb.dataset.fcLightbox, count: lb.querySelector('[data-fc-lb-count]')?.textContent || null,
      title: lb.querySelector('.fc-lb-title b')?.textContent || null, imgWidth: img ? img.naturalWidth : 0,
      card: lb.querySelector('.fc-lb-card b')?.textContent || null, thumbs: lb.querySelectorAll('[data-fc-lb-thumb]').length,
      buttons: [...lb.querySelectorAll('.fc-lb-bar .fc-lb-btn')].map((el) => el.textContent.trim() || el.title),
      focused: lb.contains(document.activeElement), vw: window.innerWidth, vh: window.innerHeight, nodes: document.querySelectorAll('[data-fc-node]').length, ...box(lb),
      panel: lb.querySelector('.fc-lb-panel') ? box(lb.querySelector('.fc-lb-panel')) : null,
      model3d: lb.querySelector('[data-fc-3d]')?.getAttribute('data-fc-3d') || null, model3dText: lb.querySelector('.fc-3d-msg, .fc-3d-info')?.textContent || null
    }
  }
  const key = (k) => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  ;(async () => {
    const sel = mode === 'inspector' ? '[data-fc-inspector] .fc-media img.fc-zoomable' : '.fc-node [data-fc-open-media="image"]'
    let el = null
    for (let i = 0; i < 80 && !(el = document.querySelector(sel)); i++) await sleep(100)
    if (!el) { diag.errors.push(`lightbox: nothing clickable at ${sel}`); return }
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, isPrimary: true }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, isPrimary: true }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    const steps = []
    diag.lightbox = steps
    for (let i = 0; i < 20 && !(state().imgWidth > 0); i++) await sleep(100)
    steps.push({ label: 'open', ...state() })
    if (mode === 'shot') {   // screenshot: optionally step forward (lb_next=n) and/or zoom (lb_zoom=1)
      for (let i = 0; i < Number(params.get('lb_next') || 0); i++) { key('ArrowRight'); await sleep(300) }
      if (params.get('lb_zoom')) { key('+'); key('+'); key('+') }
      return
    }
    key('ArrowRight'); await sleep(400)
    for (let i = 0; i < 30 && (!state().model3d || state().model3d === 'loading'); i++) await sleep(100)
    steps.push({ label: 'next', ...state() })
    key('Delete'); await sleep(200); steps.push({ label: 'delete', ...state() })
    ;[...document.querySelectorAll('.fc-lb-bar .fc-lb-btn')].find((x) => x.textContent.includes('Show in folder'))?.click()
    await sleep(200)
    steps.push({ label: 'reveal', reveals: (window.__devReveals || []).slice() })
    key('ArrowLeft'); await sleep(400); steps.push({ label: 'back', ...state() })
    key('Escape'); await sleep(300)
    steps.push({ label: 'closed', ...state(), rootFocused: document.activeElement === document.querySelector('.fc-root') })
  })().catch((err) => diag.errors.push('lightbox: ' + (err && err.message || err)))
}

// G11: For each / Collect after a finished run — item badges, loop icons, item tooltips, collected list
if (params.get('loop')) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const mouse = (el, kind) => el.dispatchEvent(new MouseEvent(kind, { bubbles: true, relatedTarget: kind === 'mouseout' ? document.body : null }))
  const byTitle = (t) => [...document.querySelectorAll('[data-fc-node]')].find((n) => n.querySelector('.fc-node-title')?.textContent === t)
  const tipLines = async (el, id) => {
    if (!el) return null
    mouse(el, 'mouseover'); await sleep(150)
    const t = document.querySelector(`[data-dev-tip] [data-fc-tip="${id}"]`)
    const out = t ? [...t.querySelectorAll('.fc-tt-line')].map((l) => l.textContent) : null
    mouse(el, 'mouseout'); await sleep(80)
    return out
  }
  ;(async () => {
    for (let i = 0; i < 100 && !document.querySelector('[data-fc-runchip="done"]'); i++) await sleep(100)
    await sleep(300)
    const out = {}
    diag.loop = out
    out.badges = Object.fromEntries([...document.querySelectorAll('[data-fc-node]')].map((n) =>
      [n.querySelector('.fc-node-title')?.textContent, n.querySelector('[data-fc-status]')?.textContent || '']))
    out.loopIcons = [...document.querySelectorAll('[data-fc-node] [data-fc-loop]')].map((el) =>
      el.closest('[data-fc-node]').querySelector('.fc-node-title')?.textContent).sort()
    out.result = byTitle('Result')?.querySelector('[data-fc-preview], [data-fc-open-value]')?.textContent || ''
    out.greetTip = await tipLines(byTitle('Greeting').querySelector('[data-fc-status]'), 'status-done')
    out.eachTip = await tipLines(byTitle('Each name').querySelector('[data-fc-status]'), 'status-done')
    out.loopTip = await tipLines(byTitle('Greeting').querySelector('[data-fc-loop]'), 'loop')
    out.inspector = document.querySelector('.fc-inspector')?.textContent || ''
    out.iterRows = [...document.querySelectorAll('.fc-inspector [data-fc-iter]')].map((r) => r.dataset.fcIter)
    out.palette = ['logic.foreach', 'logic.collect'].every((t) => document.querySelector(`.fc-palette [data-fc-type="${t}"]`))
  })().catch((err) => diag.errors.push('loop: ' + (err && err.message || err)))
}

// G10: If/Switch/Merge after a finished run — skipped branches, taken ports, faded wires, tips, Switch case edit
if (params.get('logic')) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const mouse = (el, kind) => el.dispatchEvent(new MouseEvent(kind, { bubbles: true, relatedTarget: kind === 'mouseout' ? document.body : null }))
  const byTitle = (t) => [...document.querySelectorAll('[data-fc-node]')].find((n) => n.querySelector('.fc-node-title')?.textContent === t)
  const tipLines = async (el, id) => {
    if (!el) return null
    mouse(el, 'mouseover'); await sleep(150)
    const t = document.querySelector(`[data-dev-tip] [data-fc-tip="${id}"]`)
    const out = t ? [...t.querySelectorAll('.fc-tt-line')].map((l) => l.textContent) : null
    mouse(el, 'mouseout'); await sleep(80)
    return out
  }
  ;(async () => {
    for (let i = 0; i < 100 && !document.querySelector('[data-fc-runchip="done"]'); i++) await sleep(100)
    await sleep(300)
    const out = {}
    diag.logic = out
    out.status = Object.fromEntries([...document.querySelectorAll('[data-fc-node]')].map((n) =>
      [n.querySelector('.fc-node-title')?.textContent, n.querySelector('[data-fc-status]')?.dataset.fcStatus || '']))
    out.reply = byTitle('Reply')?.querySelector('[data-fc-preview], [data-fc-open-value]')?.textContent || ''
    const ports = (title) => Object.fromEntries([...byTitle(title).querySelectorAll('[data-fc-side="out"]')].map((p) =>
      [p.dataset.fcPort, p.dataset.fcBranch || '']))
    out.ifPorts = ports('Is yes?')
    out.switchPorts = ports('Which colour')
    out.switchLabels = [...byTitle('Which colour').querySelectorAll('[data-fc-side="out"] .fc-port-label')].map((l) => l.textContent)
    out.deadEdges = document.querySelectorAll('.fc-edge.dead').length
    out.edges = document.querySelectorAll('.fc-edge').length
    out.skipTip = await tipLines(byTitle('Yes text').querySelector('[data-fc-status]'), 'status-skipped')
    out.ifTip = await tipLines(byTitle('Is yes?').querySelector('[data-fc-status]'), 'status-done')
    out.untakenTip = await tipLines(byTitle('Is yes?').querySelector('[data-fc-port="true"][data-fc-side="out"]'), 'port-out')
    out.logMsgs = [...document.querySelectorAll('.fc-log-row .fc-log-msg')].map((m) => [m.textContent, m.classList.contains('bad')])
    out.runChip = document.querySelector('[data-fc-runchip]')?.dataset.fcRunchip
    // inspector: edit the Switch cases -> one more output port, wires of removed cases drop
    const ta = [...document.querySelectorAll('.fc-inspector textarea')].find((t) => t.value.includes('green'))
    if (ta) {
      const set = (v) => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, v)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      }
      set('red\ngreen\nblue'); await sleep(250)
      out.afterAdd = [...byTitle('Which colour').querySelectorAll('[data-fc-side="out"]')].map((p) => p.dataset.fcPort)
      set('red'); await sleep(250)
      out.afterRemove = [...byTitle('Which colour').querySelectorAll('[data-fc-side="out"]')].map((p) => p.dataset.fcPort)
      out.edgesAfterRemove = document.querySelectorAll('.fc-edge').length
    }
    const entry = document.querySelector('.fc-palette [data-fc-type="logic.switch"]')
    out.paletteHasLogic = !!entry && !!document.querySelector('.fc-palette [data-fc-type="logic.if"]') && !!document.querySelector('.fc-palette [data-fc-type="logic.merge"]')
  })().catch((err) => diag.errors.push('logic: ' + (err && err.message || err)))
}

// G9: live clock, measured durations and the rich tooltips on status badges, errors, ports, header, run chip, palette
if (params.get('timings')) {
  const mode = params.get('timings')
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const mouse = (el, kind) => el.dispatchEvent(new MouseEvent(kind, { bubbles: true, relatedTarget: kind === 'mouseout' ? document.body : null }))
  const read = (id) => {
    const t = document.querySelector(`[data-dev-tip] [data-fc-tip="${id}"]`)
    return t ? { title: t.querySelector('.fc-tt-title')?.textContent || '', kind: t.querySelector('.fc-tt-kind')?.textContent || '',
      keys: [...t.querySelectorAll('kbd')].map((k) => k.textContent), lines: [...t.querySelectorAll('.fc-tt-line')].map((l) => l.textContent),
      foot: t.querySelector('.fc-tt-foot')?.textContent || '' } : null
  }
  const hover = async (el, id) => {
    if (!el) return null
    mouse(el, 'mouseover'); await sleep(150)
    const r = read(id)
    mouse(el, 'mouseout'); await sleep(80)
    return r
  }
  const running = () => document.querySelector('.fc-node [data-fc-status="running"]')
  const node = params.get('select')
  ;(async () => {
    for (let i = 0; i < 100 && !(running() && document.querySelector('.fc-node [data-fc-run-error]')); i++) await sleep(100)
    if (!running()) { diag.errors.push('timings: no running node'); return }
    if (mode === 'shot') { await sleep(1200); mouse(running(), 'mouseover'); return }
    const out = {}
    diag.timings = out
    out.clock1 = running().dataset.fcClock || ''
    out.badgeText = running().textContent
    await sleep(2100)
    out.clock2 = (running() && running().dataset.fcClock) || ''
    out.status = await hover(running(), 'status-running')
    out.statusTitle = running() ? running().getAttribute('title') : 'missing'
    const err = document.querySelector('.fc-node [data-fc-run-error]')
    out.error = await hover(err, 'error')
    out.errorTitle = err ? err.getAttribute('title') : 'missing'
    const portIn = document.querySelector(`[data-fc-node="${node}"] [data-fc-port="text"][data-fc-side="in"]`)
    out.port = await hover(portIn, 'port-in')
    out.portTitle = portIn ? portIn.getAttribute('title') : 'missing'
    out.portOut = await hover(document.querySelector(`[data-fc-node="${node}"] [data-fc-side="out"]`), 'port-out')
    const buttons = [...document.querySelectorAll('.fc-header button')]
    out.header = { ids: [...document.querySelectorAll('.fc-header [data-fc-header-tip]')].map((w) => w.dataset.fcHeaderTip),
      unwrapped: buttons.filter((b) => !b.parentElement.closest('[data-fc-header-tip]')).map((b) => b.textContent.trim() || b.getAttribute('aria-label')),
      titled: buttons.filter((b) => b.hasAttribute('title')).map((b) => b.getAttribute('title')),
      disabledPointer: getComputedStyle(document.querySelector('[data-fc-header-tip="undo"] button')).pointerEvents }
    out.stopTip = await hover(document.querySelector('[data-fc-header-tip="stop"]'), 'header-stop')
    out.undoTip = await hover(document.querySelector('[data-fc-header-tip="undo"]'), 'header-undo')
    out.undoDisabled = !!document.querySelector('[data-fc-header-tip="undo"] button:disabled')
    out.runClock = (document.querySelector('[data-fc-run-clock]') || {}).textContent || ''
    out.run = await hover(document.querySelector('[data-fc-runchip]'), 'run')
    const timing = document.querySelector('[data-fc-timing]')
    out.timing = timing ? [...timing.children].map((c) => c.textContent) : null
    const input = document.querySelector('.fc-palette .fc-search input')
    if (input) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'slow')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(200)
      const entry = document.querySelector('.fc-palette [data-fc-type="tool:slow_tool"]')
      if (entry) {
        mouse(entry, 'mouseover'); await sleep(150)
        out.palette = (document.querySelector('[data-fc-typetip] [data-fc-tt="typical"]') || {}).textContent || ''
        mouse(entry, 'mouseout')
      }
    }
  })()
}

// G2 browser probe: palette fold-all button, coloured section heads, rich entry tooltip (dev Tip stub renders it
// on hover), search over descriptions and ports. palette=shot expands everything and hovers the Text to 3D entry.
if (params.get('palette')) {
  const mode = params.get('palette')
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const pal = () => document.querySelector('.fc-palette')
  const fold = () => pal().querySelector('[data-fc-fold]')
  const visible = () => [...pal().querySelectorAll('[data-fc-type]')].filter((el) => !el.closest('[data-fc-recent]')).map((el) => el.dataset.fcType)
  const type = async (text) => {
    const input = pal().querySelector('.fc-search input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(200)
  }
  const mouse = (el, kind) => el.dispatchEvent(new MouseEvent(kind, { bubbles: true, relatedTarget: kind === 'mouseout' ? document.body : null }))
  ;(async () => {
    for (let i = 0; i < 80 && !document.querySelector('.fc-palette [data-fc-fold]'); i++) await sleep(100)
    if (!fold()) { diag.errors.push('palette: no fold button'); return }
    await sleep(300)
    const steps = {}
    diag.palette = steps
    steps.layout = {
      palette: rect(pal()), search: rect(pal().querySelector('.fc-search')), fold: rect(fold()), mode: fold().dataset.fcFold,
      sections: [...pal().querySelectorAll('[data-fc-section]')].map((s) => {
        const icon = s.querySelector('.fc-pal-sec-head .fc-pal-sec-icon')
        return { id: s.dataset.fcSection, icon: icon ? icon.className : null, color: icon ? getComputedStyle(icon).color : null,
          bg: getComputedStyle(s.querySelector('.fc-pal-sec-head')).backgroundColor }
      })
    }
    steps.total = Number(((pal().querySelector('.fc-palette-foot') || {}).textContent || '').match(/^(\d+)/)?.[1])
    fold().click(); await sleep(200)
    steps.expanded = { mode: fold().dataset.fcFold, items: visible().length }
    fold().click(); await sleep(200)
    steps.collapsed = { mode: fold().dataset.fcFold, items: visible().length,
      heads: [...pal().querySelectorAll('.fc-pal-sec-head')].map((el) => el.getAttribute('aria-expanded')) }
    fold().click(); await sleep(200)
    const entry = pal().querySelector('[data-fc-type="preset.text_to_3d"]')
    if (entry) { mouse(entry, 'mouseover'); await sleep(200) }
    const tip = document.querySelector('[data-fc-typetip]')
    const bubble = tip && (tip.closest('[data-dev-tip]') || tip)
    const css = (el, prop) => (el ? getComputedStyle(el)[prop] : null)
    const swatch = document.createElement('div')
    swatch.style.background = 'var(--ui-bg-elevated)'
    document.body.appendChild(swatch)
    const elevated = getComputedStyle(swatch).backgroundColor
    swatch.remove()
    steps.tip = tip ? {
      text: tip.textContent, rows: [...tip.querySelectorAll('[data-fc-tt]')].map((r) => r.dataset.fcTt),
      dots: tip.querySelectorAll('.fc-tt-dot').length, title: entry.getAttribute('title'),
      bubble: rect(bubble), vw: innerWidth, vh: innerHeight, entry: rect(entry),
      look: { bg: css(bubble, 'backgroundColor'), elevated, radius: css(bubble, 'borderRadius'), padding: css(bubble, 'padding'),
        overflow: css(bubble, 'overflow'), arrow: (() => {
          const a = bubble.querySelector('[data-slot="tooltip-arrow"]')
          return a ? { ...rect(a), fill: css(a, 'fill') } : null
        })(), head: css(tip.querySelector('.fc-tt-head'), 'backgroundColor'),
        icon: !!tip.querySelector('.fc-tt-head .fc-node-icon .codicon'), titleColor: css(tip.querySelector('.fc-tt-title'), 'color'),
        bubbleColor: css(bubble, 'color') }
    } : null
    if (mode === 'shot') return
    if (entry) { mouse(entry, 'mouseout'); await sleep(150) }
    steps.tipGone = !document.querySelector('[data-fc-typetip]')
    await type('model3d')
    steps.port = { items: visible(), active: pal().querySelector('.fc-item.active')?.dataset.fcType || null, foldDisabled: fold().disabled }
    await type('polls')
    steps.desc = { items: visible() }
    await type('image')
    steps.image = { active: pal().querySelector('.fc-item.active .fc-item-name')?.textContent || null, items: visible().length }
    await type('')
    steps.cleared = { items: visible().length, foldDisabled: fold().disabled }
  })().catch((err) => diag.errors.push('palette: ' + (err && err.message || err)))
}

// G3 browser probe: drop files on the canvas (png + txt + exe), check upload, File nodes and their previews, then
// Browse… (stubbed ctx.os.pickOpenPath, ?pick=<path>) and "Add another file". files=shot stops after the drop.
if (params.get('files')) {
  const mode = params.get('files')
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const nodes = () => [...document.querySelectorAll('[data-fc-node]')]
  const nodeBy = (title) => nodes().find((n) => n.querySelector('.fc-node-title')?.textContent === title)
  const preview = (n) => {
    const el = n && n.querySelector('[data-fc-file-preview]')
    return el ? { kind: el.dataset.fcFilePreview, img: el.querySelector('img')?.getAttribute('src')?.length || 0, text: el.textContent } : null
  }
  ;(async () => {
    while (nodes().length < 7) await sleep(100)
    await sleep(400)
    const steps = {}
    diag.files = steps
    const canvas = document.querySelector('.fc-canvas')
    const png = await new Promise((resolve) => {
      const c = document.createElement('canvas')
      c.width = 240; c.height = 160
      const g = c.getContext('2d')
      g.fillStyle = '#d04a3a'; g.fillRect(0, 0, 240, 160)
      g.fillStyle = '#ffffff'; g.fillRect(60, 40, 120, 80)
      c.toBlob(resolve, 'image/png')
    })
    const dt = new DataTransfer()
    dt.items.add(new File([png], 'drop-red.png', { type: 'image/png' }))
    dt.items.add(new File(['hello from a dropped note'], 'notes.txt', { type: 'text/plain' }))
    dt.items.add(new File(['MZ'], 'tool.exe', { type: 'application/octet-stream' }))
    // below and left of everything on screen, so the new nodes overlap nothing
    const rs = nodes().map((n) => n.getBoundingClientRect())
    const at = { bubbles: true, cancelable: true, dataTransfer: dt,
      clientX: Math.round(Math.min(...rs.map((r) => r.left)) + 130), clientY: Math.round(Math.max(...rs.map((r) => r.bottom)) + 60) }
    canvas.dispatchEvent(new DragEvent('dragover', at))
    await sleep(60)
    steps.over = { cls: canvas.classList.contains('file-over'), hint: !!document.querySelector('[data-fc-drop-hint]') }
    canvas.dispatchEvent(new DragEvent('drop', at))
    await sleep(30)
    steps.busy = document.querySelector('[data-fc-uploading]')?.dataset.fcUploading || null
    for (let i = 0; i < 80 && nodes().length < 9; i++) await sleep(100)
    for (let i = 0; i < 40 && !(preview(nodeBy('drop-red.png')) || {}).img; i++) await sleep(100)
    const red = nodeBy('drop-red.png')
    const txt = nodeBy('notes.txt')
    steps.dropped = {
      nodes: nodes().length, red: preview(red), txt: preview(txt), notice: document.querySelector('.fc-notice')?.textContent || null,
      overAfter: canvas.classList.contains('file-over'), busyAfter: !!document.querySelector('[data-fc-uploading]'),
      selected: document.querySelectorAll('.fc-node.selected').length, rects: [rect(red), rect(txt)]
    }
    if (mode === 'shot') return
    const r = red.getBoundingClientRect()
    const down = { bubbles: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 12), pointerId: 1, isPrimary: true, button: 0 }
    red.dispatchEvent(new PointerEvent('pointerdown', down))
    window.dispatchEvent(new PointerEvent('pointerup', down))
    await sleep(300)
    const browse = document.querySelector('[data-fc-inspector] [data-fc-browse]')
    steps.inspector = { node: document.querySelector('[data-fc-inspector]')?.dataset.fcInspector || null, browse: !!browse,
      addFile: !!document.querySelector('[data-fc-inspector] [data-fc-add-file]') }
    const before = (preview(red) || {}).img
    browse?.click()
    await sleep(300)
    steps.browsed = {
      value: document.querySelector('[data-fc-inspector] .fc-browse input')?.value || null,
      picks: (window.__devPicks || []).map((p) => ({ title: p.title, filters: (p.filters || []).map((f) => f.name) }))
    }
    document.querySelector('[data-fc-inspector] [data-fc-add-file]')?.click()
    for (let i = 0; i < 40 && nodes().length < 10; i++) await sleep(100)
    const pickName = (params.get('pick') || '').split(/[\\/]/).pop()
    for (let i = 0; i < 40 && !((preview(nodeBy(pickName)) || {}).img && (preview(red) || {}).img !== before); i++) await sleep(100)
    steps.added = {
      nodes: nodes().length, pickName, redRect: rect(red), pickedRect: rect(nodeBy(pickName)), zoom: document.querySelector('.fc-zoomval')?.textContent,
      picked: preview(nodeBy(pickName)), red: preview(red), redChanged: (preview(red) || {}).img !== before,
      pickedBelowRed: rect(nodeBy(pickName)) && rect(red) ? rect(nodeBy(pickName)).y >= rect(red).y + rect(red).h : null
    }
  })().catch((err) => diag.errors.push('files: ' + (err && err.message || err)))
}

// G4 browser probe. popin=1: this page found a hand-off — did it take it and open that flow as its own window?
if (params.get('popin')) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ;(async () => {
    for (let i = 0; i < 80 && document.querySelectorAll('[data-fc-node]').length < 7; i++) await sleep(100)
    await sleep(300)
    const out = { nodes: document.querySelectorAll('[data-fc-node]').length, button: !!document.querySelector('[data-fc-popout]'),
      handoffBefore: memory.has('popout') ? memory.get('popout') : null, navigated: (window.__devNavigated || []).slice() }
    diag.popout = out
    if (params.get('popin')) {
      out.flowName = document.querySelector('.fc-title-input')?.value || null
      const root = document.querySelector('.fc-root')
      const head = document.querySelector('.fc-header')
      const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
      const run = [...head.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Run')
      out.focus = {
        flag: root.dataset.fcFocusWindow || null, root: box(root), vw: innerWidth, vh: innerHeight,
        padRight: getComputedStyle(head).paddingRight, drag: getComputedStyle(head).getPropertyValue('-webkit-app-region') || getComputedStyle(head).getPropertyValue('app-region'),
        runDrag: run ? (getComputedStyle(run).getPropertyValue('-webkit-app-region') || getComputedStyle(run).getPropertyValue('app-region')) : null,
        runRight: run ? Math.round(run.getBoundingClientRect().right) : null, unfocus: !!head.querySelector('[data-fc-unfocus]'),
        session: sessionStorage.getItem('hermes.plugin.arachne-flow.focusWindow')
      }
      if (params.get('popin') === 'shot') return
      head.querySelector('[data-fc-unfocus]')?.click()
      await sleep(400)
      out.after = { flag: document.querySelector('.fc-root').dataset.fcFocusWindow || null, root: box(document.querySelector('.fc-root')),
        session: sessionStorage.getItem('hermes.plugin.arachne-flow.focusWindow') }
    }
  })().catch((err) => diag.errors.push('popout: ' + (err && err.message || err)))
}

// G6 browser probe: current model + provider groups -> repaired new flow -> selected model on an existing flow
// (undoable) -> two failed answers leave the prompt and selected model intact. generate=shot stops before building.
if (params.get('generate')) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const $ = (s) => document.querySelector(s)
  const until = async (fn, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) {
      const value = fn()
      if (value) return value
      await sleep(100)
    }
    return null
  }
  const setValue = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const openHeader = async () => {
    [...document.querySelectorAll('.fc-header button')].find((b) => b.textContent.trim() === 'Build with Hermes')?.click()
    return until(() => $('[data-fc-generate-dialog] [data-fc-generate-prompt]'))
  }
  ;(async () => {
    const out = {}
    diag.generate = out
    const welcome = await until(() => $('.fc-welcome [data-fc-generate-prompt]'))
    if (!welcome) throw new Error('no generate composer on the welcome canvas')
    const picker = $('.fc-welcome [data-fc-model-picker] .fc-model-btn')
    await until(() => picker.textContent.includes('deepseek/deepseek-v4.1-flash-1017:thinking'))
    out.current = picker.textContent
    picker.click()
    await until(() => $('.fc-welcome [data-fc-model-picker] [data-fc-provider]'))
    out.groups = [...document.querySelectorAll('.fc-welcome [data-fc-provider]')].map((el) => el.dataset.fcProvider)
    out.models = document.querySelectorAll('.fc-welcome [data-fc-model]').length
    picker.click()
    setValue(welcome, 'Make a text preview')
    out.before = { prompt: welcome.value, disabled: $('[data-fc-generate-submit]').disabled }
    if (params.get('generate') === 'shot') return
    $('[data-fc-generate-submit]').click()
    await until(() => document.querySelectorAll('[data-fc-node]').length === 2)
    await until(() => !$('[data-fc-generate]'))
    out.created = {
      title: $('.fc-title-input')?.value, nodes: document.querySelectorAll('[data-fc-node]').length,
      edges: document.querySelectorAll('.fc-edge').length, notice: $('.fc-notice')?.textContent,
      request: (diag.generateRequests || [])[0]
    }
    const edit = await openHeader()
    if (!edit) throw new Error('header did not open the generate dialog')
    const editPicker = $('[data-fc-generate-dialog] .fc-model-btn')
    editPicker.click()
    const picked = await until(() => $('[data-fc-generate-dialog] [data-fc-model="z-ai/glm-5.3-flash"]'))
    picked?.click()
    setValue(edit, 'Add a note')
    $('[data-fc-generate-dialog] [data-fc-generate-submit]').click()
    await until(() => document.querySelectorAll('[data-fc-node]').length === 3)
    await until(() => !$('[data-fc-generate-dialog]'))
    out.updated = {
      nodes: document.querySelectorAll('[data-fc-node]').length,
      titles: [...document.querySelectorAll('.fc-node-title')].map((el) => el.textContent),
      notice: $('.fc-notice')?.textContent, request: (diag.generateRequests || [])[1]
    }
    $('.fc-root').dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    await until(() => document.querySelectorAll('[data-fc-node]').length === 2)
    out.undo = { nodes: document.querySelectorAll('[data-fc-node]').length }
    const failing = await openHeader()
    setValue(failing, 'fail')
    $('[data-fc-generate-dialog] [data-fc-generate-submit]').click()
    const error = await until(() => $('[data-fc-generate-error]'))
    out.failure = {
      error: error?.textContent, prompt: $('[data-fc-generate-dialog] [data-fc-generate-prompt]')?.value,
      open: !!$('[data-fc-generate-dialog]'), busy: !!$('[data-fc-generate-dialog] [data-fc-generate-submit]')?.disabled
    }
    out.serverCalls = await fetch('/dev/generate-calls').then((res) => res.json())
    $('[data-fc-generate-dialog] .fc-row .fc-btn:not(.primary)')?.click()
    if (!$('.fc-menu')) $('.fc-menu-toggle')?.click()  // the toggle closes an open menu
    const blankItem = await until(() => [...document.querySelectorAll('.fc-menu-item')].find((el) => el.textContent.trim() === 'New blank flow'))
    blankItem?.click()
    const blank = await until(() => $('.fc-canvas [data-fc-generate-prompt]'))
    const canvasEl = blank ? blank.closest('.fc-canvas') : null
    const box = blank?.getBoundingClientRect()
    out.blank = {
      ready: !!blank, prompt: blank?.value,
      hitTest: !!(blank && document.elementFromPoint(box.x + box.width / 2, box.y + Math.min(30, box.height / 2)) === blank),
      box: box ? { x: box.x + box.width / 2, y: box.y + Math.min(30, box.height / 2) } : null
    }
    if (blank) {
      // Scope the menus to the composer's own canvas: `.fc-menu-item` alone also matches the header flow menu.
      const canvasMenu = () => (canvasEl ? canvasEl.querySelector('.fc-menu.fc-ctx') : null)
      const at = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + Math.min(30, box.height / 2)) }
      const pointer = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true, clientX: at.x, clientY: at.y })
      blank.dispatchEvent(pointer)
      out.blank.pointerPrevented = pointer.defaultPrevented
      out.blank.focusedAfterPointer = document.activeElement === blank
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true, clientX: at.x, clientY: at.y }))
      setValue(blank, 'Draft on the blank canvas')
      await sleep(60)
      out.blank.prompt = blank.value
      const dbl = new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0, clientX: at.x, clientY: at.y })
      blank.dispatchEvent(dbl)
      await sleep(60)
      out.blank.dblclickPrevented = dbl.defaultPrevented
      out.blank.quickSearch = !!$('.fc-canvas .fc-quick')
      const ctx = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: at.x, clientY: at.y })
      blank.dispatchEvent(ctx)
      await sleep(60)
      const menu = canvasMenu()
      out.blank.contextMenuPrevented = ctx.defaultPrevented
      out.blank.contextMenu = !!menu
      out.blank.menuInCanvas = !!(menu && canvasEl && canvasEl.contains(menu))
      out.blank.contextMenuItems = menu ? [...menu.querySelectorAll('.fc-menu-name')].map((el) => el.textContent) : []
    }
  })().catch((err) => diag.errors.push('generate: ' + (err && err.message || err)))
}

// G5 browser probe: Save as template… (dialog, clear inputs) → Your templates in the menu → edit → new flow from it
// → delete (two clicks). templates=shot stops with the filled save dialog open.
if (params.get('templates')) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const $ = (s) => document.querySelector(s)
  const setValue = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const until = async (fn, ms = 4000) => {
    for (let t = 0; t < ms; t += 100) {
      const v = fn()
      if (v) return v
      await sleep(100)
    }
    return null
  }
  const openMenu = async () => {
    if (!$('.fc-menu')) $('.fc-menu-toggle').click()
    return until(() => $('.fc-menu'))
  }
  const menuState = () => ({
    labels: [...document.querySelectorAll('.fc-menu .fc-menu-label')].map((e) => e.textContent),
    own: [...document.querySelectorAll('.fc-menu [data-fc-template^="u-"]')].map((e) => ({ id: e.dataset.fcTemplate, text: e.querySelector('.fc-menu-name').textContent }))
  })
  ;(async () => {
    const out = {}
    diag.templates = out
    await until(() => document.querySelectorAll('[data-fc-node]').length >= 7, 8000)
    await openMenu()
    out.saveItem = !!$('[data-fc-save-template]')
    $('[data-fc-save-template]').click()
    const dlg = await until(() => $('[data-fc-template-dialog="save"]'))
    out.dialog = {
      open: !!dlg, menuClosed: !$('.fc-menu'), name: $('#fc-tpl-name')?.value, focused: document.activeElement === $('#fc-tpl-name'),
      clearLabel: $('[data-fc-clear-inputs]')?.closest('label')?.textContent, clearEnabled: !$('[data-fc-clear-inputs]')?.disabled
    }
    setValue($('#fc-tpl-name'), 'My 3D pipeline')
    setValue($('#fc-tpl-desc'), 'Idea to image to 3D, my settings.')
    $('[data-fc-clear-inputs]').click()
    // Delete inside the dialog must not delete canvas nodes
    const before = document.querySelectorAll('[data-fc-node]').length
    $('#fc-tpl-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    await sleep(150)
    out.dialog.nodesAfterDelete = document.querySelectorAll('[data-fc-node]').length === before
    if (params.get('templates') === 'shot') return
    $('[data-fc-template-submit]').click()
    out.saved = { closed: !!(await until(() => !$('[data-fc-template-dialog]'))), notice: (await until(() => $('.fc-notice')))?.textContent || null }
    await openMenu()
    out.menuAfterSave = menuState()
    const id = (out.menuAfterSave.own[0] || {}).id
    $(`[data-fc-template-edit="${id}"]`)?.click()
    const edit = await until(() => $('[data-fc-template-dialog="edit"]'))
    out.edit = { open: !!edit, name: $('#fc-tpl-name')?.value, desc: $('#fc-tpl-desc')?.value, noClear: !$('[data-fc-clear-inputs]') }
    if (edit) {
      setValue($('#fc-tpl-name'), 'My 3D pipeline v2')
      $('[data-fc-template-submit]').click()
      await until(() => !$('[data-fc-template-dialog]'))
    }
    await sleep(300)
    await openMenu()
    out.menuAfterEdit = menuState()
    $(`[data-fc-template="${id}"]`)?.click()
    await until(() => $('.fc-title-input')?.value === 'My 3D pipeline v2', 5000)
    await until(() => document.querySelectorAll('[data-fc-node]').length >= 7)
    await sleep(300)
    const idea = [...document.querySelectorAll('[data-fc-node]')].find((n) => n.querySelector('.fc-node-title')?.textContent === 'Idea')
    out.created = { title: $('.fc-title-input')?.value, nodes: document.querySelectorAll('[data-fc-node]').length,
      ideaText: idea ? idea.textContent : null }
    await openMenu()
    $(`[data-fc-template-delete="${id}"]`)?.click()
    await sleep(150)
    out.armed = $(`[data-fc-template="${id}"] .fc-menu-name`)?.textContent || null
    $(`[data-fc-template-delete="${id}"]`)?.click()
    await sleep(600)
    await openMenu()
    out.menuAfterDelete = menuState()
    out.id = id
  })().catch((err) => diag.errors.push('templates: ' + (err && err.message || err)))
}

// G8: two wired images + Browse… in the preset's own media list, then a real dev run.
if (params.get('media_inputs')) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (fn, ms = 12000) => {
    for (let t = 0; t < ms; t += 100) {
      const value = fn()
      if (value) return value
      await sleep(100)
    }
    return null
  }
  ;(async () => {
    const out = {}
    diag.mediaInputs = out
    const field = () => document.querySelector('[data-fc-media="image"]')
    await until(field)
    out.initial = { count: field()?.dataset.fcMediaCount || null,
      wired: field()?.querySelector('.fc-linked')?.textContent || null,
      browse: !!document.querySelector('[data-fc-media-browse="image"]') }
    document.querySelector('[data-fc-media-browse="image"]')?.click()
    await until(() => field()?.dataset.fcMediaCount === '1')
    out.afterBrowse = { count: field()?.dataset.fcMediaCount || null,
      value: field()?.querySelector('[data-fc-media-item="0"] input')?.value || null,
      picks: (window.__devPicks || []).map((p) => ({ title: p.title, filters: (p.filters || []).map((f) => f.name) })) }
    if (params.get('media_inputs') !== 'shot') {
      const run = [...document.querySelectorAll('[data-fc-inspector] button')].find((b) => b.textContent.includes('Run up to here'))
      run?.click()
      await sleep(500)
      out.run = { result: document.querySelector('[data-fc-inspector] .fc-chip-name')?.textContent || null,
        error: document.querySelector('[data-fc-inspector] .fc-node-error')?.textContent || null }
      document.querySelector('[data-fc-media-remove="0"]')?.click()
      await sleep(200)
      out.afterRemove = field()?.dataset.fcMediaCount || null
    }
  })().catch((err) => diag.errors.push('media_inputs: ' + (err && err.message || err)))
}

// G7c: the LLM node shows what Hermes and the provider's own catalog know about the chosen model.
if (params.get('llm_info')) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (fn, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) {
      const value = fn()
      if (value) return value
      await sleep(100)
    }
    return null
  }
  ;(async () => {
    const out = {}
    diag.llmInfo = out
    await until(() => document.querySelector('[data-fc-llm-info]'))
    out.model = document.querySelector('[data-fc-llm-info]')?.dataset.fcLlmInfo || null
    out.rows = [...document.querySelectorAll('[data-fc-llm-info] .fc-info-row')].map((el) => el.textContent)
    out.pill = document.querySelector('[data-fc-inspector] [data-fc-cost]')?.dataset.fcCost || null
    const max = document.querySelector('[data-fc-field="max_tokens"]')
    out.maxHint = max?.querySelector('.fc-range')?.textContent || null
    const picker = document.querySelector('[data-fc-inspector] [data-fc-model-picker] .fc-model-btn')
    picker?.click()
    await until(() => document.querySelectorAll('[data-fc-model]').length)
    out.pickerPrice = document.querySelector('[data-fc-model="z-ai/glm-5.3-flash"] .fc-model-prov')?.textContent || null
    out.pickerTitle = document.querySelector('[data-fc-model="z-ai/glm-5.3-flash"]')?.title || null
    picker?.click()
  })().catch((err) => diag.errors.push('llm_info: ' + (err && err.message || err)))
}

// G7 browser probe: choices and cost follow the chosen model (fake lists = live NanoGPT rows in tests/fixtures).
if (params.get('model_settings')) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const $ = (s) => document.querySelector(s)
  const until = async (fn, ms = 6000) => {
    for (let t = 0; t < ms; t += 100) {
      const value = fn()
      if (value) return value
      await sleep(100)
    }
    return null
  }
  const field = (name) => $(`[data-fc-inspector] [data-fc-field="${name}"]`)
  const chips = () => Object.fromEntries([...document.querySelectorAll('[data-fc-node]')]
    .map((el) => [el.querySelector('.fc-node-title')?.textContent, el.querySelector('[data-fc-node-cost]')?.dataset.fcNodeCost || null]))
  const costLabel = () => $('[data-fc-inspector] [data-fc-cost]')?.dataset.fcCost || null
  const state = () => ({
    sizeChoices: field('size')?.querySelector('select')?.dataset.fcChoices || null,
    sizeOptions: [...(field('size')?.querySelectorAll('option') || [])].map((o) => o.textContent),
    sizeValue: field('size')?.querySelector('select')?.value ?? null,
    nRange: field('n')?.querySelector('.fc-range')?.textContent || null,
    nBad: field('n')?.querySelector('.fc-bad')?.textContent || null,
    resolution: field('resolution') ? (field('resolution').querySelector('select') ? 'select' : 'text') : null,
    aspect: field('aspect_ratio')?.querySelector('select')?.dataset.fcChoices || null,
    cost: costLabel(), chips: chips()
  })
  const setInput = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const setSelect = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  ;(async () => {
    const out = {}
    diag.modelSettings = out
    await until(() => field('size')?.querySelector('select[data-fc-choices="model"]') && costLabel())
    out.start = state()
    out.start.toolFit = toolFit($('[data-fc-inspector]'))
    const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom } }
    out.pills = [...document.querySelectorAll('[data-fc-node]')].filter((el) => el.querySelector('.fc-node-cost')).map((el) => {
      const pill = el.querySelector('.fc-node-cost')
      return { title: el.querySelector('.fc-node-title').textContent, pill: box(pill), name: box(el.querySelector('.fc-node-title')),
        head: box(el.querySelector('.fc-node-head')), font: getComputedStyle(pill).fontSize, color: getComputedStyle(pill).color,
        clipped: pill.scrollWidth > pill.clientWidth }
    })
    if (params.get('model_settings') === 'shot') return
    setInput(field('n').querySelector('input'), '2')
    await until(() => costLabel() === '≈ $0.24')
    out.afterN = state()
    setSelect(field('size').querySelector('select'), '1k')
    await until(() => costLabel() === '≈ $0.04')
    out.afterSize = state()
    const vid = [...document.querySelectorAll('[data-fc-node]')].find((el) => el.querySelector('.fc-node-title')?.textContent === 'Video')
    const r = vid.getBoundingClientRect()
    const opts = { bubbles: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 12), pointerId: 1, isPrimary: true, button: 0 }
    vid.dispatchEvent(new PointerEvent('pointerdown', opts))
    window.dispatchEvent(new PointerEvent('pointerup', opts))
    await until(() => field('duration')?.querySelector('select[data-fc-choices="model"]'))
    const dur = field('duration')
    out.video = {
      durationOptions: [...(dur?.querySelectorAll('option') || [])].map((o) => o.textContent),
      cost: costLabel(), more: $('[data-fc-inspector] .fc-more-btn')?.textContent || null
    }
    setSelect(dur.querySelector('select'), '10')
    await until(() => costLabel() === '≈ $0.40')
    out.video.after = { cost: costLabel(), chips: chips() }
    out.video.extras = [...document.querySelectorAll('[data-fc-inspector] .fc-extra [data-fc-field]')].map((el) => el.dataset.fcField)
    // G7b: the screenshot case — Image to 3D with Meshy shows every setting the model lists, as real controls
    const m3d = [...document.querySelectorAll('[data-fc-node]')].find((el) => el.querySelector('.fc-node-title')?.textContent === '3D')
    const r3 = m3d.getBoundingClientRect()
    const o3 = { bubbles: true, clientX: Math.round(r3.left + 20), clientY: Math.round(r3.top + 12), pointerId: 1, isPrimary: true, button: 0 }
    m3d.dispatchEvent(new PointerEvent('pointerdown', o3))
    window.dispatchEvent(new PointerEvent('pointerup', o3))
    await until(() => $('[data-fc-inspector] [data-fc-extras]'))
    const xf = (name) => $(`[data-fc-inspector] .fc-extra [data-fc-field="${name}"]`)
    out.meshy = {
      count: $('[data-fc-inspector] [data-fc-extras]')?.dataset.fcExtras || null,
      head: $('[data-fc-inspector] .fc-subhead')?.textContent || null,
      fields: [...document.querySelectorAll('[data-fc-inspector] .fc-extra [data-fc-field]')].map((el) => el.dataset.fcField),
      geometry: [...(xf('geometry_resolution')?.querySelectorAll('option') || [])].map((o) => o.textContent),
      pbr: xf('enable_pbr')?.querySelector('.fc-check')?.textContent || null,
      polyRange: xf('target_polycount')?.querySelector('.fc-range')?.textContent || null,
      textInputs: xf('texture_prompt')?.querySelectorAll('input').length || 0,
      cost: costLabel(), more: $('[data-fc-inspector] .fc-more-btn')?.textContent || null,
      // pixel check: every model-setting control stays inside the inspector; the heading is not cut
      overflow: (() => {
        const insp = $('[data-fc-inspector]').getBoundingClientRect()
        return [...document.querySelectorAll('[data-fc-inspector] .fc-extra [data-fc-field]')].filter((el) => {
          const c = el.querySelector('input, select, textarea, .fc-check')
          const r = c ? c.getBoundingClientRect() : null
          return !r || r.left < insp.left || r.right > insp.right - 4 || (c.tagName === 'SELECT' && c.scrollWidth > c.clientWidth + 1)
        }).map((el) => el.dataset.fcField)
      })(),
      headCut: (() => { const s = $('[data-fc-inspector] .fc-subhead > span'); return s ? s.scrollWidth > s.clientWidth : null })()
    }
    setSelect(xf('geometry_resolution').querySelector('select'), '2k')
    await sleep(400)
    out.meshy.after = { geometry: xf('geometry_resolution')?.querySelector('select')?.value || null }
    if (params.get('model_settings') === 'shot3d') return
  })().catch((err) => diag.errors.push('model_settings: ' + (err && err.message || err)))
}
