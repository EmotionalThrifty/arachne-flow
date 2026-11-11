// Node-side stand-in for @hermes/plugin-sdk: enough surface for the module to load.
// Components are inert functions; tests target pure helpers in `_internals`, not rendering.
const listeners = new Map()
export const host = {
  request: async () => ({}),
  onEvent: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) },
  state: { focusedSessionId: { get: () => null } },
  composer: { setDraft: async () => true, insertText: async () => true, focus: () => {} },
  navigated: [],
  navigate(path) { this.navigated.push(path) }
}
/** Test hook: deliver a host event the way Desktop's bus does (`{ name, payload }`). */
export const __emitHostEvent = (name, payload) => { const fn = listeners.get(name); if (fn) fn({ name, payload }) }
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'
export const PALETTE_AREA = 'palette'
export const KEYBINDS_AREA = 'keybinds'
export const PANES_AREA = 'panes'
export function atom(v) { let value = v; const subs = new Set(); return { get: () => value, set: (n) => { value = n; subs.forEach((s) => s(n)) }, subscribe: (s) => { subs.add(s); return () => subs.delete(s) } } }
export function computed(a, fn) { return { get: () => fn(a.get()), subscribe: () => () => {} } }
export const useValue = (store) => store.get()
export const cn = (...xs) => xs.filter(Boolean).join(' ')
export const randomUuid = () => 'uuid-' + Math.random().toString(16).slice(2)
const C = () => null
export const Button = C, Input = C, Textarea = C, Switch = C, Codicon = C, GlyphSpinner = C, Badge = C
export const Tooltip = C, TooltipContent = C, TooltipTrigger = C, TooltipProvider = C, Tip = C
export const ScrollArea = C, Streamdown = C, EmptyState = C, ErrorState = C, SearchField = C, Kbd = C, KbdGroup = C
export const Popover = C, PopoverContent = C, PopoverTrigger = C, CopyButton = C, Loader = C, LogView = C
export const SandboxedFrame = C, Separator = C, Checkbox = C, ConfirmDialog = C
export const useQuery = () => ({ data: undefined, isLoading: false })
export const useMutation = () => ({ mutate: () => {}, mutateAsync: async () => {} })
export const useQueryClient = () => ({ invalidateQueries: () => {} })
export const useTheme = () => ({})
export const haptic = () => {}
export const writeClipboardText = async () => {}
