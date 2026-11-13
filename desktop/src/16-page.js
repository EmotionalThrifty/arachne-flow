// ---------------------------------------------------------------- page
function ArachneFlowPage({ ctx }) {
  const api = useMemo(() => makeApi(ctx), [ctx])
  const storage = ctx ? ctx.storage : null
  const sget = (k, d) => {
    try {
      const v = storage && storage.get ? storage.get(k, d) : d
      return v === undefined || v === null ? d : v
    } catch {
      return d
    }
  }
  const sset = (k, v) => {
    try {
      if (storage && storage.set) storage.set(k, v)
    } catch {
      /* storage is best effort */
    }
  }

  const rootRef = useRef(null)
  const [focusWin, setFocusWin] = useState(() => !!SHARED.focusWindow)
  useFillHeight(rootRef, !focusWin)
  const leaveFocusWindow = () => {
    focusWindowSet(false)
    setFocusWin(false)
  }
  const latest = useRef({})

  const [boot, setBoot] = useState({ status: 'loading', error: '' })
  const [types, setTypes] = useState(EMPTY_TYPES)
  const [flows, setFlows] = useState([])
  const [templates, setTemplates] = useState([])
  const [timings, setTimings] = useState(() => indexTimings(null))
  const [doc, setDoc] = useState(EMPTY_DOC)
  const [selection, setSelection] = useState([])
  // read before the persist effect below overwrites it with the empty initial selection
  const storedSelectionRef = useRef(undefined)
  if (storedSelectionRef.current === undefined) storedSelectionRef.current = sget('selection', null)
  const [selectedEdge, setSelectedEdge] = useState(null)
  const [saveState, setSaveState] = useState('saved')
  const [saveError, setSaveError] = useState('')
  const [conflict, setConflict] = useState(null)
  const [connLost, setConnLost] = useState(false)
  const [run, setRun] = useState(null)
  const [issues, setIssues] = useState([])
  const [notice, setNotice] = useState(null)
  const [view, setView] = useState({ x: 60, y: 60, zoom: 1 })
  const [expanded, setExpanded] = useState(() => new Set())
  const [menuOpen, setMenuOpen] = useState(false)
  const [templateDialog, setTemplateDialog] = useState(null)
  const [templateBusy, setTemplateBusy] = useState(false)
  const [generation, dispatchGeneration] = useReducer(generateReducer, undefined, generateInitial)
  const [logOpen, setLogOpen] = useState(() => sget('logOpen', true) !== false)
  const [paletteOpen, setPaletteOpen] = useState(() => sget('paletteOpen', true) !== false)
  const [uploading, setUploading] = useState(0)
  const [paletteFoldState, setPaletteFoldState] = useState(() => {
    const v = sget('paletteFolds', {})
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  })
  const savePaletteFolds = (next) => {
    sset('paletteFolds', next)
    setPaletteFoldState(next)
  }
  const [inspectorOpen, setInspectorOpen] = useState(() => sget('inspectorOpen', true) !== false)
  const [recent, setRecent] = useState(() => rememberType(sget('recentTypes', []), null))
  const [lightbox, setLightbox] = useState(null)   // key of the media item shown large (G1)
  const [valueViewer, setValueViewer] = useState(null)
  const flow = doc.flow

  const docRef = useRef(doc)
  docRef.current = doc
  const flowRef = useRef(null)
  flowRef.current = flow
  const runRef = useRef(null)
  runRef.current = run
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const edgeSelRef = useRef(null)
  edgeSelRef.current = selectedEdge
  const typesRef = useRef(types)
  typesRef.current = types
  const recentRef = useRef(recent)
  recentRef.current = recent
  const conflictRef = useRef(null)
  conflictRef.current = conflict
  const loadedRef = useRef(null)
  const baseRevRef = useRef(null)
  const savingRef = useRef(null)
  const generatingRef = useRef(false)
  const generationJobRef = useRef(null)   // id of the running build job, for Stop
  const saveTimerRef = useRef(null)
  const openTokenRef = useRef(0)
  const needFitRef = useRef(false)
  const heightsRef = useRef({})
  const fitRef = useRef(null)
  const sizeRef = useRef({ w: 800, h: 600 })
  const announcedRef = useRef(new Set())
  const noticeTimerRef = useRef(null)
  const flowsTimerRef = useRef(null)
  const runRefreshTimerRef = useRef(null)
  const lastEventRef = useRef(0)
  const deletingRef = useRef(null)
  const connRef = useRef({ fails: 0, lost: false })

  // ---- notices, saving
  const notify = (text, tone = 'info', ms = 5000) => {
    clearTimeout(noticeTimerRef.current)
    setNotice({ text, tone })
    if (ms) noticeTimerRef.current = setTimeout(() => setNotice(null), ms)
  }
  const validateNow = async (flowId) => {
    try {
      const res = await api.validate(flowId)
      if (flowRef.current && flowRef.current.id === flowId) setIssues(res.issues || [])
    } catch {
      /* validation is advisory */
    }
  }
  const refreshFlows = async () => {
    try {
      const res = await api.flows()
      const list = res.flows || []
      setFlows(list)
      return list
    } catch {
      return null
    }
  }
  const scheduleSave = () => {
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => latest.current.persist(), SAVE_DELAY)
  }
  // ---- backend contact (U-5): while a run is active the fallback poll is the only regular health check
  const reportConnection = (ok) => {
    const next = connectionState(connRef.current, ok)
    connRef.current = next
    setConnLost(next.lost)
    return next
  }
  // The backend answers again: reload what the page shows (open flow + its last run) instead of leaving a
  // run chip and clocks frozen on "running" forever.
  const recoverConnection = async () => {
    const plan = recoveryPlan(flowRef.current, loadedRef.current)
    let ok = false
    try {
      if (plan === 'boot') ok = await latest.current.bootUp()
      else if (plan === 'reload') ok = await latest.current.openFlow(flowRef.current.id, { preserveState: true })
      else {
        await latest.current.persist()
        ok = flowRef.current === loadedRef.current || !!conflictRef.current
        const r = runRef.current
        if (ok && r && r.id) await latest.current.refreshRun(r.id)
      }
    } catch {
      ok = false
    }
    reportConnection(!!ok)
    if (ok) notify('Connection restored.', 'ok', 3000)
    return !!ok
  }
  const retryConnection = async () => {
    const r = runRef.current
    if (r && r.id && !TERMINAL.has(r.status) && (await latest.current.refreshRun(r.id))) return
    await latest.current.recoverConnection()
  }
  const doSave = async () => {
    const current = flowRef.current
    if (!current || current === loadedRef.current || conflictRef.current) return
    setSaveState('saving')
    try {
      const res = await api.saveFlow(current.id, current, baseRevRef.current)
      baseRevRef.current = res.flow.revision
      loadedRef.current = current
      setSaveError('')
      setFlows((list) => list.map((f) => (f.id === current.id
        ? { ...f, name: current.name, revision: res.flow.revision, updated_at: res.flow.updated_at, node_count: current.nodes.length }
        : f)))
      if (flowRef.current === current) setSaveState('saved')
      else {
        setSaveState('dirty')
        latest.current.scheduleSave()
      }
      latest.current.validateNow(current.id)
    } catch (err) {
      const e = parseRestError(err)
      if (e.status === 409) {
        const c = { revision: e.detail && typeof e.detail === 'object' ? e.detail.current_revision : null }
        conflictRef.current = c
        setConflict(c)
        setSaveState('conflict')
      } else {
        setSaveState('error')
        setSaveError(e.status === 404 ? 'This flow no longer exists.' : e.message)
      }
    }
  }
  // Serialises saves (and other revision-changing calls) so events can wait for them.
  const chainWork = (work) => {
    const chain = (savingRef.current || Promise.resolve()).then(work).catch(() => {})
    savingRef.current = chain
    chain.then(() => {
      if (savingRef.current === chain) savingRef.current = null
    })
    return chain
  }
  const persist = () => {
    clearTimeout(saveTimerRef.current)
    return chainWork(() => latest.current.doSave())
  }

  // ---- flows
  const loadLastRun = async (flowId, token) => {
    try {
      const res = await api.runs(flowId, 1)
      const last = res.runs && res.runs[0]
      if (token !== openTokenRef.current || !last) return
      const full = await api.run(last.id)
      if (token !== openTokenRef.current) return
      if (TERMINAL.has(full.run.status)) announcedRef.current.add(full.run.id)
      setRun((cur) => (cur && cur.id !== full.run.id && isRunActive(cur) ? cur : full.run))
    } catch {
      /* history is optional */
    }
  }
  const openFlow = async (id, opts = {}) => {
    const token = ++openTokenRef.current
    let f = null
    try {
      const saved = await persistForFlowChange(
        latest.current.persist,
        () => saveBlocker(conflictRef.current, flowRef.current, loadedRef.current),
        async () => (id ? (await api.getFlow(id)).flow : null),
        (reason) => { if (token === openTokenRef.current) latest.current.notify(reason, conflictRef.current ? 'warn' : 'error') },
      )
      if (!saved.ok) return false
      f = saved.value
    } catch (err) {
      if (token === openTokenRef.current) latest.current.notify(parseRestError(err).message, 'error')
      return false
    }
    if (token !== openTokenRef.current) return false
    setMenuOpen(false)
    if (!id) {
      loadedRef.current = null
      baseRevRef.current = null
      setDoc(EMPTY_DOC)
      setRun(null)
      setIssues([])
      setSelection([])
      setSelectedEdge(null)
      setConflict(null)
      conflictRef.current = null
      sset('flowId', null)
      return true
    }
    const preserve = !!opts.preserveState && flowRef.current && flowRef.current.id === id
    // A user can edit while the reconnect GET is in flight. Never replace those unsaved changes.
    if (preserve && (flowRef.current !== loadedRef.current || conflictRef.current)) return false
    const restored = !preserve && SHARED.session && SHARED.session.flowId === id ? SHARED.session : null
    if (!preserve) SHARED.session = null
    loadedRef.current = f
    baseRevRef.current = f.revision
    conflictRef.current = null
    setConflict(null)
    setSaveState('saved')
    setSaveError('')
    if (preserve) {
      setDoc((d) => {
        // Revision/timestamp churn alone is not an external edit that invalidates local history.
        const content = (value) => {
          const { revision, updated_at, ...rest } = value || {}
          return JSON.stringify(rest)
        }
        return content(d.flow) === content(f) ? { ...d, flow: f } : applyRemote(d, f)
      })
      const ids = new Set(f.nodes.map((n) => n.id))
      setSelection((cur) => cur.filter((nid) => ids.has(nid)))
      setSelectedEdge((cur) => f.edges.some((e) => e.id === cur) ? cur : null)
      setExpanded((cur) => new Set([...cur].filter((nid) => ids.has(nid))))
    } else {
      setDoc({ flow: f, undo: restored ? restored.undo : [], redo: restored ? restored.redo : [], key: null, at: 0 })
      setSelection((opts.select || []).filter((nid) => f.nodes.some((n) => n.id === nid)))
      setSelectedEdge(null)
      setRun(null)
      setExpanded(new Set())
      heightsRef.current = {}
      const stored = sget(`view:${id}`, null)
      if (stored && Number.isFinite(stored.zoom) && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
        setView(stored)
        needFitRef.current = false
      } else needFitRef.current = true
    }
    setIssues([])
    sset('flowId', id)
    latest.current.loadLastRun(id, token)
    latest.current.validateNow(id)
    return true
  }
  const bootUp = async () => {
    setBoot({ status: 'loading', error: '' })
    try {
      const [nt, fl, tp] = await Promise.all([api.nodeTypes(), api.flows(), api.templates().catch(() => ({ templates: [] }))])
      setTypes(indexTypes(nt))
      const list = fl.flows || []
      setFlows(list)
      setTemplates(tp.templates || [])
      latest.current.refreshTimings()
      const wanted = SHARED.pendingOpen || sget('flowId', null)
      SHARED.pendingOpen = null
      const pick = list.find((f) => f.id === wanted) ? wanted : list[0] ? list[0].id : null
      const sel = storedSelectionRef.current
      storedSelectionRef.current = null
      // Stay on the loading screen until the last flow is open: switching ready first flashed the Welcome page.
      try {
        if (pick) await latest.current.openFlow(pick, { select: Array.isArray(sel) ? sel : [] })
      } finally {
        setBoot({ status: 'ready', error: '' })
      }
      if (SHARED.pendingRun) {
        SHARED.pendingRun = false
        if (pick) latest.current.startRun({})
      }
      return true
    } catch (err) {
      setBoot({ status: 'error', error: parseRestError(err).message })
      return false
    }
  }
  const createAndOpen = async (body, okText) => {
    try {
      const saved = await persistForFlowChange(
        latest.current.persist,
        () => saveBlocker(conflictRef.current, flowRef.current, loadedRef.current),
        () => api.createFlow(body),
        (reason) => notify(reason, conflictRef.current ? 'warn' : 'error'),
      )
      if (!saved.ok) return
      const res = saved.value
      await latest.current.refreshFlows()
      await latest.current.openFlow(res.flow.id)
      if (okText) notify(okText, 'ok', 2500)
    } catch (err) {
      notify(parseRestError(err).message, 'error')
    }
  }
  const newFlow = () => createAndOpen({ name: 'Untitled flow' })
  const newFromTemplate = (templateId) => createAndOpen({ template: templateId }, 'Flow created from the template.')
  const refreshTemplates = async () => {
    try {
      const tp = await api.templates()
      setTemplates(tp.templates || [])
    } catch {
      /* keep the list we have */
    }
  }
  const onTemplatesChanged = () => latest.current.refreshTemplates()
  const submitTemplate = async (values) => {
    const dialog = templateDialog
    if (!dialog) return
    setTemplateBusy(true)
    try {
      if (dialog.mode === 'save') {
        const current = flowRef.current
        if (!current) return
        await latest.current.persist() // the engine copies the saved file
        const res = await api.saveTemplate({ flow_id: current.id, ...values })
        notify(`Saved as template “${res.template.name}”. It is in the Flows menu under Your templates.`, 'ok', 4500)
      } else {
        await api.updateTemplate(dialog.template.id, { name: values.name, description: values.description })
        notify('Template updated.', 'ok', 2500)
      }
      setTemplateDialog(null)
      await latest.current.refreshTemplates()
    } catch (err) {
      notify(parseRestError(err).message, 'error')
    } finally {
      setTemplateBusy(false)
    }
  }
  const removeTemplate = async (t) => {
    try {
      await api.deleteTemplate(t.id)
      notify(`Template “${t.name || t.id}” deleted.`, 'ok', 2500)
      await latest.current.refreshTemplates()
    } catch (err) {
      notify(parseRestError(err).message, 'error')
    }
  }
  const duplicateFlow = async () => {
    const current = flowRef.current
    if (!current) return
    try {
      const saved = await persistForFlowChange(
        latest.current.persist,
        () => saveBlocker(conflictRef.current, flowRef.current, loadedRef.current),
        () => api.duplicate(current.id),
        (reason) => notify(reason, conflictRef.current ? 'warn' : 'error'),
      )
      if (!saved.ok) return
      const res = saved.value
      await latest.current.refreshFlows()
      await latest.current.openFlow(res.flow.id)
      notify('Flow duplicated.', 'ok', 2500)
    } catch (err) {
      notify(parseRestError(err).message, 'error')
    }
  }
  const deleteFlow = async () => {
    const current = flowRef.current
    if (!current) return
    clearTimeout(saveTimerRef.current)
    loadedRef.current = current
    deletingRef.current = current.id
    try {
      await api.deleteFlow(current.id)
      const list = (await latest.current.refreshFlows()) || []
      await latest.current.openFlow(list[0] ? list[0].id : null)
      notify('Flow moved to the trash.', 'ok', 3000)
    } catch (err) {
      notify(parseRestError(err).message, 'error')
    }
  }
  const tidy = async () => {
    const current = flowRef.current
    if (!current) return
    await latest.current.persist()
    if (conflictRef.current || flowRef.current !== loadedRef.current) return
    await chainWork(async () => {
      try {
        const res = await api.layout(current.id, baseRevRef.current, measureNodeSizes(rootRef.current, current))
        loadedRef.current = res.flow
        baseRevRef.current = res.flow.revision
        setDoc((d) => applyEdit(d, res.flow))
        needFitRef.current = true
      } catch (err) {
        notify(parseRestError(err).message, 'error')
      }
    })
  }
  const messagingOptIn = async (nodeId, enable, allowAttachments = false) => {
    const current = flowRef.current
    if (!current) return
    await latest.current.persist()
    if (conflictRef.current || flowRef.current !== loadedRef.current) return
    await chainWork(async () => {
      try {
        const res = await api.messagingOptIn(current.id, nodeId, enable, baseRevRef.current, allowAttachments)
        loadedRef.current = res.flow
        baseRevRef.current = res.flow.revision
        setDoc((d) => applyEdit(d, res.flow))
        notify(enable
          ? (allowAttachments ? 'Text and file sending enabled. A run can upload a real attachment.' : 'Sending enabled for this recipient. A run will now send a real message.')
          : 'Sending disabled for this node.', enable ? 'warn' : 'info', 4500)
      } catch (err) {
        notify(parseRestError(err).message, 'error')
      }
    })
  }
  const triggerSwitch = async (nodeId, active, rotate = false) => {
    const current = flowRef.current
    if (!current) return null
    await latest.current.persist()           // a trigger fires what is saved: save the canvas first
    if (conflictRef.current || flowRef.current !== loadedRef.current) {
      notify(saveBlocker(conflictRef.current, flowRef.current, loadedRef.current) || 'Save the flow first.', 'warn')
      return null
    }
    let out = null
    await chainWork(async () => {
      try {
        const res = await api.triggerSwitch(current.id, nodeId, active, baseRevRef.current, rotate)
        loadedRef.current = res.flow
        baseRevRef.current = res.flow.revision
        setDoc((d) => applyEdit(d, res.flow))
        notify(rotate ? 'New webhook URL. The old one no longer works.'
          : active ? 'Trigger active: it starts this flow by itself while Hermes runs.' : 'Trigger off.', active ? 'ok' : 'info', 4500)
        out = res
      } catch (err) {
        notify(parseRestError(err).message, 'error')
      }
    })
    return out
  }
  const stopGeneration = async () => {
    const id = generationJobRef.current
    if (!id) return
    try {
      await api.generateCancel(id)   // the poll loop then reports "Build cancelled" and keeps the prompt
    } catch (err) {
      notify(parseRestError(err).message, 'error')
    }
  }
  const generateFlow = async () => {
    if (generatingRef.current) return
    const draft = { ...generation.draft }
    if (!draft.prompt.trim()) return
    const original = flowRef.current
    generatingRef.current = true
    dispatchGeneration({ type: 'start', at: Date.now() })
    let result = null
    let failure = null
    try {
      await latest.current.persist()
      if (original && flowRef.current?.id !== original.id) throw new Error('The open flow changed. Build again from its current state.')
      if (conflictRef.current) throw new Error('Resolve the save conflict first, then build again.')
      if (original && flowRef.current !== loadedRef.current) throw new Error('Save the current edits successfully before building with Hermes.')
      await chainWork(async () => {
        try {
          // The model list Hermes offers, so the build can set LLM nodes to models the user names. Optional:
          // without the gateway the build still works, it just cannot pick LLM models.
          const llmModels = await loadModelOptions().then(llmModelsHint, () => null)
          const res = await runGenerationJob(api, generationBody({
            ...draft, flow: original, baseRevision: original ? baseRevRef.current : null, llmModels,
          }), {
            onProgress: (job) => {
              generationJobRef.current = job.id
              dispatchGeneration({ type: 'progress', jobId: job.id, phase: job.phase, elapsed: job.elapsed_s })
            },
          })
          if (!res.created) {
            if (!flowRef.current || flowRef.current.id !== res.flow.id) {
              throw new Error(`Hermes saved the changes to “${res.flow.name}”; open it from Flows to view them.`)
            }
            loadedRef.current = res.flow
            baseRevRef.current = res.flow.revision
            conflictRef.current = null
            setConflict(null)
            setSaveError('')
            setSaveState('saved')
            setDoc((d) => applyEdit(d, res.flow))
            needFitRef.current = true
            setFlows((list) => list.map((f) => (f.id === res.flow.id
              ? { ...f, name: res.flow.name, revision: res.flow.revision, updated_at: res.flow.updated_at, node_count: res.flow.nodes.length }
              : f)))
            latest.current.validateNow(res.flow.id)
          }
          result = res
        } catch (err) {
          failure = err
        }
      })
      if (failure) throw failure
      if (result.created) {
        if (flowRef.current !== original) throw new Error(`Hermes saved “${result.flow.name}”; open it from Flows.`)
        await latest.current.refreshFlows()
        await latest.current.openFlow(result.flow.id)
      }
      dispatchGeneration({ type: 'success' })
      notify(generationSummary(result), 'ok', 6000)
    } catch (err) {
      const e = parseRestError(err)
      if (e.status === 409) {
        const c = { revision: e.detail && typeof e.detail === 'object' ? e.detail.current_revision : null }
        conflictRef.current = c
        setConflict(c)
        setSaveState('conflict')
        dispatchGeneration({ type: 'close' }) // keeps the draft for the retry
        notify('The flow changed elsewhere. Choose Load latest or Keep mine, then build again.', 'warn', 7000)
      } else {
        dispatchGeneration({ type: 'fail', error: e.message })
      }
    } finally {
      generatingRef.current = false
      generationJobRef.current = null
    }
  }
  const loadTheirs = async () => {
    const current = flowRef.current
    const token = openTokenRef.current
    if (!current) return
    try {
      const res = await api.getFlow(current.id)
      if (token !== openTokenRef.current || flowRef.current !== current) return
      const hadHistory = !!(docRef.current && (docRef.current.undo.length || docRef.current.redo.length))
      loadedRef.current = res.flow
      baseRevRef.current = res.flow.revision
      conflictRef.current = null
      setConflict(null)
      setSaveState('saved')
      setDoc((d) => applyRemote(d, res.flow))   // U-15: the local history belongs to a flow this is not
      latest.current.validateNow(current.id)
      if (hadHistory) notify('Loaded the latest revision — undo history cleared.', 'info', 5000)
    } catch (err) {
      if (token === openTokenRef.current && flowRef.current === current) notify(parseRestError(err).message, 'error')
    }
  }
  const keepMine = async () => {
    const current = flowRef.current
    const token = openTokenRef.current
    if (!current) return
    let revision = conflictRef.current && conflictRef.current.revision
    if (revision === null || revision === undefined) {
      try {
        revision = (await api.getFlow(current.id)).flow.revision
      } catch {
        if (token !== openTokenRef.current || flowRef.current !== current) return
        revision = baseRevRef.current
      }
    }
    if (token !== openTokenRef.current || flowRef.current !== current) return
    baseRevRef.current = revision
    conflictRef.current = null
    setConflict(null)
    loadedRef.current = null
    latest.current.persist()
  }
  const askHermes = async () => {
    const text = askPrompt(flowRef.current)
    const focused = host.state && host.state.focusedSessionId
    const sid = focused && typeof focused.get === 'function' ? focused.get() : null
    try {
      if (await draftToComposer(host, sid, text)) {
        notify('A prompt is waiting in your chat composer — finish the sentence and send it.', 'ok', 4500)
        return
      }
      if (typeof sdk.writeClipboardText === 'function') {
        await sdk.writeClipboardText(text)
        notify('No chat composer is open, so the prompt was copied — open a chat, paste it and finish the sentence.', 'warn', 6500)
      } else notify('Open a chat first, then choose Discuss in chat again.', 'warn')
    } catch (err) {
      notify(parseRestError(err).message, 'error')
    }
  }

  // ---- runs
  const refreshTimings = async () => {
    try {
      setTimings(indexTimings(await api.timings()))
    } catch {
      /* durations are a hint; an older engine has no /x/timings */
    }
  }
  const finishedRun = (r) => {
    if (!r || !r.id || announcedRef.current.has(r.id)) return
    announcedRef.current.add(r.id)
    latest.current.refreshFlows()
    latest.current.refreshTimings()
    if (r.status === 'done') notify(`Run finished in ${formatMs(r.ms)}.`, 'ok')
    else if (r.status === 'error') notify(`Run failed — ${r.error || 'see the run log'}`, 'error', 9000)
    else if (r.status === 'cancelled') notify('Run stopped.', 'warn')
    else if (r.status === 'interrupted') notify('The run was interrupted (Hermes restarted).', 'warn')
    else if (r.status === 'invalid') notify(`The flow cannot run yet — ${r.error || 'see the checks'}`, 'error', 9000)
  }
  const refreshRun = async (runId) => {
    if (!runId) return false
    try {
      const res = await api.run(runId)
      // events may have landed while this fetch was in flight: merge them instead of dropping the newer status
      setRun((cur) => (cur && cur.id === runId ? mergeRun(cur, res.run) : cur))
      if (TERMINAL.has(res.run.status) && runRef.current && runRef.current.id === runId) latest.current.finishedRun(res.run)
      // first answer after a lost connection: the flow and its last run may have changed meanwhile
      if (reportConnection(true).recovered) latest.current.recoverConnection()
      return true
    } catch {
      /* the fallback poll retries; three misses in a row show the retry banner */
      reportConnection(false)
      return false
    }
  }
  const scheduleRunRefresh = (runId) => {
    if (runRefreshTimerRef.current) return
    runRefreshTimerRef.current = setTimeout(() => {
      runRefreshTimerRef.current = null
      latest.current.refreshRun(runId)
    }, 300)
  }
  const startRun = async (opts = {}) => {
    const current = flowRef.current
    if (!current || !current.nodes.length) return
    if (isRunActive(runRef.current)) {
      notify('A run is already in progress.', 'warn')
      return
    }
    await latest.current.persist()
    const blocked = saveBlocker(conflictRef.current, flowRef.current, loadedRef.current)
    if (blocked) {
      notify(blocked, conflictRef.current ? 'warn' : 'error')
      return
    }
    setRun({ id: null, flow_id: current.id, status: 'starting', nodes: {}, order: [] })
    try {
      const res = await api.startRun({ flow_id: current.id, target_node: opts.target || undefined, fresh: !!opts.fresh })
      if (res.status === 'invalid') {
        setIssues(res.issues || [])
        const r = {
          id: res.run_id, flow_id: current.id, status: 'invalid', issues: res.issues || [], nodes: {}, order: [],
          error: res.issues && res.issues[0] ? res.issues[0].message : 'invalid flow', started_at: new Date().toISOString()
        }
        setRun(r)
        latest.current.finishedRun(r)
        return
      }
      setRun((r) => (r && r.id === res.run_id ? r : {
        id: res.run_id, flow_id: current.id, status: 'running', nodes: {}, order: [], target_node: opts.target || null,
        fresh: !!opts.fresh, started_at: new Date().toISOString()
      }))
      latest.current.refreshRun(res.run_id)
    } catch (err) {
      setRun(null)
      notify(parseRestError(err).message, 'error', 9000)
    }
  }
  const stopRun = async () => {
    const r = runRef.current
    if (!r || !r.id) return
    try {
      await api.cancel(r.id)
      latest.current.refreshRun(r.id)
    } catch (err) {
      notify(parseRestError(err).message, 'error')
    }
  }

  // ---- live events
  const onFlowChanged = (pl) => {
    clearTimeout(flowsTimerRef.current)
    flowsTimerRef.current = setTimeout(() => latest.current.refreshFlows(), 300)
    const current = flowRef.current
    if (!current || pl.flow_id !== current.id) return
    if (pl.deleted) {
      if (deletingRef.current === pl.flow_id) return
      if (loadedRef.current === current && savingRef.current === null) {
        notify('This flow was deleted elsewhere.', 'warn')
        latest.current.refreshFlows().then((list) => latest.current.openFlow(list && list[0] ? list[0].id : null))
      }
      return
    }
    if (savingRef.current) {
      savingRef.current.then(() => latest.current.onFlowChanged(pl))
      return
    }
    if (!(pl.revision > (baseRevRef.current || 0))) return
    if (current === loadedRef.current) {
      api.getFlow(current.id).then((res) => {
        if (flowRef.current !== current) return
        const hadHistory = !!(docRef.current && (docRef.current.undo.length || docRef.current.redo.length))
        loadedRef.current = res.flow
        baseRevRef.current = res.flow.revision
        setDoc((d) => applyRemote(d, res.flow))   // U-15: not undoable — Ctrl+Z must not revert Hermes' edit
        latest.current.validateNow(current.id)
        if (hadHistory) {
          notify(pl.origin === 'agent'
            ? 'Hermes changed this flow — undo history cleared.'
            : 'This flow was changed elsewhere — undo history cleared.', 'info', 6000)
        } else {
          notify(pl.origin === 'agent' ? 'Hermes updated this flow.' : 'This flow was updated elsewhere.', 'info', 3500)
        }
      }).catch(() => {})
    } else {
      const c = { revision: pl.revision }
      conflictRef.current = c
      setConflict(c)
      setSaveState('conflict')
    }
  }
  const onRunStarted = (pl) => {
    const current = flowRef.current
    if (!current || pl.flow_id !== current.id) return
    const r = runRef.current
    if (r && (r.id === pl.run_id || r.status === 'starting')) return
    lastEventRef.current = Date.now()
    setRun({
      id: pl.run_id, flow_id: pl.flow_id, status: 'running', order: pl.nodes || [],
      nodes: Object.fromEntries((pl.nodes || []).map((n) => [n, { status: 'queued' }])), started_at: new Date().toISOString()
    })
  }
  const onNodeStatus = (pl) => {
    const r = runRef.current
    if (!r || r.id !== pl.run_id) return
    lastEventRef.current = Date.now()
    setRun((cur) => {
      if (!cur || cur.id !== pl.run_id) return cur
      const next = applyNodeStatus((cur.nodes && cur.nodes[pl.node_id]) || {}, pl)
      return { ...cur, status: cur.status === 'queued' ? 'running' : cur.status, nodes: { ...cur.nodes, [pl.node_id]: next } }
    })
    // outputs (thumbnails, inspector values) only live in the run record
    if (pl.status === 'done' || pl.status === 'cached' || pl.status === 'error') latest.current.scheduleRunRefresh(pl.run_id)
  }
  const onRunFinished = (pl) => {
    const r = runRef.current
    if (!r || r.id !== pl.run_id) return
    lastEventRef.current = Date.now()
    setRun((cur) => (cur && cur.id === pl.run_id ? { ...cur, status: pl.status, ms: pl.ms } : cur))
    latest.current.refreshRun(pl.run_id)
  }
  const openPending = async (flowId) => {
    if (!flowId) return
    await latest.current.refreshFlows()
    latest.current.openFlow(flowId)
  }

  // ---- edits
  const edit = (fn, key) => setDoc((d) => (d.flow ? applyEdit(d, fn(d.flow), key ? { key } : {}) : d))
  const select = (ids, mode = 'replace') => {
    setSelectedEdge(null)
    setSelection((cur) => {
      if (mode === 'toggle') {
        const s = new Set(cur)
        for (const id of ids) {
          if (s.has(id)) s.delete(id)
          else s.add(id)
        }
        return [...s]
      }
      if (mode === 'add') return [...new Set([...cur, ...ids])]
      return ids
    })
  }
  const addNodeAt = (type, x, y) => {
    const current = flowRef.current
    if (!current) return
    const spec = typesRef.current.byName[type]
    const pos = freeSpot(current, snap(x), snap(y))
    const { node } = addNode(current, { type, x: pos.x, y: pos.y, params: defaultParams(spec) })
    const nextRecent = rememberType(recentRef.current, type)
    recentRef.current = nextRecent
    setRecent(nextRecent)
    sset('recentTypes', nextRecent)
    edit((f) => ({ ...f, nodes: [...f.nodes, node] }))
    setSelection([node.id])
    setSelectedEdge(null)
  }
  // ---- files (G3): Browse… through ctx.os (one file per dialog), drops through the upload route
  // A picked file is signed for (flow, node, path) and kept in the node's picked_files: the backend runs a local file
  // outside the uploads folder only with that pick, and drops it whenever the agent edits the node.
  const confirmPick = async (nodeId, path, folder = false) => {
    const current = flowRef.current
    if (!current || !nodeId || !path) return
    try {
      const res = await api.filePick(current.id, nodeId, path, folder)
      edit((f) => {
        const n = f.nodes.find((x) => x.id === nodeId)
        if (!n) return f
        return updateNode(f, nodeId, { params: { [PICKED_FILES]: pickedFilesWith(n.params, res.path || path, res.token) } }, typesRef.current.byName)
      }, `p:${nodeId}:${PICKED_FILES}`)
    } catch (err) {
      notify(`This file cannot be used: ${parseRestError(err).message}`, 'error')
    }
  }
  const pickFile = async (kind, nodeId) => {
    const os = ctx && ctx.os
    if (!os || typeof os.pickOpenPath !== 'function') return null
    let picked = null
    const folder = kind === 'folder'   // Folder watch trigger: a folder dialog, signed like a file pick
    try {
      picked = await os.pickOpenPath(folder ? { title: 'Choose a folder to watch', directories: true }
        : { title: `Choose ${kind && kind !== 'auto' ? `an ${kind}` : 'a'} file`, filters: fileFilters(kind, typesRef.current.extKinds) })
    } catch {
      return null
    }
    if (picked && nodeId) await confirmPick(nodeId, picked, folder)
    return picked
  }
  const addFileNodes = (files, x, y) => {
    const current = flowRef.current
    const spec = typesRef.current.byName['input.file']
    if (!current || !files.length) return []
    if (!spec) {
      notify('The File node type is not available.', 'error')
      return []
    }
    const added = fileNodes(current, files, x, y, spec)
    edit((f) => ({ ...f, nodes: [...f.nodes, ...added] }))
    setSelection(added.map((n) => n.id))
    setSelectedEdge(null)
    return added
  }
  const dropFiles = async (files, x, y) => {
    const t = typesRef.current
    const flowId = flowRef.current && flowRef.current.id
    const problems = files.length > MAX_DROP_FILES ? [`Only the first ${MAX_DROP_FILES} files are added.`] : []
    const ok = []
    for (const f of files.slice(0, MAX_DROP_FILES)) {
      const c = checkDropFile(f, t.extKinds, t.uploadMax)
      if (c.ok) ok.push(f)
      else problems.push(c.reason)
    }
    const stored = []
    if (ok.length) {
      setUploading(ok.length)
      try {
        for (const f of ok) {
          try {
            const res = await api.upload(f.name, f)
            stored.push({ path: res.path, name: res.name || f.name })
          } catch (err) {
            problems.push(`${f.name}: ${parseRestError(err).message}`)
          }
        }
      } finally {
        setUploading(0)
      }
    }
    if (stored.length && flowRef.current && flowRef.current.id === flowId) addFileNodes(stored, x, y)
    else if (stored.length) problems.push('The flow changed while uploading; the files were stored but not added.')
    if (problems.length) notify(problems.slice(0, 3).join(' · ') + (problems.length > 3 ? ` (+${problems.length - 3} more)` : ''), stored.length ? 'warn' : 'error', 9000)
    else notify(`Added ${stored.length} File node${stored.length === 1 ? '' : 's'}.`, 'ok', 2500)
  }
  const addFromPalette = (type) => {
    const s = sizeRef.current
    const c = screenToWorld(view, { x: s.w / 2, y: s.h / 2 })
    addNodeAt(type, c.x - NODE_W / 2, c.y - 50)
  }
  const deleteSelection = () => {
    const edgeId = edgeSelRef.current
    if (edgeId) {
      edit((f) => disconnect(f, edgeId))
      setSelectedEdge(null)
      return
    }
    const ids = selectionRef.current
    if (!ids.length) return
    edit((f) => removeNodes(f, ids))
    setSelection([])
  }
  const duplicateSelection = () => {
    const current = flowRef.current
    const ids = selectionRef.current
    if (!current || !ids.length) return
    const sub = cloneSubgraph(current, ids, 40, 40)
    edit((f) => insertSubgraph(f, sub))
    setSelection(sub.nodes.map((n) => n.id))
  }
  const copySelection = (verb = 'Copied') => {
    const current = flowRef.current
    const ids = new Set(pruneSelection(selectionRef.current, current))
    if (!current || !ids.size) return 0
    CLIPBOARD = {
      nodes: JSON.parse(JSON.stringify(current.nodes.filter((n) => ids.has(n.id)))),
      edges: JSON.parse(JSON.stringify(current.edges.filter((e) => ids.has(e.from.node) && ids.has(e.to.node))))
    }
    notify(`${verb} ${ids.size} node${ids.size === 1 ? '' : 's'}.`, 'info', 1800)
    return ids.size
  }
  const cutSelection = () => {
    if (!copySelection('Cut')) return
    const ids = selectionRef.current
    edit((f) => removeNodes(f, ids))
    setSelection([])
    setSelectedEdge(null)
  }
  /** `at` (world point) pastes there — context menu; without it the copy lands +40 px or in view. */
  const pasteClipboard = (at) => {
    const current = flowRef.current
    if (!current || !CLIPBOARD || !CLIPBOARD.nodes.length) return
    let sub = cloneSubgraph(CLIPBOARD, CLIPBOARD.nodes.map((n) => n.id), 40, 40, nodeIdSet(current), edgeIdSet(current))
    sub = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? placeSubgraph(sub, at) : placeInView(sub, view, sizeRef.current)
    CLIPBOARD = { nodes: JSON.parse(JSON.stringify(sub.nodes)), edges: CLIPBOARD.edges.map((e) => ({ ...e, from: { ...e.from, node: sub.map[e.from.node] }, to: { ...e.to, node: sub.map[e.to.node] } })) }
    edit((f) => insertSubgraph(f, sub))
    setSelection(sub.nodes.map((n) => n.id))
  }
  const connectPorts = (from, to, replaceEdgeId) => {
    const base = replaceEdgeId ? disconnect(flowRef.current, replaceEdgeId) : flowRef.current
    const check = canConnect(base, typesRef.current, from, to)
    if (!check.ok) {
      notify(check.reason, 'warn', 3500)
      return
    }
    edit((f) => connect(replaceEdgeId ? disconnect(f, replaceEdgeId) : f, from, to, typesRef.current))
  }
  const toggleExpand = (id) => setExpanded((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  })

  latest.current = {
    notify, validateNow, refreshFlows, scheduleSave, doSave, persist, loadLastRun, openFlow, bootUp, finishedRun,
    refreshRun, scheduleRunRefresh, startRun, refreshTimings, onFlowChanged, onRunStarted, onNodeStatus, onRunFinished, openPending,
    refreshTemplates, onTemplatesChanged, recoverConnection, retryConnection
  }

  // ---- effects
  useEffect(() => {
    latest.current.bootUp()
  }, [])
  useEffect(() => {
    const offs = []
    if (typeof host.onEvent === 'function') {
      const map = {
        'flow.changed': 'onFlowChanged', 'run.started': 'onRunStarted', 'node.status': 'onNodeStatus', 'run.finished': 'onRunFinished',
        'templates.changed': 'onTemplatesChanged'
      }
      for (const [name, fn] of Object.entries(map)) {
        offs.push(host.onEvent(evt(name), (msg) => latest.current[fn]((msg && msg.payload) || {})))
      }
    }
    const onOpen = (id) => latest.current.openPending(id)
    SHARED.listeners.add(onOpen)
    // Sticky for the life of the window (U-14): the boot navigation retries stop for good once the page showed,
    // so navigating away later is not undone by a late retry.
    SHARED.pageMounted = true
    SHARED.runCurrent = () => latest.current.startRun({})
    return () => {
      offs.forEach((off) => {
        if (typeof off === 'function') off()
      })
      SHARED.listeners.delete(onOpen)
      SHARED.runCurrent = null
    }
  }, [])
  useEffect(() => {
    if (!flow || flow === loadedRef.current || conflictRef.current) return
    setSaveState('dirty')
    latest.current.scheduleSave()
  }, [flow])
  const runId = run ? run.id : null
  const runActive = !!runId && !TERMINAL.has(run.status)
  useEffect(() => {
    if (!runActive) return undefined
    // fallback when live events stop arriving
    const t = setInterval(() => {
      if (Date.now() - lastEventRef.current > POLL_MS) latest.current.refreshRun(runId)
    }, POLL_MS)
    return () => clearInterval(t)
  }, [runActive, runId])
  const flowId = flow ? flow.id : null
  useEffect(() => {
    if (!flowId) return undefined
    const t = setTimeout(() => sset(`view:${flowId}`, view), 400)
    return () => clearTimeout(t)
  }, [view, flowId])
  useEffect(() => {
    sset('selection', selection)
  }, [selection])
  // undo/redo or an agent edit can remove nodes/edges that are still selected
  useEffect(() => {
    if (!flow) return
    setSelection((cur) => pruneSelection(cur, flow))
    setSelectedEdge((cur) => (cur && !flow.edges.some((e) => e.id === cur) ? null : cur))
  }, [flow])
  useEffect(() => () => {
    clearTimeout(saveTimerRef.current)
    clearTimeout(noticeTimerRef.current)
    clearTimeout(flowsTimerRef.current)
    clearTimeout(runRefreshTimerRef.current)
    const d = docRef.current
    if (d.flow) SHARED.session = { flowId: d.flow.id, undo: d.undo, redo: d.redo }
    latest.current.persist()
  }, [])

  // ---- derived
  const edges = flow ? flow.edges : null
  const nodes = flow ? flow.nodes : null
  const connectedIn = useMemo(() => {
    const m = {}
    for (const e of edges || []) (m[e.to.node] = m[e.to.node] || new Set()).add(e.to.port)
    return m
  }, [edges])
  const connectedOut = useMemo(() => {
    const m = {}
    for (const e of edges || []) (m[e.from.node] = m[e.from.node] || new Set()).add(e.from.port)
    return m
  }, [edges])
  const wireCounts = useMemo(() => {
    const m = {}
    const bump = (node, side, port) => {
      const bySide = (m[node] = m[node] || { in: {}, out: {} })[side]
      bySide[port] = (bySide[port] || 0) + 1
    }
    for (const e of edges || []) {
      bump(e.to.node, 'in', e.to.port)
      bump(e.from.node, 'out', e.from.port)
    }
    return m
  }, [edges])
  const loopOwners = useMemo(() => loopBodies({ nodes: nodes || [], edges: edges || [] }), [nodes, edges])
  const nameOf = (id) => {
    const n = (nodes || []).find((x) => x.id === id)
    return n ? nodeTitle(n, types.byName) : ''
  }
  const layouts = useMemo(() => {
    const out = {}
    for (const n of nodes || []) out[n.id] = nodeLayout(n, types.byName[n.type], connectedIn[n.id], expanded.has(n.id))
    return out
  }, [nodes, types, connectedIn, expanded])
  const issuesByNode = useMemo(() => {
    const m = {}
    for (const i of issues) if (i.node && (!m[i.node] || i.level === 'error')) m[i.node] = i.message
    return m
  }, [issues])
  const running = isRunActive(run)
  const mediaItems = useMemo(() => runMediaList(run, flow, types.byName), [run, flow, types])
  const lightboxAt = lightbox ? mediaItems.findIndex((m) => m.key === lightbox) : -1
  useEffect(() => {
    if (lightbox && lightboxAt < 0) setLightbox(null)   // its run was replaced or re-started
  }, [lightbox, lightboxAt])
  const openMedia = ({ nodeId, port, index = 0, path }) => {
    const hit = mediaItems.find((m) => m.key === `${nodeId}|${port}|${index}`) ||
      (path ? mediaItems.find((m) => m.media.path === path) : null) ||
      mediaItems.find((m) => m.nodeId === nodeId)
    if (hit) setLightbox(hit.key)
  }
  const openValue = ({ nodeId, port = null, field = 'outputs' } = {}) => {
    if (!flow || !run || !run.id || !nodeId) return
    const node = flow.nodes && flow.nodes.find((n) => n.id === nodeId)
    if (!node || !run.nodes || !run.nodes[nodeId]) return
    setValueViewer({ flowId: flow.id, runId: run.id, nodeId, port: port != null ? port : null, field })
  }
  useEffect(() => {
    if (valueViewer && (!run || valueViewer.runId !== run.id || !flow || valueViewer.flowId !== flow.id)) {
      setValueViewer(null)
    }
  }, [valueViewer, run && run.id, flow && flow.id])

  const focusRoot = () => {
    if (rootRef.current) rootRef.current.focus({ preventScroll: true })
  }
  const onKeyDown = (e) => {
    if (!flow || isEditableTarget(e.target)) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
    if (mod && (k === 'a' || k === 'c' || k === 'x')) {
      const sel = window.getSelection ? String(window.getSelection()) : ''
      const canvasEl = rootRef.current && rootRef.current.querySelector('.fc-canvas')
      if (!canvasClipboardKey(k, { textSelected: sel !== '', nodesSelected: selection.length, inCanvas: inCanvasArea(e.target, canvasEl) })) return
    }
    let handled = true
    if (mod && k === 'z') setDoc(e.shiftKey ? redoDoc : undoDoc)
    else if (mod && k === 'y') setDoc(redoDoc)
    else if (mod && k === 'a') select(flow.nodes.map((n) => n.id))
    else if (mod && k === 'd') duplicateSelection()
    else if (mod && k === 'c') copySelection()
    else if (mod && k === 'x') cutSelection()
    else if (mod && k === 'v') pasteClipboard()
    else if (mod && k === 's') persist()
    else if (mod && k === 'Enter') startRun({ fresh: e.shiftKey })
    else if (!mod && (k === 'Delete' || k === 'Backspace')) deleteSelection()
    else if (!mod && k === 'f') {
      if (fitRef.current) fitRef.current()
    } else if (k === 'Escape') {
      setSelection([])
      setSelectedEdge(null)
      setMenuOpen(false)
    } else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  let body
  if (boot.status === 'loading') {
    body = h('div', { className: 'fc-center' }, h('div', { className: 'fc-muted' }, h(Icon, { name: 'loading', spin: true }), '  Loading Arachne Flow…'))
  } else if (boot.status === 'error') {
    body = h('div', { className: 'fc-center' }, h('div', { className: 'fc-welcome' },
      h('div', { className: 'fc-welcome-icon' }, h(Icon, { name: 'debug-disconnect' })),
      h('h2', null, 'Arachne Flow could not start'),
      h('p', null, boot.error || 'The plugin backend did not answer.'),
      h('p', { className: 'fc-muted' }, 'If you just installed or updated the plugin, restart Hermes Desktop once.'),
      h('button', { className: 'fc-btn primary', onClick: () => latest.current.bootUp() }, h(Icon, { name: 'refresh' }), 'Try again')))
  } else if (!flow) {
    body = h('div', { className: 'fc-center' }, h(Welcome, {
      templates, hasFlows: flows.length > 0, onNew: newFlow, onFromTemplate: newFromTemplate, onOpenMenu: () => setMenuOpen(true),
      generation, onGenerate: generateFlow, onGenerateEdit: (patch) => dispatchGeneration({ type: 'edit', patch }), onGenerateStop: stopGeneration,
    }))
  } else {
    body = h('div', { className: 'fc-main' },
      paletteOpen ? h(Palette, { types, recent, onAdd: addFromPalette, folds: paletteFoldState, onFolds: savePaletteFolds, timings }) : null,
      h(Canvas, {
        flow, types, recent, layouts, connectedIn, connectedOut, run, running, selection, selectedEdge, issuesByNode, view, setView, expanded, api,
        timings, nameOf, wireCounts, loopOwners,
        heightsRef, needFitRef, fitRef, sizeRef,
        generation, onGenerate: generateFlow, onGenerateEdit: (patch) => dispatchGeneration({ type: 'edit', patch }), onGenerateStop: stopGeneration,
        onFocusRoot: focusRoot,
        onSelect: select,
        onSelectEdge: (id) => {
          setSelectedEdge(id)
          setSelection([])
        },
        onMove: (positions) => setDoc((d) => (d.flow ? { ...d, flow: moveNodes(d.flow, positions) } : d)),
        onMoveEnd: (startFlow) => setDoc((d) => (d.flow && d.flow !== startFlow
          ? { ...d, undo: [...d.undo, startFlow].slice(-UNDO_LIMIT), redo: [], key: null } : d)),
        onConnect: connectPorts,
        onDisconnect: (id) => edit((f) => disconnect(f, id)),
        onDropType: addNodeAt,
        onToggleExpand: toggleExpand,
        onOpenInspector: () => {
          if (!inspectorOpen) {
            setInspectorOpen(true)
            sset('inspectorOpen', true)
          }
        },
        onRunTo: (id) => startRun({ target: id }),
        onOpenMedia: openMedia,
        onOpenValue: openValue,
        onDuplicate: duplicateSelection,
        onCopy: () => copySelection(),
        onCut: cutSelection,
        onPaste: pasteClipboard,
        canPaste: () => !!(CLIPBOARD && CLIPBOARD.nodes.length),
        onDelete: deleteSelection,
        onSelectAll: () => select(flow.nodes.map((n) => n.id)),
        onTidy: tidy,
        onDropFiles: dropFiles,
        uploading,
        savedRev: (flows.find((f) => f.id === flow.id) || flow).revision
      }),
      inspectorOpen ? h(Inspector, {
        flow, selection, types, run, issues, api, running, timings, onOpenValue: openValue,
        onSelect: select,
        onUpdateNode: (id, patch, key) => edit((f) => updateNode(f, id, patch, typesRef.current.byName), key),
        onChangeType: (id, type) => {
          edit((f) => changeNodeType(f, id, type, typesRef.current))
          const nextRecent = rememberType(recentRef.current, type)
          recentRef.current = nextRecent
          setRecent(nextRecent)
          sset('recentTypes', nextRecent)
        },
        onUpdateFlow: (patch, key) => edit((f) => ({ ...f, ...patch }), key),
        onMessagingOptIn: messagingOptIn,
        onTriggerSwitch: triggerSwitch,
        onRunTo: (id) => startRun({ target: id }),
        onOpenMedia: openMedia,
        onDelete: deleteSelection,
        onDuplicate: duplicateSelection,
        onPickFile: ctx && ctx.os && typeof ctx.os.pickOpenPath === 'function' ? pickFile : null,
        onAddFileBelow: (id, files) => {
          const n = flowRef.current && flowRef.current.nodes.find((x) => x.id === id)
          if (!n) return
          // measure now; the preview may still be loading (it vanishes while a new path is saved), so reserve
          // room for a full image preview (~250 px) to keep the new node clear of it
          const el = rootRef.current && rootRef.current.querySelector(`[data-fc-node="${id}"]`)
          const height = Math.max(el ? el.offsetHeight : 0, heightsRef.current[id] || 0, FILE_NODE_MIN_H)
          const added = addFileNodes(files, n.x, n.y + height + 40)
          for (const node of added) confirmPick(node.id, node.params && node.params.path)   // picked with Browse…
        }
      }) : null)
  }

  return h('div', { ref: rootRef, className: focusWin ? 'fc-root fc-focus' : 'fc-root', tabIndex: -1, onKeyDown, 'data-fc-focus-window': focusWin ? '1' : undefined },
    h('style', null, CSS),
    h(Header, {
      flows, flow, templates, saveState, saveError, run, menuOpen, setMenuOpen, paletteOpen, inspectorOpen,
      closeMenu: () => setMenuOpen(false),
      onOpen: (id) => latest.current.openFlow(id),
      onNew: newFlow,
      onFromTemplate: newFromTemplate,
      onDuplicate: duplicateFlow,
      onDelete: deleteFlow,
      onSaveTemplate: () => {
        setMenuOpen(false)
        if (flowRef.current) setTemplateDialog({ mode: 'save' })
      },
      onEditTemplate: (t) => {
        setMenuOpen(false)
        setTemplateDialog({ mode: 'edit', template: t })
      },
      onDeleteTemplate: removeTemplate,
      onRename: (name) => edit((f) => ({ ...f, name })),
      onRun: (opts) => startRun(opts),
      onStop: stopRun,
      onLayout: tidy,
      onGenerate: () => dispatchGeneration({ type: 'open' }),
      generationBusy: generation.busy,
      onAsk: askHermes,
      onShowHermes: focusWin ? leaveFocusWindow : null,
      onUndo: () => setDoc(undoDoc),
      onRedo: () => setDoc(redoDoc),
      canUndo: doc.undo.length > 0,
      canRedo: doc.redo.length > 0,
      togglePalette: () => {
        sset('paletteOpen', !paletteOpen)
        setPaletteOpen(!paletteOpen)
      },
      toggleInspector: () => {
        sset('inspectorOpen', !inspectorOpen)
        setInspectorOpen(!inspectorOpen)
      }
    }),
    conflict ? h('div', { className: 'fc-banner warn' },
      h(Icon, { name: 'warning' }),
      h('span', null, 'This flow was changed elsewhere (maybe by Hermes) while you were editing.'),
      h('span', { className: 'fc-grow' }),
      h('button', { className: 'fc-btn', onClick: loadTheirs }, 'Load latest'),
      h('button', { className: 'fc-btn', onClick: keepMine }, 'Keep mine')) : null,
    saveState === 'error' ? h('div', { className: 'fc-banner bad' },
      h(Icon, { name: 'error' }),
      h('span', null, `Saving failed: ${saveError}`),
      h('span', { className: 'fc-grow' }),
      h('button', { className: 'fc-btn', onClick: () => persist() }, 'Retry')) : null,
    connLost ? h('div', { className: 'fc-banner bad' },
      h(Icon, { name: 'debug-disconnect' }),
      h('span', null, 'Lost contact with the Arachne Flow backend.'),
      h('span', { className: 'fc-grow' }),
      h('button', { className: 'fc-btn', onClick: () => latest.current.retryConnection() }, h(Icon, { name: 'refresh' }), 'Retry')) : null,
    notice ? h('div', { className: `fc-notice ${notice.tone}`, onClick: () => setNotice(null) },
      h(Icon, { name: NOTICE_ICON[notice.tone] || 'info' }), h('span', null, notice.text)) : null,
    body,
    flow ? h(RunLog, {
      run, flow, types, open: logOpen, onSelect: select, timings, nameOf,
      onToggle: () => {
        sset('logOpen', !logOpen)
        setLogOpen(!logOpen)
      }
    }) : null,
    generation.open ? h(DialogFrame, {
      label: 'Build with Hermes',
      scrim: { 'data-fc-generate-dialog': '1' },
      onCancel: () => dispatchGeneration({ type: 'close' })
    }, h('div', { className: 'fc-generate-modal' }, h(GenerateComposer, {
      flow, generation,
      onEdit: (patch) => dispatchGeneration({ type: 'edit', patch }),
      onSubmit: generateFlow,
      onStop: stopGeneration,
      onCancel: () => dispatchGeneration({ type: 'close' }),
    }))) : null,
    templateDialog ? h(TemplateDialog, {
      key: templateDialog.mode === 'edit' ? `edit-${templateDialog.template.id}` : 'save',
      mode: templateDialog.mode,
      initial: templateDialog.mode === 'edit' ? templateDialog.template : { name: flow ? flow.name : '', description: flow ? flow.description : '' },
      inputs: templateDialog.mode === 'save' ? filledInputs(flow) : [],
      busy: templateBusy,
      onSubmit: submitTemplate,
      onCancel: () => {
        setTemplateDialog(null)
        focusRoot()
      }
    }) : null,
    valueViewer && flow && run && valueViewer.flowId === flow.id && valueViewer.runId === run.id && flow.nodes && flow.nodes.find((n) => n.id === valueViewer.nodeId) ? h(ValueViewer, {
      api,
      run,
      flow,
      node: flow.nodes.find((n) => n.id === valueViewer.nodeId),
      port: valueViewer.port,
      field: valueViewer.field || 'outputs',
      onClose: () => setValueViewer(null),
      onSelectPort: ({ nodeId, port }) => {
        const nextNodeId = nodeId || valueViewer.nodeId
        if (flow.nodes && flow.nodes.some((n) => n.id === nextNodeId)) {
          setValueViewer({
            flowId: flow.id,
            runId: run.id,
            nodeId: nextNodeId,
            field: valueViewer.field || 'outputs',
            port: port != null ? port : null,
          })
        }
      },
      onOpenMedia: (args) => {
        setValueViewer(null)
        openMedia(args)
      },
    }) : null,
    lightboxAt >= 0 && run ? h(Lightbox, {
      api, ctx, runId: run.id, items: mediaItems, at: lightboxAt,
      onMove: (i) => mediaItems[i] && setLightbox(mediaItems[i].key),
      onClose: () => {
        setLightbox(null)
        focusRoot()
      }
    }) : null)
}

