// ---------------------------------------------------------------- small components
// ---------------------------------------------------------------- G9: rich tooltips + live clock
const richTips = () => typeof sdk.Tip === 'function'
/** Native `title` only when the app offers no rich Tip (old Desktop); never both at once. */
const nativeTitle = (tip) => (richTips() ? undefined : tipText(tip))
/** Small tooltip card in the palette-tip look: tinted head (icon or port dot, title, kind, keys), lines, foot. */
function TipCard({ tip }) {
  const color = tip.color || (tip.tone === 'bad' ? 'var(--ui-red)' : tip.tone === 'warn' ? 'var(--ui-yellow)' : 'var(--ui-accent)')
  return h('div', { className: 'fc-tt fc-tt-sm', 'data-fc-tip': tip.id, 'data-tone': tip.tone || undefined, style: { '--fc-cat': color } },
    h('div', { className: 'fc-tt-head' },
      tip.icon ? h('span', { className: 'fc-node-icon' }, h(Icon, { name: tip.icon }))
        : tip.color ? h('i', { className: 'fc-tt-dot', style: { '--fc-port': tip.color } }) : null,
      h('span', { className: 'fc-tt-title' }, tip.title),
      tip.kind ? h('span', { className: 'fc-tt-kind' }, tip.kind) : null,
      tip.keys && tip.keys.length ? h('span', { className: 'fc-tt-keys' }, tip.keys.map((k, i) => h('kbd', { key: i }, k))) : null),
    tip.lines && tip.lines.length ? h('div', { className: 'fc-tt-body' }, tip.lines.map((l, i) => h('div', { key: i, className: 'fc-tt-line' }, l))) : null,
    tip.foot ? h('div', { className: 'fc-tt-foot' }, h(Icon, { name: 'info' }), tip.foot) : null)
}
/** Wraps one DOM element in the app's Tip with a TipCard. Without Tip the element keeps its nativeTitle. */
function withTip(tip, el, side = 'top', key) {
  if (!tip || !el || !richTips()) return el
  return h(sdk.Tip, { key, label: h(TipCard, { tip }), side, sideOffset: 8, className: 'fc-tt-bubble' }, el)
}
/** While a wire is being pulled nothing may pop up. Every rich tip Arachne renders carries one of its own bubble
 *  classes (`fc-tt-bubble`, `fc-tip-bubble`), so the canvas renders this rule only for the length of the drag:
 *  it hides only our bubbles, never touches app markup, and lifts the moment the wire is dropped or cancelled. */
const WIRE_TIP_CSS = '.fc-tt-bubble, .fc-tip-bubble { display: none !important; }'
/** Native `title` tips inside the plugin are muted for the drag and restored afterwards, but only where the
 *  title is still the one we muted (a re-render that set a new title wins). Returns the restore function. */
function muteTitles(scope) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return () => {}
  const saved = []
  for (const el of scope.querySelectorAll('[title]:not([title=""])')) {
    saved.push({ el, text: el.getAttribute('title') })
    el.setAttribute('title', '')
  }
  return () => {
    for (const { el, text } of saved) if (el.isConnected && el.getAttribute('title') === '') el.setAttribute('title', text)
  }
}
/** Mutes the plugin's native titles exactly while a wire drag is live (`ref`: any element inside the page). */
function useWireTipGuard(wire, ref) {
  useEffect(() => {
    if (!wire) return undefined
    const el = ref.current
    return muteTitles(el && el.closest ? el.closest('.fc-root') || el : el)
  }, [!!wire])
}
/** Current time, re-rendering every `ms` while `active` (live clocks on running nodes and runs). */
function useNow(active, ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [active, ms])
  return now
}
const sinceMs = (iso, now) => {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? Math.max(0, now - t) : null
}

function StatusBadge({ state, exp = null, nameOf, showMs = true, side = 'top', branchName = '' }) {
  const s = STATUS[state.status] || STATUS.queued
  const running = state.status === 'running'
  const now = useNow(running)
  const elapsed = running ? sinceMs(state.started_at, now) : null
  const clock = elapsed !== null ? formatClock(elapsed) : ''
  const label = !showMs && !running ? '' : badgeLabel(state, clock)
  const usual = running && !state.items && exp && exp.n > 0 ? h('span', { className: 'fc-badge-exp' }, `/ ~${formatMs(exp.avg_ms)}`) : null
  const tip = { ...statusTip(state, exp, now, nameOf, branchName), icon: s.icon }
  return withTip(tip, h('span', {
    className: 'fc-badge', style: { '--fc-st': s.color }, 'data-fc-status': state.status,
    'data-fc-clock': running && clock ? clock : undefined, 'data-fc-items': state.items ? itemsFinished(state.items) : undefined,
    title: nativeTitle(tip)
  }, h(Icon, { name: s.icon, spin: s.spin }), label, usual), side)
}

function RunChip({ run }) {
  const s = RUN_STATUS[run.status] || RUN_STATUS.queued
  const active = isRunActive(run)
  const now = useNow(active)
  const counts = countStatuses(run)
  const total = (run.order && run.order.length) || Object.keys(run.nodes || {}).length
  const finished = (counts.done || 0) + (counts.cached || 0)
  const elapsed = active ? sinceMs(run.started_at, now) : null
  const tip = { ...runTip(run, now), icon: s.icon }
  return withTip(tip, h('span', { className: 'fc-runchip', style: { '--fc-st': s.color }, 'data-fc-runchip': run.status, title: nativeTitle(tip) },
    h(Icon, { name: s.icon, spin: s.spin }),
    s.label,
    total > 0 ? h('span', { className: 'fc-muted' }, ` · ${finished}/${total} steps`) : null,
    counts.cached > 0 ? h('span', { className: 'fc-muted' }, ` · ${counts.cached} cached`) : null,
    elapsed !== null ? h('span', { className: 'fc-muted', 'data-fc-run-clock': '1' }, ` · ${formatClock(elapsed)}`) : null,
    run.ms !== undefined && run.ms !== null && TERMINAL.has(run.status) ? h('span', { className: 'fc-muted' }, ` · ${formatMs(run.ms)}`) : null))
}

/** Did a clipboard write succeed? The app's SDK resolves undefined on success and `false` when the host refused;
 *  a write that throws is a failure the caller catches. Pure, tested. */
const clipboardOk = (res) => res !== false

function CopyBtn({ text, title = 'Copy' }) {
  const [done, setDone] = useState(false)
  const copy = async (e) => {
    e.stopPropagation()
    // U-18: the check mark means "it worked" — never show it for a refused or missing clipboard write.
    let ok = false
    try {
      if (typeof sdk.writeClipboardText === 'function') ok = clipboardOk(await sdk.writeClipboardText(text))
    } catch {
      ok = false
    }
    setDone(ok)
    if (ok) setTimeout(() => setDone(false), 1200)
  }
  return h('button', { className: 'fc-btn ghost icon fc-copy', title, onClick: copy }, h(Icon, { name: done ? 'check' : 'copy' }))
}

function NameInput({ value, onCommit }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const v = draft.trim()
    if (v && v !== value) onCommit(v)
    else setDraft(value)
  }
  return h('input', {
    className: 'fc-title-input',
    value: draft,
    size: Math.max(10, Math.min(40, draft.length + 2)),
    title: 'Rename this flow',
    onChange: (e) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e) => {
      if (e.key === 'Enter') e.currentTarget.blur()
      if (e.key === 'Escape') {
        setDraft(value)
        const el = e.currentTarget
        setTimeout(() => el.blur(), 0)
      }
    }
  })
}

function useDismiss(ref, onClose, ignoreSelector) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && ref.current.contains(e.target)) return
      if (ignoreSelector && e.target.closest && e.target.closest(ignoreSelector)) return
      close.current()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') close.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}

/** Review U-8: a menu that opens puts focus on its first row; arrows/Home/End move, Enter/Space activates the
 *  focused row (a real click, so the row's own handler decides), Escape/Tab close it and hand focus back to the
 *  control that opened it. */
function useMenuKeys(ref, onClose, returnFocus) {
  const root = useRef(null)
  const keyboard = useRef(false)   // the last thing that happened in this menu was a key, not a pointer
  useEffect(() => {
    const el = ref.current
    root.current = el && el.closest ? el.closest('.fc-root') : null
    const pointer = () => { keyboard.current = false }
    window.addEventListener('pointerdown', pointer, true)
    focusEl(menuRowsIn(el)[0])
    return () => {
      window.removeEventListener('pointerdown', pointer, true)
      // A row activated by key can close the menu from its own handler (open another flow, duplicate): without
      // this, focus falls to <body> and the canvas shortcuts stay dead until the user clicks the canvas.
      if (!keyboard.current) return
      const active = document.activeElement
      if (active && active !== document.body && active.isConnected) return   // a dialog or a field took it
      const back = returnFocus ? returnFocus() : null
      if (!back || !back.isConnected) focusEl(root.current)
    }
  }, [])
  return (e) => {
    const rows = menuRowsIn(ref.current)
    const at = rows.indexOf(document.activeElement)
    const next = menuKeyNav(at, rows.length, e.key)
    if (next === null) return
    e.preventDefault()
    e.stopPropagation()
    if (next === 'close') {
      onClose()
      if (returnFocus) returnFocus()
    } else if (next === 'activate') {
      const row = rows[at]
      if (!row) return
      const delId = row.getAttribute ? row.getAttribute('data-fc-template-delete') : null
      keyboard.current = true
      row.click()
      // A row that keeps the menu open re-renders it and drops the focused node: put the keyboard back on it.
      setTimeout(() => {
        const el = ref.current
        const active = document.activeElement
        if (!el || !el.isConnected) return
        if (active && active !== document.body && active.isConnected) return   // a dialog took it: leave it there
        const now = menuRowsIn(el)
        const target = (delId && now.find((n) => n.getAttribute && n.getAttribute('data-fc-template-delete') === delId)) ||
          (now.includes(row) ? row : now[Math.min(at, now.length - 1)])
        if (target) focusEl(target)
      }, 0)
    } else {
      focusEl(rows[next])
      rows[next]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    }
  }
}

function MenuItems({ items, onClose }) {
  return items.map((it, i) => (it === '-'
    ? h('div', { key: `sep${i}`, className: 'fc-menu-sep' })
    : h('div', {
      key: it.label,
      className: `fc-menu-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`,
      title: it.title || '',
      role: 'menuitem',
      tabIndex: -1,
      'aria-disabled': it.disabled ? 'true' : undefined,
      onClick: () => {
        if (it.disabled) return
        onClose()
        it.run()
      }
    }, h(Icon, { name: it.icon || 'blank' }), h('span', { className: 'fc-menu-name' }, it.label), it.hint ? h('span', { className: 'fc-menu-meta' }, it.hint) : null)))
}

function ContextMenu({ menu, items, onClose }) {
  const ref = useRef(null)
  useDismiss(ref, onClose)
  const onKeyDown = useMenuKeys(ref, onClose, () => focusPluginRoot(ref.current))
  return h('div', {
    ref,
    className: 'fc-menu fc-ctx',
    role: 'menu',
    'aria-label': 'Canvas menu',
    tabIndex: -1,
    style: { left: menu.x, top: menu.y },
    onPointerDown: (e) => e.stopPropagation(),
    onContextMenu: (e) => e.preventDefault(),
    onKeyDown
  }, h(MenuItems, { items, onClose }))
}

