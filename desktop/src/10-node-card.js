// ---------------------------------------------------------------- node card
// U-4: memoized — a pan, a zoom or another node's status update re-renders the canvas, but a card whose own
// data props are unchanged is skipped. Every callback handed to it is stable (see Canvas), and `state` is this
// node's slice of the run record rather than the whole run.
function nodeCardPropsEqual(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const k of keys) if (!Object.is(a[k], b[k])) return false
  return true
}
const NodeCard = memo(function NodeCard(p) {
  const { node, spec, layout, types, state, runId, selected, issue, connectedIn, connectedOut, expanded, portClass, api } = p
  const isNote = node.type === 'note'
  const status = state ? state.status : null
  const lay = layout || { inputs: [], outputs: [], hidden: 0, collapsible: false }
  const rows = Math.max(lay.inputs.length, lay.outputs.length)
  const inSet = connectedIn || EMPTY_SET
  const outSet = connectedOut || EMPTY_SET
  const finished = status === 'done' || status === 'cached'
  const media = finished && state ? findMedia(state.outputs) : null
  const thumb = useMedia(api, runId, node.id, media ? media.port : null, 320, !!media && media.kind === 'image', media ? media.index : 0)
  const isFile = node.type === 'input.file'
  const fileInfo = useFileNode(api, p.flowId, node.id, isFile ? (node.params || {}).path : '', p.savedRev, isFile && !media && status !== 'error')
  const cls = ['fc-node', selected && 'selected', status === 'running' && 'running', status === 'error' && 'error',
    !spec && !isNote && 'unknown', isNote && 'note', (status === 'skipped' || status === 'cancelled') && 'muted'].filter(Boolean).join(' ')
  const title = node.title || (spec && spec.title) || node.type
  const summary = isNote ? [] : paramSummary(node, spec, inSet)
  const mi = useModelInfo(api, node.type, spec, node.params)
  const mInfo = mi && mi.data && mi.data.found ? mi.data : null
  const llm = useLlmInfo(api, node.params || {}, node.type === 'llm.complete')
  const cost = mInfo ? estimateCost(mInfo.cost, effectiveValues(spec, node.params, mInfo.fields || {}))
    : llm ? estimateLlmCost(llm, node.params) : null
  const exp = isNote ? null : expectedTime(spec, node, p.timings)
  const ms = modelSetting(spec, node.params)
  const modelLabel = mInfo && mInfo.label ? String(mInfo.label) : mi && mi.model ? String(mi.model) : ''
  const sub = nodeSubline(node, spec, modelLabel, !!(ms && ms.auto))
  const foot = isNote ? { cost: '', time: '' } : nodeFooter(cost, exp)
  const wires = p.wires || {}

  const port = (pt, side) => {
    const isConn = side === 'in' ? inSet.has(pt.name) : outSet.has(pt.name)
    const extra = portClass ? portClass(node.id, pt, side) : ''
    const hasValue = !isBlank((node.params || {})[pt.name])
    const required = side === 'in' && pt.required && !isConn && !hasValue
    const br = side === 'out' ? branchPort(state, pt.name) : ''
    const tip = portTip(pt, side, { wires: ((wires[side] || {})[pt.name]) || 0, hasValue, portTypes: types.portTypes, branch: br })
    const dot = h('span', { className: 'fc-dot', style: { '--fc-port': portColor(pt.type, types.portTypes) } })
    return withTip(tip, h('div', {
      key: `${side}:${pt.name}`,
      className: `fc-port fc-port-${side}${isConn ? ' connected' : ''}${br ? ` ${br}` : ''}${extra ? ` ${extra}` : ''}`,
      'data-fc-branch': br || undefined,
      'data-fc-port': pt.name,
      'data-fc-owner': node.id,
      'data-fc-side': side,
      title: nativeTitle(tip),
      onPointerDown: (e) => p.onPortDown(e, node.id, pt, side)
    },
    side === 'in' ? dot : null,
    h('span', { className: 'fc-port-label' }, pt.label || pt.name),
    required ? h('span', { className: 'fc-req' }, '*') : null,
    side === 'out' ? dot : null), side === 'in' ? 'left' : 'right', `${side}:${pt.name}`)
  }

  let preview = null
  const stop = (e) => e.stopPropagation()
  const openProps = (m) => m && p.onOpenMedia ? {
    'data-fc-nodrag': '1',
    'data-fc-open-media': m.kind,
    title: 'Click to view large',
    onPointerDown: (e) => {
      if (e.button === 0) e.stopPropagation()
    },
    onDoubleClick: stop,
    onClick: (e) => {
      e.stopPropagation()
      p.onOpenMedia({ nodeId: node.id, port: m.port, index: m.index, path: m.media.path })
    }
  } : {}
  const openable = openProps(media)
  const canOpenValue = typeof p.onOpenValue === 'function'
  const openValueHandlers = (port) => ({
    onPointerDown: (e) => {
      if (e.button === 0) e.stopPropagation()
    },
    onClick: (e) => {
      e.stopPropagation()
      p.onOpenValue({ nodeId: node.id, port })
    },
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault?.()
        e.stopPropagation()
        p.onOpenValue({ nodeId: node.id, port })
      }
    }
  })
  const valueProps = (it) => !it.media && canOpenValue ? {
    role: 'button',
    tabIndex: 0,
    'data-fc-open-value': it.port,
    'aria-label': `${it.label}: ${it.detail}`,
    onDoubleClick: stop,
    ...openValueHandlers(it.port)
  } : {}
  const minis = finished && status !== 'error' ? nodeOutputItems(node, state, types.byName) : null
  // every finished node lists its outputs — no exceptions for one output, plain text or a single image
  const showRows = !!minis && minis.total > 0
  const zoomCls = media && p.onOpenMedia ? ' fc-zoomable' : ''
  if (status === 'error' && state.error) {
    const tip = errorTip(state.error)
    preview = withTip(tip, h('div', {
      className: 'fc-node-error',
      'data-fc-run-error': '1',
      title: nativeTitle(tip)
    }, state.error), 'bottom')
  }
  else if (showRows) {
    preview = h('div', { className: 'fc-minis', 'data-fc-minis': String(minis.total) },
      minis.items.map((it) => h('div', {
        key: it.key,
        className: `fc-out k-${it.kind}` +
          (it.link && p.onOpenMedia ? ' fc-zoomable' : '') +
          (!it.media && canOpenValue ? ' fc-openable' : ''),
        'data-fc-mini': it.kind,
        ...(it.link && p.onOpenMedia
          ? openProps({ kind: it.kind, port: it.port, index: it.index, media: it.media })
          : {}),
        ...valueProps(it),
        title: `${it.label}: ${it.detail}`
      },
      h('div', { className: 'fc-mini-top' },
        h('span', { className: 'fc-mini-label' }, it.label),
        h('span', { className: 'fc-mini-badge' }, it.badge)),
      it.kind === 'image' && it.link
        ? h('div', { className: 'fc-mini-thumb' },
          h(MiniThumb, { api, runId, nodeId: node.id, port: it.port, index: it.index, name: it.detail }))
        : it.link && ['video', 'audio', 'model3d'].includes(it.kind)
          ? h(MiniMedia, { api, runId, nodeId: node.id, port: it.port, index: it.index, kind: it.kind,
            name: it.media.file || it.detail })
        : it.media
          ? h('div', { className: 'fc-mini-file' },
            h(Icon, { name: it.kind === 'broken' ? 'warning' : MEDIA_ICON[it.kind] || 'file' }),
            h('span', null, it.detail))
          : h('div', { className: 'fc-mini-text' }, it.detail))),
    minis.more > 0 ? h('div', {
      className: 'fc-mini-more',
      'data-fc-mini-more': String(minis.more),
      ...(canOpenValue ? {
        role: 'button',
        tabIndex: 0,
        'aria-label': `Show all ${minis.more} hidden outputs`,
        ...openValueHandlers(null)
      } : {})
    }, `+${minis.more}`) : null)
  } else if (media && media.kind === 'image' && thumb && thumb.data_url) {
    preview = h('div', { className: `fc-preview media${zoomCls}`, ...openable }, h('img', { src: thumb.data_url, alt: media.media.file || '', draggable: false }))
  } else if (media) {
    preview = h('div', { className: `fc-preview file${zoomCls}`, ...openable }, h(Icon, { name: MEDIA_ICON[media.kind] || 'file' }), h('span', null, media.media.file || media.kind))
  } else if (finished && state.preview !== undefined && state.preview !== null) {
    const text = previewString(state.preview)
    if (text) preview = h('div', { className: 'fc-preview' }, text)
  } else if (fileInfo && fileInfo.data_url) {
    preview = h('div', { className: 'fc-preview media', 'data-fc-file-preview': 'image', title: fileInfo.path },
      h('img', { src: fileInfo.data_url, alt: fileInfo.name || '', draggable: false }))
  } else if (fileInfo) {
    preview = fileInfo.exists
      ? h('div', { className: 'fc-preview file', 'data-fc-file-preview': fileInfo.kind || 'file', title: fileInfo.path },
        h(Icon, { name: MEDIA_ICON[fileInfo.kind] || 'file' }), h('span', null, fileInfo.name),
        fileInfo.size !== null && fileInfo.size !== undefined ? h('span', { className: 'fc-muted' }, formatBytes(fileInfo.size)) : null)
      : h('div', { className: 'fc-node-error', 'data-fc-file-preview': 'missing', title: fileInfo.path }, `File not found: ${fileInfo.name || fileInfo.path}`)
  }

  return h('div', {
    className: cls,
    'data-fc-node': node.id,
    style: { left: node.x, top: node.y, '--fc-cat': spec ? categoryColor(spec.category) : 'var(--ui-red)' },
    onPointerDown: (e) => p.onDown(e, node),
    onDoubleClick: (e) => {
      e.stopPropagation()
      if (p.onOpenInspector) p.onOpenInspector(node.id)
    },
    ref: (el) => {
      if (el && p.heightsRef) p.heightsRef.current[node.id] = el.offsetHeight
    }
  },
  h('div', { className: 'fc-node-head' },
    h('span', { className: 'fc-node-icon' }, h(Icon, { name: (spec && spec.icon) || (isNote ? 'note' : 'question') })),
    p.loopOwner ? withTip({ id: 'loop', title: 'Runs once per item', icon: 'sync',
      lines: [`Repeats for every item of “${(p.nameOf && p.nameOf(p.loopOwner)) || 'For each'}”.`, 'A Collect after it gathers the results.'] },
    h('span', { className: 'fc-tipwrap fc-node-loop', 'data-fc-loop': p.loopOwner,
      title: nativeTitle({ title: 'Runs once per item', lines: ['A Collect after it gathers the results.'] }) }, h(Icon, { name: 'sync' }))) : null,
    h('span', { className: 'fc-node-titles' },
      h('span', { className: 'fc-node-title', title: (spec && spec.description) || title }, title),
      sub ? h('span', { className: 'fc-node-sub', 'data-fc-node-sub': '1', title: sub }, sub) : null),
    issue && !status ? withTip({ id: 'issue', title: 'Not ready to run', tone: 'warn', icon: 'warning', lines: [issue] },
      h('span', { className: 'fc-tipwrap', 'data-fc-issue': '1', title: nativeTitle({ title: 'Not ready to run', lines: [issue] }) },
        h(Icon, { name: 'warning', className: 'fc-node-issue' }))) : null,
    state && status ? h(StatusBadge, { state, exp, nameOf: p.nameOf, branchName: branchLabel(node, spec, state) }) : null),
  isNote ? h('div', { className: 'fc-note-text' }, (node.params && node.params.text) || 'Empty note — select it and type in the inspector.') : null,
  rows > 0 ? h('div', { className: 'fc-ports' },
    range(rows).map((i) => h('div', { key: i, className: 'fc-port-row' },
      lay.inputs[i] ? port(lay.inputs[i], 'in') : null,
      lay.outputs[i] ? port(lay.outputs[i], 'out') : null))) : null,
  lay.hidden > 0 ? h('div', { className: 'fc-more', 'data-fc-nodrag': '1', onPointerDown: stop, onClick: () => p.onToggleExpand(node.id) },
    `+ ${lay.hidden} more input${lay.hidden === 1 ? '' : 's'}`) : null,
  expanded && lay.collapsible ? h('div', { className: 'fc-more', 'data-fc-nodrag': '1', onPointerDown: stop, onClick: () => p.onToggleExpand(node.id) }, 'Show fewer inputs') : null,
  summary.length > 0 ? h('div', { className: 'fc-summary' }, summary.map(([k, v], i) => [
    // the row index, not the label: two params can share a label (U-18: duplicate React keys)
    h('span', { key: `k:${i}`, className: 'fc-summary-key' }, k),
    h('span', { key: `v:${i}`, className: 'fc-summary-val', title: String(v) }, v)])) : null,
  !spec && !isNote ? h('div', { className: 'fc-node-error' }, `Unknown node type “${node.type}”. The tool may be missing or blocked.`) : null,
  preview,
  foot.cost || foot.time ? h('div', { className: 'fc-node-foot', 'data-fc-node-foot': '1' },
    foot.cost ? h('span', { className: 'fc-node-cost', 'data-fc-node-cost': foot.cost, title: cost.lines.join('\n') }, foot.cost)
      : h('span', { className: 'fc-node-free' }, ''),
    foot.time ? h('span', { className: 'fc-node-time', title: 'Usual duration' }, foot.time) : null) : null)
}, nodeCardPropsEqual)

