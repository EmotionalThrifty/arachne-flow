// ---------------------------------------------------------------- header + flow menu
const FLOW_MENU_LIMIT = 8          // recent flows shown before "Show all"
/** Every word of `query` appears in one of `texts` (case-insensitive). Pure, tested. */
function menuMatch(query, ...texts) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = texts.filter(Boolean).join(' ').toLowerCase()
  return words.every((w) => hay.includes(w))
}
/** What the flows menu lists: recent flows (or all), templates split into yours/built-in, all filtered by the
 *  search. With a search both kinds show at once, so the tab never hides a match. Pure, tested. */
function flowMenuModel({ flows, templates, query = '', tab = 'flows', showAll = false, limit = FLOW_MENU_LIMIT }) {
  const list = Array.isArray(flows) ? flows.slice() : []
  list.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
  const { own, builtin } = splitTemplates(templates)
  const searching = String(query || '').trim() !== ''
  const fl = list.filter((f) => menuMatch(query, f.name || 'Untitled flow'))
  const tpl = (arr) => arr.filter((x) => menuMatch(query, x.name || x.id, x.description))
  const ownHit = tpl(own)
  const builtinHit = tpl(builtin)
  const showFlows = searching || tab !== 'templates'
  const showTemplates = searching || tab === 'templates'
  const cut = !searching && !showAll && fl.length > limit
  return {
    searching,
    counts: { flows: list.length, templates: own.length + builtin.length },
    flows: showFlows ? (cut ? fl.slice(0, limit) : fl) : [],
    moreFlows: showFlows && cut ? fl.length - limit : 0,
    own: showTemplates ? ownHit : [],
    builtin: showTemplates ? builtinHit : [],
    empty: searching && !fl.length && !ownHit.length && !builtinHit.length
  }
}

function FlowMenu({ flows, current, templates, onOpen, onNew, onFromTemplate, onDuplicate, onDelete, onClose,
  onSaveTemplate, onEditTemplate, onDeleteTemplate, returnFocus }) {
  const ref = useRef(null)
  const searchRef = useRef(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmTemplate, setConfirmTemplate] = useState(null)
  const [query, setQuery] = useState('')
  const [tab, setTabState] = useState(SHARED.flowMenuTab || 'flows')
  const [showAll, setShowAll] = useState(false)
  useDismiss(ref, onClose, '.fc-menu-toggle')
  const onKeyDown = useMenuKeys(ref, onClose, returnFocus)
  useEffect(() => { focusEl(searchRef.current) }, [])
  const setTab = (next) => { SHARED.flowMenuTab = next; setTabState(next) }
  const model = flowMenuModel({ flows, templates, query, tab, showAll })
  const templateItem = (t) => {
    const mine = t.source === 'user'
    const armed = mine && confirmTemplate === t.id
    return h('div', {
      key: `t-${t.id}`,
      className: `fc-menu-item${t.available === false ? ' disabled' : ''}${armed ? ' danger' : ''}`,
      'data-fc-template': t.id,
      title: t.available === false ? `Needs: ${(t.missing_tools || []).join(', ')}` : t.description || '',
      role: 'menuitem',
      tabIndex: -1,
      'aria-disabled': t.available === false ? 'true' : undefined,
      onClick: () => t.available !== false && !armed && onFromTemplate(t.id)
    }, h(Icon, { name: mine ? 'bookmark' : 'symbol-structure' }),
    h('span', { className: 'fc-menu-name' }, armed ? 'Click the trash again to delete' : t.name || t.id),
    mine && onEditTemplate && !armed ? h('button', {
      key: 'edit', type: 'button', tabIndex: -1,
      className: 'fc-mini', title: 'Rename or describe', 'aria-label': `Edit template ${t.name || t.id}`, 'data-fc-template-edit': t.id,
      onClick: (e) => {
        e.stopPropagation()
        onEditTemplate(t)
      }
    }, h(Icon, { name: 'edit' })) : null,
    mine && onDeleteTemplate ? h('button', {
      key: 'delete', type: 'button', tabIndex: -1,
      className: `fc-mini${armed ? ' armed' : ''}`, title: armed ? 'Click again to delete' : 'Delete template',
      'aria-label': `Delete template ${t.name || t.id}`, 'data-fc-template-delete': t.id,
      onClick: (e) => {
        e.stopPropagation()
        if (!armed) return setConfirmTemplate(t.id)
        setConfirmTemplate(null)
        onDeleteTemplate(t)
      }
    }, h(Icon, { name: 'trash' })) : null)
  }
  const flowItem = (f) => {
    const st = f.last_run ? RUN_STATUS[f.last_run.status] : null
    return h('div', {
      key: f.id, className: `fc-menu-item${current && f.id === current.id ? ' active' : ''}`, 'data-fc-flow-item': f.id,
      role: 'menuitem', tabIndex: -1, 'aria-current': current && f.id === current.id ? 'true' : undefined,
      title: f.name || 'Untitled flow', onClick: () => onOpen(f.id)
    },
      h(Icon, { name: st ? st.icon : 'circle-large-outline', style: { color: st ? st.color : 'var(--ui-text-quaternary)' } }),
      h('span', { className: 'fc-menu-name' }, f.name || 'Untitled flow'),
      h('span', { className: 'fc-menu-meta' }, `${f.node_count} nodes · ${ago(f.updated_at)}`))
  }
  const firstHit = () => model.flows[0] ? () => onOpen(model.flows[0].id)
    : [...model.own, ...model.builtin].find((x) => x.available !== false)
      ? () => onFromTemplate([...model.own, ...model.builtin].find((x) => x.available !== false).id) : null
  const tabButton = (id, label, count) => h('div', {
    role: 'menuitem', tabIndex: -1, className: `fc-menu-tab${tab === id && !model.searching ? ' on' : ''}`,
    'data-fc-menu-tab': id, 'aria-pressed': tab === id ? 'true' : 'false', onClick: () => { setTab(id); setShowAll(false) }
  }, label, h('span', { className: 'fc-menu-count' }, String(count)))
  const label = (text) => h('div', { className: 'fc-menu-label' }, text)
  return h('div', { ref, className: 'fc-menu fc-flows-menu', role: 'menu', 'aria-label': 'Flows', tabIndex: -1, onKeyDown },
    h('div', { className: 'fc-menu-top' },
      h('div', { className: 'fc-menu-search' }, h(Icon, { name: 'search' }),
        h('input', {
          ref: searchRef, value: query, placeholder: 'Search flows and templates…', 'data-fc-menu-search': '1',
          'aria-label': 'Search flows and templates',
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              const go = firstHit()
              if (go) go()
            } else if (['Home', 'End', 'ArrowLeft', 'ArrowRight', ' ', 'Spacebar'].includes(e.key)) e.stopPropagation()
            else if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') }
          }
        })),
      model.searching ? null : h('div', { className: 'fc-menu-tabs' },
        tabButton('flows', 'Your flows', model.counts.flows), tabButton('templates', 'Templates', model.counts.templates))),
    h('div', { className: 'fc-menu-scroll' },
      model.searching ? null : h('div', { className: 'fc-menu-item', role: 'menuitem', tabIndex: -1, onClick: onNew },
        h(Icon, { name: 'add' }), h('span', { className: 'fc-menu-name' }, 'New blank flow')),
      model.empty ? h('div', { className: 'fc-menu-empty' }, `Nothing matches “${query.trim()}”.`) : null,
      model.searching && model.flows.length ? label('Your flows') : null,
      !model.searching && tab === 'flows' && !flows.length ? h('div', { className: 'fc-menu-empty' }, 'No flows yet. Start blank or from a template.') : null,
      model.flows.map(flowItem),
      model.moreFlows > 0 ? h('div', {
        className: 'fc-menu-item fc-menu-more', role: 'menuitem', tabIndex: -1, 'data-fc-flows-more': '1', onClick: () => setShowAll(true)
      }, h(Icon, { name: 'chevron-down' }), h('span', { className: 'fc-menu-name' }, `Show all ${model.counts.flows} flows`)) : null,
      model.own.length ? label('Your templates') : null,
      model.own.map(templateItem),
      model.builtin.length ? label(model.searching || model.own.length ? 'Built-in templates' : 'Start from a template') : null,
      model.builtin.map(templateItem)),
    current ? h('div', { className: 'fc-menu-foot', 'aria-label': 'This flow' },
      onSaveTemplate ? h('div', { className: 'fc-menu-item', role: 'menuitem', tabIndex: -1, 'data-fc-save-template': '1', title: 'Save this flow as a template…', onClick: onSaveTemplate },
        h(Icon, { name: 'save-as' }), h('span', { className: 'fc-menu-name' }, 'As template…')) : null,
      h('div', { className: 'fc-menu-item', role: 'menuitem', tabIndex: -1, 'data-fc-duplicate': '1', title: 'Duplicate this flow', onClick: onDuplicate },
        h(Icon, { name: 'copy' }), h('span', { className: 'fc-menu-name' }, 'Duplicate')),
      h('div', { className: 'fc-menu-item danger', role: 'menuitem', tabIndex: -1, 'data-fc-delete-flow': '1', title: 'Delete this flow',
        onClick: () => (confirmDelete ? onDelete() : setConfirmDelete(true)) },
      h(Icon, { name: 'trash' }), h('span', { className: 'fc-menu-name' }, confirmDelete ? 'Click again' : 'Delete'))) : null)
}

/** After flow trigger: searchable list of every flow (like the model picker). Stores the flow id. */
function FlowPicker({ api, value, ownId, onChange }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [flows, setFlows] = useState(null)
  const [error, setError] = useState(null)
  const [highlight, setHighlight] = useState(0)
  const wrapRef = useRef(null)
  const request = useRef(0)
  const load = () => {
    if (!api || typeof api.flows !== 'function') return
    const ticket = ++request.current
    api.flows().then((res) => {
      if (ticket !== request.current) return
      setFlows((res && res.flows) || [])
      setError(null)
    }, (e) => { if (ticket === request.current) setError(parseRestError(e).message) })
  }
  useEffect(() => { load(); return () => { request.current++ } }, [api])
  useEffect(() => {
    if (!open) return undefined
    const away = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [open])
  const others = (flows || []).filter((f) => f.id !== ownId)
  const chosen = flowPickerChoice(others, value)
  const shown = flowMenuModel({ flows: others, templates: [], query, showAll: true }).flows
  const index = Math.min(highlight, Math.max(0, shown.length - 1))
  const listId = `fc-flow-list-${ownId || 'picker'}`
  const optionId = (f) => `${listId}-${f.id}`
  const close = () => { setOpen(false); focusEl(wrapRef.current && wrapRef.current.querySelector('button')) }
  const pick = (f) => { onChange(f.id); close(); setQuery(''); setHighlight(0) }
  useLayoutEffect(() => {
    // Keep the whole chooser in the scrollable inspector, even with many flows in a short window.
    if (open) wrapRef.current?.querySelector('.fc-model-pop')?.scrollIntoView({ block: 'nearest' })
  }, [open, flows, query])
  useEffect(() => {
    if (open && wrapRef.current) wrapRef.current.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, highlight, query])
  return h('div', { className: 'fc-model', ref: wrapRef, 'data-fc-flow-picker': '1' },
    h('button', { type: 'button', className: `fc-input fc-model-btn${open ? ' open' : ''}`, 'aria-haspopup': 'listbox', 'aria-expanded': open,
      onClick: () => { if (!open) { setQuery(''); setHighlight(0); load() }; setOpen(!open) } },
    chosen ? h('span', null, chosen.name || 'Untitled flow') : h('span', { className: 'fc-muted' }, isBlank(value) ? 'Choose a flow…' : `${value} (not found)`),
    chosen ? h('span', { className: 'fc-model-prov' }, `${chosen.node_count} nodes`) : null,
    h(Icon, { name: 'chevron-down' })),
    open ? h('div', { className: 'fc-model-pop' },
      h('div', { className: 'fc-model-search' }, h(Icon, { name: 'search' }),
        h('input', { autoFocus: true, value: query, placeholder: 'Search flows…', 'data-fc-flow-search': '1',
          role: 'combobox', 'aria-label': 'Search flows', 'aria-controls': listId, 'aria-expanded': true,
          'aria-activedescendant': shown[index] ? optionId(shown[index]) : undefined,
          onChange: (e) => { setQuery(e.target.value); setHighlight(0) },
          onKeyDown: (e) => {
            e.stopPropagation()
            if (e.key === 'Escape') { e.preventDefault(); close() }
            else if (e.key === 'Tab') setOpen(false)
            else if (e.key === 'Enter' && shown[index]) { e.preventDefault(); pick(shown[index]) }
            else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shown.length) {
              e.preventDefault()
              setHighlight((index + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length)
            }
          } }),
        h('button', { type: 'button', className: 'fc-mini', title: 'Refresh flows', 'aria-label': 'Refresh flows',
          'data-fc-flow-refresh': '1', onClick: load }, h(Icon, { name: 'refresh' }))),
      h('div', { className: 'fc-model-list', id: listId, role: 'listbox', 'aria-label': 'Other flows' },
        error ? h('div', { className: 'fc-help fc-bad fc-model-note', 'data-fc-flow-error': '1' }, `Could not load flows: ${error}`) : null,
        !flows && !error ? h('div', { className: 'fc-help fc-model-note' }, 'Loading flows…') : null,
        flows && !shown.length ? h('div', { className: 'fc-help fc-model-note' }, query ? 'No flow matches.' : 'No other flows yet.') : null,
        shown.map((f, i) => {
          const st = f.last_run ? RUN_STATUS[f.last_run.status] : null
          return h('div', { key: f.id, id: optionId(f), role: 'option', 'aria-selected': !!(chosen && chosen.id === f.id),
            'data-fc-flow-option': f.id, 'data-highlighted': i === index ? 'true' : 'false', title: `${f.name || 'Untitled flow'} · ${f.id}`,
            className: `fc-model-item${chosen && chosen.id === f.id ? ' active' : ''}`, onMouseEnter: () => setHighlight(i), onClick: () => pick(f) },
          h('span', null, h(Icon, { name: st ? st.icon : 'circle-large-outline', style: { color: st ? st.color : 'var(--ui-text-quaternary)', marginRight: 6 } }), f.name || 'Untitled flow'),
          h('span', { className: 'fc-model-prov' }, `${f.node_count} nodes · ${ago(f.updated_at)}`))
        }))) : null)
}
/** The flow a stored After-flow value names: by id, else by (unique) name. Pure, tested. */
function flowPickerChoice(flows, value) {
  if (!Array.isArray(flows) || isBlank(value)) return null
  const v = String(value).trim()
  const byId = flows.find((f) => f.id === v)
  if (byId) return byId
  const byName = flows.filter((f) => String(f.name || '').trim().toLowerCase() === v.toLowerCase())
  return byName.length === 1 ? byName[0] : null
}

function SaveIndicator({ state, error }) {
  const map = {
    saved: ['check', 'Saved'],
    dirty: ['circle-filled', 'Unsaved'],
    saving: ['loading', 'Saving…'],
    error: ['error', 'Not saved'],
    conflict: ['warning', 'Conflict']
  }
  const [icon, label] = map[state] || map.saved
  return h('span', { className: `fc-save${state === 'error' || state === 'conflict' ? ' bad' : ''}`, title: error || label },
    h(Icon, { name: icon, spin: state === 'saving' }), label)
}

function Header(p) {
  const running = isRunActive(p.run)
  const f = p.flow
  const flowsBtn = useRef(null)
  // G9: rich tip per button. The wrapper span gets the pointer events a disabled button never fires.
  const tb = (id, el) => (el ? withTip(HEADER_TIPS[id], h('span', { className: 'fc-tipwrap', 'data-fc-header-tip': id }, el), 'bottom') : null)
  const tt = (id) => nativeTitle(HEADER_TIPS[id])
  const name = (id) => HEADER_TIPS[id].title
  return h('div', { className: 'fc-header' },
    h('div', { className: 'fc-menu-wrap' },
      tb('flows', h('button', {
        ref: flowsBtn, className: `fc-btn fc-menu-toggle${p.menuOpen ? ' active' : ''}`, title: tt('flows'),
        'aria-haspopup': 'menu', 'aria-expanded': p.menuOpen ? 'true' : 'false',
        onClick: () => p.setMenuOpen(!p.menuOpen),
        // U-8: ArrowDown/ArrowUp open the menu like every other menu button; focus lands on the first row.
        onKeyDown: (e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            p.setMenuOpen(true)
          }
        }
      },
        h(Icon, { name: 'type-hierarchy' }), 'Flows', h(Icon, { name: 'chevron-down' }))),
      p.menuOpen ? h(FlowMenu, {
        flows: p.flows, current: f, templates: p.templates, onOpen: p.onOpen, onNew: p.onNew,
        onFromTemplate: p.onFromTemplate, onDuplicate: p.onDuplicate, onDelete: p.onDelete, onClose: p.closeMenu,
        onSaveTemplate: p.onSaveTemplate, onEditTemplate: p.onEditTemplate, onDeleteTemplate: p.onDeleteTemplate,
        returnFocus: () => focusEl(flowsBtn.current)
      }) : null),
    f ? h(NameInput, { value: f.name || 'Untitled flow', onCommit: p.onRename }) : h('span', { className: 'fc-header-title' }, 'Arachne Flow'),
    f ? h(SaveIndicator, { state: p.saveState, error: p.saveError }) : null,
    h('span', { className: 'fc-grow' }),
    f ? tb('palette', h('button', { className: `fc-btn ghost icon${p.paletteOpen ? ' active' : ''}`, 'aria-label': name('palette'), title: tt('palette'), onClick: p.togglePalette }, h(Icon, { name: 'layout-sidebar-left' }))) : null,
    f ? tb('inspector', h('button', { className: `fc-btn ghost icon${p.inspectorOpen ? ' active' : ''}`, 'aria-label': name('inspector'), title: tt('inspector'), onClick: p.toggleInspector }, h(Icon, { name: 'layout-sidebar-right' }))) : null,
    f ? h('span', { className: 'fc-sep' }) : null,
    f ? tb('undo', h('button', { className: 'fc-btn ghost icon', 'aria-label': name('undo'), title: tt('undo'), disabled: !p.canUndo, onClick: p.onUndo }, h(Icon, { name: 'discard' }))) : null,
    f ? tb('redo', h('button', { className: 'fc-btn ghost icon', 'aria-label': name('redo'), title: tt('redo'), disabled: !p.canRedo, onClick: p.onRedo }, h(Icon, { name: 'redo' }))) : null,
    f ? tb('tidy', h('button', { className: 'fc-btn ghost', title: tt('tidy'), disabled: running || !f.nodes.length, onClick: p.onLayout }, h(Icon, { name: 'wand' }), 'Tidy')) : null,
    tb('generate', h('button', { className: 'fc-btn', title: tt('generate'), disabled: p.generationBusy, onClick: p.onGenerate },
      h(Icon, { name: 'sparkle' }), 'Build with Hermes')),
    tb('ask', h('button', { className: 'fc-btn ghost', title: tt('ask'), onClick: p.onAsk },
      h(Icon, { name: 'comment-discussion' }), 'Discuss in chat')),
    p.onShowHermes ? tb('unfocus', h('button', {
      className: 'fc-btn ghost icon', 'data-fc-unfocus': '1', 'aria-label': 'Show Hermes in this window',
      title: tt('unfocus'), onClick: p.onShowHermes
    }, h(Icon, { name: 'layout' }))) : null,
    f ? h('span', { className: 'fc-sep' }) : null,
    f && running ? tb('stop', h('button', { className: 'fc-btn danger', title: tt('stop'), onClick: p.onStop }, h(Icon, { name: 'debug-stop' }), 'Stop')) : null,
    f && !running ? tb('fresh', h('button', { className: 'fc-btn', title: tt('fresh'), disabled: !f.nodes.length, onClick: () => p.onRun({ fresh: true }) },
      h(Icon, { name: 'refresh' }), 'Fresh')) : null,
    f ? tb('run', h('button', {
      className: 'fc-btn primary', title: tt('run'), disabled: running || !f.nodes.length,
      onClick: (e) => p.onRun({ fresh: e.shiftKey })
    }, h(Icon, { name: running ? 'loading' : 'play', spin: running }), running ? 'Running…' : 'Run')) : null)
}

