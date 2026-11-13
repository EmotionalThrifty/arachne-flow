// Explicit dev-harness regression only; never imported by Hermes or the production plugin.
export async function probeTidy(ctx, diag) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async fn => {
    for (let t = 0; t < 9000; t += 50) { if (fn()) return; await sleep(50) }
    throw new Error('Tidy regression timed out')
  }
  const out = diag.tidy = {}
  await until(() => document.querySelector('.fc-root'))
  const call = (method, path, body) => ctx.rest('/x/' + path, { method, body })
  const created = (await call('POST', 'flows', { name: 'Tidy regression fixture' })).flow
  const ops = []
  for (let i = 0; i < 4; i++) ops.push({
    op: 'add_node', ref: 'note' + i, type: 'note', title: 'Long note ' + i,
    params: { text: Array(20).fill('A long note with several readable lines.').join('\n') }, x: 80, y: 80 + i * 60
  })
  ops.push({ op: 'add_node', ref: 'source', type: 'input.text', title: 'Source', params: { value: 'Example' }, x: 380, y: 80 })
  for (let i = 0; i < 3; i++) {
    ops.push({ op: 'add_node', ref: 'llm' + i, type: 'llm.complete', title: 'Expanded inputs ' + i,
      params: { template: Array.from({ length: 24 }, (_, j) => '{{field' + j + '}}').join(' ') }, x: 680, y: 80 + i * 180 })
    ops.push({ op: 'connect', from: 'source.text', to: 'llm' + i + '.field0' })
  }
  const flow = (await call('POST', 'flows/' + created.id + '/ops', { ops, base_revision: created.revision, origin: 'ui' })).flow
  window.__devEmit('plugin.arachne-flow.ui.open', { flow_id: flow.id })
  await until(() => document.querySelectorAll('[data-fc-node]').length === flow.nodes.length)
  out.stage = 'wait for the visible template ports'
  // Template ports are always visible (p.dynamic), so these cards have no '+ more' button.
  await until(() => [...document.querySelectorAll('[data-fc-node]')].filter(e => e.querySelectorAll('.fc-port-row').length >= 24).length === 3)
  out.stage = 'measure and tidy'
  const nodes = () => [...document.querySelectorAll('[data-fc-node]')].map(e => ({
    id: e.dataset.fcNode, x: e.offsetLeft, y: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight
  }))
  const positions = () => JSON.stringify(nodes().map(({ id, x, y }) => ({ id, x, y })))
  const overlaps = () => {
    const ns = nodes(), hits = []
    ns.forEach((a, i) => ns.slice(i + 1).forEach(b => {
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) hits.push([a.id, b.id])
    }))
    return hits
  }
  out.beforeOverlaps = overlaps().length
  out.heights = nodes().map(n => n.h)
  const originalPositions = positions(), realRest = ctx.rest
  out.requests = []
  let answers = 0
  ctx.rest = async (path, opts) => {
    const result = await realRest(path, opts)
    if (path.endsWith('/layout')) { out.requests.push(opts.body); answers += 1 }
    return result
  }
  try {
    const tidy = () => [...document.querySelectorAll('.fc-header button')].find(b => b.textContent.trim() === 'Tidy').click()
    tidy()
    await until(() => answers === 1 && overlaps().length === 0)
    const once = positions()
    out.afterOverlaps = overlaps().length
    document.querySelector('.fc-root').dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    await until(() => positions() === originalPositions)
    out.undo = true
    document.querySelector('.fc-root').dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }))
    await until(() => positions() === once)
    out.redo = true
    const canvas = document.querySelector('.fc-canvas'), r = canvas.getBoundingClientRect()
    canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 200, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }))
    await sleep(100)
    tidy()
    await until(() => answers === 2)
    await sleep(100)
    out.stable = positions() === once
    out.zoomSafe = JSON.stringify(out.requests[0].node_sizes) === JSON.stringify(out.requests[1].node_sizes)
    out.allMeasured = out.requests.every(b => Object.keys(b.node_sizes || {}).length === flow.nodes.length)
    const saved = (await call('GET', 'flows/' + flow.id)).flow
    out.contentPreserved = JSON.stringify(saved.nodes.map(n => [n.id, n.type, n.params])) === JSON.stringify(flow.nodes.map(n => [n.id, n.type, n.params])) &&
      JSON.stringify(saved.edges) === JSON.stringify(flow.edges)
    out.done = true
  } finally { ctx.rest = realRest }
}
