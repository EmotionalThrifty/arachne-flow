// ---------------------------------------------------------------- inspector
/** Tool picker label: the title (the group already names the server); the raw tool name only where two tools
 *  of one group share a title. Long raw names (mcp__server__tool) clipped the select. Pure, tested. */
function toolOptionLabel(t, group) {
  const name = (t && (t.title || t.tool || t.type)) || ''
  const twins = ((group && group.items) || []).filter((x) => (x.title || x.tool || x.type) === name).length
  return twins > 1 ? `${name} · ${t.tool || t.type}` : name
}

function ToolSelect({ types, value, missing, className, onChange, title }) {
  const groups = toolChoices(types)
  const known = groups.some((g) => g.items.some((t) => t.type === value))
  const current = known ? groups.flatMap((g) => g.items).find((t) => t.type === value) : null
  const hover = [current ? current.tool || current.type : null, title].filter(Boolean).join('\n') || undefined
  return h('select', { className: className || 'fc-input', value: value || '', title: hover, onChange: (e) => onChange(e.target.value) },
    !known ? h('option', { value: value || '' }, value ? `${missing || value} (missing)` : '— pick a tool —') : null,
    groups.map((g) => h('optgroup', { key: g.category, label: g.category },
      g.items.map((t) => h('option', { key: t.type, value: t.type, title: t.tool || t.type }, toolOptionLabel(t, g))))))
}

/** Small "i" next to a label; hover or keyboard focus shows the explanation (app tooltip when available). */
function InfoTip({ lines }) {
  const list = (Array.isArray(lines) ? lines : [lines]).filter(Boolean)
  if (!list.length) return null
  const text = list.join('\n')
  const icon = h('span', { className: 'fc-info', tabIndex: 0, role: 'img', 'aria-label': text, title: typeof sdk.Tip === 'function' ? undefined : text },
    h(Icon, { name: 'info' }))
  if (typeof sdk.Tip !== 'function') return icon
  return h(sdk.Tip, { label: h('div', { className: 'fc-tip' }, list.map((l, i) => h('div', { key: i }, l))), side: 'top', className: 'fc-tip-bubble' }, icon)
}

function loadModelOptions(refresh = false) {
  if (!refresh && SHARED.modelOptions) return SHARED.modelOptions
  if (typeof host.request !== 'function') return Promise.reject(new Error('Hermes gateway is not available'))
  const p = host.request('model.options', refresh ? { explicit_only: true, refresh: true } : { explicit_only: true }, 30000)
  SHARED.modelOptions = p
  p.catch(() => {
    if (SHARED.modelOptions === p) SHARED.modelOptions = null
  })
  return p
}

/** Puts a `position: fixed` popup under `anchor` (above it when there is clearly more room there), inside
 *  `bounds`, and caps its scrolling list to the space left. Corrects for a transformed ancestor by measuring. */
function placeFloating(pop, anchor, bounds, gap = 4) {
  const a = anchor.getBoundingClientRect()
  const b = bounds ? bounds.getBoundingClientRect() : { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight }
  const list = pop.querySelector('.fc-model-list')
  const below = b.bottom - a.bottom - gap - 8
  const above = a.top - b.top - gap - 8
  const up = below < 220 && above > below
  const chrome = pop.offsetHeight - (list ? list.offsetHeight : 0)
  if (list) list.style.maxHeight = `${Math.max(96, Math.min(320, (up ? above : below) - chrome))}px`
  const width = Math.min(Math.max(a.width, 260), b.right - b.left - 16)
  const left = Math.max(b.left + 8, Math.min(a.left, b.right - 8 - width))
  const top = up ? a.top - gap - pop.offsetHeight : a.bottom + gap
  pop.style.width = `${width}px`
  pop.style.left = `${left}px`
  pop.style.top = `${top}px`
  const got = pop.getBoundingClientRect()          // a transformed ancestor shifts `fixed`: correct by the offset
  if (Math.abs(got.left - left) > 0.5) pop.style.left = `${2 * left - got.left}px`
  if (Math.abs(got.top - top) > 0.5) pop.style.top = `${2 * top - got.top}px`
}
/** Searchable model dropdown, grouped by provider. Empty value = Hermes' active model. */
function ModelPicker({ model, provider, onChange, eager = false, disabled = false }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const wrapRef = useRef(null)
  const popRef = useRef(null)
  const load = (refresh) => {
    setLoading(true)
    setError(null)
    loadModelOptions(refresh).then((d) => setData(d || {}), (e) => setError(parseRestError(e).message)).finally(() => setLoading(false))
  }
  useEffect(() => {
    if ((open || eager) && !data && !loading) load(false)
    if (!open) return undefined
    const away = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [open, eager])
  useLayoutEffect(() => {
    // In the Build composer the list floats over the dialog instead of growing it: place it under (or above) the
    // button, inside the visible Arachne page, and shrink the list to the room that is there.
    const wrap = wrapRef.current
    if (!open || !wrap || !wrap.closest('.fc-generate-card')) return undefined
    const place = () => {
      const pop = popRef.current
      const btn = wrap.querySelector('.fc-model-btn')
      if (!pop || !btn) return
      placeFloating(pop, btn, wrap.closest('.fc-modal-scrim, .fc-root'))
    }
    place()
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [open, data, query])
  const groups = useMemo(() => modelGroups(data), [data])
  const { groups: shown, hidden } = useMemo(() => filterModelGroups(groups, query), [groups, query])
  const providerName = (slug) => (groups.find((g) => g.slug === slug) || {}).name || slug
  const active = data && data.model ? `${data.model}${data.provider ? ` · ${providerName(data.provider)}` : ''}` : 'active model'
  const pick = (next) => {
    onChange(next)
    setOpen(false)
    setQuery('')
  }
  const first = shown.length ? { provider: shown[0].slug, model: shown[0].models[0] } : null
  const label = isBlank(model)
    ? h('span', { className: 'fc-muted' }, data && data.model ? `Current · ${data.model}` : 'Current Hermes model')
    : h('span', null, String(model))
  return h('div', { className: 'fc-model', ref: wrapRef, 'data-fc-model-picker': '1' },
    h('button', {
      type: 'button', className: `fc-input fc-model-btn${open ? ' open' : ''}`, 'aria-haspopup': 'listbox', 'aria-expanded': open,
      disabled, onClick: () => setOpen(!open)
    }, label,
    !isBlank(model) && !isBlank(provider) ? h('span', { className: 'fc-model-prov' }, providerName(provider)) : null,
    h(Icon, { name: 'chevron-down' })),
    open ? h('div', { className: 'fc-model-pop', role: 'listbox', ref: popRef },
      h('div', { className: 'fc-model-search' },
        h(Icon, { name: 'search' }),
        h('input', {
          autoFocus: true, value: query, placeholder: 'Search models or providers…',
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
            if (e.key === 'Enter' && first) { e.preventDefault(); pick(first) }
          }
        }),
        h('button', { type: 'button', className: 'fc-btn ghost icon', title: 'Reload the model lists from your providers', onClick: () => load(true) },
          h(Icon, { name: 'refresh', spin: loading }))),
      h('div', { className: 'fc-model-list' },
        h('div', { className: `fc-model-item${isBlank(model) ? ' active' : ''}`, 'data-fc-model-default': '1', onClick: () => pick({ provider: null, model: null }) },
          h('span', null, 'Current Hermes model'), h('span', { className: 'fc-model-prov' }, active)),
        loading && !data ? h('div', { className: 'fc-help fc-model-note' }, 'Loading models…') : null,
        error ? h('div', { className: 'fc-help fc-bad fc-model-note' }, `Could not load models: ${error}`) : null,
        data && !shown.length ? h('div', { className: 'fc-help fc-model-note' }, query ? 'No model matches.' : 'No configured providers found.') : null,
        shown.map((g) => h('div', { key: g.slug, className: 'fc-model-group', 'data-fc-provider': g.slug },
          h('div', { className: 'fc-model-head' }, g.name, g.current ? h('span', { className: 'fc-model-tag' }, 'active') : null,
            h('span', { className: 'fc-model-count' }, String(g.models.length))),
          g.models.map((m) => {
            const price = g.prices[m]
            const caps = g.caps[m] || {}
            const tip = [m, price ? `Input ${price.input || '?'} · Output ${price.output || '?'} per Mtok` : null,
              caps.reasoning === false ? 'No reasoning' : caps.reasoning ? 'Reasoning' : null].filter(Boolean).join('\n')
            return h('div', {
              key: m, title: tip, 'data-fc-model': m, 'data-fc-model-provider': g.slug,
              className: `fc-model-item${m === model && g.slug === provider ? ' active' : ''}`,
              onClick: () => pick({ provider: g.slug, model: m })
            }, h('span', null, m), price ? h('span', { className: 'fc-model-prov' }, `in ${price.input || '–'} / out ${price.output || '–'}`) : null)
          }))),
        hidden > 0 ? h('div', { className: 'fc-help fc-model-note' }, `${hidden} more — type to narrow the list.`) : null)) : null)
}

/** Controlled G6 composer. The parent owns draft/busy/error so a failed request loses none of the input. */
function GenerateComposer({ flow, generation, onEdit, onSubmit, onCancel, onStop, inline = false }) {
  const { draft, busy, error } = generation
  const now = useNow(busy)
  const submit = () => {
    if (!busy && draft.prompt.trim()) onSubmit()
  }
  return h('div', {
    className: 'fc-generate-card', 'data-fc-generate': '1',
    onPointerDown: inline ? (e) => e.stopPropagation() : undefined,
    onMouseDown: inline ? (e) => e.stopPropagation() : undefined
  },
    h('div', { className: 'fc-generate-head' }, h(Icon, { name: 'sparkle' }),
      flow ? 'Build with Hermes · edit this flow' : 'Build a new flow with Hermes'),
    h('div', { className: 'fc-help' }, 'Describe the result. Hermes adds or changes nodes and connections, validates the graph, and does not run it.'),
    h('textarea', {
      className: 'fc-input', 'data-fc-generate-prompt': '1', value: draft.prompt, disabled: busy,
      autoFocus: !inline, rows: 4,
      placeholder: flow ? 'e.g. Add a preview after the LLM and tidy the layout…' : 'e.g. Turn an idea into an image and show the result…',
      onChange: (e) => onEdit({ prompt: e.target.value }),
      onKeyDown: (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit() }
        if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel() }
      }
    }),
    h('div', { className: 'fc-generate-controls' },
      h('div', { className: 'fc-generate-model' }, h('label', null, 'Model · all configured providers'),
        h(ModelPicker, {
          model: draft.model, provider: draft.provider, eager: true, disabled: busy,
          onChange: ({ model, provider }) => onEdit({ model, provider })
        })),
      h('div', { className: 'fc-row' },
        onCancel ? h('button', { type: 'button', className: 'fc-btn', disabled: busy, onClick: onCancel }, 'Cancel') : null,
        h('button', {
          type: 'button', className: 'fc-btn primary', 'data-fc-generate-submit': '1',
          disabled: busy || !draft.prompt.trim(), title: 'Build and validate the graph (Ctrl+Enter)', onClick: submit
        }, h(Icon, { name: busy ? 'loading' : 'sparkle', spin: busy }), busy ? 'Building…' : flow ? 'Apply changes' : 'Build flow'))),
    busy ? h('div', { className: 'fc-generate-busy fc-row', 'data-fc-generate-status': '1', role: 'status' },
      h('span', null, generationStatus(generation.phase, generationElapsed(generation, now))),
      onStop ? h('button', {
        type: 'button', className: 'fc-btn', 'data-fc-generate-stop': '1', disabled: !generation.jobId,
        title: 'Stop this build; nothing is saved', onClick: onStop
      }, 'Stop') : null) : null,
    error ? h('div', { className: 'fc-generate-error', 'data-fc-generate-error': '1', role: 'alert' }, error) : null)
}

/** "$0.01" style price label; null when unknown. */
function formatPrice(price) {
  if (typeof price !== 'number' || !(price > 0)) return null
  return price < 0.1 ? `$${price.toFixed(price < 0.01 ? 4 : 3).replace(/0+$/, '')}` : `$${price.toFixed(2)}`
}

