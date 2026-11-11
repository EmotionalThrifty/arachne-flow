// Node-side stand-in for react: hooks behave like a single static render unless wrapped in withHookState.
let ACTIVE_HOOKS = null
const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
const nextSlot = () => {
  if (!ACTIVE_HOOKS) return null
  const idx = ACTIVE_HOOKS.index
  ACTIVE_HOOKS.index += 1
  return { list: ACTIVE_HOOKS.list, idx }
}
export function withHookState(store, fn) {
  const prev = ACTIVE_HOOKS
  if (!store.list) store.list = []
  ACTIVE_HOOKS = { list: store.list, index: 0 }
  try {
    return fn()
  } finally {
    ACTIVE_HOOKS = prev
  }
}
export const useState = (v) => {
  const slot = nextSlot()
  if (!slot) return [typeof v === 'function' ? v() : v, () => {}]
  if (!(slot.idx in slot.list)) {
    const set = (next) => {
      slot.list[slot.idx].value = typeof next === 'function' ? next(slot.list[slot.idx].value) : next
    }
    slot.list[slot.idx] = { value: typeof v === 'function' ? v() : v, set }
  }
  return [slot.list[slot.idx].value, slot.list[slot.idx].set]
}
export const useEffect = () => {}
export const useLayoutEffect = () => {}
export const useMemo = (fn, deps) => {
  const slot = nextSlot()
  if (!slot) return fn()
  const cur = slot.list[slot.idx]
  if (cur && sameDeps(cur.deps, deps)) return cur.value
  const value = fn()
  slot.list[slot.idx] = { value, deps }
  return value
}
export const useCallback = (fn, deps) => {
  const slot = nextSlot()
  if (!slot) return fn
  const cur = slot.list[slot.idx]
  if (cur && sameDeps(cur.deps, deps)) return cur.fn
  slot.list[slot.idx] = { fn, deps }
  return fn
}
export const useRef = (v) => {
  const slot = nextSlot()
  if (!slot) return { current: v }
  if (!(slot.idx in slot.list)) slot.list[slot.idx] = { current: v }
  return slot.list[slot.idx]
}
export const useReducer = (r, init) => [init, () => {}]
export const useContext = () => undefined
export const createContext = (v) => ({ Provider: () => null, _v: v })
export const memo = (c, compare) => Object.assign(c, { _memo: true, compare: compare || null })
export const forwardRef = (c) => c
export const Fragment = 'Fragment'
export default { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, useReducer, useContext, createContext, memo, forwardRef, Fragment, withHookState }
