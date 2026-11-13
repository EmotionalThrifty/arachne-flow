// ---------------------------------------------------------------- exports
// U-12: a reload hot-swaps a fresh copy of this module, so nothing app-side may inherit the old run's data:
// media previews, file previews and model/tool catalogs are all thrown away when the host disposes the plugin.
function clearCaches() {
  MODEL_THUMBNAILS.clear()
  MEDIA_CACHE.clear()
  FILE_NODE_CACHE.clear()
  llmInfoCache.clear()
  modelInfoCache.clear()
  optionsCache.clear()
}
const cacheSizes = () => ({
  media: MEDIA_CACHE.size,
  fileNode: FILE_NODE_CACHE.size,
  llmInfo: llmInfoCache.size,
  modelInfo: modelInfoCache.size,
  toolOptions: optionsCache.size
})
const _internals = {
  Palette, MiniMedia, ModelThumbnail, createModelThumbnailCache, menuMatch, flowMenuModel, flowPickerChoice, FlowPicker, triggerWhen, triggerLines, TriggerGuard, isTriggerType,
  runGenerationJob, llmModelsHint, generationJobError, generationStatus, generationElapsed, GenerateComposer, measureNodeSizes, GENERATE_POLL_MS,
  NODE_W, HEAD_H, PORTS_TOP, ROW_H, GRID, MIN_ZOOM, MAX_ZOOM, COLLAPSE_AFTER, VISIBLE_OPTIONAL, UNDO_LIMIT, POLL_MS,
  // U-4: pure helpers used by the canvas render path (tested in tests/js/perf.test.mjs)
  edgePathWorld, rafThrottle, NodeCard, nodeCardPropsEqual, Canvas,
  templatePlaceholders, nodePorts, visibleInputs, nodeLayout, portPosition, edgePath, worldToScreen, screenToWorld,
  zoomAt, fitView, rectSelect, snap, compatible, addNode, removeNodes, moveNodes, ancestors, descendants, reaches,
  canConnect, connect, disconnect, updateNode, cloneSubgraph, insertSubgraph, defaultParams, freeSpot, applyEdit,
  disarmCopiedNode, messagingArmed, messagingScope,
  undoDoc, redoDoc, applyRemote, mergeRun, mergeNodeState, generateInitial, generateReducer, generationBody, generationSummary, filterTypes, groupByCategory, toolChoices, changeNodeType, nodesBox, placeSubgraph, placeInView, pruneSelection, askPrompt, draftToComposer, rememberType, resolveRecentTypes, formatMs, ago, parseRestError, findMedia, runMediaList, nodeOutputItems, MiniThumb, lightboxZoom, previewString,
  fileFilters, checkDropFile, dropSpots, fileNodes, pickedFilesWith, baseName, formatBytes, popoutFlow, takePopout, POPOUT_KEY, FOCUS_WINDOW_KEY, SHARED,
  // small review findings (E0): per-window hand-off ownership, boot navigation retries, copy feedback
  shouldConsumeHandoff, peekPopout, clearPopout, windowIdGet, WINDOW_ID_KEY, shouldRetryNavigate, clipboardOk,
  splitTemplates, filledInputs,
  muteTitles, WIRE_TIP_CSS, paramSummary, paramInfo, splitFields, paletteSections, presetGroups, nodeSubline, nodeFooter, toolProvider, autoPick, modelSetting, paletteFolds, allFoldsOpen, setAllFolds, typeTip, typeTipText, modelGroups, filterModelGroups, optionGroups, toolOptionCopy, formatPrice, fillHeight, parseNumberInput, saveBlocker, persistForFlowChange, spacePans, canvasClipboardKey, connectionState, recoveryPlan, LOST_CONTACT_AFTER, categoryColor, portColor, indexTypes, countStatuses, isRunActive, makeApi, loadRunValue, isEditableTarget,
  // accessibility (U-8): keyboard decisions for menus and dialogs
  menuKeyNav, menuRowsIn, FlowMenu, trapFocus, activatesOn,
  modelSetting, fieldControl, rangeHint, numberIssue, choiceValue, multiValues, mediaValues, addMediaPath, toggleChoice, effectiveValues, estimateCost,
  toolOptionLabel, extraVisible, extraValues, extraSpec, llmPickerInfo, llmInfoRows, estimateLlmCost,
  cacheOn, cachePatch, formatClock, typicalShort, timingModel, indexTimings, expectedTime, timingLines, typeTiming, statusTip, runTip, portTip,
  errorTip, tipText, HEADER_TIPS, switchCases, branchPort, edgeDead, branchLabel, MAX_CASES,
  loopBodies, itemsFinished, itemsLine, badgeLabel, itemRows,
  applyNodeStatus, setMediaItem, valuePorts, ValueViewer, formatJsonText, JsonInputEditor, SafeMarkdown, MarkdownEditor,
  fitImageLimit, wiredItemCount, parseGlb, readAccessor, collectModel, fitOrbit, orbitEye, orbitMatrix, computeNormals, uploadModelTexture, createModelRenderer, bindLightboxPan,
  // lifecycle (U-12): the byte-capped media cache rule, the caches themselves and the dispose hook
  mediaEntryBytes, mediaCacheBytes, evictMediaCache, fetchMedia, clearCaches, cacheSizes, MEDIA_CACHE_MAX_BYTES,
  caches: { media: MEDIA_CACHE, fileNode: FILE_NODE_CACHE, llmInfo: llmInfoCache, modelInfo: modelInfoCache, toolOptions: optionsCache }
}

export default {
  id: PLUGIN_ID,
  name: 'Arachne Flow',
  _internals,
  register(ctx) {
    // Everything this module wires to the outside goes through ctx when the host offers the lifecycle helpers
    // (U-12): bare timers/listeners are invisible to the host, so they would survive disable and every hot reload.
    const disposal = []
    const later = (fn, ms) => {
      if (typeof ctx.setTimeout === 'function') disposal.push(ctx.setTimeout(fn, ms))
      else {
        const t = setTimeout(fn, ms)
        disposal.push(() => clearTimeout(t))
      }
    }
    const subscribe = (type, fn) => {
      if (typeof ctx.onEvent === 'function') return ctx.onEvent(type, fn) // tracked by the host
      if (typeof host.onEvent !== 'function') return null
      const off = host.onEvent(type, fn)
      if (typeof off === 'function') disposal.push(off)
      return off
    }
    // One place to undo it all: scoped timers and fallback subscriptions, then the module-level caches (a reload
    // must not inherit the previous copy's media previews or model catalogs).
    const dispose = () => {
      const fns = disposal.splice(0)
      fns.forEach((fn) => {
        try {
          fn()
        } catch {
          /* one bad disposer must not keep the rest alive */
        }
      })
      clearCaches()
    }
    if (typeof ctx.onDispose === 'function') ctx.onDispose(dispose)
    const navigate = () => {
      if (typeof host.navigate === 'function') host.navigate(ROUTE)
    }
    ctx.register({ id: 'page', area: sdk.ROUTES_AREA, data: { path: ROUTE }, render: () => h(ArachneFlowPage, { ctx }) })
    ctx.register({ id: 'nav', area: sdk.SIDEBAR_NAV_AREA, data: { path: ROUTE, label: 'Arachne Flow', codicon: 'type-hierarchy' } })
    if (sdk.PALETTE_AREA) {
      ctx.register({
        id: 'palette-open',
        area: sdk.PALETTE_AREA,
        data: { id: 'arachne-flow.open', label: 'Arachne Flow: Open', keywords: ['flow', 'canvas', 'nodes', 'pipeline', 'workflow'], run: navigate }
      })
      ctx.register({
        id: 'palette-run',
        area: sdk.PALETTE_AREA,
        data: {
          id: 'arachne-flow.run',
          label: 'Arachne Flow: Run current flow',
          keywords: ['flow', 'run', 'execute', 'pipeline'],
          run: () => {
            if (SHARED.runCurrent) SHARED.runCurrent()
            else {
              SHARED.pendingRun = true
              navigate()
            }
          }
        }
      })
    }
    // G4: a window opened by "Open in new window" boots on the app's start route; take the hand-off (once, so no
    // other window acts on it) and show the same flow. Only a window that is not the one that left it takes it
    // (U-14: a hot reload of the source window must not turn it into the plugin-only window), and the entry stays
    // put for the peer when we do not take it. Re-navigate while the page has not mounted yet, because the peer
    // window's own boot can settle on its start route after this runs.
    const myId = windowIdGet()
    const handoff = peekPopout(ctx.storage)
    const now = Date.now()
    const takeIt = shouldConsumeHandoff(handoff, myId, now)
    const popped = takeIt ? popoutFlow(handoff, now) : null
    if (takeIt) clearPopout(ctx.storage)
    if (popped) focusWindowSet(true)
    else SHARED.focusWindow = focusWindowGet() // a reloaded Arachne Flow window stays one
    if (SHARED.focusWindow) {
      // this window exists for Arachne Flow: show the page (the popped flow, else the last one) right away
      if (popped) SHARED.pendingOpen = popped
      navigate()
      for (const ms of [700, 2000, 4500]) later(() => { if (shouldRetryNavigate(SHARED.pageMounted, SHARED.listeners.size)) navigate() }, ms)
    }
    subscribe(evt('ui.open'), (msg) => {
      const id = msg && msg.payload ? msg.payload.flow_id : null
      if (SHARED.listeners.size) SHARED.listeners.forEach((fn) => fn(id))
      else SHARED.pendingOpen = id
      navigate()
    })
  }
}
