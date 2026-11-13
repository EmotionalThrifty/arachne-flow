// Arachne Flow — the Hermes Desktop page of the arachne-flow plugin.
//
// GENERATED: desktop/plugin.js is built from desktop/src/NN-*.js by `node scripts/build_desktop.mjs`; edit the
// sources, never plugin.js (check.sh refuses a stale build). One shipped file on purpose: Desktop evaluates it
// from a blob: URL, so it cannot import siblings. The parts share one module scope; imports are limited to the
// plugin SDK and React and live in 00-core.js. Pure logic (geometry, graph edits, undo, parsing) lives in plain
// functions exported through `_internals` and is unit-tested in tests/js without the app.
import * as sdk from '@hermes/plugin-sdk'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const host = sdk.host || {}
const PLUGIN_ID = 'arachne-flow'
const ROUTE = '/arachne-flow'
const evt = (name) => `plugin.${PLUGIN_ID}.${name}`

const NODE_W = 240
const HEAD_H = 48  // Clean card: title line + "provider · model" line (ports and wires are placed below it)
const PORTS_TOP = 6
const ROW_H = 22
const GRID = 10
const MIN_ZOOM = 0.2
const MAX_ZOOM = 2.5
const COLLAPSE_AFTER = 6
const VISIBLE_OPTIONAL = 4
const UNDO_LIMIT = 50
const SAVE_DELAY = 600
const POLL_MS = 2000
// Consecutive failed fallback polls after which the page admits it lost the backend (U-5).
const LOST_CONTACT_AFTER = 3
const DND_TYPE = 'application/x-arachne-flow-node'
const TERMINAL = new Set(['done', 'error', 'cancelled', 'invalid', 'interrupted'])
const EMPTY_SET = new Set()
const EMPTY_DOC = { flow: null, undo: [], redo: [], key: null, at: 0 }
const EMPTY_TYPES = { list: [], byName: {}, compat: {}, portTypes: {}, categories: [] }
// Survives navigating away from the page (the module stays loaded; the component does not).
const SHARED = { pendingOpen: null, pendingRun: false, session: null, runCurrent: null, listeners: new Set(), pageMounted: false }
let CLIPBOARD = null

// ---------------------------------------------------------------- element helper (no JSX)
// Children keep their positions (false/null holes included), exactly like JSX, so toggling one
// conditional child never remounts its siblings.
function h(type, props, ...children) {
  const { key, ...rest } = props || {}
  if (children.length === 1) rest.children = children[0]
  else if (children.length > 1) rest.children = children
  return children.length > 1 ? jsxs(type, rest, key) : jsx(type, rest, key)
}

function Icon({ name, spin, className, style, title }) {
  const cls = `codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}${className ? ` ${className}` : ''}`
  return h('i', { className: cls, style, title, 'aria-hidden': title ? undefined : 'true' })
}

