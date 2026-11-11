// Browser stand-in for @hermes/plugin-sdk used by dev/harness.html. Mirrors the subset of the real
// SDK that desktop/plugin.js may use. Dev tooling only.
import { createElement as h, useSyncExternalStore, useEffect, useState, cloneElement, isValidElement, Fragment } from 'react'
import { createPortal } from 'react-dom'

// ---------------------------------------------------------------- state + events
export function atom(initial) {
  let value = initial
  const subs = new Set()
  return {
    get: () => value,
    set: (next) => { value = next; subs.forEach((fn) => fn(value)) },
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn) },
    listen: (fn) => { subs.add(fn); return () => subs.delete(fn) }
  }
}
export function computed(store, fn) {
  return { get: () => fn(store.get()), subscribe: (cb) => store.subscribe(() => cb(fn(store.get()))) }
}
export function useValue(store) {
  return useSyncExternalStore((cb) => store.subscribe(cb), () => store.get())
}

const listeners = new Map()
let source = null
const eventsEnabled = new URLSearchParams(location.search).get('events') !== '0'
function ensureSource() {
  if (source || !eventsEnabled) return
  source = new EventSource('/events')
  source.onmessage = (msg) => {
    let data
    try { data = JSON.parse(msg.data) } catch { return }
    const fns = listeners.get(data.name)
    if (fns) fns.forEach((fn) => fn({ name: data.name, payload: data.payload }))
  }
}

// Probe hook: deliver a host event without SSE (an open EventSource keeps headless Chrome's
// --virtual-time-budget from ever expiring). Same `{ name, payload }` shape as Desktop's bus.
window.__devEmit = (name, payload) => {
  const fns = listeners.get(name)
  if (fns) fns.forEach((fn) => fn({ name, payload }))
  return fns ? fns.size : 0
}

const focused = atom('dev-session')
export const host = {
  state: { gateway: atom('open'), focusedSessionId: focused },
  onEvent(name, fn) {
    ensureSource()
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name).add(fn)
    return () => listeners.get(name)?.delete(fn)
  },
  async request(method, params) {
    console.info('[dev] host.request', method, params)
    if (method === 'model.options') {
      // Shape of the real gateway RPC (hermes_cli/inventory.py build_model_options_payload), trimmed.
      return {
        provider: 'custom', model: 'deepseek/deepseek-v4.1-flash-1017:thinking',
        providers: [
          { slug: 'anthropic', name: 'Anthropic', authenticated: true, is_current: false, models: ['claude-opus-5-5', 'claude-haiku-4-5'],
            capabilities: { 'claude-opus-5-5': { fast: false, reasoning: true } } },
          { slug: 'custom', name: 'NanoGPT', authenticated: true, is_current: true, api_url: 'https://nano-gpt.com/api/v1',
            models: ['deepseek/deepseek-v4.1-flash-1017:thinking', 'z-ai/glm-5.3-flash', 'xiaomi/mimo-v2.6-pro', 'openai/gpt-6.1-sol'],
            pricing: { 'z-ai/glm-5.3-flash': { input: '$0.10', output: '$0.30', free: false } },
            capabilities: { 'z-ai/glm-5.3-flash': { fast: false, reasoning: true, can_disable_reasoning: true } } },
          { slug: 'moa', name: 'Mixture of Agents', authenticated: true, models: ['default'] },
          { slug: 'nous', name: 'Nous Portal', authenticated: true, models: ['a/x', 'b/y'], unavailable_models: ['a/x', 'b/y'] }
        ]
      }
    }
    return {}
  },
  navigate(path) { (window.__devNavigated = window.__devNavigated || []).push(path); console.info('[dev] navigate', path) },
  toast(message) { console.info('[dev] toast', message); window.__devToasts = [...(window.__devToasts || []), message] },
  composer: {
    async setDraft(sid, text) {
      // ?composer=none mimics Desktop with no mounted chat composer: setDraft resolves false
      window.__devDraftCalls = [...(window.__devDraftCalls || []), sid]
      if (new URLSearchParams(location.search).get('composer') === 'none') return false
      window.__devDraft = text
      return true
    },
    async insertText(sid, text) {
      // same contract as setDraft (records the address, ?composer=none -> false), but appends like Desktop's 'block' mode
      window.__devDraftCalls = [...(window.__devDraftCalls || []), sid]
      if (new URLSearchParams(location.search).get('composer') === 'none') return false
      window.__devDraft = window.__devDraft ? `${window.__devDraft}\n\n${text}` : text
      return true
    },
    async getDraft() { return window.__devDraft || '' },
    submit(sid, text) { window.__devDraft = text; return true },
    focus() {}
  }
}

// ---------------------------------------------------------------- areas + helpers
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'
export const PALETTE_AREA = 'palette'
export const KEYBINDS_AREA = 'keybinds'
export const PANES_AREA = 'panes'
export const cn = (...xs) => xs.filter(Boolean).join(' ')
export const randomUuid = () => crypto.randomUUID()
export const haptic = () => {}
export const writeClipboardText = async (text) => { window.__devClipboard = text }
export const useTheme = () => ({ resolvedTheme: 'dark' })

// ---------------------------------------------------------------- components (plain HTML look-alikes)
const control = {
  background: 'var(--ui-bg-elevated)', color: 'var(--ui-text-primary)', border: '1px solid var(--ui-stroke-secondary)',
  borderRadius: 6, font: 'inherit', fontSize: 12.5, padding: '5px 8px', outline: 'none'
}
export function Button({ variant = 'default', size, className, style, children, loading, ...props }) {
  const ghost = variant === 'ghost' || variant === 'outline' || variant === 'textStrong'
  const primary = variant === 'default' || variant === 'primary'
  return h('button', {
    ...props,
    className,
    style: {
      ...control,
      padding: size === 'icon' || size === 'icon-sm' ? 4 : size === 'sm' ? '3px 8px' : '5px 10px',
      display: 'inline-flex', alignItems: 'center', gap: 6, cursor: props.disabled ? 'default' : 'pointer',
      background: primary ? 'var(--ui-accent)' : ghost ? 'transparent' : 'var(--ui-bg-elevated)',
      color: primary ? '#1a1406' : 'var(--ui-text-primary)', borderColor: ghost ? 'transparent' : 'var(--ui-stroke-secondary)',
      opacity: props.disabled ? 0.5 : 1, ...style
    }
  }, children)
}
export function Input({ className, style, ...props }) {
  return h('input', { ...props, className, style: { ...control, ...style } })
}
export function Textarea({ className, style, ...props }) {
  return h('textarea', { ...props, className, style: { ...control, resize: 'vertical', minHeight: 60, ...style } })
}
export function Switch({ checked, onCheckedChange, disabled }) {
  return h('input', { type: 'checkbox', checked: !!checked, disabled, onChange: (e) => onCheckedChange?.(e.target.checked) })
}
export function Checkbox(props) { return Switch(props) }
export function Codicon({ name, size, spinning, className, style, ...props }) {
  return h('i', {
    ...props, 'aria-hidden': 'true',
    className: cn('codicon', `codicon-${name}`, spinning && 'codicon-modifier-spin', className),
    style: { ...(size != null ? { fontSize: size } : {}), ...style }
  })
}
export function GlyphSpinner({ size = 12 }) { return Codicon({ name: 'loading', spinning: true, size }) }
export function Loader() { return GlyphSpinner({}) }
export function Badge({ children, className, style }) {
  return h('span', { className, style: { fontSize: 11, padding: '1px 6px', borderRadius: 999, background: 'var(--ui-bg-tertiary)', ...style } }, children)
}
export function Kbd({ children }) {
  return h('kbd', { style: { fontSize: 11, padding: '0 4px', border: '1px solid var(--ui-stroke-secondary)', borderRadius: 4 } }, children)
}
export function KbdGroup({ children }) { return h('span', null, children) }
export function Separator() { return h('hr', { style: { border: 0, borderTop: '1px solid var(--ui-stroke-tertiary)', margin: '6px 0' } }) }
export function ScrollArea({ children, className, style }) { return h('div', { className, style: { overflow: 'auto', ...style } }, children) }
export function Streamdown({ children }) { return h('div', { style: { whiteSpace: 'pre-wrap' } }, children) }
export function EmptyState({ title, description, children }) {
  return h('div', { style: { textAlign: 'center', padding: 24 } }, h('div', { style: { fontWeight: 600 } }, title), h('div', null, description), children)
}
export function ErrorState({ title, description }) { return EmptyState({ title, description }) }
export function SearchField({ value, onChange, placeholder, style }) {
  return h('input', { value, placeholder, style: { ...control, width: '100%', ...style }, onChange: (e) => onChange?.(e.target.value) })
}
export function CopyButton({ text }) {
  return Button({ variant: 'ghost', size: 'icon', onClick: () => writeClipboardText(text), children: Codicon({ name: 'copy' }) })
}
// Like the app's Tip: shows `label` on hover beside the trigger, so probes and screenshots can check tooltip content
// (dev/boot.js hovers with a synthetic mouseover). Same DOM and cascade as Desktop (src/components/ui/tooltip.tsx +
// tooltip.css): inverted look from Tailwind utilities in a CSS layer, radius/max-width/arrow fill from unlayered
// tooltip.css, caller `className` appended. A plugin override that works here works the same way in Desktop.
// Portalled to <body> like Radix' TooltipPrimitive.Portal: inside the canvas the trigger sits under a transformed
// .fc-world, where position: fixed would be relative to that transform instead of the viewport.
const TIP_CSS = `@layer utilities { .dev-tw-bubble { padding: 4px 8px; font-size: 11px; font-weight: 500; line-height: 1.4;
  background: var(--ui-text-primary); color: var(--ui-bg-editor); width: fit-content; user-select: none; pointer-events: none; } }
.tooltip-bubble { max-width: min(24rem, calc(100vw - 1.5rem)); border-radius: 0.25rem; text-align: start; overflow-wrap: anywhere; white-space: normal; }
.tooltip-bubble [data-slot='tooltip-arrow'] { fill: var(--ui-text-primary); }
.tooltip-bubble-label { min-width: 0; }`
function ensureTipCss() {
  if (typeof document === 'undefined' || document.getElementById('dev-tip-css')) return
  const el = document.createElement('style')
  el.id = 'dev-tip-css'
  el.textContent = TIP_CSS
  document.head.appendChild(el)
}
export function Tip({ label, children, side = 'top', sideOffset = 5, className = '' }) {
  const [rect, setRect] = useState(null)
  if (!label || !isValidElement(children)) return children
  ensureTipCss()
  const own = children.props
  const trigger = cloneElement(children, {
    onMouseEnter: (e) => { own.onMouseEnter?.(e); setRect(e.currentTarget.getBoundingClientRect()) },
    onMouseLeave: (e) => { own.onMouseLeave?.(e); setRect(null) }
  })
  if (!rect) return trigger
  const at = side === 'right' ? { left: rect.right + sideOffset, top: rect.top }
    : side === 'bottom' ? { left: rect.left, top: rect.bottom + sideOffset }
      : { left: rect.left, top: rect.top - sideOffset, transform: 'translateY(-100%)' }
  return h(Fragment, null, trigger, createPortal(h('div', {
    'data-dev-tip': '1',
    'data-side': side,
    className: cn('tooltip-bubble dev-tw-bubble', className),
    style: { position: 'fixed', zIndex: 1000, ...at }
  },
  h('div', { className: 'tooltip-bubble-label', 'data-slot': 'tooltip-label' }, label),
  // arrow wrapper exactly like @radix-ui/react-popper PopperArrow: sits just outside the box on the trigger side
  h('span', {
    style: side === 'right'
      ? { position: 'absolute', top: 8, left: 0, transformOrigin: '0 0', transform: 'translateY(50%) rotate(90deg) translateX(-50%)' }
      : side === 'bottom' ? { position: 'absolute', left: 8, top: 0, transformOrigin: 'center 0', transform: 'rotate(180deg)' }
        : { position: 'absolute', left: 8, bottom: 0, transform: 'translateY(100%)' }
  },
  h('svg', { 'aria-hidden': true, 'data-slot': 'tooltip-arrow', viewBox: '0 0 10 5', width: 10, height: 5, style: { display: 'block' } },
    h('path', { d: 'M0 0h10L5.7 4.3a1 1 0 0 1-1.4 0Z' })))), document.body))
}
export function Tooltip({ children }) { return children }
export function TooltipTrigger({ children }) { return children }
export function TooltipContent() { return null }
export function TooltipProvider({ children }) { return children }
export function Popover({ children }) { return children }
export function PopoverTrigger({ children }) { return children }
export function PopoverContent() { return null }
export function LogView({ lines = [] }) { return h('pre', null, lines.join('\n')) }
export function SandboxedFrame(props) { return h('iframe', { ...props, sandbox: 'allow-scripts' }) }
export function ConfirmDialog() { return null }
export const useQuery = () => ({ data: undefined, isLoading: false })
export const useMutation = () => ({ mutate: () => {}, mutateAsync: async () => {} })
export const useQueryClient = () => ({ invalidateQueries: () => {} })
export { useEffect, useState }
