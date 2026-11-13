// Explicit dev-harness regression: while a wire is being pulled, no tooltip may show — and afterwards they return.
export async function probeWire(ctx, diag) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (fn, ms = 9000) => {
    for (let t = 0; t < ms; t += 50) {
      const v = fn()
      if (v) return v
      await sleep(50)
    }
    throw new Error('wire-tip probe timed out')
  }
  const out = (diag.wire = {})
  const call = (method, path, body) => ctx.rest('/x/' + path, { method, body })
  const mouse = (el, kind) => el.dispatchEvent(new MouseEvent(kind, { bubbles: true, relatedTarget: document.body }))
  // Visible, not merely present: the guard hides bubbles with CSS so the host's own state stays intact.
  const tips = () => [...document.querySelectorAll('[data-dev-tip]')].filter((el) => el.getClientRects().length > 0).length
  const present = () => document.querySelectorAll('[data-dev-tip]').length
  // Native titles inside the plugin page only; the app's own chrome is not Arachne's to touch.
  const titles = () => [...document.querySelectorAll('.fc-root [title]')].filter((el) => el.getAttribute('title') !== '').length
  const wireStyle = () => !!document.querySelector('[data-fc-wire-tips]')
  const pointer = (el, kind, x, y) => el.dispatchEvent(new PointerEvent(kind, {
    bubbles: true, cancelable: true, button: 0, buttons: kind === 'pointerup' ? 0 : 1, pointerId: 7, isPrimary: true, clientX: x, clientY: y
  }))
  const at = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } }

  await until(() => document.querySelector('.fc-root'))
  const created = (await call('POST', 'flows', { name: 'Wire tip fixture' })).flow
  const flow = (await call('POST', 'flows/' + created.id + '/ops', {
    base_revision: created.revision,
    origin: 'ui',
    ops: [
      { op: 'add_node', ref: 'text', type: 'input.text', title: 'Wire source', params: { value: 'hello' }, x: 80, y: 120 },
      { op: 'add_node', ref: 'llm', type: 'llm.complete', title: 'Wire target', params: {}, x: 520, y: 120 }
    ]
  })).flow
  window.__devEmit('plugin.arachne-flow.ui.open', { flow_id: flow.id })
  await until(() => document.querySelectorAll('[data-fc-node]').length === 2)

  const source = await until(() => document.querySelector('[data-fc-node] [data-fc-side="out"]'))
  const target = await until(() => document.querySelector('[data-fc-node] [data-fc-port="prompt"][data-fc-side="in"]')
    || document.querySelector('[data-fc-node] [data-fc-side="in"]'))
  out.edgesBefore = document.querySelectorAll('.fc-edge').length

  // A tip opens normally while the pointer simply rests on a port.
  mouse(source, 'mouseover')
  await until(() => tips() > 0)
  out.tipBefore = tips()
  out.titleBefore = titles() > 0
  mouse(source, 'mouseout')
  await until(() => tips() === 0)

  // Pull a wire: nothing may pop up — not the tip already open, not a new one, not a native title bubble.
  const from = at(source)
  pointer(source, 'pointerdown', from.x, from.y)
  await until(() => document.querySelector('.fc-wire'))
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, buttons: 1, pointerId: 7, isPrimary: true, clientX: from.x + 60, clientY: from.y + 40 }))
  await sleep(120)
  out.tipsDuringWire = tips()
  out.titlesDuringWire = titles()
  mouse(target, 'mouseover')      // a port under the cursor while the wire is alive
  await sleep(300)
  out.guardDuringWire = wireStyle()
  out.tipsAfterHoverDuringWire = tips()
  out.tipsPresentDuringWire = present()
  out.titlesAfterHoverDuringWire = titles()
  mouse(target, 'mouseout')
  await sleep(80)

  const to = at(target)
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, buttons: 1, pointerId: 7, isPrimary: true, clientX: to.x, clientY: to.y }))
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, buttons: 0, pointerId: 7, isPrimary: true, clientX: to.x, clientY: to.y }))
  await until(() => document.querySelectorAll('.fc-edge').length === out.edgesBefore + 1)
  out.edgesAfter = document.querySelectorAll('.fc-edge').length
  out.wireGone = !document.querySelector('.fc-wire')
  out.guardAfterDrop = wireStyle()

  // Tips come back the moment the drag is over (leave first: the pointer never left the port above).
  mouse(target, 'mouseout')
  await sleep(60)
  mouse(target, 'mouseover')
  await until(() => tips() > 0)
  out.tipAfter = tips()
  out.titleAfter = titles() > 0
  mouse(target, 'mouseout')
  await sleep(100)
  out.tipAfterLeave = tips()

  // Escape aborts the drag: the same rules must not leave the page tip-less.
  pointer(source, 'pointerdown', from.x, from.y)
  await until(() => document.querySelector('.fc-wire'))
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, buttons: 1, pointerId: 8, isPrimary: true, clientX: from.x + 40, clientY: from.y + 30 }))
  await sleep(100)
  out.tipsBeforeEscape = tips()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await until(() => !document.querySelector('.fc-wire'))
  mouse(source, 'mouseover')
  await until(() => tips() > 0)
  out.tipAfterEscape = tips()
  mouse(source, 'mouseout')
  out.done = true
}
