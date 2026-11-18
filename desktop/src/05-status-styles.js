// ---------------------------------------------------------------- status vocab
const STATUS = {
  queued: { icon: 'circle-large-outline', color: 'var(--ui-text-tertiary)', label: 'Queued' },
  running: { icon: 'loading', spin: true, color: 'var(--ui-accent)', label: 'Running' },
  done: { icon: 'pass-filled', color: 'var(--ui-green)', label: 'Done' },
  cached: { icon: 'zap', color: 'var(--ui-cyan)', label: 'Cached' },
  error: { icon: 'error', color: 'var(--ui-red)', label: 'Failed' },
  skipped: { icon: 'debug-step-over', color: 'var(--ui-text-tertiary)', label: 'Skipped' },
  cancelled: { icon: 'circle-slash', color: 'var(--ui-text-tertiary)', label: 'Stopped' },
  interrupted: { icon: 'debug-disconnect', color: 'var(--ui-yellow)', label: 'Interrupted' }
}
const RUN_STATUS = {
  starting: { icon: 'loading', spin: true, color: 'var(--ui-accent)', label: 'Starting' },
  queued: { icon: 'loading', spin: true, color: 'var(--ui-accent)', label: 'Queued' },
  running: { icon: 'loading', spin: true, color: 'var(--ui-accent)', label: 'Running' },
  done: { icon: 'pass-filled', color: 'var(--ui-green)', label: 'Done' },
  error: { icon: 'error', color: 'var(--ui-red)', label: 'Failed' },
  cancelled: { icon: 'circle-slash', color: 'var(--ui-text-tertiary)', label: 'Stopped' },
  invalid: { icon: 'warning', color: 'var(--ui-yellow)', label: 'Not runnable' },
  interrupted: { icon: 'debug-disconnect', color: 'var(--ui-yellow)', label: 'Interrupted' }
}
const MEDIA_ICON = { image: 'file-media', audio: 'unmute', video: 'device-camera-video', model3d: 'package', file: 'file' }
const NOTICE_ICON = { ok: 'pass-filled', error: 'error', warn: 'warning', info: 'info' }
const SHORTCUTS = [
  ['Ctrl+Enter', 'Run the flow'],
  ['Shift+Run', 'Run without cache'],
  ['Del', 'Delete selection'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
  ['Ctrl+C / X / V', 'Copy / cut / paste nodes'],
  ['Ctrl+D', 'Duplicate'],
  ['Ctrl+A', 'Select all'],
  ['F', 'Fit to screen'],
  ['Shift+drag', 'Box select'],
  ['Space+drag', 'Pan'],
  ['Wheel', 'Zoom'],
  ['Right-click', 'More actions']
]

// ---------------------------------------------------------------- styles
const CSS = `
.fc-root { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; overflow: hidden;
  color: var(--ui-text-primary); background: var(--ui-bg-editor); outline: none; user-select: none; -webkit-user-select: none;
  font-size: 12.5px; line-height: 1.35; }
.fc-root *, .fc-root *::before, .fc-root *::after { box-sizing: border-box; }
/* The Arachne Flow window (G4): our page covers the whole window. z 75 keeps it above the app's titlebar tools
   (z 70) and BELOW the native window buttons the Desktop/WSLg shell draws (z 80): at z 100 this page covered
   them, so a full-window Arachne Flow window could not be closed, maximized or restored (U-6). App dialogs,
   toasts and tooltips (z 120+) still sit above it. The header is the window's drag area and keeps clear of the
   same window buttons on the right (--titlebar-tools-right / --titlebar-controls-* come from the app shell). */
.fc-root.fc-focus { position: fixed; inset: 0; z-index: 75; width: 100vw; height: 100vh; }
.fc-focus .fc-header { -webkit-app-region: drag; height: max(46px, var(--titlebar-control-size, 0px));
  padding-right: calc(var(--titlebar-tools-right, 0px) + 12px);
  padding-left: max(12px, var(--titlebar-content-inset, 0px)); }
.fc-focus .fc-header button, .fc-focus .fc-header input, .fc-focus .fc-header select, .fc-focus .fc-header a,
.fc-focus .fc-menu-wrap, .fc-focus .fc-header [role="button"] { -webkit-app-region: no-drag; }
.fc-root input, .fc-root textarea, .fc-root select, .fc-root pre, .fc-md, .fc-log-body { user-select: text; -webkit-user-select: text; }
.fc-grow { flex: 1; min-width: 0; }
.fc-muted { color: var(--ui-text-tertiary); }
.fc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fc-row.center { justify-content: center; }
.fc-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 7px;
  border: 1px solid var(--ui-stroke-secondary); background: var(--ui-bg-elevated); color: var(--ui-text-primary); font: inherit;
  font-size: 12.5px; cursor: pointer; white-space: nowrap; transition: background-color .12s, border-color .12s, opacity .12s; }
.fc-btn:hover:not(:disabled) { background: var(--ui-control-hover-background); border-color: var(--ui-stroke-primary); }
.fc-btn:disabled { opacity: .45; cursor: default; }
.fc-btn .codicon { font-size: 14px; }
.fc-btn.primary { background: var(--ui-accent); border-color: transparent; color: var(--ui-bg-editor); font-weight: 600; }
.fc-btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--ui-accent) 90%, transparent); border-color: transparent; }
.fc-btn.ghost { background: transparent; border-color: transparent; }
.fc-btn.ghost:hover:not(:disabled) { background: var(--ui-control-hover-background); border-color: transparent; }
.fc-btn.icon { width: 28px; padding: 0; }
.fc-btn.danger { color: var(--ui-red); }
.fc-btn.active { background: var(--ui-selection-background); }
.fc-header { flex: none; position: relative; z-index: 5; display: flex; align-items: center; gap: 8px; height: 46px; padding: 0 12px;
  border-bottom: 1px solid var(--ui-stroke-tertiary); }
.fc-header-title { font-size: 14px; font-weight: 600; }
.fc-title-input { font: inherit; font-size: 14px; font-weight: 600; color: var(--ui-text-primary); background: transparent;
  border: 1px solid transparent; border-radius: 6px; padding: 3px 6px; max-width: 380px; outline: none; }
.fc-title-input:hover { border-color: var(--ui-stroke-tertiary); }
.fc-title-input:focus { border-color: var(--ui-accent); background: var(--ui-bg-elevated); }
.fc-save { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--ui-text-tertiary); white-space: nowrap; }
.fc-save .codicon { font-size: 13px; }
.fc-save.bad { color: var(--ui-red); }
.fc-sep { width: 1px; height: 20px; background: var(--ui-stroke-tertiary); margin: 0 2px; }
.fc-menu-wrap { position: relative; }
.fc-menu { position: absolute; top: 34px; left: 0; width: 330px; max-height: 70vh; overflow-y: auto; padding: 6px; border-radius: 10px;
  background: var(--ui-bg-elevated); box-shadow: var(--shadow-md, 0 0 0 1px var(--ui-stroke-secondary), 0 14px 40px rgba(0,0,0,.35)); z-index: 30; }
.fc-menu.fc-ctx { width: 230px; }
.fc-menu.fc-flows-menu { display: flex; flex-direction: column; width: 360px; max-height: min(72vh, 600px); overflow: hidden; padding: 0; }
.fc-menu-top { flex: none; padding: 6px 6px 4px; border-bottom: 1px solid var(--ui-stroke-tertiary); }
.fc-menu-search { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 7px; color: var(--ui-text-tertiary);
  background: var(--ui-bg-tertiary, transparent); border: 1px solid var(--ui-stroke-tertiary); }
.fc-menu-search:focus-within { border-color: var(--ui-accent); }
.fc-menu-search input { flex: 1; min-width: 0; font: inherit; font-size: 12.5px; color: var(--ui-text-primary); background: none; border: 0; outline: none; }
.fc-menu-tabs { display: flex; gap: 4px; margin-top: 6px; }
.fc-menu-tab { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 5px 8px; border-radius: 6px; cursor: pointer;
  font-size: 12px; color: var(--ui-text-secondary); }
.fc-menu-tab:hover, .fc-menu-tab:focus { outline: none; background: var(--ui-row-hover-background); color: var(--ui-text-primary); }
.fc-menu-tab:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
.fc-menu-tab.on { background: var(--ui-selection-background); color: var(--ui-text-primary); font-weight: 600; }
.fc-menu-count { font-size: 10.5px; font-weight: 400; color: var(--ui-text-tertiary); }
.fc-menu-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 6px 6px; }
.fc-menu-more { color: var(--ui-text-tertiary); font-size: 12px; }
.fc-menu-foot { flex: none; display: flex; gap: 2px; padding: 4px 6px; border-top: 1px solid var(--ui-stroke-tertiary); }
.fc-menu-foot .fc-menu-item { flex: 1; justify-content: center; gap: 6px; padding: 6px 4px; font-size: 12px; }
.fc-menu-foot .fc-menu-item .fc-menu-name { flex: none; }
.fc-menu-label { padding: 8px 8px 4px; font-size: 10.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--ui-text-tertiary); }
.fc-menu-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer; color: var(--ui-text-secondary); }
.fc-menu-item:hover { background: var(--ui-row-hover-background); color: var(--ui-text-primary); }
.fc-menu-item.active { background: var(--ui-selection-background); color: var(--ui-text-primary); }
.fc-menu-item.disabled { opacity: .45; cursor: default; }
.fc-menu-item.disabled:hover { background: transparent; color: var(--ui-text-secondary); }
.fc-menu-item.danger { color: var(--ui-red); }
/* U-8: the keyboard-focused row looks focused (arrows move it), and a dialog scrim never shows a ring of its own. */
.fc-menu:focus { outline: none; }
.fc-menu-item:focus { outline: none; background: var(--ui-row-hover-background); color: var(--ui-text-primary); }
.fc-menu-item:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
.fc-menu-item.disabled:focus-visible { outline: 1px dashed var(--ui-stroke-secondary); }
.fc-modal-scrim:focus { outline: none; }
.fc-value-modal {
  display: flex;
  flex-direction: column;
  width: 85vw;
  max-width: 850px;
  height: 85vh;
  max-height: 700px;
  background: var(--ui-bg-elevated);
  color: var(--ui-text-primary);
  border: 1px solid var(--ui-stroke-tertiary);
  border-radius: 8px;
  overflow: hidden;
}
.fc-value-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--ui-stroke-tertiary);
  gap: 8px;
}
.fc-value-modal-title {
  font-weight: 600;
  font-size: 14px;
  color: var(--ui-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fc-value-modal-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.fc-value-modal-selectors {
  width: 200px;
  flex-shrink: 0;
  border-right: 1px solid var(--ui-stroke-tertiary);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}
.fc-value-modal-selectors button {
  text-align: left;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fc-value-modal-selectors button[aria-pressed="true"] {
  background: var(--ui-accent);
  color: var(--ui-text-primary);
}
.fc-value-warning{font-size:12px;line-height:1.45;color:var(--ui-text-secondary);overflow-wrap:anywhere;padding:6px 0}
.fc-value-modal-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-y: auto;
  padding: 12px 16px;
  gap: 12px;
}
.fc-value-modal-content .fc-pre { max-height: none; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere; }
.fc-value-modal-content .fc-value-toolbar { position: sticky; top: 0; z-index: 1; background: var(--ui-bg-elevated); padding: 4px 0; }
@media (max-width: 600px) { .fc-value-modal { width: 95vw; } .fc-value-modal-selectors { width: 110px; } }
.fc-value-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.fc-value-btn-group {
  display: flex;
  gap: 4px;
}
.fc-value-btn-group button.active {
  background: var(--ui-accent);
  color: var(--ui-text-primary);
}
.fc-json-tree {
  font-family: monospace;
  font-size: 12px;
  line-height: 1.5;
}
.fc-json-tree-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.fc-json-branch {
  margin-left: 12px;
}
.fc-json-summary {
  cursor: pointer;
  color: var(--ui-text-primary);
}
.fc-json-children {
  margin-left: 12px;
}
.fc-json-leaf {
  margin-left: 12px;
}
.fc-json-key {
  color: var(--ui-text-tertiary);
}
.fc-json-string {
  color: var(--ui-text-primary);
}
.fc-json-number, .fc-json-boolean {
  color: var(--ui-accent);
}
.fc-json-null {
  color: var(--ui-text-tertiary);
  font-style: italic;
}
.fc-json-truncated {
  color: var(--ui-text-tertiary);
  font-style: italic;
  margin-left: 12px;
}
.fc-value-empty {
  color: var(--ui-text-tertiary);
  font-style: italic;
  padding: 8px 0;
}
.fc-value-status {
  color: var(--ui-text-tertiary);
  padding: 8px 0;
}
.fc-value-error {
  color: var(--ui-text-primary);
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-stroke-tertiary);
  padding: 8px 12px;
  border-radius: 4px;
}
.fc-raw-collapse {
  margin-top: 8px;
  color: var(--ui-text-tertiary);
  font-size: 12px;
}
.fc-raw-collapse summary {
  cursor: pointer;
  margin-bottom: 4px;
}
.fc-menu-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-menu-meta { font-size: 11px; color: var(--ui-text-quaternary); white-space: nowrap; }
.fc-menu-sep { height: 1px; margin: 6px 4px; background: var(--ui-stroke-tertiary); }
.fc-menu-empty { padding: 6px 8px; color: var(--ui-text-tertiary); }
.fc-mini { flex: none; display: none; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0;
  border-radius: 5px; background: transparent; color: var(--ui-text-tertiary); cursor: pointer; }
.fc-mini .codicon { font-size: 13px; }
.fc-menu-item:hover .fc-mini, .fc-menu-item:focus .fc-mini, .fc-menu-item:focus-within .fc-mini, .fc-mini.armed, .fc-mini:focus, .fc-mini:focus-visible { display: inline-flex; }
.fc-mini:hover, .fc-mini:focus { background: var(--ui-control-hover-background); color: var(--ui-text-primary); outline: none; }
.fc-mini:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -1px; }
.fc-mini.armed { color: var(--ui-red); background: color-mix(in srgb, var(--ui-red) 14%, transparent); }
.fc-tag { flex: none; display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 999px; font-size: 10px; font-weight: 600;
  vertical-align: 1px; letter-spacing: .02em; color: var(--ui-accent); background: color-mix(in srgb, var(--ui-accent) 16%, transparent); }
/* Template dialog (G5): opaque card over a scrim, inside our page. */
.fc-modal-scrim { position: absolute; inset: 0; z-index: 60; display: flex; align-items: flex-start; justify-content: center;
  padding-top: 12vh; background: color-mix(in srgb, #000 22%, transparent); }
.fc-modal { width: min(440px, calc(100% - 32px)); padding: 16px 16px 14px; border-radius: 12px; background: var(--ui-bg-elevated);
  box-shadow: var(--shadow-lg, 0 0 0 1px var(--ui-stroke-secondary), 0 18px 50px rgba(0, 0, 0, .45)); }
.fc-modal-title { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 14px; font-weight: 600; color: var(--ui-text-primary); }
.fc-modal-title .codicon { color: var(--ui-accent); }
.fc-modal .fc-help { margin: 0 0 12px; }
.fc-modal .fc-check { margin-top: 4px; }
.fc-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
/* Build with Hermes (G6): the same controlled composer on the welcome/blank canvas and in the header dialog. */
.fc-generate-card { width: 100%; padding: 14px; border: 1px solid var(--ui-stroke-secondary); border-radius: 12px;
  background: var(--ui-bg-elevated); color: var(--ui-text-primary); text-align: left;
  box-shadow: var(--shadow-sm, 0 10px 28px rgba(0,0,0,.16)); }
.fc-generate-head { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; font-size: 13.5px; font-weight: 600; }
.fc-generate-head .codicon { color: var(--ui-accent); }
.fc-generate-card > .fc-help { margin: 0 0 10px; }
.fc-generate-card textarea { min-height: 86px; max-height: 220px; }
.fc-generate-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 10px; margin-top: 10px; }
.fc-generate-controls > .fc-row { padding-top: 17px; }
.fc-generate-model > label { display: block; margin-bottom: 4px; color: var(--ui-text-tertiary); font-size: 11px; }
.fc-generate-model .fc-model-btn { width: 100%; }
/* The composer's model list floats over the dialog (fixed, placed by ModelPicker): it never grows the card. */
.fc-generate-card .fc-model-pop { position: fixed; z-index: 90; right: auto; }
.fc-generate-error { margin-top: 9px; padding: 7px 9px; border-radius: 7px; color: var(--ui-red); white-space: pre-wrap;
  background: color-mix(in srgb, var(--ui-red) 11%, transparent); font-size: 11.5px; user-select: text; }
.fc-generate-busy { margin-top: 8px; color: var(--ui-text-tertiary); font-size: 11px; }
[data-fc-generate-dialog] { padding: clamp(12px, 6vh, 56px) 16px; }
.fc-generate-modal { width: min(620px, 100%); max-height: 100%; overflow-y: auto; overscroll-behavior: contain; border-radius: 12px; }
.fc-generate-hint { max-height: calc(100% - 32px); overflow-y: auto; }
@media (max-width: 600px) {
  .fc-generate-controls { grid-template-columns: minmax(0, 1fr); }
  .fc-generate-controls > .fc-row { padding-top: 0; justify-content: flex-end; }
}
.fc-hint.fc-generate-hint { width: min(540px, calc(100% - 32px)); pointer-events: auto;
  inset: 0; margin: auto; height: fit-content; transform: none; }  /* no transform: the floating model list stays unclipped */
.fc-generate-hint .fc-hint-title { margin: 0 0 8px; }
.fc-welcome .fc-generate-card { margin: 18px auto 8px; max-width: 580px; }
.fc-check.disabled { opacity: .55; cursor: default; }
.fc-template .fc-tag { font-size: 10px; color: var(--ui-accent); }
.fc-banner { flex: none; display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--ui-stroke-tertiary); }
.fc-banner.warn { background: color-mix(in srgb, var(--ui-yellow) 13%, transparent); }
.fc-banner.bad { background: color-mix(in srgb, var(--ui-red) 12%, transparent); }
.fc-banner > .codicon { font-size: 15px; }
.fc-banner.warn > .codicon { color: var(--ui-yellow); }
.fc-banner.bad > .codicon { color: var(--ui-red); }
.fc-notice { position: absolute; top: 56px; left: 50%; transform: translateX(-50%); z-index: 40; display: flex; align-items: center; gap: 8px;
  max-width: min(640px, 80%); padding: 8px 14px; border-radius: 999px; background: var(--ui-bg-elevated); cursor: pointer;
  box-shadow: var(--shadow-md, 0 0 0 1px var(--ui-stroke-secondary), 0 10px 30px rgba(0,0,0,.3)); animation: fc-in .18s ease-out; }
.fc-notice span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-notice.ok .codicon { color: var(--ui-green); }
.fc-notice.error .codicon { color: var(--ui-red); }
.fc-notice.warn .codicon { color: var(--ui-yellow); }
.fc-notice.info .codicon { color: var(--ui-accent); }
@keyframes fc-in { from { opacity: 0; transform: translate(-50%, -6px); } }
.fc-main { flex: 1; display: flex; min-height: 0; position: relative; }
.fc-side { flex: none; display: flex; flex-direction: column; min-height: 0; }
.fc-palette { width: 232px; border-right: 1px solid var(--ui-stroke-tertiary); }
.fc-inspector { width: 316px; border-left: 1px solid var(--ui-stroke-tertiary); overflow-y: auto; }
.fc-search { margin: 10px 10px 6px; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px; border-radius: 7px;
  border: 1px solid var(--ui-stroke-secondary); background: var(--ui-bg-elevated); }
.fc-search:focus-within { border-color: var(--ui-accent); }
.fc-search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--ui-text-primary); font: inherit; }
.fc-search .codicon { color: var(--ui-text-tertiary); }
.fc-palette-list { flex: 1; overflow-y: auto; padding: 0 6px 10px; }
.fc-cat { display: flex; align-items: center; gap: 5px; padding: 8px 6px 4px; font-size: 10.5px; font-weight: 600; letter-spacing: .04em;
  text-transform: uppercase; color: var(--ui-text-tertiary); cursor: pointer; }
.fc-cat:hover { color: var(--ui-text-secondary); }
.fc-cat .fc-count { margin-left: auto; font-weight: 500; color: var(--ui-text-quaternary); }
.fc-item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: grab; color: var(--ui-text-secondary); }
.fc-item:hover, .fc-item.active { background: var(--ui-row-hover-background); color: var(--ui-text-primary); }
.fc-item.active { background: var(--ui-selection-background); }
.fc-item .codicon { color: var(--fc-cat); font-size: 14px; flex: none; }
.fc-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-item-name { flex: 1; min-width: 0; }
.fc-item-meta { flex: none; max-width: 120px; font-size: 10.5px; color: var(--ui-text-quaternary); }
.fc-palette-foot { flex: none; padding: 8px 12px; font-size: 11px; color: var(--ui-text-quaternary); border-top: 1px solid var(--ui-stroke-tertiary); }
.fc-quick { position: absolute; z-index: 35; display: flex; flex-direction: column; width: 340px; height: 440px; max-height: calc(100% - 16px);
  border-radius: 11px; background: var(--ui-bg-elevated); box-shadow: var(--shadow-lg, 0 0 0 1px var(--ui-stroke-secondary), 0 18px 50px rgba(0,0,0,.45)); }
.fc-quick .fc-search { flex: none; margin: 8px 8px 5px; background: var(--ui-bg-tertiary); }
.fc-quick-list { min-height: 0; overflow-y: auto; padding: 0 6px 6px; }
.fc-quick .fc-item { cursor: pointer; padding: 7px 8px; }
.fc-quick-label { padding: 7px 8px 4px; font-size: 10.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--ui-text-tertiary); }
.fc-quick-foot { flex: none; padding: 7px 12px; border-top: 1px solid var(--ui-stroke-tertiary); font-size: 10.5px; color: var(--ui-text-quaternary); }
.fc-canvas { position: relative; flex: 1; min-width: 0; overflow: hidden; outline: none; touch-action: none; cursor: default;
  background-color: var(--ui-bg-editor);
  background-image: radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--ui-text-tertiary) 34%, transparent) 1px, transparent 1.6px); }
.fc-canvas.panning, .fc-canvas.panning * { cursor: grabbing !important; }
.fc-canvas.space, .fc-canvas.space * { cursor: grab !important; }
/* U-4: edges live in world coordinates under the same transform as .fc-world, so a pan/zoom moves this layer
   instead of rewriting every path. vector-effect: non-scaling-stroke keeps the stroke 2.2/3.6/14 px on screen,
   as it was when the paths were computed in screen space. */
.fc-edges { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; transform-origin: 0 0; }
.fc-edge { fill: none; stroke-width: 2.2; opacity: .8; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.fc-edge.selected { stroke-width: 3.6; opacity: 1; }
.fc-edge.flowing { opacity: 1; stroke-dasharray: 7 6; animation: fc-dash .55s linear infinite; }
.fc-edge.dead { opacity: .28; }
.fc-edge-hit { fill: none; stroke: transparent; stroke-width: 14; pointer-events: stroke; cursor: pointer; vector-effect: non-scaling-stroke; }
.fc-wire { fill: none; stroke-width: 2.4; stroke-dasharray: 6 5; vector-effect: non-scaling-stroke; }
@keyframes fc-dash { to { stroke-dashoffset: -13; } }
@media (prefers-reduced-motion: reduce) {
  .fc-edge.flowing { animation: none; }
  .fc-node.running { animation: none; box-shadow: 0 0 0 2px var(--ui-accent), 0 0 18px color-mix(in srgb, var(--ui-accent) 45%, transparent); }
}
.fc-world { position: absolute; left: 0; top: 0; width: 0; height: 0; transform-origin: 0 0; }
.fc-rect { position: absolute; border: 1px solid var(--ui-accent); background: color-mix(in srgb, var(--ui-accent) 12%, transparent); pointer-events: none; }
.fc-hint { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); text-align: center; color: var(--ui-text-tertiary);
  pointer-events: none; line-height: 1.6; }
.fc-hint > .codicon { font-size: 34px; color: var(--ui-text-quaternary); }
.fc-hint-title { margin-top: 6px; font-size: 15px; font-weight: 600; color: var(--ui-text-secondary); }
.fc-canvas.file-over { box-shadow: inset 0 0 0 2px var(--ui-accent); background-color: color-mix(in srgb, var(--ui-accent) 5%, var(--ui-bg-editor)); }
.fc-drop-hint { position: absolute; left: 50%; top: 18px; transform: translateX(-50%); z-index: 20; display: flex; align-items: center; gap: 8px;
  padding: 8px 14px; border-radius: 999px; font-size: 12.5px; font-weight: 600; color: var(--ui-text-primary); pointer-events: none;
  background: var(--ui-bg-elevated); box-shadow: 0 0 0 1px var(--ui-accent), var(--shadow-md, 0 10px 26px rgba(0,0,0,.35)); }
.fc-drop-hint .codicon { font-size: 15px; color: var(--ui-accent); }
.fc-drop-hint.busy { box-shadow: var(--shadow-md, 0 0 0 1px var(--ui-stroke-secondary), 0 10px 26px rgba(0,0,0,.35)); }
.fc-browse { display: flex; gap: 6px; }
.fc-browse .fc-input { flex: 1; min-width: 0; }
.fc-browse .fc-btn { flex: none; height: 30px; }
.fc-media-list { display: grid; gap: 6px; }
.fc-media-row { min-width: 0; }
.fc-media-list > .fc-linked { margin-bottom: 2px; font-size: 11px; }
.fc-media-list > .fc-row { justify-content: space-between; }
.fc-media-list > .fc-row .fc-help { margin-top: 0; }
.fc-add-file { margin: -2px 0 8px; color: var(--ui-text-secondary); }
.fc-preview.file .fc-muted { margin-left: auto; font-size: 10.5px; }
.fc-preview.file > span:nth-child(2) { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.fc-zoombar { position: absolute; right: 12px; bottom: 12px; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 9px;
  background: var(--ui-bg-elevated); box-shadow: var(--shadow-sm, 0 0 0 1px var(--ui-stroke-secondary), 0 6px 18px rgba(0,0,0,.25)); }
.fc-zoomval { min-width: 44px; text-align: center; font-size: 11.5px; color: var(--ui-text-secondary); font-variant-numeric: tabular-nums; }
.fc-node { position: absolute; width: ${NODE_W}px; border-radius: 10px; background: var(--ui-bg-elevated); cursor: grab;
  box-shadow: var(--shadow-sm, 0 0 0 1px var(--ui-stroke-secondary), 0 2px 4px rgba(0,0,0,.18), 0 10px 26px rgba(0,0,0,.32)); transition: box-shadow .15s, opacity .2s; }
.fc-node.selected { box-shadow: 0 0 0 2px var(--ui-accent), var(--shadow-md, 0 10px 26px rgba(0,0,0,.32)); }
.fc-node.running { animation: fc-pulse 1.3s ease-in-out infinite; }
.fc-node.error { box-shadow: 0 0 0 1.5px var(--ui-red), var(--shadow-sm, 0 8px 22px rgba(0,0,0,.26)); }
.fc-node.error.selected { box-shadow: 0 0 0 2.5px var(--ui-red), var(--shadow-md, 0 10px 26px rgba(0,0,0,.32)); }
.fc-node.muted { opacity: .55; }
.fc-node.unknown { outline: 1.5px dashed var(--ui-red); }
.fc-node.note { background: color-mix(in srgb, var(--ui-yellow) 10%, var(--ui-bg-elevated)); }
@keyframes fc-pulse { 0%, 100% { box-shadow: 0 0 0 2px var(--ui-accent), 0 0 14px color-mix(in srgb, var(--ui-accent) 35%, transparent); }
  50% { box-shadow: 0 0 0 2px var(--ui-accent), 0 0 32px color-mix(in srgb, var(--ui-accent) 62%, transparent); } }
.fc-node-head { height: ${HEAD_H}px; display: flex; align-items: center; gap: 9px; padding: 0 10px 0 9px; border-radius: 10px 10px 0 0;
  border-bottom: 1px solid var(--ui-stroke-tertiary); }
.fc-node-titles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.fc-node-sub { font-size: 11px; color: var(--ui-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-node-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 10px 6px;
  border-top: 1px solid var(--ui-stroke-tertiary); font-size: 10.5px; color: var(--ui-text-tertiary); font-variant-numeric: tabular-nums; }
.fc-node-time { flex: none; }
.fc-node-icon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 6px;
  background: color-mix(in srgb, var(--fc-cat) 24%, transparent); color: var(--fc-cat); }
.fc-node-icon .codicon { font-size: 13px; }
.fc-node-title { min-width: 0; font-size: 13px; font-weight: 600; letter-spacing: .005em; color: var(--ui-text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-node-issue { color: var(--ui-yellow); font-size: 13px; flex: none; }
.fc-node-loop { flex: none; color: color-mix(in srgb, var(--ui-purple) 55%, var(--ui-red)); }
.fc-node-loop .codicon { font-size: 12.5px; }
.fc-iters { display: grid; gap: 4px; }
.fc-iter { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 6px; align-items: baseline; }
.fc-iter-n { font-size: 10.5px; font-variant-numeric: tabular-nums; color: var(--ui-text-tertiary); text-align: right; }
.fc-iter-msg { font-size: 11.5px; color: var(--ui-text-tertiary); font-style: italic; overflow-wrap: anywhere; }
.fc-iter-msg.bad { color: var(--ui-red); font-style: normal; }
.fc-node-cost { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; font-weight: 500;
  color: var(--ui-text-secondary); font-variant-numeric: tabular-nums; cursor: help; }
.fc-cost { display: flex; align-items: center; gap: 6px; margin: 2px 0 10px; padding: 5px 8px; border-radius: 7px;
  background: color-mix(in srgb, var(--ui-yellow) 9%, transparent); font-size: 12px; color: var(--ui-text-secondary); }
.fc-cost .codicon { color: var(--ui-yellow); }
.fc-cost b { color: var(--ui-text-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.fc-cost > span:first-of-type { flex: none; }
.fc-multi { display: flex; flex-wrap: wrap; gap: 5px; }
.fc-extra { margin: 4px 0 6px; padding-top: 8px; border-top: 1px solid var(--ui-stroke-tertiary); }
.fc-info-row { display: flex; gap: 8px; font-size: 11.5px; line-height: 1.6; }
.fc-info-k { flex: none; width: 92px; color: var(--ui-text-tertiary); }
.fc-info-v { min-width: 0; color: var(--ui-text-secondary); overflow-wrap: anywhere; }
.fc-subhead { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 8px; font-size: 11.5px; font-weight: 600;
  line-height: 1.35; color: var(--ui-text-secondary); }
.fc-subhead > .codicon { margin-top: 1px; }
.fc-subhead > span:not(.fc-info) { min-width: 0; overflow-wrap: anywhere; } /* long model names wrap, never cut */
.fc-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px 3px 6px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--ui-stroke-primary); font-size: 11.5px; color: var(--ui-text-secondary); user-select: none; }
.fc-chip.on { border-color: var(--ui-accent); color: var(--ui-text-primary); }
.fc-chip input { margin: 0; }
.fc-chip:has(input:disabled) { opacity: .5; cursor: default; }
.fc-badge { flex: none; display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; color: var(--fc-st); white-space: nowrap;
  font-variant-numeric: tabular-nums; }
.fc-badge .codicon { color: var(--fc-st); font-size: 13px; }
.fc-ports { padding: ${PORTS_TOP}px 0 4px; }
.fc-port-row { position: relative; height: ${ROW_H}px; display: flex; align-items: center; }
.fc-port { display: flex; align-items: center; gap: 2px; height: ${ROW_H}px; max-width: 52%; font-size: 11.5px; color: var(--ui-text-secondary); cursor: crosshair; }
.fc-port:hover { color: var(--ui-text-primary); }
.fc-port-in { padding-left: 13px; }
.fc-port-out { margin-left: auto; padding-right: 13px; }
.fc-port-out.untaken { opacity: .42; }
.fc-port-out.taken .fc-port-label { color: var(--ui-text-primary); font-weight: 600; }
.fc-port-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-dot { position: absolute; top: 50%; width: 12px; height: 12px; margin-top: -6px; border-radius: 50%; background: var(--ui-bg-editor);
  border: 2px solid var(--fc-port); transition: transform .1s, background-color .1s; }
.fc-port-in .fc-dot { left: -6px; }
.fc-port-out .fc-dot { right: -6px; }
.fc-dot::after { content: ''; position: absolute; inset: -6px; border-radius: 50%; }
.fc-port.connected .fc-dot { background: var(--fc-port); }
.fc-port:hover .fc-dot { transform: scale(1.3); }
.fc-wiring .fc-port.dim { opacity: .28; }
.fc-wiring .fc-port.ok .fc-dot { transform: scale(1.25); box-shadow: 0 0 0 3px color-mix(in srgb, var(--fc-port) 30%, transparent); }
.fc-port.hot .fc-dot { transform: scale(1.5); background: var(--fc-port); }
.fc-req { color: var(--ui-red); margin-left: 1px; }
.fc-more { margin: 0 10px 6px 13px; font-size: 11px; color: var(--ui-text-tertiary); cursor: pointer; }
.fc-more:hover { color: var(--ui-accent); }
.fc-summary { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 8px; row-gap: 3px; margin: 2px 10px 0 13px;
  padding: 7px 0 9px; border-top: 1px solid var(--ui-stroke-tertiary); font-size: 11px; line-height: 1.3; }
.fc-summary-key { color: var(--ui-text-tertiary); white-space: nowrap; }
.fc-summary-val { color: var(--ui-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-note-text { padding: 9px 13px 11px; white-space: pre-wrap; word-break: break-word; line-height: 1.45; color: var(--ui-text-secondary); max-height: 160px; overflow: hidden; }
.fc-preview { margin: 0 8px 8px; padding: 6px 8px; border-radius: 7px; background: var(--ui-bg-tertiary); font-size: 11.5px; line-height: 1.4; color: var(--ui-text-secondary);
  overflow: hidden; white-space: pre-wrap; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; }
.fc-preview.media { padding: 4px; display: block; }
.fc-preview.file { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.fc-preview img { display: block; width: 100%; max-height: 170px; object-fit: contain; border-radius: 5px; }
/* Every finished output as a readable little card: label + type on top, picture or text underneath. */
.fc-minis { margin: 8px 8px 10px; display: flex; flex-direction: column; gap: 8px; }
.fc-minis .fc-out { display: block; width: auto; height: auto; margin: 0; padding: 7px 9px 8px;
  border: 1px solid var(--ui-stroke-tertiary); border-radius: 8px; background: var(--ui-bg-tertiary); }
.fc-mini-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.fc-mini-label { min-width: 0; font-size: 11.5px; font-weight: 600; color: var(--ui-text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-mini-badge { flex: none; padding: 1px 6px; border-radius: 4px; font-size: 10px; line-height: 14px;
  background: var(--ui-bg-elevated); color: var(--ui-text-tertiary); }
.fc-mini-thumb { margin-top: 7px; border-radius: 6px; overflow: hidden; }
.fc-mini-thumb img { display: block; width: 100%; height: auto; max-height: 140px; object-fit: contain;
  border-radius: 6px; background: var(--ui-bg-elevated); }
.fc-mini-file { margin-top: 6px; display: flex; align-items: center; gap: 8px; font-size: 12.5px;
  color: var(--ui-text-primary); }
.fc-mini-file .codicon { font-size: 19px; }
.fc-mini-player { margin-top: 7px; min-height: 56px; border-radius: 6px; overflow: hidden; }
.fc-mini-player[data-fc-inline-media="video"], .fc-mini-player[data-fc-inline-media="model3d"] { min-height: 140px; }
.fc-mini-player video { display: block; width: 100%; height: 140px; object-fit: contain; background: var(--ui-bg-elevated); }
.fc-mini-player audio { display: block; width: 100%; height: 40px; }
.fc-mini-player .fc-mini-unavailable { padding: 8px 0; font-size: 11px; color: var(--ui-text-tertiary); }
.fc-model-thumb { display: block; width: 100%; height: 140px; object-fit: contain; border-radius: 6px;
  background: var(--ui-bg-elevated); }
.fc-mini-text { margin-top: 6px; font-size: 12.5px; line-height: 1.55; color: var(--ui-text-primary);
  white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3;
  -webkit-box-orient: vertical; overflow: hidden; }
.fc-out.k-broken .fc-mini-badge { color: var(--ui-yellow); }
.fc-out.fc-zoomable { cursor: zoom-in; }
.fc-out.fc-zoomable:hover { border-color: var(--ui-accent); }
.fc-mini-more { padding: 0 4px; font-size: 11px; color: var(--ui-text-tertiary); }
.fc-out.fc-openable { cursor: pointer; text-align: left; }
.fc-out.fc-openable:hover { border-color: var(--ui-accent); }
.fc-out.fc-openable:focus-visible, .fc-mini-more[role="button"]:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 1px; }
.fc-mini-more[role="button"] { cursor: pointer; }
.fc-node-error { margin: 0 8px 8px; padding: 6px 8px; border-radius: 7px; font-size: 11px; color: var(--ui-red);
  background: color-mix(in srgb, var(--ui-red) 11%, transparent); white-space: pre-wrap; word-break: break-word; max-height: 74px; overflow: hidden; }
.fc-section { padding: 12px 14px; border-bottom: 1px solid var(--ui-stroke-tertiary); }
.fc-section h4 { margin: 0 0 9px; font-size: 10.5px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--ui-text-tertiary); }
.fc-insp-head { display: flex; align-items: center; gap: 8px; }
.fc-insp-head > .codicon { font-size: 18px; color: var(--fc-cat); }
.fc-insp-title { font-weight: 600; font-size: 13.5px; }
.fc-insp-type { margin: 10px 0 8px; font-size: 11px; color: var(--ui-text-tertiary); overflow-wrap: anywhere; }
/* Inspector layout B: title, a Run bar that stays on top while scrolling, foldable sections in working order */
.fc-insp-top { padding-bottom: 10px; }
.fc-insp-desc { margin-top: 5px; }
.fc-runbar { position: sticky; top: 0; z-index: 2; padding: 9px 14px; background: var(--ui-bg-elevated);
  border-bottom: 1px solid var(--ui-stroke-tertiary); }
.fc-runbar-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; min-width: 0; }
.fc-runbar-row .fc-btn { flex: none; }
.fc-runbar .fc-cost { margin: 0 0 0 auto; padding: 3px 7px; font-size: 11.5px; flex: 0 1 auto; min-width: 0; max-width: 100%; }
.fc-runbar .fc-cost b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-runbar .fc-timing { margin-top: 6px; font-size: 11px; }
.fc-insp-issues.fc-section { padding: 9px 14px; margin: 0; }
.fc-fold { border-bottom: 1px solid var(--ui-stroke-tertiary); }
.fc-fold-head { display: flex; align-items: center; gap: 7px; width: 100%; min-width: 0; padding: 10px 14px; border: 0; background: none;
  color: var(--ui-text-primary); font: inherit; text-align: left; cursor: pointer; }
.fc-fold-head:hover { background: color-mix(in srgb, var(--ui-text-primary) 4%, transparent); }
.fc-fold-head:focus-visible { outline: 1px solid var(--ui-accent); outline-offset: -1px; }
.fc-fold-head > .codicon { flex: none; color: var(--ui-text-tertiary); }
.fc-fold-title { flex: none; font-size: 12px; font-weight: 600; }
.fc-fold-sum { flex: 1; min-width: 0; text-align: right; font-size: 11px; color: var(--ui-text-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-fold-body { padding: 0 14px 12px; }
.fc-fold-body[hidden] { display: none; }
.fc-fold-body > .fc-row + .fc-check, .fc-fold-body > .fc-check + .fc-row { margin-top: 8px; }
.fc-fold-body > .fc-btn.danger { margin-top: 2px; }
.fc-result .fc-insp-error { margin-bottom: 6px; }
.fc-field { margin-bottom: 11px; }
.fc-field > label { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; font-size: 11.5px; color: var(--ui-text-secondary); }
.fc-more-btn { display: flex; align-items: center; gap: 6px; width: 100%; margin: 2px 0 0; padding: 6px 2px; border: 0; background: none;
  font: inherit; font-size: 12px; color: var(--ui-text-secondary); cursor: pointer; text-align: left; border-top: 1px dashed var(--ui-stroke-tertiary); }
.fc-more-btn:hover { color: var(--ui-accent); }
.fc-more-btn .fc-muted { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.fc-pal-sec + .fc-pal-sec { margin-top: 6px; }
.fc-pal-sec-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; font-size: 10.5px; font-weight: 700;
  letter-spacing: .06em; text-transform: uppercase; color: var(--ui-text-secondary); cursor: pointer; user-select: none; margin-bottom: 2px;
  background: color-mix(in srgb, var(--fc-sec) 9%, transparent); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--fc-sec) 70%, transparent); }
.fc-pal-sec-head:hover { color: var(--ui-text-primary); background: color-mix(in srgb, var(--fc-sec) 15%, transparent); }
.fc-pal-sec-head .fc-pal-chev { font-size: 12px; color: var(--ui-text-tertiary); }
.fc-pal-sec-head .fc-pal-sec-icon { font-size: 13px; color: var(--fc-sec); }
.fc-pal-sec-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-pal-sec-head .fc-count { font-weight: 500; letter-spacing: 0; color: var(--ui-text-quaternary); }
.fc-pal-top { flex: none; display: flex; align-items: center; gap: 2px; margin: 10px 6px 6px 10px; }
.fc-pal-top .fc-search { flex: 1; min-width: 0; margin: 0; }
.fc-pal-fold { flex: none; color: var(--ui-text-tertiary); }
.fc-pal-fold:hover:not(:disabled) { color: var(--ui-text-primary); }
/* Palette tooltip in the Arachne Flow look. The app bubble is inverted and padded via Tailwind utilities (a CSS layer)
   plus tooltip.css; this unlayered, doubled-class rule on our own className wins over both. overflow: hidden clips the
   tip arrow (Radix draws it just outside the box, still in the inverted colour); app markup itself is never styled. */
.fc-tt-bubble.fc-tt-bubble { padding: 0; max-width: 340px; border-radius: 10px; overflow: hidden; text-align: left;
  background: var(--ui-bg-elevated); color: var(--ui-text-secondary); font-size: 11.5px; font-weight: 400; line-height: 1.45;
  box-shadow: var(--shadow-md, 0 0 0 1px var(--ui-stroke-secondary), 0 14px 40px rgba(0,0,0,.35)); }
.fc-tt { width: 300px; max-width: 100%; white-space: normal; }
.fc-tt-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px 6px 7px;
  background: color-mix(in srgb, var(--fc-cat) 13%, var(--ui-bg-elevated));
  border-bottom: 1px solid color-mix(in srgb, var(--fc-cat) 26%, var(--ui-stroke-tertiary)); }
.fc-tt-title { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; color: var(--ui-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-tt-kind { flex: none; padding: 1px 7px; border-radius: 999px; font-size: 9.5px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase;
  white-space: nowrap; color: var(--fc-cat); background: color-mix(in srgb, var(--fc-cat) 16%, transparent); }
.fc-tt-body { display: grid; gap: 5px; padding: 8px 10px 9px; }
.fc-tt-desc { margin-bottom: 2px; color: var(--ui-text-secondary); }
.fc-tt-row { display: grid; grid-template-columns: 44px 1fr; gap: 6px; align-items: baseline; }
.fc-tt-k { font-size: 10px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--ui-text-tertiary); }
.fc-tt-v { display: flex; flex-wrap: wrap; gap: 2px 12px; min-width: 0; color: var(--ui-text-primary); }
.fc-tt-port { display: inline-flex; align-items: baseline; gap: 5px; }
.fc-tt-dot { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--fc-port); transform: translateY(-1px);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--fc-port) 22%, transparent); }
.fc-tt-type { color: var(--ui-text-tertiary); }
.fc-tt-tool { margin-top: 1px; font-family: var(--font-mono, ui-monospace, monospace); font-size: 10.5px; color: var(--ui-text-tertiary); overflow-wrap: anywhere; }
.fc-tt-foot { display: flex; align-items: center; gap: 6px; padding: 7px 10px 8px; border-top: 1px solid var(--ui-stroke-tertiary);
  font-size: 10.5px; line-height: 14px; color: var(--ui-text-tertiary); background: color-mix(in srgb, var(--ui-text-primary) 3%, transparent); }
.fc-tt-foot .codicon { display: block; font-size: 12px; line-height: 14px; }
.fc-info { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; margin-left: 2px; border-radius: 50%;
  color: var(--ui-text-tertiary); cursor: help; outline: none; }
.fc-info .codicon { font-size: 12.5px; }
.fc-info:hover, .fc-info:focus-visible { color: var(--ui-accent); background: color-mix(in srgb, var(--ui-accent) 14%, transparent); }
.fc-tip { max-width: 280px; white-space: normal; line-height: 1.45; }
.fc-tip > div + div { margin-top: 4px; opacity: .8; }
/* G9: small rich tips (status, ports, errors, header buttons) reuse the palette card look */
.fc-tipwrap { display: inline-flex; }
/* disabled buttons fire no pointer events; let them reach the wrapper (the Tip trigger) instead */
.fc-tipwrap > button:disabled { pointer-events: none; }
.fc-tt.fc-tt-sm { width: max-content; min-width: 150px; max-width: 300px; }
.fc-tt-sm .fc-tt-head { padding: 5px 10px 5px 8px; }
.fc-tt-sm .fc-tt-head .fc-node-icon { width: 20px; height: 20px; }
.fc-tt-sm .fc-tt-body { gap: 3px; padding: 7px 10px 8px; }
.fc-tt-line { color: var(--ui-text-secondary); overflow-wrap: anywhere; }
.fc-tt-line:first-child { color: var(--ui-text-primary); }
.fc-tt-sm[data-tone="bad"] .fc-tt-line:not(:first-child) { color: var(--ui-red); }
.fc-tt-sm .fc-tt-foot { padding: 6px 10px 7px; }
.fc-tt-keys { display: inline-flex; gap: 3px; flex: none; }
.fc-tt-keys kbd { padding: 0 5px; border-radius: 4px; font: 600 10px/16px var(--font-mono, ui-monospace, monospace); color: var(--ui-text-secondary);
  background: color-mix(in srgb, var(--ui-text-primary) 8%, transparent); box-shadow: inset 0 0 0 1px var(--ui-stroke-tertiary); }
.fc-badge-exp { color: var(--ui-text-tertiary); }
.fc-timing { display: grid; gap: 2px; margin-top: 8px; font-size: 11.5px; color: var(--ui-text-secondary); }
.fc-timing > div:first-child { color: var(--ui-text-primary); }
.fc-model { position: relative; }
.fc-model-btn { display: flex; align-items: center; gap: 6px; height: 30px; text-align: left; cursor: pointer; }
.fc-model-btn > span:first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-model-btn.open { border-color: var(--ui-accent); }
.fc-model-prov { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--ui-text-tertiary); }
.fc-model-pop { position: absolute; z-index: 30; top: 34px; left: 0; right: 0; border-radius: 9px; background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-stroke-secondary); box-shadow: var(--shadow-md, 0 12px 30px rgba(0,0,0,.35)); overflow: hidden; }
.fc-model-search { display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 9px; border-bottom: 1px solid var(--ui-stroke-tertiary); color: var(--ui-text-tertiary); }
.fc-model-search input { flex: 1; min-width: 0; font: inherit; font-size: 12.5px; color: var(--ui-text-primary); background: none; border: 0; outline: none; }
.fc-model-list { max-height: 320px; overflow-y: auto; padding: 4px; }
.fc-model-head { position: sticky; top: -4px; display: flex; align-items: center; gap: 6px; padding: 7px 8px 4px; font-size: 10.5px; font-weight: 600;
  letter-spacing: .04em; text-transform: uppercase; color: var(--ui-text-tertiary); background: var(--ui-bg-elevated); }
.fc-model-tag { padding: 0 5px; border-radius: 4px; font-size: 9.5px; color: var(--ui-accent); background: color-mix(in srgb, var(--ui-accent) 14%, transparent); }
.fc-model-count { margin-left: auto; font-weight: 400; }
.fc-model-item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; font-size: 12px; cursor: pointer; color: var(--ui-text-secondary); }
.fc-model-item > span:first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-model-item:hover { background: var(--ui-bg-tertiary); color: var(--ui-text-primary); }
.fc-model-item.active { color: var(--ui-accent); }
.fc-model-item[data-highlighted="true"] { background: var(--ui-bg-tertiary); color: var(--ui-text-primary); }
.fc-model-note { padding: 6px 8px; }
[data-fc-flow-picker] .fc-model-pop { position: static; margin-top: 4px; }
[data-fc-flow-picker] .fc-model-list { max-height: min(280px, 35vh); }
.fc-input { width: 100%; font: inherit; font-size: 12.5px; color: var(--ui-text-primary); background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-stroke-secondary); border-radius: 7px; padding: 6px 8px; outline: none; }
.fc-input:focus { border-color: var(--ui-accent); }
textarea.fc-input { resize: vertical; min-height: 60px; line-height: 1.45; }
select.fc-input { height: 30px; padding: 0 6px; }
.fc-mono { font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; font-size: 11.5px; }
.fc-help { margin-top: 4px; font-size: 11px; color: var(--ui-text-tertiary); line-height: 1.4; }
.fc-bad { color: var(--ui-red); }
.fc-linked { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 7px; border: 1px dashed var(--ui-stroke-primary);
  color: var(--ui-text-secondary); font-size: 12px; }
.fc-linked b { color: var(--ui-text-primary); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ui-text-secondary); cursor: pointer; }
.fc-out { margin-top: 10px; }
.fc-out-port { font-size: 11px; color: var(--ui-text-tertiary); margin-bottom: 4px; }
.fc-pre-wrap { position: relative; }
.fc-pre { margin: 0; padding: 8px 10px; border-radius: 7px; background: var(--ui-bg-tertiary); max-height: 260px; overflow: auto;
  white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; font-size: 11.5px; line-height: 1.45; }
.fc-md { padding: 8px 10px; border-radius: 7px; background: var(--ui-bg-tertiary); max-height: 320px; overflow: auto; font-size: 12.5px; line-height: 1.5; }
.fc-pre-wrap .fc-copy { position: absolute; top: 4px; right: 4px; }
.fc-media img, .fc-media video { display: block; width: 100%; border-radius: 7px; background: var(--ui-bg-tertiary); }
.fc-media audio { width: 100%; margin: 4px 0; }
.fc-media + .fc-media { margin-top: 8px; }
.fc-file-chip { display: flex; align-items: center; gap: 6px; margin-top: 6px; padding: 3px 3px 3px 8px; border-radius: 7px; background: var(--ui-bg-tertiary); font-size: 11.5px; }
.fc-chip-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-zoomable { cursor: zoom-in; }
.fc-preview.media.fc-zoomable:hover, .fc-preview.file.fc-zoomable:hover { box-shadow: 0 0 0 1px var(--ui-accent); }
.fc-media .fc-zoomable:hover { outline: 1px solid var(--ui-accent); }
.fc-lb { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center; outline: none;
  color: var(--ui-text-primary); background: var(--fc-scrim, color-mix(in srgb, #000 22%, transparent));
  -webkit-app-region: no-drag; user-select: none; -webkit-user-select: none; font-size: 12.5px; }
/* the preview is a window of 85 % of the app window, the dimmed margin around it closes it (07.11.) */
.fc-lb-panel { width: 85vw; height: 85vh; display: flex; flex-direction: column; min-width: 0; overflow: hidden; border-radius: 12px;
  background: var(--ui-bg-editor); border: 1px solid var(--ui-stroke-tertiary); box-shadow: var(--shadow-lg, 0 18px 50px rgba(0, 0, 0, .45)); }
.fc-lb:fullscreen .fc-lb-panel { width: 100%; height: 100%; border: 0; border-radius: 0; }
.fc-3d { position: relative; width: 100%; height: 100%; }
.fc-3d-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
.fc-3d-canvas:active { cursor: grabbing; }
.fc-3d-msg { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); max-width: 520px; text-align: center;
  color: var(--ui-text-secondary); }
.fc-3d-info { position: absolute; right: 16px; bottom: 12px; color: var(--ui-text-quaternary); font-size: 11px; pointer-events: none; }
.fc-lb *, .fc-lb *::before, .fc-lb *::after { box-sizing: border-box; }
.fc-lb-bar { flex: none; display: flex; align-items: center; gap: 4px; height: 48px; padding: 0 10px 0 16px; background: var(--ui-bg-chrome); border-bottom: 1px solid var(--ui-stroke-tertiary); }
.fc-lb-title { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.fc-lb-title b { font-weight: 600; white-space: nowrap; }
.fc-lb-title .fc-lb-file { color: var(--ui-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-lb-count { padding: 0 10px; color: var(--ui-text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.fc-lb-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 30px; min-width: 30px; padding: 0 8px; border: 0;
  border-radius: 7px; background: transparent; color: inherit; font: inherit; cursor: pointer; white-space: nowrap; }
.fc-lb-btn:hover:not(:disabled) { background: var(--ui-control-hover-background); }
.fc-lb-btn:disabled { opacity: .35; cursor: default; }
.fc-lb-btn .codicon { font-size: 16px; }
.fc-lb-zoom { min-width: 52px; font-variant-numeric: tabular-nums; }
.fc-lb-sep { width: 1px; height: 20px; margin: 0 4px; background: var(--ui-stroke-secondary); }
.fc-lb-stage { position: relative; flex: 1; min-height: 0; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.fc-lb-stage.zoomed { cursor: grab; }
.fc-lb-stage.panning { cursor: grabbing; }
.fc-lb-img { max-width: calc(100% - 120px); max-height: calc(100% - 32px); object-fit: contain; transform-origin: center center;
  will-change: transform; -webkit-user-drag: none; }
.fc-lb-stage video { max-width: calc(100% - 120px); max-height: calc(100% - 32px); background: var(--ui-bg-chrome); outline: none; box-shadow: 0 0 0 1px var(--ui-stroke-tertiary); }
.fc-lb-card { display: flex; flex-direction: column; align-items: center; gap: 14px; max-width: 520px; padding: 28px 34px; border-radius: 14px;
  background: var(--ui-bg-card); box-shadow: 0 0 0 1px var(--ui-stroke-tertiary); text-align: center; }
.fc-lb-card .codicon { font-size: 54px; opacity: .8; }
.fc-lb-card audio { width: 420px; max-width: 100%; }
.fc-lb-card .fc-lb-msg { color: var(--ui-text-secondary); }
.fc-lb-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 44px; height: 64px; border: 0; border-radius: 10px;
  background: var(--ui-bg-elevated); color: inherit; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.fc-lb-nav:hover { background: var(--ui-control-hover-background); }
.fc-lb-nav .codicon { font-size: 22px; }
.fc-lb-nav.prev { left: 14px; }
.fc-lb-nav.next { right: 14px; }
.fc-lb-strip { flex: none; display: flex; gap: 6px; justify-content: center; padding: 8px 12px 12px; overflow-x: auto; }
.fc-lb-thumb { flex: none; width: 58px; height: 44px; padding: 0; border: 2px solid transparent; border-radius: 6px; overflow: hidden; cursor: pointer;
  background: var(--ui-bg-tertiary); color: var(--ui-text-secondary); display: flex; align-items: center; justify-content: center; }
.fc-lb-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.fc-lb-thumb.active { border-color: var(--ui-accent); }
.fc-lb-thumb:hover:not(.active) { border-color: var(--ui-stroke-primary); }
.fc-lb-flash { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); padding: 7px 14px; border-radius: 8px;
  background: var(--ui-bg-elevated); box-shadow: 0 0 0 1px var(--ui-stroke-secondary); pointer-events: none; }
.fc-lb-hint { position: absolute; left: 16px; bottom: 12px; color: var(--ui-text-quaternary); font-size: 11px; pointer-events: none; }
.fc-issue { display: flex; gap: 6px; align-items: flex-start; padding: 5px 6px; border-radius: 6px; font-size: 12px; cursor: pointer; color: var(--ui-text-secondary); }
.fc-issue:hover { background: var(--ui-row-hover-background); }
.fc-issue.error .codicon { color: var(--ui-red); }
.fc-issue.warning .codicon { color: var(--ui-yellow); }
.fc-ok { display: flex; align-items: center; gap: 6px; color: var(--ui-green); font-size: 12px; }
.fc-shortcut { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 0; font-size: 11.5px; color: var(--ui-text-secondary); }
.fc-shortcut kbd { font: inherit; font-size: 10.5px; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--ui-stroke-secondary);
  color: var(--ui-text-tertiary); background: var(--ui-bg-elevated); white-space: nowrap; }
.fc-tool-pick { margin: 10px 0 4px; }
.fc-insp-issues { margin-top: 8px; }
.fc-insp-issues .fc-issue { cursor: default; padding: 3px 0; }
.fc-insp-issues .fc-issue:hover { background: none; }
.fc-insp-error .fc-copy { top: 12px; }
.fc-stats { margin-top: 2px; font-size: 11.5px; color: var(--ui-text-tertiary); }
details.fc-raw { margin-top: 10px; }
details.fc-raw summary { cursor: pointer; font-size: 11px; color: var(--ui-text-tertiary); margin-bottom: 4px; }
.fc-log { flex: none; border-top: 1px solid var(--ui-stroke-tertiary); display: flex; flex-direction: column; }
.fc-log.open { height: 168px; }
.fc-log-head { flex: none; display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 12px; cursor: pointer; font-size: 12px; }
.fc-log-head:hover { background: var(--ui-row-hover-background); }
.fc-log-title { font-weight: 600; }
.fc-log-body { flex: 1; overflow-y: auto; padding: 0 8px 8px; }
.fc-log-row { display: grid; grid-template-columns: 70px minmax(120px, 220px) 64px 1fr; align-items: center; gap: 10px; padding: 3px 6px;
  border-radius: 6px; cursor: pointer; font-size: 12px; }
.fc-log-row:hover { background: var(--ui-row-hover-background); }
/* U-8: run log rows are buttons, so Tab lands on them and the ring shows where. */
.fc-log-head:focus-visible, .fc-log-row:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
.fc-log-node { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-log-ms { color: var(--ui-text-tertiary); text-align: right; font-variant-numeric: tabular-nums; }
.fc-log-msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-text-tertiary); }
.fc-log-msg.bad { color: var(--ui-red); }
.fc-runchip { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--fc-st); }
.fc-runchip .codicon { color: var(--fc-st); }
.fc-center { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; min-height: 0; overflow: auto; }
.fc-welcome { max-width: 640px; text-align: center; }
.fc-welcome-icon .codicon { font-size: 42px; color: var(--ui-accent); }
.fc-welcome h2 { margin: 10px 0 8px; font-size: 20px; }
.fc-welcome p { margin: 0 auto 16px; max-width: 540px; color: var(--ui-text-secondary); line-height: 1.55; }
.fc-templates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 18px 0; text-align: left; }
.fc-template { display: flex; flex-direction: column; gap: 4px; padding: 12px; border-radius: 10px; border: 1px solid var(--ui-stroke-secondary);
  background: var(--ui-bg-elevated); color: var(--ui-text-primary); font: inherit; cursor: pointer; text-align: left; }
.fc-template:hover:not(:disabled) { border-color: var(--ui-accent); }
.fc-template:disabled { opacity: .5; cursor: default; }
.fc-template span { font-size: 11.5px; color: var(--ui-text-secondary); }
@media (max-width: 560px) { .fc-templates { grid-template-columns: 1fr; } }
`

