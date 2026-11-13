// ---------------------------------------------------------------- hooks
/** Nearest ancestor that renders a box. Desktop wraps route pages in `display: contents`, whose clientHeight is 0. */
function boxParent(el) {
  let p = el.parentElement
  while (p && getComputedStyle(p).display === 'contents') p = p.parentElement
  return p
}

/**
 * Height that fills the space below `top` (all values in px): the box parent's content bottom when it has a
 * definite height, else the window bottom; minus whatever still overflows a scrolling ancestor. Pure, tested.
 */
function fillHeight({ top, parentBottom, windowHeight, overflow = 0, min = 320 }) {
  const bottom = parentBottom !== null && parentBottom !== undefined ? parentBottom : windowHeight
  return Math.max(min, Math.floor(bottom - top - Math.max(0, overflow)))
}

/** Fill the route's height exactly, so the page itself never scrolls (the run log stays on screen). */
function useFillHeight(ref, enabled = true) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    if (!enabled) {
      el.style.height = '' // the Arachne Flow window (G4) sizes itself to the whole window
      return undefined
    }
    let raf = 0
    const fit = () => {
      raf = 0
      const parent = boxParent(el)
      el.style.height = '0px'
      let parentBottom = null
      if (parent && parent.clientHeight >= 320) {
        const r = parent.getBoundingClientRect()
        const pad = parseFloat(getComputedStyle(parent).paddingBottom) || 0
        parentBottom = r.top + parent.clientTop + parent.clientHeight - pad
      }
      const top = el.getBoundingClientRect().top
      el.style.height = `${fillHeight({ top, parentBottom, windowHeight: window.innerHeight })}px`
      // Anything that still scrolls because of us (status bar, pane padding) comes off our height.
      const doc = document.scrollingElement || document.documentElement
      for (let a = el.parentElement; a; a = a.parentElement) {
        const scrolls = a === doc || /(auto|scroll)/.test(getComputedStyle(a).overflowY)
        const over = a.scrollHeight - a.clientHeight
        if (scrolls && over > 0) {
          el.style.height = `${fillHeight({ top, parentBottom, windowHeight: window.innerHeight, overflow: over })}px`
          break
        }
        if (a === doc) break
      }
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(fit)
    }
    fit()
    window.addEventListener('resize', schedule)
    let ro = null
    const parent = boxParent(el)
    if (typeof ResizeObserver === 'function' && parent) {
      ro = new ResizeObserver(schedule)
      ro.observe(parent)
    }
    return () => {
      window.removeEventListener('resize', schedule)
      if (ro) ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [ref, enabled])
}

const MEDIA_CACHE = new Map()
// Bounded by entries AND by the inline bytes it holds (U-12): a handful of 10 MB previews would otherwise sit in
// memory for the life of the module, and a reload never gets them back.
const MEDIA_CACHE_MAX = 160
const MEDIA_CACHE_MAX_BYTES = 64 * 1024 * 1024
/** What one cache entry keeps alive: the data URL it carries (files served by path cost only their key). */
function mediaEntryBytes(entry) {
  const v = entry && entry.value
  if (!v || typeof v !== 'object') return 0
  const text = typeof v.data_url === 'string' ? v.data_url : typeof v.url === 'string' ? v.url : ''
  return text.length
}
function mediaCacheBytes(cache) {
  let total = 0
  for (const entry of cache.values()) total += mediaEntryBytes(entry)
  return total
}
/** Drop the oldest entries until the cache fits `maxBytes` and `maxCount`; returns the dropped keys. `keep` (the
 *  entry just written) survives even when it alone is over budget, so one huge file cannot thrash the cache. */
function evictMediaCache(cache, { maxBytes = MEDIA_CACHE_MAX_BYTES, maxCount = MEDIA_CACHE_MAX, keep = null } = {}) {
  const evicted = []
  let total = mediaCacheBytes(cache)
  for (const key of cache.keys()) {
    if (total <= maxBytes && cache.size <= maxCount) break
    if (key === keep) continue
    total -= mediaEntryBytes(cache.get(key))
    cache.delete(key)
    evicted.push(key)
  }
  return evicted
}
function fetchMedia(api, key, runId, nodeId, port, thumb, index) {
  const hit = MEDIA_CACHE.get(key)
  if (hit) return hit.promise
  const entry = { promise: api.media(runId, nodeId, port, thumb, index), value: null }
  MEDIA_CACHE.set(key, entry)
  entry.promise.then(
    (v) => {
      entry.value = v
      // the entry only starts costing bytes once the data URL is here: cap again so a batch of big previews
      // that arrived together is trimmed in the order they were asked for
      evictMediaCache(MEDIA_CACHE, { keep: key })
    },
    () => MEDIA_CACHE.delete(key)
  )
  evictMediaCache(MEDIA_CACHE, { keep: key })
  return entry.promise
}
function useMedia(api, runId, nodeId, port, thumb, enabled, index = 0) {
  const key = enabled && runId && nodeId && port ? `${runId}|${nodeId}|${port}|${index}|${thumb}` : ''
  const cached = key ? MEDIA_CACHE.get(key) : null
  const [state, setState] = useState(null)
  useEffect(() => {
    if (!key) return undefined
    let alive = true
    fetchMedia(api, key, runId, nodeId, port, thumb, index).then(
      (value) => alive && setState({ key, value }),
      (err) => alive && setState({ key, error: parseRestError(err).message })
    )
    return () => {
      alive = false
    }
  }, [key])
  if (!key) return null
  if (state && state.key === key) return state.error ? { error: state.error } : state.value
  return cached && cached.value ? cached.value : null
}

/** Thumbnail cell of an image mini entry: the cached 320 px thumbnail the card already uses (same cache key, so no
 *  extra request); until it is there, or when it failed, a fixed-size icon, so the row never jumps. */
function MiniThumb({ api, runId, nodeId, port, index, name }) {
  const thumb = useMedia(api, runId, nodeId, port, 320, true, index)
  if (thumb && thumb.data_url) return h('img', { src: thumb.data_url, alt: name || '', draggable: false })
  return h(Icon, { name: thumb && thumb.error ? 'warning' : MEDIA_ICON.image })
}

/** Off-screen outputs should not fetch media or hold decoders. Keep the wrapper's dimensions while hidden. */
function useMediaVisible(ref) {
  const [visible, setVisible] = useState(typeof IntersectionObserver !== 'function')
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver !== 'function') return undefined
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)),
      { rootMargin: '100px' })
    observer.observe(ref.current)
    // The observer's first report can come late (busy or throttled renderer, headless virtual time): a player
    // that is already on screen when it mounts loads at once instead of waiting for it.
    const early = setTimeout(() => {
      const r = ref.current && ref.current.getBoundingClientRect()
      if (r && r.width > 0 && r.bottom > -100 && r.top < (window.innerHeight || 0) + 100 &&
          r.right > -100 && r.left < (window.innerWidth || 0) + 100) setVisible(true)
    }, 50)
    return () => { clearTimeout(early); observer.disconnect() }
  }, [ref])
  return visible
}

/** A video/audio player or mesh thumbnail in ANY producer node, not a dedicated output.preview node.
 *  Only the existing guarded media route is used; no remote URLs or file:// reads. The header still opens
 *  the large viewer. Player controls must not start a drag, open a dialog or trigger canvas shortcuts. */
function MiniMedia({ api, runId, nodeId, port, index, kind, name }) {
  const stop = (e) => e.stopPropagation()
  const ref = useRef(null)
  const visible = useMediaVisible(ref)
  const data = useMedia(api, runId, nodeId, port, 0, visible, index)
  const [failed, setFailed] = useState(null)
  const src = data && data.data_url
  const key = `${runId}|${nodeId}|${port}|${index}|${src ? src.length : 0}`
  let body
  if (failed === key) body = h('div', { className: 'fc-mini-unavailable' }, 'This media format cannot be played here.')
  else if (data && data.error) body = h('div', { className: 'fc-mini-unavailable' }, `Preview unavailable: ${data.error}`)
  else if (!visible || !data) body = h('div', { className: 'fc-mini-unavailable' }, !visible ? 'Preview' : 'Loading preview…')
  else if (!src) body = h('div', { className: 'fc-mini-unavailable' }, 'File too large for inline preview — open it from the viewer.')
  else if (kind === 'model3d') {
    const file = data.name || name || ''
    body = /\.glb$/i.test(file)
      ? h(ModelThumbnail, { cacheKey: `${runId}|${nodeId}|${port}|${index}`, dataUrl: src, name })
      : h('div', { className: 'fc-mini-unavailable' }, 'Only GLB models can be previewed here; the original file is preserved.')
  } else body = h(kind === 'video' ? 'video' : 'audio', {
    key, src, controls: true, preload: 'metadata', playsInline: true,
    'aria-label': name || kind, onError: () => setFailed(key)
  })
  const controls = kind === 'video' || kind === 'audio'
  return h('div', {
    ref, className: 'fc-mini-player', 'data-fc-inline-media': kind, 'data-fc-nodrag': '1',
    onPointerDown: stop, onDoubleClick: controls ? stop : undefined,
    onClick: controls ? stop : undefined, onKeyDown: controls ? stop : undefined, onWheel: controls ? stop : undefined,
  }, body)
}

// File node previews (G3): what the SAVED node points at. Keyed by flow, node and the raw path; `savedRev` only
// re-asks after a save until the server answers for the path shown (an unsaved edit gets the old path back).
const FILE_NODE_CACHE = new Map()
function useFileNode(api, flowId, nodeId, rawPath, savedRev, enabled) {
  const path = typeof rawPath === 'string' ? rawPath : ''
  const key = enabled && api && flowId && nodeId && path.trim() ? `${flowId}|${nodeId}|${path}` : ''
  const [, bump] = useState(0)
  useEffect(() => {
    if (!key || FILE_NODE_CACHE.has(key)) return undefined
    let alive = true
    api.fileNode(flowId, nodeId, 320).then((info) => {
      if (!info || info.path_param !== path) return // answer for an older saved path: wait for the next save
      FILE_NODE_CACHE.set(key, info)
      if (FILE_NODE_CACHE.size > 200) FILE_NODE_CACHE.delete(FILE_NODE_CACHE.keys().next().value)
      if (alive) bump((n) => n + 1)
    }, () => {})
    return () => {
      alive = false
    }
  }, [key, savedRev])
  return key ? FILE_NODE_CACHE.get(key) || null : null
}

