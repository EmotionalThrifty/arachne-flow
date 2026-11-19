// ---------------------------------------------------------------- canvas
/** Current rendered card bounds in world pixels. Client rectangles would shrink when the canvas is zoomed out. */
function measureNodeSizes(root, flow) {
  const known = new Set((flow?.nodes || []).map((n) => n.id))
  return Object.fromEntries([...root?.querySelectorAll('[data-fc-node]') || []].flatMap((el) => {
    const id = el.dataset.fcNode, width = el.offsetWidth, height = el.offsetHeight
    return known.has(id) && [width, height].every((v) => Number.isFinite(v) && v > 0 && v <= 100000)
      ? [[id, { width, height }]] : []
  }))
}
function Canvas(p) {
  const { flow, types, layouts, run, view, setView } = p
  const ref = useRef(null)
  const live = useRef({})
  live.current = { flow, layouts, view, selection: p.selection, types, connectedIn: p.connectedIn }
  // U-4: node cards are memoized, so the callbacks they hold are created once and read the props of the frame
  // they run in. Anything a card is given must keep its identity across a pan or another node's status update.
  const props = useRef(p)
  props.current = p
  const stable = useRef(null)
  if (!stable.current) {
    const call = (name) => (...args) => {
      const fn = props.current[name]
      return typeof fn === 'function' ? fn(...args) : undefined
    }
    stable.current = {
      nameOf: call('nameOf'),
      onToggleExpand: call('onToggleExpand'),
      onOpenInspector: call('onOpenInspector'),
      onOpenMedia: call('onOpenMedia'),
      onOpenValue: call('onOpenValue')
    }
  }
  // One document update per animation frame while nodes are dragged; `up` flushes the last one before the
  // undo step, so a drag still commits its final position and stays a single undo entry.
  const moveRef = useRef(null)
  if (!moveRef.current) moveRef.current = rafThrottle((pos) => props.current.onMove(pos))
  const dragRef = useRef(null)
  const spaceRef = useRef(false)
  const [wire, setWire] = useState(null)
  useWireTipGuard(wire, ref)
  const [rect, setRect] = useState(null)
  const [panning, setPanning] = useState(false)
  const [space, setSpace] = useState(false)
  const [menu, setMenu] = useState(null)
  const [quick, setQuick] = useState(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hoverNode, setHoverNode] = useState(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const update = () => {
      const s = { w: el.clientWidth, h: el.clientHeight }
      if (p.sizeRef) p.sizeRef.current = s
      setSize(s)
    }
    update()
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(update)
      ro.observe(el)
      return () => ro.disconnect()
    }
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  const fit = () => {
    const el = ref.current
    const f = live.current.flow
    if (!el || !f) return
    const rects = f.nodes.map((n) => ({ x: n.x, y: n.y, w: NODE_W, h: p.heightsRef.current[n.id] || 110 }))
    setView(fitView(rects, el.clientWidth, el.clientHeight))
  }
  if (p.fitRef) p.fitRef.current = fit

  useLayoutEffect(() => {
    if (p.needFitRef.current && size.w > 0 && size.h > 0) {
      p.needFitRef.current = false
      fit()
    }
  })

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const onWheel = (e) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const pt = { x: e.clientX - r.left, y: e.clientY - r.top }
      if (e.shiftKey && !e.ctrlKey) {
        setView((v) => ({ ...v, x: v.x - (e.deltaY || e.deltaX) }))
        return
      }
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0016))
      setView((v) => zoomAt(v, factor, pt))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setView])

  // Space held = pan mode (like most canvas tools)
  useEffect(() => {
    const down = (e) => {
      if (e.code !== 'Space' || !spacePans(e.target, ref.current)) return
      e.preventDefault()
      if (!spaceRef.current) {
        spaceRef.current = true
        setSpace(true)
      }
    }
    const up = (e) => {
      if (e.code !== 'Space') return
      spaceRef.current = false
      setSpace(false)
    }
    const blur = () => {
      spaceRef.current = false
      setSpace(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const local = useCallback((e) => {
    const r = ref.current.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }, [])

  const wireOk = (from, blocked, nodeId, portName) => {
    if (!from || nodeId === from.node || (blocked && blocked.has(nodeId))) return false
    const lay = live.current.layouts[nodeId]
    if (!lay) return false
    const list = from.side === 'out' ? lay.allInputs : lay.outputs
    const pt = list.find((q) => q.name === portName)
    if (!pt) return false
    const compat = live.current.types.compat
    return from.side === 'out' ? compatible(compat, from.type, pt.type) : compatible(compat, pt.type, from.type)
  }

  const targetAt = (x, y, from, blocked) => {
    const el = document.elementFromPoint(x, y)
    if (!el || !ref.current || !ref.current.contains(el)) return null
    const wantSide = from.side === 'out' ? 'in' : 'out'
    const portEl = el.closest('[data-fc-port]')
    if (portEl) {
      if (portEl.getAttribute('data-fc-side') !== wantSide) return null
      const node = portEl.getAttribute('data-fc-owner')
      const port = portEl.getAttribute('data-fc-port')
      return wireOk(from, blocked, node, port) ? { node, port } : null
    }
    const card = el.closest('[data-fc-node]')
    if (!card) return null
    const node = card.getAttribute('data-fc-node')
    const lay = live.current.layouts[node]
    if (!lay) return null
    const list = wantSide === 'in' ? lay.allInputs : lay.outputs
    const ok = list.filter((q) => wireOk(from, blocked, node, q.name))
    if (!ok.length) return null
    const taken = live.current.connectedIn[node] || EMPTY_SET
    const best = wantSide === 'in' ? ok.find((q) => !taken.has(q.name)) || ok[0] : ok[0]
    return { node, port: best.name }
  }

  // window listeners for drags: created once, dispatch to the latest handlers
  const handlers = useRef({})
  const listeners = useRef(null)
  if (!listeners.current) {
    const move = (e) => handlers.current.move(e)
    const up = (e) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      handlers.current.up(e)
    }
    listeners.current = { move, up }
  }
  const detach = useCallback(() => {
    window.removeEventListener('pointermove', listeners.current.move)
    window.removeEventListener('pointerup', listeners.current.up)
    window.removeEventListener('pointercancel', listeners.current.up)
  }, [])
  const begin = useCallback((kind, e, data) => {
    detach()
    dragRef.current = { kind, sx: e.clientX, sy: e.clientY, moved: false, ...data }
    // Capture the pointer so a drag keeps reporting after the cursor leaves the canvas or the node it started on
    // (U-18: without it the drag only ends on the next click over the element).
    try {
      if (e.currentTarget && typeof e.currentTarget.setPointerCapture === 'function') e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* no capture (old browser, stale pointerId): the window listeners below still drive the drag */
    }
    window.addEventListener('pointermove', listeners.current.move)
    window.addEventListener('pointerup', listeners.current.up)
    window.addEventListener('pointercancel', listeners.current.up)
  }, [detach])
  // on unmount: drop the window listeners and any move that has not reached a frame yet
  useEffect(() => () => {
    detach()
    moveRef.current.cancel()
  }, [detach])

  handlers.current.move = (e) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (!d.moved) {
      if (Math.abs(dx) + Math.abs(dy) < 4) return
      d.moved = true
      if (d.kind === 'pan') setPanning(true)
    }
    if (d.kind === 'pan') setView({ ...d.view0, x: d.view0.x + dx, y: d.view0.y + dy })
    else if (d.kind === 'nodes') {
      const z = live.current.view.zoom
      const pos = {}
      for (const id of Object.keys(d.starts)) pos[id] = { x: snap(d.starts[id].x + dx / z), y: snap(d.starts[id].y + dy / z) }
      moveRef.current(pos)
    } else if (d.kind === 'rect') {
      const pt = local(e)
      setRect({ x0: d.origin.x, y0: d.origin.y, x1: pt.x, y1: pt.y })
    } else if (d.kind === 'wire') {
      const pt = local(e)
      const hot = targetAt(e.clientX, e.clientY, d.from, d.blocked)
      setWire({ from: d.from, blocked: d.blocked, detach: d.detach || null, point: pt, hot })
    }
  }
  handlers.current.up = (e) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (d.kind === 'pan') {
      setPanning(false)
      if (!d.moved && d.clear) p.onSelect([], 'replace')
    } else if (d.kind === 'nodes') {
      if (d.moved) {
        // the frame that is still pending holds the last pointer position: commit it before the undo step
        moveRef.current.flush()
        p.onMoveEnd(d.startFlow)
      } else if (d.collapseTo) p.onSelect([d.collapseTo], 'replace')
    } else if (d.kind === 'rect') {
      setRect(null)
      if (d.moved) {
        const v = live.current.view
        const a = screenToWorld(v, d.origin)
        const b = screenToWorld(v, local(e))
        const box = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }
        const rects = live.current.flow.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: NODE_W, h: p.heightsRef.current[n.id] || 110 }))
        p.onSelect(rectSelect(rects, box), d.additive ? 'add' : 'replace')
      }
    } else if (d.kind === 'wire') {
      setWire(null)
      if (!d.moved) return
      const t = targetAt(e.clientX, e.clientY, d.from, d.blocked)
      if (d.detach) {
        // dragged an existing edge off its input: re-route it, or drop it
        if (t && t.node === d.detach.to.node && t.port === d.detach.to.port) return
        if (t) p.onConnect({ node: d.from.node, port: d.from.port }, { node: t.node, port: t.port }, d.detach.id)
        else p.onDisconnect(d.detach.id)
        return
      }
      if (!t) return
      if (d.from.side === 'out') p.onConnect({ node: d.from.node, port: d.from.port }, { node: t.node, port: t.port })
      else p.onConnect({ node: t.node, port: t.port }, { node: d.from.node, port: d.from.port })
    }
  }

  useEffect(() => {
    if (!wire) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        dragRef.current = null
        detach()
        setWire(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [!!wire])

  const startPan = useCallback((e) => {
    e.preventDefault()
    begin('pan', e, { view0: live.current.view, clear: false })
  }, [begin])

  const onBgDown = (e) => {
    if (e.button !== 0 && e.button !== 1) return
    p.onFocusRoot()
    if (spaceRef.current || e.button === 1) {
      startPan(e)
      return
    }
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      begin('rect', e, { origin: local(e), additive: true })
      return
    }
    e.preventDefault()
    begin('pan', e, { view0: live.current.view, clear: true })
  }

  // Handed to every (memoized) card: stable for the life of the canvas, reading the latest props when it runs.
  const onNodeDown = useCallback((e, node) => {
    const p = props.current
    if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
      e.stopPropagation()
      p.onFocusRoot()
      startPan(e)
      return
    }
    if (e.button !== 0) return
    if (e.target.closest && (e.target.closest('[data-fc-port]') || e.target.closest('[data-fc-nodrag]'))) return
    e.stopPropagation()
    p.onFocusRoot()
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      p.onSelect([node.id], 'toggle')
      return
    }
    const sel = live.current.selection
    const already = sel.includes(node.id)
    const ids = already ? sel : [node.id]
    if (!already) p.onSelect([node.id], 'replace')
    const starts = {}
    for (const n of live.current.flow.nodes) if (ids.includes(n.id)) starts[n.id] = { x: n.x, y: n.y }
    begin('nodes', e, { starts, startFlow: live.current.flow, collapseTo: already && sel.length > 1 ? node.id : null })
  }, [begin, startPan])

  const onPortDown = useCallback((e, nodeId, pt, side) => {
    const p = props.current
    if (e.button !== 0 || spaceRef.current) return
    e.stopPropagation()
    e.preventDefault()
    p.onFocusRoot()
    const f = live.current.flow
    let from = { node: nodeId, port: pt.name, side, type: pt.type }
    let detachEdge = null
    if (side === 'in') {
      const existing = f.edges.find((ed) => ed.to.node === nodeId && ed.to.port === pt.name)
      if (existing) {
        const srcLayout = live.current.layouts[existing.from.node]
        const outPort = srcLayout ? srcLayout.outputs.find((q) => q.name === existing.from.port) : null
        from = { node: existing.from.node, port: existing.from.port, side: 'out', type: outPort ? outPort.type : 'any' }
        detachEdge = existing
      }
    }
    const blocked = from.side === 'out' ? ancestors(f, from.node) : descendants(f, from.node)
    blocked.add(from.node)
    if (!detachEdge) setWire({ from, blocked, detach: null, point: local(e), hot: null })
    begin('wire', e, { from, blocked, detach: detachEdge })
  }, [begin, local])

  const fileOverTimer = useRef(null)
  const [fileOver, setFileOver] = useState(false)
  const hasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files')
  const onDragOver = (e) => {
    const types = Array.from(e.dataTransfer.types || [])
    if (types.includes(DND_TYPE) || (hasFiles(e) && p.onDropFiles)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
    if (hasFiles(e) && p.onDropFiles) {
      // no reliable dragleave over child elements: the highlight ends 160 ms after the last dragover
      setFileOver(true)
      clearTimeout(fileOverTimer.current)
      fileOverTimer.current = setTimeout(() => setFileOver(false), 160)
    }
  }
  const onDrop = (e) => {
    const w = screenToWorld(live.current.view, local(e))
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
    if (files.length && p.onDropFiles) {
      e.preventDefault()
      clearTimeout(fileOverTimer.current)
      setFileOver(false)
      p.onDropFiles(files, w.x - NODE_W / 2, w.y - HEAD_H / 2)
      return
    }
    const type = e.dataTransfer.getData(DND_TYPE)
    if (!type) return
    e.preventDefault()
    p.onDropType(type, w.x - NODE_W / 2, w.y - HEAD_H / 2)
  }
  useEffect(() => () => clearTimeout(fileOverTimer.current), [])

  const onContextMenu = (e) => {
    if (e.target.closest('[data-fc-generate]')) return  // keep native paste/context behaviour in the composer
    e.preventDefault()
    setQuick(null)
    const pt = local(e)
    const card = e.target.closest ? e.target.closest('[data-fc-node]') : null
    const nodeId = card ? card.getAttribute('data-fc-node') : null
    const hit = !nodeId && e.target.closest ? e.target.closest('[data-fc-edge]') : null
    const edgeId = hit ? hit.getAttribute('data-fc-edge') : null
    if (nodeId && !live.current.selection.includes(nodeId)) p.onSelect([nodeId], 'replace')
    if (edgeId) p.onSelectEdge(edgeId)
    const w = ref.current ? ref.current.clientWidth : 800
    const hgt = ref.current ? ref.current.clientHeight : 600
    setMenu({ x: clamp(pt.x, 4, Math.max(4, w - 236)), y: clamp(pt.y, 4, Math.max(4, hgt - 250)), nodeId, edgeId, world: screenToWorld(live.current.view, pt) })
  }

  const onDoubleClick = (e) => {
    if (e.button !== 0) return
    const el = e.target
    if (el.closest && el.closest('[data-fc-node], [data-fc-generate], .fc-zoombar, .fc-menu, .fc-quick')) return
    e.preventDefault()
    e.stopPropagation()
    const pt = local(e)
    const w = ref.current ? ref.current.clientWidth : 800
    const hgt = ref.current ? ref.current.clientHeight : 600
    setMenu(null)
    setQuick({
      x: clamp(pt.x, 8, Math.max(8, w - 348)),
      y: clamp(pt.y, 8, Math.max(8, hgt - 440)),
      world: screenToWorld(live.current.view, pt)
    })
  }

  const menuItems = () => {
    if (!menu) return []
    const mod = 'Ctrl'
    if (menu.edgeId) {
      return [{ label: 'Remove connection', icon: 'trash', hint: 'Del', danger: true, run: () => {
        p.onDisconnect(menu.edgeId)
        p.onSelectEdge(null)
      } }]
    }
    if (menu.nodeId) {
      const node = flow.nodes.find((n) => n.id === menu.nodeId)
      const isNote = node && node.type === 'note'
      const many = p.selection.length > 1
      return [
        { label: 'Run up to here', icon: 'debug-continue', disabled: p.running || isNote || many, run: () => p.onRunTo(menu.nodeId) },
        '-',
        { label: many ? `Duplicate ${p.selection.length} nodes` : 'Duplicate', icon: 'copy', hint: `${mod}+D`, run: p.onDuplicate },
        { label: 'Copy', icon: 'clippy', hint: `${mod}+C`, run: p.onCopy },
        { label: 'Cut', icon: 'clippy', hint: `${mod}+X`, run: p.onCut },
        { label: many ? `Delete ${p.selection.length} nodes` : 'Delete', icon: 'trash', hint: 'Del', danger: true, run: p.onDelete }
      ]
    }
    return [
      { label: 'Paste here', icon: 'clippy', hint: `${mod}+V`, disabled: !p.canPaste(), run: () => p.onPaste(menu.world) },
      { label: 'Add a note here', icon: 'note', run: () => p.onDropType('note', menu.world.x, menu.world.y) },
      '-',
      { label: 'Select all', icon: 'checklist', hint: `${mod}+A`, disabled: !flow.nodes.length, run: p.onSelectAll },
      { label: 'Tidy layout', icon: 'wand', disabled: p.running || !flow.nodes.length, run: p.onTidy },
      { label: 'Fit to screen', icon: 'screen-full', hint: 'F', disabled: !flow.nodes.length, run: fit }
    ]
  }

  const byId = {}
  for (const n of flow.nodes) byId[n.id] = n
  const colorOf = (t) => portColor(t, types.portTypes)
  const stateOf = (id) => (run && run.nodes ? run.nodes[id] : null)
  const hiddenEdge = wire && wire.detach ? wire.detach.id : null
  // Edge layout A: the wires of the hovered (or the one selected) node are drawn bold above the cards, the rest fade.
  const lit = edgeFocus(flow.edges, { hover: hoverNode, selection: p.selection, selectedEdge: p.selectedEdge, dragging: !!wire })
  const boxOf = (n) => ({ x: n.x, y: n.y, w: NODE_W, h: (p.heightsRef && p.heightsRef.current[n.id]) || 110 })
  const litEls = []

  const edgeEls = flow.edges.map((ed) => {
    if (ed.id === hiddenEdge) return null
    const a = byId[ed.from.node]
    const b = byId[ed.to.node]
    const la = a && layouts[a.id]
    const lb = b && layouts[b.id]
    if (!la || !lb) return null
    // U-4: world coordinates — the layer carries the view transform, so a pan only moves one attribute and the
    // path data (whose strings are identical across pans) is left alone. Strokes stay screen-sized (CSS
    // `vector-effect: non-scaling-stroke`), so the curve looks exactly as it did in screen space.
    const pa = portPosition(a, la, 'out', ed.from.port)
    const pb = portPosition(b, lb, 'in', ed.to.port)
    const op = la.outputs.find((q) => q.name === ed.from.port)
    const d = edgeRouteWorld(pa, pb, boxOf(a), boxOf(b))
    const ts = stateOf(b.id)
    const ss = stateOf(a.id)
    const on = !!lit && lit.has(ed.id)
    const cls = ['fc-edge', p.selectedEdge === ed.id && 'selected', ts && ts.status === 'running' && 'flowing',
      edgeDead(ss, ts, ed.from.port) && 'dead', lit && !on && 'faded'].filter(Boolean).join(' ')
    const stroke = colorOf(op ? op.type : 'any')
    if (on) litEls.push(h('path', { key: ed.id, d, className: `${cls} lit`, 'data-fc-lit': ed.id, style: { stroke } }))
    return h('g', { key: ed.id },
      h('path', {
        d,
        className: 'fc-edge-hit',
        'data-fc-edge': ed.id,
        onPointerDown: (ev) => {
          if (ev.button !== 0 || spaceRef.current) return
          ev.stopPropagation()
          p.onFocusRoot()
          p.onSelectEdge(ed.id)
        }
      }),
      on ? null : h('path', { d, className: cls, style: { stroke } }))
  })

  let wireEl = null
  if (wire) {
    const n = byId[wire.from.node]
    const l = n && layouts[n.id]
    if (l) {
      // the pointer is in screen space; the temporary wire lives with the edges, in world space
      const p0 = portPosition(n, l, wire.from.side, wire.from.port)
      const tip = screenToWorld(view, wire.point)
      const d = wire.from.side === 'out' ? edgePathWorld(p0, tip) : edgePathWorld(tip, p0)
      wireEl = h('path', { d, className: 'fc-wire', style: { stroke: colorOf(wire.from.type) } })
    }
  }

  const portClass = wire
    ? (nodeId, pt, side) => {
        if (nodeId === wire.from.node && pt.name === wire.from.port && side === wire.from.side) return 'hot'
        if (wire.hot && wire.hot.node === nodeId && wire.hot.port === pt.name) return 'ok hot'
        if (side === wire.from.side) return 'dim'
        return wireOk(wire.from, wire.blocked, nodeId, pt.name) ? 'ok' : 'dim'
      }
    : null

  const nodeEls = flow.nodes.map((n) =>
    h(NodeCard, {
      key: n.id,
      node: n,
      spec: types.byName[n.type],
      layout: layouts[n.id],
      types,
      state: stateOf(n.id),
      runId: run ? run.id : null,
      selected: p.selection.includes(n.id),
      issue: p.issuesByNode[n.id],
      connectedIn: p.connectedIn[n.id],
      connectedOut: p.connectedOut[n.id],
      expanded: p.expanded.has(n.id),
      portClass,
      timings: p.timings,
      nameOf: stable.current.nameOf,
      loopOwner: p.loopOwners ? p.loopOwners[n.id] : null,
      wires: p.wireCounts ? p.wireCounts[n.id] : null,
      api: p.api,
      heightsRef: p.heightsRef,
      onDown: onNodeDown,
      onPortDown,
      onToggleExpand: stable.current.onToggleExpand,
      onOpenInspector: stable.current.onOpenInspector,
      onOpenMedia: stable.current.onOpenMedia,
      onOpenValue: stable.current.onOpenValue,
      flowId: flow.id,
      savedRev: p.savedRev
    }))

  const zoomBy = (factor) => setView((v) => zoomAt(v, factor, { x: size.w / 2, y: size.h / 2 }))
  const cls = ['fc-canvas', wire && 'fc-wiring', panning && 'panning', space && !panning && 'space', fileOver && 'file-over'].filter(Boolean).join(' ')
  return h('div', {
    ref,
    className: cls,
    style: { backgroundSize: `${20 * view.zoom}px ${20 * view.zoom}px`, backgroundPosition: `${view.x}px ${view.y}px` },
    onPointerDown: onBgDown,
    onDoubleClick,
    onContextMenu,
    onDragOver,
    onDrop
  },
  wire ? h('style', { 'data-fc-wire-tips': '1' }, WIRE_TIP_CSS) : null,
  h('svg', { className: 'fc-edges', style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` } }, edgeEls, wireEl),
  h('div', {
    className: 'fc-world',
    style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` },
    onPointerOver: (e) => { const el = e.target.closest && e.target.closest('[data-fc-node]'); setHoverNode(el ? el.getAttribute('data-fc-node') : null) },
    onPointerOut: (e) => { const el = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-fc-node]'); if (!el) setHoverNode(null) }
  }, nodeEls),
  litEls.length ? h('svg', { className: 'fc-edges fc-edges-top', style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` } }, litEls) : null,
  rect ? h('div', {
    className: 'fc-rect',
    style: { left: Math.min(rect.x0, rect.x1), top: Math.min(rect.y0, rect.y1), width: Math.abs(rect.x1 - rect.x0), height: Math.abs(rect.y1 - rect.y0) }
  }) : null,
  flow.nodes.length === 0 && !fileOver ? h('div', { className: 'fc-hint fc-generate-hint' },
    h('div', { className: 'fc-hint-title' }, 'Start building'),
    p.generation ? h(GenerateComposer, {
      flow, generation: p.generation, onEdit: p.onGenerateEdit, onSubmit: p.onGenerate, onStop: p.onGenerateStop, inline: true,
    }) : null,
    h('div', { className: 'fc-help', style: { marginTop: 10 } },
      'Or click/drag a node from the left panel. Connect an output to an input, then press Run.'),
    p.onDropFiles ? h('div', { className: 'fc-help' }, 'Drop files here to add them as File nodes.') : null) : null,
  fileOver ? h('div', { className: 'fc-drop-hint', 'data-fc-drop-hint': '1' },
    h(Icon, { name: 'cloud-upload' }), 'Drop to add as File nodes') : null,
  p.uploading ? h('div', { className: 'fc-drop-hint busy', 'data-fc-uploading': String(p.uploading) },
    h(Icon, { name: 'loading', spin: true }), `Adding ${p.uploading} file${p.uploading === 1 ? '' : 's'}…`) : null,
  h('div', { className: 'fc-zoombar', onPointerDown: (e) => e.stopPropagation() },
    h('button', { className: 'fc-btn ghost icon', title: 'Zoom out', onClick: () => zoomBy(1 / 1.2) }, h(Icon, { name: 'zoom-out' })),
    h('span', { className: 'fc-zoomval' }, `${Math.round(view.zoom * 100)}%`),
    h('button', { className: 'fc-btn ghost icon', title: 'Zoom in', onClick: () => zoomBy(1.2) }, h(Icon, { name: 'zoom-in' })),
    h('button', { className: 'fc-btn ghost icon', title: 'Fit to screen (F)', onClick: fit }, h(Icon, { name: 'screen-full' }))),
  quick ? h(QuickSearch, {
    types, recent: p.recent, position: quick,
    onAdd: (type) => {
      p.onDropType(type, quick.world.x - NODE_W / 2, quick.world.y - HEAD_H / 2)
      setQuick(null)
      p.onFocusRoot()
    },
    onClose: () => setQuick(null)
  }) : null,
  menu ? h(ContextMenu, { menu, items: menuItems(), onClose: () => setMenu(null) }) : null)
}

