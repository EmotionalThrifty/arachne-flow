// ---------------------------------------------------------------- palette + quick search
/** Rich tooltip body for a palette entry, drawn like a small node card: tinted header with the category icon, port
 *  rows with port colours, duration, cost, tool. The bubble itself gets the Arachne Flow look via `fc-tt-bubble`. */
function TypeTip({ spec, portTypes, timings }) {
  const tip = typeTip(spec, portTypes, 6, timings)
  const row = (label, body, key) => h('div', { className: 'fc-tt-row', 'data-fc-tt': key }, h('span', { className: 'fc-tt-k' }, label), h('span', { className: 'fc-tt-v' }, body))
  const ports = (list, more, extra) => [
    ...list.map((p, i) => h('span', { key: i, className: 'fc-tt-port' },
      h('i', { className: 'fc-tt-dot', style: { '--fc-port': p.color } }), p.name,
      p.type || p.optional ? h('span', { className: 'fc-tt-type' }, [p.type, p.optional ? 'optional' : ''].filter(Boolean).join(', ')) : null)),
    more ? h('span', { key: 'more', className: 'fc-tt-type' }, `+${more} more`) : null,
    extra ? h('span', { key: 'extra', className: 'fc-tt-type' }, extra) : null
  ]
  return h('div', { className: 'fc-tt', 'data-fc-typetip': spec.type, style: { '--fc-cat': categoryColor(spec.category) } },
    h('div', { className: 'fc-tt-head' },
      h('span', { className: 'fc-node-icon' }, h(Icon, { name: spec.icon || 'symbol-misc' })),
      h('span', { className: 'fc-tt-title' }, tip.title),
      h('span', { className: 'fc-tt-kind' }, tip.kind)),
    h('div', { className: 'fc-tt-body' },
      tip.description ? h('div', { className: 'fc-tt-desc' }, tip.description) : null,
      tip.inputs.length || tip.dynamic ? row('In', ports(tip.inputs, tip.moreInputs, tip.dynamic), 'in') : null,
      tip.outputs.length ? row('Out', ports(tip.outputs, tip.moreOutputs, tip.moreOutputsText), 'out') : null,
      tip.typical || tip.measured ? row('Takes', [tip.typical, tip.measured].filter(Boolean).join(' · '), 'typical') : null,
      tip.cost ? row('Cost', tip.cost, 'cost') : null,
      tip.tool ? h('div', { className: 'fc-tt-tool' }, tip.tool) : null),
    h('div', { className: 'fc-tt-foot' }, h(Icon, { name: 'add' }), 'Click to add · or drag onto the canvas'))
}

function TypeItem({ spec: t, onAdd, active = false, onHover, showCategory = false, draggable = true, portTypes = {}, richTip = false, timings = null }) {
  // Palette entries get the app's rich tooltip; quick search (keyboard-driven) and the dev stub keep a plain title.
  const rich = richTip && typeof sdk.Tip === 'function'
  const item = h('div', {
    className: `fc-item${active ? ' active' : ''}`,
    draggable,
    'data-fc-type': t.type,
    role: showCategory ? 'option' : undefined,
    'aria-selected': showCategory ? active : undefined,
    title: rich ? undefined : typeTipText(typeTip(t, portTypes, 6, timings)),
    style: { '--fc-cat': categoryColor(t.category) },
    onDragStart: (e) => {
      e.dataTransfer.setData(DND_TYPE, t.type)
      e.dataTransfer.effectAllowed = 'copy'
    },
    onMouseEnter: onHover,
    onClick: (e) => {
      e.stopPropagation()
      onAdd(t.type)
    }
  },
  h(Icon, { name: t.icon || 'symbol-misc' }),
  h('span', { className: 'fc-item-name' }, t.title),
  showCategory ? h('span', { className: 'fc-item-meta' }, t.category || 'Other') : null)
  if (!rich) return item
  return h(sdk.Tip, { label: h(TypeTip, { spec: t, portTypes, timings }), side: 'right', align: 'start', sideOffset: 10, className: 'fc-tt-bubble' }, item)
}

function Palette({ types, recent, onAdd, folds, onFolds, timings }) {
  const [query, setQuery] = useState('')
  const open = folds && typeof folds === 'object' ? folds : {}
  const setOpen = (fn) => onFolds(fn(open))
  const items = useMemo(() => filterTypes(types.list, query), [types.list, query])
  const recents = useMemo(() => resolveRecentTypes(items, recent), [items, recent])
  const groups = useMemo(() => groupByCategory(items), [items])
  const sections = useMemo(() => paletteSections(groups, recents), [groups, recents])
  const searching = query.trim().length > 0
  const best = searching && items[0] ? items[0].type : null // what Enter adds; highlighted while searching
  const allOpen = !searching && allFoldsOpen(sections, open)
  const foldLabel = searching ? 'Search shows every match' : allOpen ? 'Collapse all' : 'Expand all'
  const toolCount = types.list.filter((t) => t.kind === 'tool').length
  const item = (t, key) => h(TypeItem, { key, spec: t, onAdd, active: t.type === best, portTypes: types.portTypes, richTip: true, timings })
  return h('div', { className: 'fc-side fc-palette' },
    h('div', { className: 'fc-pal-top' },
      h('div', { className: 'fc-search' },
        h(Icon, { name: 'search' }),
        h('input', {
          value: query,
          placeholder: 'Search nodes, ports…',
          'aria-label': 'Search nodes by name, description or port',
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter' && items[0]) onAdd(items[0].type)
            if (e.key === 'Escape') setQuery('')
          }
        }),
        searching ? h('button', { className: 'fc-btn ghost icon', style: { width: 20, height: 20 }, title: 'Clear', onClick: () => setQuery('') }, h(Icon, { name: 'close' })) : null),
      h('button', {
        className: 'fc-btn ghost icon fc-pal-fold',
        title: foldLabel,
        'aria-label': foldLabel,
        'data-fc-fold': allOpen ? 'collapse' : 'expand',
        disabled: searching,
        onClick: () => onFolds(setAllFolds(sections, !allOpen))
      }, h(Icon, { name: allOpen ? 'collapse-all' : 'expand-all' }))),
    h('div', { className: 'fc-palette-list' },
      groups.length === 0 ? h('div', { className: 'fc-muted', style: { padding: 12 } }, 'No node matches.') : null,
      sections.map((sec) => {
        const secKey = `§${sec.id}`
        const secOpen = searching || foldOpen(open, secKey, sec.open)
        return h('div', { key: sec.id, className: 'fc-pal-sec', 'data-fc-section': sec.id,
          'data-fc-recent': sec.id === 'recent' ? '1' : undefined, style: { '--fc-sec': sec.color } },
          h('div', {
            className: 'fc-pal-sec-head', title: sec.hint, role: 'button', tabIndex: 0, 'aria-expanded': secOpen,
            onClick: () => setOpen((o) => ({ ...o, [secKey]: !secOpen })),
            onKeyDown: (e) => {
              if (!activatesOn(e.key)) return
              e.preventDefault()
              setOpen((o) => ({ ...o, [secKey]: !secOpen }))
            }
          },
          h(Icon, { name: secOpen ? 'chevron-down' : 'chevron-right', className: 'fc-pal-chev' }),
          h(Icon, { name: sec.icon, className: 'fc-pal-sec-icon' }),
          h('span', { className: 'fc-pal-sec-title' }, sec.label),
          h('span', { className: 'fc-count' }, String(sec.count))),
          secOpen ? sec.groups.map((g) => {
            const label = g.category.replace(/^(Tools|MCP|Ready) · /, '')
            if (sec.flat) return h('div', { key: g.category }, g.items.map((t) => item(t, t.type)))
            const isOpen = searching || foldOpen(open, g.category, sec.id === 'basic' || sec.id === 'ready')
            return h('div', { key: g.category },
              h('div', { className: 'fc-cat', role: 'button', 'aria-expanded': isOpen, onClick: () => setOpen((o) => ({ ...o, [g.category]: !isOpen })) },
                h(Icon, { name: isOpen ? 'chevron-down' : 'chevron-right' }), label, h('span', { className: 'fc-count' }, String(g.items.length))),
              isOpen ? g.items.map((t) => item(t, t.type)) : null)
          }) : null)
      })),
    h('div', { className: 'fc-palette-foot' }, `${types.list.filter((t) => t.palette !== false).length} nodes · ${toolCount} from Hermes tools`))
}

function QuickSearch({ types, recent, position, onAdd, onClose }) {
  const ref = useRef(null)
  const inputRef = useRef(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  useDismiss(ref, onClose)
  useLayoutEffect(() => {
    if (inputRef.current) inputRef.current.focus({ preventScroll: true })
  }, [])
  const matches = useMemo(() => filterTypes(types.list, query), [types.list, query])
  const recents = useMemo(() => resolveRecentTypes(matches, recent), [matches, recent])
  const recentIds = new Set(recents.map((t) => t.type))
  const rest = matches.filter((t) => !recentIds.has(t.type))
  const items = [...recents, ...rest]
  const current = items.length ? clamp(active, 0, items.length - 1) : 0
  useEffect(() => {
    const el = ref.current && ref.current.querySelector('.fc-item.active')
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [current])
  const choose = (t) => {
    if (t) onAdd(t.type)
  }
  const section = (label, list, isRecent = false) => list.length > 0 ? h('div', {
    key: label, 'data-fc-recent': isRecent ? '1' : undefined
  },
  h('div', { className: 'fc-quick-label' }, label),
  list.map((t) => h(TypeItem, {
    key: `${isRecent ? 'recent' : 'all'}:${t.type}`, spec: t, onAdd: choose, showCategory: true, draggable: false, portTypes: types.portTypes,
    active: items[current] === t, onHover: () => setActive(items.indexOf(t))
  }))) : null
  return h('div', {
    ref,
    className: 'fc-quick',
    role: 'dialog',
    'aria-label': 'Add node',
    style: { left: position.x, top: position.y },
    onPointerDown: (e) => e.stopPropagation(),
    onDoubleClick: (e) => e.stopPropagation(),
    onContextMenu: (e) => e.preventDefault()
  },
  h('div', { className: 'fc-search' },
    h(Icon, { name: 'search' }),
    h('input', {
      ref: inputRef,
      autoFocus: true,
      value: query,
      placeholder: 'Add a node…',
      'aria-label': 'Search nodes',
      onChange: (e) => {
        setQuery(e.target.value)
        setActive(0)
      },
      onKeyDown: (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          if (!items.length) return
          const delta = e.key === 'ArrowDown' ? 1 : -1
          setActive((current + delta + items.length) % items.length)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          choose(items[current])
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }
    })),
  h('div', { className: 'fc-quick-list', role: 'listbox' },
    items.length === 0 ? h('div', { className: 'fc-menu-empty' }, 'No node matches.') : null,
    section('Recently used', recents, true),
    section(query.trim() ? 'Other matches' : 'All nodes', rest)),
  h('div', { className: 'fc-quick-foot' }, '↑↓ select · Enter add at cursor · Esc close'))
}

