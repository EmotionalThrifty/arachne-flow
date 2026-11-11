// Review U-8: the flows menu, the context menu, clickable rows and the dialogs are keyboard usable.
// Pure decisions live in menuKeyNav / trapFocus / activatesOn; the components only move focus.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const SOURCE = readFileSync(join(root, 'desktop', 'plugin.js'), 'utf8')
/** The source of one `function name(` ... up to the next top-level `function ` — enough to assert on a component. */
const block = (name) => {
  const at = SOURCE.indexOf(`function ${name}(`)
  assert.ok(at > 0, `${name} exists`)
  const rest = SOURCE.slice(at)
  const end = rest.slice(1).search(/\nfunction /)
  return end < 0 ? rest : rest.slice(0, end + 1)
}

test('menuKeyNav walks the menu and wraps at both ends', () => {
  assert.equal(I.menuKeyNav(0, 3, 'ArrowDown'), 1)
  assert.equal(I.menuKeyNav(1, 3, 'ArrowDown'), 2)
  assert.equal(I.menuKeyNav(2, 3, 'ArrowDown'), 0)   // last -> first
  assert.equal(I.menuKeyNav(0, 3, 'ArrowUp'), 2)     // first -> last
  assert.equal(I.menuKeyNav(2, 3, 'ArrowUp'), 1)
  assert.equal(I.menuKeyNav(4, 3, 'ArrowDown'), 0)   // stale index -> top
})

test('menuKeyNav: Home/End jump, Enter and Space activate, Escape and Tab close', () => {
  assert.equal(I.menuKeyNav(1, 4, 'Home'), 0)
  assert.equal(I.menuKeyNav(1, 4, 'End'), 3)
  assert.equal(I.menuKeyNav(1, 4, 'Enter'), 'activate')
  assert.equal(I.menuKeyNav(1, 4, ' '), 'activate')
  assert.equal(I.menuKeyNav(1, 4, 'Spacebar'), 'activate')
  assert.equal(I.menuKeyNav(1, 4, 'Escape'), 'close')
  assert.equal(I.menuKeyNav(1, 4, 'Tab'), 'close')
})

test('menuKeyNav: opened but nothing focused yet starts at top/bottom, never activates', () => {
  assert.equal(I.menuKeyNav(-1, 3, 'ArrowDown'), 0)
  assert.equal(I.menuKeyNav(-1, 3, 'ArrowUp'), 2)
  assert.equal(I.menuKeyNav(-1, 3, 'Enter'), null)
  assert.equal(I.menuKeyNav(-1, 3, ' '), null)
})

test('menuKeyNav: an empty menu can only be closed; foreign keys are left alone', () => {
  assert.equal(I.menuKeyNav(-1, 0, 'ArrowDown'), null)
  assert.equal(I.menuKeyNav(0, 0, 'Home'), null)
  assert.equal(I.menuKeyNav(0, 0, 'Escape'), 'close')
  for (const key of ['a', 'F5', 'Shift', 'ArrowLeft', 'PageDown']) {
    assert.equal(I.menuKeyNav(1, 3, key), null, `${key} is not a menu key`)
  }
})

test('trapFocus wraps Tab from the last field and Shift+Tab from the first', () => {
  const first = { id: 'name' }
  const last = { id: 'ok' }
  assert.equal(I.trapFocus(first, last, last, false), first)
  assert.equal(I.trapFocus(first, last, first, true), last)
})

test('trapFocus leaves the browser default alone in the middle of the dialog', () => {
  const first = { id: 'name' }
  const mid = { id: 'desc' }
  const last = { id: 'ok' }
  assert.equal(I.trapFocus(first, last, mid, false), null)
  assert.equal(I.trapFocus(first, last, mid, true), null)
})

test('trapFocus: focus that is not inside the dialog enters it (first / last)', () => {
  const first = { id: 'name' }
  const last = { id: 'ok' }
  assert.equal(I.trapFocus(first, last, null, false), first)
  assert.equal(I.trapFocus(first, last, null, true), last)
})

test('trapFocus: one field stays put, no fields means no trap', () => {
  const only = { id: 'name' }
  assert.equal(I.trapFocus(only, only, only, false), only)
  assert.equal(I.trapFocus(only, only, only, true), only)
  assert.equal(I.trapFocus(undefined, undefined, null, false), null)
  assert.equal(I.trapFocus(null, null, null, true), null)
})

test('activatesOn: Enter and Space press a focused row, nothing else does', () => {
  assert.equal(I.activatesOn('Enter'), true)
  assert.equal(I.activatesOn(' '), true)
  assert.equal(I.activatesOn('Spacebar'), true)
  for (const key of ['a', 'ArrowDown', 'Escape', 'Tab', 'Shift']) assert.equal(I.activatesOn(key), false, key)
})

test('the flows menu is a role=menu whose rows are role=menuitem', () => {
  const menu = block('FlowMenu')
  assert.match(menu, /role: 'menu'/, 'the flows menu has role=menu')
  const rows = menu.match(/role: 'menuitem'/g) || []
  // flow rows, New blank flow, template rows, save as template, schedule, duplicate, delete
  assert.ok(rows.length >= 6, `every row is a menuitem (found ${rows.length})`)
})

test('the context menu is a role=menu too, and its rows are menuitems', () => {
  const ctx = block('ContextMenu')
  assert.match(ctx, /role: 'menu'/, 'the context menu has role=menu')
  assert.match(ctx, /h\(MenuItems,/, 'its rows come from MenuItems')
  assert.match(block('MenuItems'), /role: 'menuitem'/, 'and MenuItems renders menuitems')
})

test('clickable run log rows are buttons reachable by Tab', () => {
  const log = block('RunLog')
  assert.match(log, /role: 'button'/, 'rows are buttons')
  assert.match(log, /tabIndex: 0/, 'rows are in the tab order')
  assert.match(log, /onKeyDown/, 'rows take Enter/Space')
})

test('every dialog goes through the focus-trapping frame', () => {
  assert.match(block('TemplateDialog'), /h\(DialogFrame,/, 'template dialog')
  assert.match(block('ScheduleDialog'), /h\(DialogFrame,/, 'schedule dialog')
  assert.match(block('DialogFrame'), /role: 'dialog'/, 'the frame is a dialog')
  assert.match(block('DialogFrame'), /'aria-modal': 'true'/, 'and modal')
  assert.match(block('DialogFrame'), /trapFocus\(/, 'and traps Tab')
})

test('the generate modal is a trapped dialog as well', () => {
  const page = block('FlowCanvasPage')
  assert.match(page, /h\(DialogFrame, \{[\s\S]{0,200}Build with Hermes/, 'the generate modal uses the frame')
  assert.doesNotMatch(page, /className: 'fc-modal-scrim'/, 'no bare scrim left in the page')
})

test('UI-8: user template rename and delete buttons in FlowMenu are keyboard-reachable and operable', async () => {
  assert.equal(typeof I.menuRowsIn, 'function', 'menuRowsIn is exported in _internals')
  assert.equal(typeof I.FlowMenu, 'function', 'FlowMenu is exported in _internals')

  // Minimal DOM tree adapter so FlowMenu + useMenuKeys can be driven with real ArrowDown/Enter key events.
  let activeEl = null
  const prevDoc = globalThis.document
  const prevWin = globalThis.window
  const matchesSingle = (node, sel) => {
    if (sel === '[role="menuitem"]') return node.props?.role === 'menuitem'
    if (sel === '.fc-mini' || sel === 'button.fc-mini:not([disabled])') {
      const cls = String(node.props?.className || '').split(/\s+/)
      return cls.includes('fc-mini') && !node.props?.disabled
    }
    return false
  }
  const buildDom = (vnode) => {
    if (!vnode || typeof vnode !== 'object') return null
    const rawChildren = Array.isArray(vnode.props?.children)
      ? vnode.props.children
      : vnode.props?.children != null ? [vnode.props.children] : []
    const children = []
    if (typeof vnode.type === 'function') {
      return buildDom(vnode.type(vnode.props || {}))
    }
    const el = {
      tagName: String(vnode.type || 'div').toUpperCase(),
      props: vnode.props || {},
      disabled: !!vnode.props?.disabled,
      isConnected: true,
      children,
      getAttribute(name) {
        const v = this.props[name]
        return v === undefined || v === null ? null : String(v)
      },
      focus() { activeEl = this },
      click() {
        if (typeof this.props.onClick === 'function') {
          this.props.onClick({ stopPropagation() {}, preventDefault() {} })
        }
      },
      closest() { return null },
      querySelectorAll(selector) {
        const parts = selector.split(',').map((s) => s.trim()).filter(Boolean)
        const out = []
        const walk = (n) => {
          if (!n) return
          if (parts.some((p) => matchesSingle(n, p))) out.push(n)
          for (const c of n.children || []) walk(c)
        }
        for (const c of this.children) walk(c)
        return out
      }
    }
    for (const c of rawChildren.flat(Infinity)) {
      const built = buildDom(c)
      if (built) children.push(built)
    }
    return el
  }

  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  globalThis.document = {
    body: { isConnected: true },
    get activeElement() { return activeEl }
  }
  try {
    const edited = []
    const deleted = []
    const templates = [
      { id: 'tpl_user', name: 'My pipeline', source: 'user', available: true },
      { id: 'tpl_builtin', name: 'Starter', source: 'builtin', available: true }
    ]
    const renderMenu = () => {
      const vnode = I.FlowMenu({
        flows: [{ id: 'f_1', name: 'Flow 1', node_count: 2, updated_at: new Date().toISOString() }],
        current: { id: 'f_1', name: 'Flow 1' },
        templates,
        onOpen() {},
        onNew() {},
        onFromTemplate() {},
        onDuplicate() {},
        onDelete() {},
        onClose() {},
        onSaveTemplate() {},
        onEditTemplate: (t) => edited.push(t.id),
        onDeleteTemplate: (t) => deleted.push(t.id),
        onSchedule() {}
      })
      const dom = buildDom(vnode)
      if (vnode.props?.ref) vnode.props.ref.current = dom
      return dom
    }

    const dom = renderMenu()
    const rows = I.menuRowsIn(dom)
    const editIdx = rows.findIndex((r) => r.getAttribute('data-fc-template-edit') === 'tpl_user')
    const delIdx = rows.findIndex((r) => r.getAttribute('data-fc-template-delete') === 'tpl_user')
    assert.ok(editIdx > 0, 'the user template Rename/Edit button is in menuRowsIn')
    assert.equal(delIdx, editIdx + 1, 'the user template Delete button immediately follows Edit in menuRowsIn')

    // Walk from the top of the menu to Edit using ArrowDown and press Enter
    activeEl = rows[0]
    const key = (k) => dom.props.onKeyDown({ key: k, preventDefault() {}, stopPropagation() {} })
    for (let i = 0; i < editIdx; i++) key('ArrowDown')
    assert.equal(activeEl.getAttribute('data-fc-template-edit'), 'tpl_user', 'ArrowDown reaches Edit template')
    key('Enter')
    assert.deepEqual(edited, ['tpl_user'], 'Enter on Edit template triggers onEditTemplate')

    // Move one step down to Delete template and press Space to arm, then Enter to confirm delete
    key('ArrowDown')
    assert.equal(activeEl.getAttribute('data-fc-template-delete'), 'tpl_user', 'ArrowDown reaches Delete template')
    key(' ')
    assert.deepEqual(deleted, [], 'first activation only arms template deletion')
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(activeEl?.getAttribute('data-fc-template-delete'), 'tpl_user',
      'focus stays on the armed Delete button even when Built-in templates follow')
  } finally {
    globalThis.document = prevDoc
    globalThis.window = prevWin
  }
})
