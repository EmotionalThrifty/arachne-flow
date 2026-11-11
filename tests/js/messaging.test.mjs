// Send message node: a copy path must never inherit an egress opt-in (egress contract).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'

const I = (await loadPlugin())._internals

const armed = () => ({ id: 'n1', type: 'output.send_message', x: 0, y: 0,
  params: { target: 'signal:+491234', message: 'hi', send_enabled: true, authorized_target: 'signal:+491234',
    optin_token: 'a'.repeat(64), timeout_s: 45 } })

test('a copied Send message node starts disarmed and keeps its target and message', () => {
  const copy = I.disarmCopiedNode(I.cloneSubgraph({ nodes: [armed()], edges: [] }, ['n1'], 40, 40).nodes[0])
  assert.equal(copy.params.send_enabled, false)
  assert.equal(Object.prototype.hasOwnProperty.call(copy.params, 'authorized_target'), false)
  assert.equal(copy.params.target, 'signal:+491234')
  assert.equal(copy.params.message, 'hi')
})

test('copying through cloneSubgraph drops the opt-in without touching other nodes', () => {
  const flow = { nodes: [armed(), { id: 'n2', type: 'input.text', x: 0, y: 0, params: { value: 'x' } }], edges: [] }
  const sub = I.cloneSubgraph(flow, ['n1', 'n2'], 40, 40)
  const copied = sub.nodes.find((n) => n.type === 'output.send_message')
  assert.equal(copied.params.send_enabled, false)
  assert.equal(Object.prototype.hasOwnProperty.call(copied.params, 'authorized_target'), false)
  assert.deepEqual(sub.nodes.find((n) => n.type === 'input.text').params, { value: 'x' })
})

test('armed is only true when the stored authorization matches the stored target', () => {
  assert.equal(I.messagingArmed(armed()), true)
  assert.equal(I.messagingArmed({ ...armed(), params: { ...armed().params, send_enabled: false } }), false)
  assert.equal(I.messagingArmed({ ...armed(), params: { ...armed().params, target: 'signal:+499999' } }), false)
  assert.equal(I.messagingArmed({ ...armed(), params: { ...armed().params, authorized_target: '' } }), false)
  assert.equal(I.messagingArmed({ ...armed(), params: { ...armed().params, optin_token: '' } }), false)
  assert.equal(I.messagingArmed({ id: 'x', type: 'input.text', params: { send_enabled: true } }), false)
})
