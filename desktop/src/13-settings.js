// ---------------------------------------------------------------- G7: settings from schema + chosen model
const MODEL_DRIVEN = ['size', 'n', 'duration', 'resolution', 'aspect_ratio', 'quality']

/** The model setting a node's `from_model` settings follow and the model in effect (value, else preset default). */
function modelSetting(spec, params = {}) {
  const fields = (spec && spec.params) || []
  const m = fields.find((f) => f.options_source && f.options_source !== 'messaging_channels')
  if (!m) return null
  const value = (params || {})[m.name]
  const auto = !!m.auto && isBlank(value) && isBlank(m.default)
  const mode = auto ? String((params || {})[m.auto] || 'cheapest') : ''
  const out = { param: m.name, model: !isBlank(value) ? String(value) : !isBlank(m.default) ? String(m.default) : '' }
  return m.auto ? { ...out, auto, mode } : out
}

/** The model a blank `auto` setting runs with: cheapest (mode 'best': priciest) priced option, else the first.
 *  Mirrors engine presets.auto_pick. Pure, tested. */
function autoPick(options, mode = 'cheapest') {
  const list = (Array.isArray(options) ? options : []).filter((o) => o && typeof o.value === 'string' && o.value)
  const priced = list.filter((o) => typeof o.price === 'number' && Number.isFinite(o.price))
  const better = mode === 'best' ? (a, b) => b.price > a.price : (a, b) => b.price < a.price
  if (priced.length) return priced.reduce((a, b) => (better(a, b) ? b : a))
  return list[0] || null
}

/**
 * Setting spec (+ the chosen model's field from GET /x/options&model=) → what the inspector renders. Pure, tested.
 * Model choices win over the schema; model bounds only narrow the schema's.
 */
function fieldControl(spec, mf) {
  const m = mf && typeof mf === 'object' ? mf : null
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const ctl = { kind: spec.kind, options: [], fromModel: false, min: num(spec.min), max: num(spec.max),
    minExclusive: !!spec.min_exclusive, maxExclusive: !!spec.max_exclusive, integer: !!spec.integer,
    step: num(spec.step), modelDefault: m && !isBlank(m.default) ? String(m.default) : null,
    description: m && m.description ? String(m.description) : null }
  if (m && Array.isArray(m.options) && m.options.length && spec.kind !== 'multiselect' && spec.kind !== 'boolean') {
    ctl.kind = 'select'
    ctl.fromModel = true
    ctl.options = m.options.filter((o) => o && o.value !== undefined && o.value !== null).map((o) => ({
      value: String(o.value), label: String(o.label || o.value), raw: o.value,
      price: typeof o.price === 'number' ? (formatPrice(o.price) || '$0') + (o.unit || '') : null
    }))
  } else if (spec.kind === 'select' || spec.kind === 'multiselect') {
    ctl.options = (spec.options || []).map((o) => ({ value: String(o), label: String(o), raw: o, price: null }))
  }
  if (m) {
    if (num(m.min) !== null && (ctl.min === null || m.min > ctl.min)) { ctl.min = m.min; ctl.minExclusive = false }
    if (num(m.max) !== null && (ctl.max === null || m.max < ctl.max)) { ctl.max = m.max; ctl.maxExclusive = false }
    if (m.integer) ctl.integer = true
    if (ctl.step === null && num(m.step) !== null) ctl.step = m.step
  }
  // A free text setting that only takes numbers (e.g. duration: number | "auto") gets the number field once bounded.
  if (ctl.kind === 'text' && spec.numeric && (ctl.min !== null || ctl.max !== null)) ctl.kind = 'number'
  ctl.hint = rangeHint(ctl)
  return ctl
}

/** "1–4 · whole numbers", "> 0", "≤ 10"; empty without bounds. Pure, tested. */
function rangeHint(ctl) {
  const f = (v) => String(+v.toFixed(6))
  const parts = []
  if (ctl.min !== null && ctl.max !== null && !ctl.minExclusive && !ctl.maxExclusive) parts.push(`${f(ctl.min)}–${f(ctl.max)}`)
  else {
    if (ctl.min !== null) parts.push(`${ctl.minExclusive ? '>' : '≥'} ${f(ctl.min)}`)
    if (ctl.max !== null) parts.push(`${ctl.maxExclusive ? '<' : '≤'} ${f(ctl.max)}`)
  }
  if (ctl.integer && parts.length) parts.push('whole numbers')
  if (ctl.step !== null && !ctl.integer && parts.length) parts.push(`steps of ${f(ctl.step)}`)
  return parts.join(' · ')
}

/** Why a number does not fit the bounds, or null. Text values are left to the tool. Pure, tested. */
function numberIssue(value, ctl) {
  if (isBlank(value) || typeof value !== 'number') return null
  const outside = (ctl.min !== null && (ctl.minExclusive ? value <= ctl.min : value < ctl.min)) ||
    (ctl.max !== null && (ctl.maxExclusive ? value >= ctl.max : value > ctl.max))
  if (outside) return `Outside the allowed range (${ctl.hint}).`
  if (ctl.integer && !Number.isInteger(value)) return 'Must be a whole number.'
  return null
}

/** Select value → stored value: schema enums keep their JSON type, numeric settings store numbers. Pure, tested. */
function choiceValue(raw, spec, ctl) {
  if (raw === '') return null
  const o = ctl.options.find((x) => x.value === raw)
  if (o && !ctl.fromModel) return o.raw
  if ((spec.kind === 'number' || spec.numeric) && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

/** Multi-select value (list, or legacy JSON text) → string values. Pure, tested. */
function multiValues(value) {
  let v = value
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return [] }
  }
  return Array.isArray(v) ? v.map(String) : []
}

/** Media field value → clean string[] (scalar, array or legacy JSON list). Pure, tested. */
function mediaValues(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
  if (typeof value !== 'string' || !value.trim()) return []
  const text = value.trim()
  if (text.startsWith('[')) {
    try { return mediaValues(JSON.parse(text)) } catch { /* a plain path/URL is not JSON */ }
  }
  return [text]
}

/** Browse result → stored media value: replace a scalar, append uniquely to a bounded list. Pure, tested. */
function addMediaPath(value, path, { multiple = false, maxItems = null } = {}) {
  const clean = String(path || '').trim()
  if (!multiple) return clean || value
  const items = mediaValues(value)
  if (!clean || items.includes(clean) || (Number.isFinite(maxItems) && items.length >= maxItems)) return items
  return [...items, clean]
}

/** Toggle one choice; the result keeps the options' order and raw types. Pure, tested. */
function toggleChoice(value, option, options) {
  const have = new Set(multiValues(value))
  if (have.has(option.value)) have.delete(option.value)
  else have.add(option.value)
  return options.filter((o) => have.has(o.value)).map((o) => o.raw)
}

/** G7b: show a model setting? `show_when` = {other setting: value | [values]} from the model list. Pure, tested. */
function extraVisible(p, values) {
  const cond = p && p.show_when
  if (!cond || typeof cond !== 'object') return true
  return Object.entries(cond).every(([k, want]) => {
    const have = values ? values[k] : undefined
    const list = (Array.isArray(want) ? want : [want]).map(String)
    return !isBlank(have) && list.includes(String(have))
  })
}

/** Values in effect for `show_when`: what the node stores, else each setting's model default. Pure, tested. */
function extraValues(extras, params = {}) {
  const out = {}
  for (const p of extras || []) if (!isBlank(p.default)) out[p.name] = p.default
  for (const [k, v] of Object.entries(params || {})) if (!isBlank(v)) out[k] = v
  return out
}

/** A model setting from GET /x/options&model= → [inspector spec, model field] for ParamField. Pure, tested. */
function extraSpec(p) {
  const kind = { boolean: 'boolean', number: 'number', json: 'json', media: 'media', media_list: 'media_list' }[p.kind] || 'text'
  const spec = { name: p.name, kind, label: p.label || p.name, default: p.default === undefined ? null : p.default, extra: true }
  if (p.media_kind) spec.media_kind = p.media_kind
  for (const key of ['min_items', 'max_items']) if (p[key] !== undefined) spec[key] = p[key]
  if (p.description) spec.description = p.description
  if (p.required) spec.required = true
  if (p.numeric || p.kind === 'number') spec.numeric = true
  return [spec, p]
}

/** The value each model-driven setting has in effect: node value, else spec default, else the model's default. */
function effectiveValues(spec, params = {}, modelFields = {}) {
  const out = {}
  const fields = new Map(((spec && spec.params) || []).map((f) => [f.name, f]))
  for (const name of MODEL_DRIVEN) {
    const v = (params || {})[name]
    const f = fields.get(name)
    const mf = modelFields[name]
    if (!isBlank(v)) out[name] = v
    else if (f && !isBlank(f.default)) out[name] = f.default
    else if (mf && !isBlank(mf.default)) out[name] = mf.default
  }
  return out
}

/**
 * Cost data from the model list (engine/options.py model_cost) × the node's settings → {label, lines} or null.
 * Only multiplies what the list states (per image × n, per second × duration, per clip, per run). Pure, tested.
 */
function estimateCost(cost, values = {}) {
  if (!cost || typeof cost !== 'object') return null
  const money = (v) => formatPrice(v) || '$0'
  const unit = { image: 'image', second: 'second', video: 'clip', run: 'run' }[cost.unit] || 'run'
  const lines = []
  let label = null
  const byValue = cost.by ? values[cost.by] : undefined
  let rate = cost.by && cost.prices && !isBlank(byValue) ? cost.prices[String(byValue)] : undefined
  if (typeof rate !== 'number') rate = typeof cost.base === 'number' ? cost.base : null
  const minimum = typeof cost.minimum === 'number' ? cost.minimum : 0
  if (rate !== null) {
    const raw = cost.times ? values[cost.times] : 1
    const times = cost.times === 'n' && isBlank(raw) ? 1 : Number(raw)
    if (Number.isFinite(times) && times > 0) {
      const total = Math.max(rate * times, minimum)
      label = `≈ ${money(total)}`
      const per = `${money(rate)} per ${unit}${cost.by && !isBlank(byValue) ? ` (${cost.by} ${byValue})` : ''}`
      lines.push(times === 1 && cost.unit !== 'second' ? per : `${per} × ${times}${cost.unit === 'second' ? ' s' : ''} = ${money(rate * times)}`)
    } else {
      label = `${money(rate)}/${cost.unit === 'second' ? 's' : unit}`
      lines.push(`${money(rate)} per ${unit}; the total depends on ${cost.times}.`)
    }
  } else if (cost.prices) {
    const all = Object.values(cost.prices).filter((v) => typeof v === 'number' && v > 0)
    if (all.length) {
      label = `from ${money(Math.min(...all))}`
      lines.push(`From ${money(Math.min(...all))} per ${unit}, depending on ${cost.by}.`)
    }
  }
  if (Array.isArray(cost.range) && cost.range.length === 2) {
    lines.push(`${money(cost.range[0])}–${money(cost.range[1])} per ${unit} depending on the model settings; the estimate uses the model's default variant.`)
  }
  if (minimum) {
    lines.push(`At least ${money(minimum)} per run.`)
    if (!label) label = `≥ ${money(minimum)}`
  }
  if (cost.note) lines.push(String(cost.note))
  if (!label && !lines.length) return null
  lines.push('List price from the model list (USD); the provider bills the final amount.')
  return { label: label || 'see note', lines }
}

/** What Hermes' picker payload already knows about a model (per provider). Pure, tested. */
function llmPickerInfo(payload, provider, model) {
  const rows = (payload && Array.isArray(payload.providers)) ? payload.providers : []
  const row = rows.find((r) => r.slug === provider) || {}
  const price = (row.pricing || {})[model]
  const caps = (row.capabilities || {})[model]
  return {
    provider: row.name || provider || '', apiUrl: row.api_url || '',
    hermesPricing: price ? { input: price.input, output: price.output, cache: price.cache } : null,
    pricingPending: !!row.pricing_pending,
    caps: caps || null
  }
}

/** Rows for the LLM node's model info, merging Hermes' picker data with the provider's own catalog. Pure, tested. */
function llmInfoRows(info) {
  if (!info) return []
  const fmt = (n) => n >= 1000000 ? `${+(n / 1000000).toFixed(2)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n)
  const rows = []
  if (info.provider) rows.push(['Provider', info.provider])
  const pr = info.pricing
  if (pr && (pr.input !== null || pr.output !== null)) {
    rows.push(['Price', `$${pr.input} in / $${pr.output} out per Mtok`])
  } else if (info.hermesPricing) {
    rows.push(['Price', `${info.hermesPricing.input || '?'} in / ${info.hermesPricing.output || '?'} out per Mtok`])
  } else if (info.pricingPending) rows.push(['Price', 'loading from the provider…'])
  else if (info.found === false && !info.hermesPricing) rows.push(['Price', 'not published by this provider'])
  if (info.context_length) rows.push(['Context window', fmt(info.context_length) + ' tokens'])
  if (info.max_output_tokens) rows.push(['Max output', fmt(info.max_output_tokens) + ' tokens'])
  if (info.efforts && info.efforts.length) rows.push(['Reasoning', info.efforts.join(' · ')])
  else if (info.caps && info.caps.reasoning === false) rows.push(['Reasoning', 'not supported'])
  else if (info.caps && info.caps.reasoning) rows.push(['Reasoning', 'supported'])
  if (info.input_modalities && info.input_modalities.length) rows.push(['Input', info.input_modalities.join(', ')])
  return rows
}

/** Cost hint for an LLM node from the provider's token price; upper bound when max_tokens is set. Pure, tested. */
function estimateLlmCost(info, params = {}) {
  const pr = info && info.pricing
  if (!pr || pr.output === null || pr.output === undefined) {
    if (info && info.hermesPricing && info.hermesPricing.output) return { label: `out ${info.hermesPricing.output}/M`, lines: ['Hermes picker price per million output tokens.'] }
    return null
  }
  const money = (v) => formatPrice(v) || '$0'
  const lines = [`$${pr.input} per M input tokens, $${pr.output} per M output tokens.`]
  if (pr.cache_read !== undefined && pr.cache_read !== null) lines.push(`Cached input: $${pr.cache_read} per M tokens.`)
  const max = Number(params.max_tokens)
  if (Number.isFinite(max) && max > 0) {
    const upper = (pr.output * max) / 1000000
    lines.push(`At most ${money(upper)} output cost with max tokens ${max} (input tokens are extra).`)
    return { label: `≤ ${money(upper)}`, lines }
  }
  return { label: `out ${money(pr.output)}/M`, lines }
}

// Provider catalog info for the LLM node (GET /x/llm-info); Hermes' picker data comes from the gateway RPC.
const llmInfoCache = new Map()
const llmInfoListeners = new Set()
function useLlmInfo(api, params, enabled = true) {
  const [, bump] = useReducer((x) => x + 1, 0)
  const [payload, setPayload] = useState(SHARED.modelOptionsData || null)
  useEffect(() => {
    llmInfoListeners.add(bump)
    return () => { llmInfoListeners.delete(bump) }
  }, [])
  useEffect(() => {
    if (!enabled) return undefined
    let alive = true
    loadModelOptions(false).then((d) => {
      SHARED.modelOptionsData = d
      if (alive) setPayload(d)
    }).catch(() => {})
    return () => { alive = false }
  }, [enabled])
  const provider = !isBlank(params.provider) ? String(params.provider) : (payload && payload.provider) || ''
  const model = !isBlank(params.model) ? String(params.model) : (payload && payload.model) || ''
  const picker = llmPickerInfo(payload, provider, model)
  const key = model ? `${provider}\u0000${model}\u0000${picker.apiUrl}` : ''
  useEffect(() => {
    if (!enabled || !key || !api || typeof api.llmInfo !== 'function' || llmInfoCache.has(key)) return
    const entry = { data: null, error: null }
    llmInfoCache.set(key, entry)
    api.llmInfo(provider, model, picker.apiUrl, picker.provider).then((d) => { entry.data = d || {} },
      (e) => { entry.error = parseRestError(e).message })
      .finally(() => llmInfoListeners.forEach((fn) => fn()))
  }, [key])
  if (!enabled) return null
  const hit = key ? llmInfoCache.get(key) : null
  const catalog = hit && hit.data && hit.data.found ? hit.data.info : null
  const found = hit && hit.data ? hit.data.found : null
  return { model, provider, found, error: hit ? hit.error : null,
    loading: !!key && !!hit && !hit.data && !hit.error,
    ...picker, ...(catalog || {}) }
}

// One request per (node type, model) shared by the inspector and the node cards; the engine caches the list call.
const modelInfoCache = new Map()
const modelInfoListeners = new Set()
function loadModelInfo(api, type, param, model, refresh = false) {
  const key = `${type}\u0000${param}\u0000${model}`
  const hit = modelInfoCache.get(key)
  if (hit && !refresh) return hit.promise
  const entry = { promise: null, data: null, error: null }
  entry.promise = api.options(type, param, refresh, model)
  modelInfoCache.set(key, entry)
  entry.promise.then((d) => { entry.data = d || {} }, (e) => { entry.error = parseRestError(e).message })
    .finally(() => modelInfoListeners.forEach((fn) => fn()))
  return entry.promise
}
const autoModelCache = new Map()
/** '' until the node's model list arrived; then the auto-picked id (listeners re-render the cards). */
function autoModel(api, type, param, mode = 'cheapest') {
  const key = `${type}\u0000${param}\u0000${mode}`
  if (autoModelCache.has(key)) return autoModelCache.get(key)
  autoModelCache.set(key, '')
  if (api && typeof api.options === 'function') {
    loadToolOptions(api, type, param).then((d) => {
      const pick = autoPick(d && d.options, mode)
      if (pick) {
        autoModelCache.set(key, pick.value)
        modelInfoListeners.forEach((fn) => fn())
      }
    }, () => { autoModelCache.delete(key) })
  }
  return ''
}
function useModelInfo(api, nodeType, spec, params, { fetch = true } = {}) {
  let ms = modelSetting(spec, params)
  if (ms && ms.auto && fetch) ms = { ...ms, model: autoModel(api, nodeType, ms.param, ms.mode) }
  const key = ms && ms.model ? `${nodeType}\u0000${ms.param}\u0000${ms.model}` : ''
  const [, bump] = useReducer((x) => x + 1, 0)
  useEffect(() => {
    modelInfoListeners.add(bump)
    return () => { modelInfoListeners.delete(bump) }
  }, [])
  useEffect(() => {
    if (fetch && key && api && typeof api.options === 'function' && !modelInfoCache.has(key)) {
      loadModelInfo(api, nodeType, ms.param, ms.model).catch(() => {})
    }
  }, [key, fetch])
  if (!key) return null
  const hit = modelInfoCache.get(key)
  if (!hit) return fetch ? { model: ms.model, data: null, error: null, loading: true } : null
  return { model: ms.model, data: hit.data, error: hit.error, loading: !hit.data && !hit.error }
}

/** Options from GET /x/options → picker groups [{slug, name, models, labels, prices}], cheapest group first. Pure, tested. */
function optionGroups(options) {
  const byGroup = new Map()
  for (const o of Array.isArray(options) ? options : []) {
    if (!o || typeof o.value !== 'string') continue
    const g = String(o.group || 'Other')
    if (!byGroup.has(g)) byGroup.set(g, { slug: g, name: g, models: [], labels: {}, prices: {}, hints: {} })
    const grp = byGroup.get(g)
    grp.models.push(o.value)
    if (o.label && o.label !== o.value) grp.labels[o.value] = o.label
    if (typeof o.price === 'number') grp.prices[o.value] = formatPrice(o.price) + (o.unit || '')
    if (o.description) grp.hints[o.value] = o.description
  }
  return [...byGroup.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const optionsCache = new Map()
function loadToolOptions(api, type, param, refresh = false) {
  const key = `${type}\u0000${param}`
  if (!refresh && optionsCache.has(key)) return optionsCache.get(key)
  const p = api.options(type, param, refresh)
  optionsCache.set(key, p)
  p.catch(() => {
    if (optionsCache.get(key) === p) optionsCache.delete(key)
  })
  return p
}

/** Copy and refresh policy for model choices versus a fixed message recipient. */
function toolOptionCopy(type, param) {
  const recipient = type === 'output.send_message' && param === 'target'
  return recipient ? {
    kind: 'recipient', refreshOnOpen: true, blank: 'Choose recipient…',
    placeholder: 'Search recipients…', loading: 'Loading recipients…',
    empty: 'No recipients available. Reload the list or enter a fixed platform:recipient target.',
    noMatch: 'No recipient matches.', clear: 'No recipient selected', clearHint: 'required',
  } : {
    kind: 'model', refreshOnOpen: false, blank: 'Tool default',
    placeholder: 'Search models…', loading: 'Loading models…',
    empty: 'The tool listed no models.', noMatch: 'No model matches.',
    clear: 'Tool default', clearHint: 'leave empty',
  }
}

/** Searchable model or recipient choices. An explicit fixed value may also be entered. */
function ToolOptionPicker({ api, type, param, value, fallback, fallbackPrefix = 'Default', onChange }) {
  const copy = toolOptionCopy(type, param)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const wrapRef = useRef(null)
  const load = (refresh) => {
    if (!api || typeof api.options !== 'function') return
    setLoading(true)
    setError(null)
    loadToolOptions(api, type, param, refresh).then((d) => setData(d || {}), (e) => setError(parseRestError(e).message)).finally(() => setLoading(false))
  }
  useEffect(() => {
    if (open && !loading && (copy.refreshOnOpen || !data)) load(copy.refreshOnOpen)
    if (!open) return undefined
    const away = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [open])
  const groups = useMemo(() => optionGroups(data && data.options), [data])
  const { groups: shown, hidden } = useMemo(() => filterModelGroups(groups, query), [groups, query])
  const pick = (v) => {
    onChange(v)
    setOpen(false)
    setQuery('')
  }
  const typed = query.trim()
  const exact = typed && groups.some((g) => g.models.includes(typed))
  const first = shown.length ? shown[0].models[0] : typed || null
  const label = isBlank(value)
    ? h('span', { className: 'fc-muted' }, fallback ? `${fallbackPrefix} · ${fallback}` : copy.blank)
    : h('span', null, String(value))
  const priceOf = (v) => {
    for (const g of groups) if (v in g.prices) return g.prices[v]
    return null
  }
  return h('div', { className: 'fc-model', ref: wrapRef, 'data-fc-option-kind': copy.kind },
    h('button', { type: 'button', className: `fc-input fc-model-btn${open ? ' open' : ''}`, 'aria-haspopup': 'listbox', 'aria-expanded': open, onClick: () => setOpen(!open) },
      label, !isBlank(value) && priceOf(value) ? h('span', { className: 'fc-model-prov' }, priceOf(value)) : null, h(Icon, { name: 'chevron-down' })),
    open ? h('div', { className: 'fc-model-pop', role: 'listbox' },
      h('div', { className: 'fc-model-search' },
        h(Icon, { name: 'search' }),
        h('input', {
          autoFocus: true, value: query, placeholder: copy.placeholder,
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
            if (e.key === 'Enter' && first) { e.preventDefault(); pick(first) }
          }
        }),
        h('button', { type: 'button', className: 'fc-btn ghost icon', title: 'Reload the list', onClick: () => load(true) }, h(Icon, { name: 'refresh', spin: loading }))),
      h('div', { className: 'fc-model-list' },
        h('div', { className: `fc-model-item${isBlank(value) ? ' active' : ''}`, onClick: () => pick('') },
          h('span', null, fallback ? `${fallbackPrefix} · ${fallback}` : copy.clear), h('span', { className: 'fc-model-prov' }, copy.clearHint)),
        typed && !exact ? h('div', { className: 'fc-model-item', onClick: () => pick(typed) }, h('span', null, `Use “${typed}”`), h('span', { className: 'fc-model-prov' }, 'custom')) : null,
        loading && !data ? h('div', { className: 'fc-help fc-model-note' }, copy.loading) : null,
        error ? h('div', { className: 'fc-help fc-bad fc-model-note' }, `Could not load the list: ${error}`) : null,
        data && !shown.length ? h('div', { className: 'fc-help fc-model-note' }, query ? copy.noMatch : copy.empty) : null,
        shown.map((g) => h('div', { key: g.slug, className: 'fc-model-group' },
          h('div', { className: 'fc-model-head' }, g.name, h('span', { className: 'fc-model-count' }, String(g.models.length))),
          g.models.map((m) => h('div', {
            key: m, title: g.hints[m] ? `${m}\n\n${g.hints[m]}` : m,
            className: `fc-model-item${m === value ? ' active' : ''}`,
            onClick: () => pick(m)
          }, h('span', null, g.labels[m] || m), g.prices[m] ? h('span', { className: 'fc-model-prov' }, g.prices[m]) : null)))),
        hidden > 0 ? h('div', { className: 'fc-help fc-model-note' }, `${hidden} more — type to narrow the list.`) : null)) : null)
}

/** One URL/path row of a media list. Keeps the typed text (spaces, an emptied field) as a draft while focused,
 *  so typing never fights the trimmed stored list; an emptied row goes away on blur. */
function MediaRow({ item, index, existing, onSet, onRemove }) {
  const [draft, setDraft] = useState(null)
  const shown = draft !== null ? draft : item
  return h('div', { className: 'fc-browse fc-media-row', 'data-fc-media-item': index },
    h('input', { className: 'fc-input', value: shown, placeholder: 'https://… or C:\\path\\image.png', title: item || undefined,
      onChange: (e) => {
        setDraft(e.target.value)
        onSet(e.target.value)
      },
      onBlur: () => {
        if (draft !== null && !draft.trim() && existing) onRemove()
        setDraft(null)
      } }),
    existing ? h('button', {
      type: 'button', className: 'fc-btn ghost icon', title: 'Remove this file/URL', 'data-fc-media-remove': index,
      onClick: onRemove
    }, h(Icon, { name: 'close' })) : null)
}

/** The image list of a preset follows the chosen model's own limit (catalog ``max_images``; live 07.11.: MoGe 2
 *  takes one image, the field said "0 / 4"). ``count`` = images the node has now (wired + listed). */
function fitImageLimit(field, maxImages, modelName, count) {
  if (!field || field.kind !== 'media_list' || !Number.isFinite(maxImages)) return { field, note: null }
  const toolMax = typeof field.max_items === 'number' ? field.max_items : Infinity
  if (maxImages >= toolMax) return { field, note: null }
  const label = modelName || 'This model'
  const over = count > maxImages
  return {
    field: { ...field, max_items: maxImages },
    note: { bad: over, text: `${label} takes ${maxImages} image${maxImages === 1 ? '' : 's'}${over
      ? ` — only the first ${maxImages === 1 ? 'one' : maxImages} of ${count} will be used. Pick a multi-view model to use them all.`
      : '.'}` }
  }
}

/** Items a wire delivers, from the last run when known (a Collect node's list), else 1. */
function wiredItemCount(run, edge) {
  const st = run && run.nodes ? run.nodes[edge.from.node] : null
  const out = st && st.outputs ? st.outputs[edge.from.port] : undefined
  return Array.isArray(out) ? out.length : 1
}

function formatJsonText(raw) {
  const text = String(raw)
  if (text.length > 1048576) throw new Error('JSON input exceeds 1 MiB')
  const parsed = JSON.parse(text)
  const pending = [[parsed, 0]]
  let count = 0
  while (pending.length) {
    const [value, depth] = pending.pop()
    if (++count > 50000 || depth > 32) throw new Error('JSON exceeds 32 levels or 50,000 values')
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('JSON numbers must be finite')
    if (typeof value === 'string') {
      for (const ch of value) if (ch.length === 1 && /[\uD800-\uDFFF]/.test(ch)) throw new Error('JSON text must be valid Unicode')
    }
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) pending.push([child, depth + 1])
    }
  }
  // Lexical whitespace formatting: never stringify parsed numbers, which would
  // corrupt integer/decimal lexemes before the user even runs the node.
  let out = '', depth = 0, quoted = false, escaped = false
  const indent = () => '  '.repeat(depth)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
    } else if (ch === '"') { quoted = true; out += ch }
    else if (/\s/.test(ch)) continue
    else if (ch === '{' || ch === '[') {
      out += ch
      let j = i + 1
      while (/\s/.test(text[j] || '') && j < text.length) j++
      if (text[j] === (ch === '{' ? '}' : ']')) { out += text[j]; i = j }
      else { depth++; out += '\n' + indent() }
    } else if (ch === '}' || ch === ']') { depth--; out += '\n' + indent() + ch }
    else if (ch === ',') out += ',\n' + indent()
    else if (ch === ':') out += ': '
    else out += ch
  }
  return out
}

function JsonInputEditor({ value, onChange }) {
  const raw = value === undefined ? '{}' : value === null ? 'null' : typeof value === 'string' ? value : JSON.stringify(value)
  const checked = useMemo(() => {
    try { return { formatted: formatJsonText(raw), error: null } }
    catch (e) { return { formatted: null, error: String(e.message || e) } }
  }, [raw])
  return h('div', { className: 'fc-json-editor' },
    h('textarea', { className: 'fc-input fc-mono', rows: 6, value: raw, 'aria-label': 'JSON source', spellCheck: false, onChange: (e) => onChange(e.target.value) }),
    h('div', { className: 'fc-row' },
      h('button', { type: 'button', className: 'fc-btn', disabled: !!checked.error, onClick: () => onChange(checked.formatted) }, 'Format JSON'),
      h('span', { className: checked.error ? 'fc-help fc-bad' : 'fc-help', role: 'status' }, checked.error || 'Valid JSON · server validates size and types on run')),
    h('div', { className: 'fc-help' }, 'Formatting preserves numeric text. Reserved $large / $media keys become inert data when run.'),
    checked.error ? null : h('details', null, h('summary', null, 'JSON preview'), h('pre', { className: 'fc-pre' }, checked.formatted)))
}

function safeMarkdownInline(text) {
  const parts = [], pattern = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\[([^\]]+)\]\(([^)\s]+)\))/g
  let cursor = 0, match
  while ((match = pattern.exec(text))) {
    parts.push(text.slice(cursor, match.index))
    if (match[1]) parts.push(h('code', { key: match.index }, match[2]))
    else if (match[3]) parts.push(h('strong', { key: match.index }, match[4]))
    else {
      let href = null
      if (text[match.index - 1] !== '!' && /^https?:\/\//i.test(match[7]) && !/[\u0000-\u0020\u007f]/.test(match[7])) {
        try { const url = new URL(match[7]); if (url.protocol === 'http:' || url.protocol === 'https:') href = url.href } catch {}
      }
      parts.push(href ? h('a', { key: match.index, href, target: '_blank', rel: 'noopener noreferrer' }, match[6]) : match[0])
    }
    cursor = match.index + match[0].length
  }
  parts.push(text.slice(cursor))
  return parts
}

function SafeMarkdown({ text }) {
  const original = String(text == null ? '' : text)
  const lines = original.slice(0, 262144).replace(/\r\n?/g, '\n').split('\n').slice(0, 5000)
  const blocks = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    if (/^\s*```/.test(line)) {
      const code = []; i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++])
      if (i < lines.length) i++
      blocks.push(h('pre', { key: i, className: 'fc-pre' }, h('code', null, code.join('\n')))); continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) { blocks.push(h('h' + heading[1].length, { key: i }, safeMarkdownInline(heading[2]))); i++; continue }
    const bullet = /^\s*(?:[-+*]|\d+\.)\s+/.exec(line)
    if (bullet) {
      const ordered = /^\s*\d+\./.test(line), items = []
      while (i < lines.length && /^\s*(?:[-+*]|\d+\.)\s+/.test(lines[i]) && /^\s*\d+\./.test(lines[i]) === ordered) {
        items.push(h('li', { key: i }, safeMarkdownInline(lines[i].replace(/^\s*(?:[-+*]|\d+\.)\s+/, '')))); i++
      }
      blocks.push(h(ordered ? 'ol' : 'ul', { key: i }, items)); continue
    }
    const paragraph = [line]; i++
    while (i < lines.length && lines[i].trim() && !/^(?:#{1,6}\s|\s*```|\s*(?:[-+*]|\d+\.)\s)/.test(lines[i])) paragraph.push(lines[i++])
    blocks.push(h('p', { key: i, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, safeMarkdownInline(paragraph.join('\n'))))
  }
  let lineCount = 1
  for (let i = 0; i < original.length && lineCount <= 5000; i++) {
    const ch = original.charCodeAt(i)
    if (ch === 10) lineCount++
    else if (ch === 13) { lineCount++; if (original.charCodeAt(i + 1) === 10) i++ }
  }
  const truncated = original.length > 262144 || lineCount > 5000
  return h('div', { className: 'fc-markdown', 'data-fc-safe-markdown': true }, blocks,
    truncated ? h('div', { className: 'fc-help' }, 'Preview truncated at 256 Ki characters / 5,000 lines; source remains unchanged.') : null)
}

function MarkdownEditor({ value, onChange, placeholder }) {
  const [preview, setPreview] = useState(false)
  const raw = value == null ? '' : String(value)
  return h('div', { className: 'fc-markdown-editor' },
    h('div', { className: 'fc-row' },
      h('button', { type: 'button', className: 'fc-btn', 'aria-pressed': !preview, onClick: () => setPreview(false) }, 'Edit'),
      h('button', { type: 'button', className: 'fc-btn', 'aria-pressed': preview, onClick: () => setPreview(true) }, 'Preview Markdown')),
    preview ? h(SafeMarkdown, { text: raw }) : h('textarea', { className: 'fc-input', rows: 6, value: raw, placeholder, onChange: (e) => onChange(e.target.value) }),
    preview ? h('div', { className: 'fc-help' }, 'Safe preview: HTML is text; images are not loaded. Only http/https links are clickable.') : null)
}

function ParamField({ spec, value, source, types, onChange, onChangeMany, params, port, api, nodeType, onBrowse, modelField, modelName, note, flowId }) {
  const placeholder = spec.default !== null && spec.default !== undefined && spec.default !== '' ? `default: ${typeof spec.default === 'string' ? spec.default : JSON.stringify(spec.default)}` : ''
  const ctl = fieldControl(spec, modelField)
  const extra = []
  const info = paramInfo(spec, { port })
  if (ctl.fromModel) info.push(`Choices from the model list for ${modelName}.`)
  if (ctl.description && ctl.description !== spec.description) info.push(ctl.description)
  if (ctl.hint) info.push(`Allowed: ${ctl.hint}.`)
  let control
  if (source && spec.kind !== 'media_list') control = h('div', { className: 'fc-linked' }, h(Icon, { name: 'link' }), 'from', h('b', null, source))
  else if (spec.picker === 'flow') control = h(FlowPicker, { api, value, ownId: flowId, onChange })
  else if (spec.kind === 'media' || spec.kind === 'media_list') {
    const multiple = spec.kind === 'media_list'
    const items = multiple ? mediaValues(value) : []
    const maxItems = typeof spec.max_items === 'number' ? spec.max_items : null
    const pick = async () => {
      if (!onBrowse || (maxItems !== null && items.length >= maxItems)) return
      const picked = await onBrowse(spec.media_kind || 'auto')
      if (picked) onChange(multiple ? addMediaPath(items, picked, { multiple: true, maxItems }) : picked)
    }
    const browseButton = onBrowse ? h('button', {
      type: 'button', className: 'fc-btn', 'data-fc-media-browse': spec.name,
      disabled: multiple && maxItems !== null && items.length >= maxItems,
      title: multiple ? 'Add a local file to this list' : 'Choose a local file', onClick: pick
    }, h(Icon, { name: 'folder-opened' }), multiple ? 'Add file…' : 'Browse…') : null
    if (!multiple) {
      control = h('div', { className: 'fc-browse', 'data-fc-media': spec.name },
        h('input', { className: 'fc-input', value: value == null ? '' : String(value),
          placeholder: placeholder || 'https://… or C:\\path\\image.png', title: value ? String(value) : undefined,
          onChange: (e) => onChange(e.target.value === '' ? null : e.target.value) }), browseButton)
    } else {
      const remove = (index) => { const next = [...items]; next.splice(index, 1); onChange(next.length ? next : null) }
      const row = (item, index) => h(MediaRow, {
        key: `row-${index}`, item, index, existing: index < items.length,
        onSet: (text) => { const next = setMediaItem(items, index, text); if (next !== items) onChange(next) },
        onRemove: () => remove(index)
      })
      control = h('div', { className: 'fc-media-list', 'data-fc-media': spec.name, 'data-fc-media-count': items.length },
        source ? h('div', { className: 'fc-linked', title: 'Wired images are added after the files/URLs below' }, h(Icon, { name: 'link' }), 'also from', h('b', null, source)) : null,
        items.map((item, index) => row(item, index)),
        maxItems === null || items.length < maxItems ? row('', items.length) : null,
        h('div', { className: 'fc-row' }, browseButton,
          h('span', { className: 'fc-help' }, `${items.length}${maxItems !== null ? ` / ${maxItems}` : ''} file${(maxItems !== null ? maxItems : items.length) === 1 ? '' : 's'}`)))
    }
  } else if (spec.kind === 'textarea') {
    control = nodeType === 'input.text' || nodeType === 'note' ? h(MarkdownEditor, { value, onChange, placeholder }) : h('textarea', { className: 'fc-input', rows: 4, value: value === null || value === undefined ? '' : String(value), placeholder, onChange: (e) => onChange(e.target.value === '' ? null : e.target.value) })
  } else if (ctl.kind === 'number') {
    control = h('input', { className: 'fc-input', inputMode: 'decimal', 'data-fc-range': ctl.hint || undefined, value: value === null || value === undefined ? '' : String(value), placeholder: placeholder || ctl.hint, onChange: (e) => onChange(parseNumberInput(e.target.value)), onBlur: (e) => { const v = parseNumberInput(e.target.value, true); if (v !== value) onChange(v) } })
    if (ctl.hint) extra.push(h('div', { key: 'range', className: 'fc-help fc-range' }, ctl.hint))
    const issue = numberIssue(value, ctl)
    if (issue) extra.push(h('div', { key: 'bad', className: 'fc-help fc-bad' }, issue))
  } else if (spec.kind === 'boolean') {
    const checked = value === true || ((value === null || value === undefined) && spec.default === true)
    control = h('label', { className: 'fc-check' },
      h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) }),
      value === null || value === undefined ? `default (${spec.default === true ? 'on' : 'off'})` : value ? 'on' : 'off')
  } else if (ctl.kind === 'select') {
    const current = value === null || value === undefined ? '' : String(value)
    const listed = current === '' || ctl.options.some((o) => o.value === current)
    const blankLabel = !isBlank(spec.default) ? `default (${spec.default})`
      : ctl.modelDefault ? `model default (${ctl.modelDefault})` : ctl.fromModel ? 'tool default' : '—'
    control = h('select', {
      className: 'fc-input', value: current, 'data-fc-choices': ctl.fromModel ? 'model' : 'schema',
      onChange: (e) => onChange(choiceValue(e.target.value, spec, ctl))
    }, h('option', { value: '' }, blankLabel),
    listed ? null : h('option', { value: current }, `${current} (not listed)`),
    ctl.options.map((o) => h('option', { key: o.value, value: o.value }, o.price ? `${o.label} · ${o.price}` : o.label)))
    if (!listed) {
      extra.push(h('div', { key: 'unlisted', className: 'fc-help fc-bad' },
        ctl.fromModel ? `${modelName} does not list “${current}”. Pick one of its choices or leave the default.` : `“${current}” is not one of the choices.`))
    }
  } else if (ctl.kind === 'multiselect') {
    const have = new Set(multiValues(value))
    const max = typeof spec.max_items === 'number' ? spec.max_items : null
    const min = typeof spec.min_items === 'number' ? spec.min_items : null
    control = h('div', { className: 'fc-multi', role: 'group', 'data-fc-multi': spec.name },
      ctl.options.map((o) => {
        const on = have.has(o.value)
        return h('label', { key: o.value, className: `fc-chip${on ? ' on' : ''}` },
          h('input', {
            type: 'checkbox', checked: on, disabled: !on && max !== null && have.size >= max,
            onChange: () => {
              const next = toggleChoice(value, o, ctl.options)
              onChange(next.length ? next : null)
            }
          }), o.label)
      }))
    if (min !== null || max !== null) {
      const range = min !== null && max !== null ? (min === max ? `${min}` : `${min}–${max}`) : min !== null ? `at least ${min}` : `up to ${max}`
      extra.push(h('div', { key: 'count', className: `fc-help${have.size && min !== null && have.size < min ? ' fc-bad' : ''}` }, `Pick ${range}.`))
    }
  } else if (spec.options_source && (spec.kind === 'text' || spec.kind === 'textarea')) {
    const mode = spec.auto ? String((params && params[spec.auto]) || 'cheapest') : ''
    const picked = spec.auto && isBlank(spec.default) ? autoModel(api, nodeType, spec.name, mode) : ''
    control = h(ToolOptionPicker, {
      api, type: nodeType, param: spec.name, value, onChange,
      fallback: !isBlank(spec.default) ? String(spec.default) : picked || null,
      fallbackPrefix: spec.auto && isBlank(spec.default) ? `Auto (${mode})` : 'Default'
    })
  } else if (spec.kind === 'model') {
    control = h(ModelPicker, {
      model: value, provider: params ? params.provider : null,
      onChange: (next) => (onChangeMany ? onChangeMany({ model: next.model, provider: next.provider }) : onChange(next.model))
    })
  } else if (spec.kind === 'tool') {
    const prefixed = typeof value === 'string' && value ? `tool:${value}` : ''
    control = h(ToolSelect, { types, value: prefixed, missing: value, onChange: (t) => onChange(t ? t.replace(/^tool:/, '') : null) })
  } else if (spec.kind === 'json') {
    control = h(JsonInputEditor, { value: value === undefined ? spec.default : value, onChange })
  } else if (spec.browse === 'file' || spec.browse === 'folder') {
    const folder = spec.browse === 'folder'
    control = h('div', { className: 'fc-browse' },
      h('input', { className: 'fc-input', value: value === null || value === undefined ? '' : String(value), placeholder: placeholder || (folder ? 'C:\\path\\to\\folder' : 'C:\\path\\to\\file.png'), title: value ? String(value) : undefined,
        onChange: (e) => onChange(e.target.value === '' ? null : e.target.value) }),
      onBrowse ? h('button', {
        type: 'button', className: 'fc-btn', 'data-fc-browse': spec.name, title: folder ? 'Choose a folder' : 'Choose a file',
        onClick: async () => {
          const picked = await onBrowse(folder ? 'folder' : params ? params.kind : 'auto')
          if (picked) onChange(picked)
        }
      }, h(Icon, { name: 'folder-opened' }), 'Browse…') : null)
  } else {
    control = h('input', { className: 'fc-input', value: value === null || value === undefined ? '' : String(value), placeholder, onChange: (e) => onChange(spec.numeric ? parseNumberInput(e.target.value) : e.target.value === '' ? null : e.target.value), onBlur: spec.numeric ? (e) => { const v = parseNumberInput(e.target.value, true); if (v !== value) onChange(v) } : undefined })
  }
  return h('div', { className: 'fc-field', 'data-fc-field': spec.name },
    h('label', null, spec.label || spec.name, spec.required ? h('span', { className: 'fc-req' }, '*') : null,
      h(InfoTip, { lines: info })),
    control, source ? null : extra,
    note ? h('div', { className: `fc-help${note.bad ? ' fc-bad' : ''}`, 'data-fc-note': spec.name }, note.text) : null)
}

function FileChip({ media, onOpen }) {
  return h('div', { className: 'fc-file-chip' },
    h(Icon, { name: MEDIA_ICON[media.kind] || 'file' }),
    h('span', { className: 'fc-chip-name', title: media.path || media.file }, media.file || media.path),
    onOpen ? h('button', { className: 'fc-btn ghost icon', title: 'View large', onClick: onOpen }, h(Icon, { name: 'screen-full' })) : null,
    media.path ? h(CopyBtn, { text: media.path, title: 'Copy file path' }) : null)
}

function MediaView({ api, runId, nodeId, port, index, media, onOpenMedia }) {
  const kind = media.kind
  const wants = kind === 'image' || kind === 'audio' || kind === 'video'
  const data = useMedia(api, runId, nodeId, port, kind === 'image' ? 768 : 0, wants, index)
  const open = onOpenMedia ? () => onOpenMedia({ nodeId, port, index, path: media.path }) : null
  let body = null
  if (kind === 'image') {
    body = data && data.data_url
      ? h('img', { src: data.data_url, alt: media.file || '', className: open ? 'fc-zoomable' : '', title: open ? 'Click to view large' : undefined, onClick: open || undefined })
      : h('div', { className: 'fc-help' }, data && data.error ? 'Preview unavailable.' : 'Loading preview…')
  } else if (kind === 'audio' && data && data.data_url) body = h('audio', { controls: true, src: data.data_url })
  else if (kind === 'video' && data && data.data_url) body = h('video', { controls: true, src: data.data_url })
  else if (wants) {
    const msg = !data ? 'Loading preview…' : data.error ? 'Preview unavailable.' : 'Too large to preview here — open the file instead.'
    body = h('div', { className: 'fc-help' }, msg)
  }
  return h('div', { className: 'fc-media' }, body, h(FileChip, { media, onOpen: open }))
}

function OutputValue({ api, runId, nodeId, port, value, onOpenMedia }) {
  if (isMedia(value)) return h(MediaView, { api, runId, nodeId, port, index: 0, media: value.$media, onOpenMedia })
  if (Array.isArray(value) && value.length && value.every(isMedia)) {
    return h('div', null,
      value.slice(0, 6).map((m, i) => h(MediaView, { key: `${i}:${m.$media.file || ''}`, api, runId, nodeId, port, index: i, media: m.$media, onOpenMedia })),
      value.length > 6 ? h('div', { className: 'fc-help' }, `+ ${value.length - 6} more files — open the first one large and use ← → to see all`) : null)
  }
  if (value && typeof value === 'object' && value.$large) {
    return h('div', null,
      h('pre', { className: 'fc-pre' }, value.$large.preview || ''),
      h('div', { className: 'fc-help' }, `${value.$large.chars} characters — full value saved to ${value.$large.path}`))
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (typeof value === 'string' && port === 'text' && typeof sdk.Streamdown === 'function' && text.length <= 20000) {
    // Output text is model/tool output: only inline `data:` images may load, so `![](http…)` in it cannot ping a
    // remote server (a tracking pixel) from the app (U-17).
    return h('div', { className: 'fc-pre-wrap' }, h('div', { className: 'fc-md' }, h(sdk.Streamdown, { allowedImagePrefixes: ['data:'] }, text)), h(CopyBtn, { text }))
  }
  return h('div', { className: 'fc-pre-wrap' },
    h('pre', { className: 'fc-pre' }, text.length > 20000 ? `${text.slice(0, 20000)}…` : text),
    h(CopyBtn, { text }))
}

