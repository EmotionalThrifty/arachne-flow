// Review U-11 (C5b): the plugin's CSS must take shadows and ink from the app's theme variables instead of
// hardcoded black/white. Reads desktop/plugin.js as text, extracts the one `<style>` payload (the `CSS`
// template literal) and checks every colour literal outside a `var(--x, …)` fallback.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE = readFileSync(join(root, 'desktop', 'plugin.js'), 'utf8')

/** The CSS template literal (`const CSS = \`…\``), the only stylesheet the page root renders. */
export function extractCss(source) {
  const start = source.indexOf('const CSS = `')
  assert.ok(start >= 0, 'const CSS = `…` not found in desktop/plugin.js')
  const from = start + 'const CSS = `'.length
  const end = source.indexOf('`', from)
  assert.ok(end > from, 'unterminated CSS template literal')
  return source.slice(from, end)
}

/**
 * Drop every `var(--x, fallback)` fallback, keeping `var(--x)`. A var() fallback may itself contain commas
 * and nested var()/color functions, so this walks balanced parentheses instead of using a regex.
 */
export function stripVarFallbacks(css) {
  let out = ''
  let i = 0
  for (;;) {
    const at = css.indexOf('var(', i)
    if (at < 0) return out + css.slice(i)
    out += css.slice(i, at)
    let depth = 0
    let j = at + 3
    for (; j < css.length; j += 1) {
      if (css[j] === '(') depth += 1
      else if (css[j] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const inner = css.slice(at + 4, j)
    let split = -1
    for (let k = 0, d = 0; k < inner.length; k += 1) {
      if (inner[k] === '(') d += 1
      else if (inner[k] === ')') d -= 1
      else if (inner[k] === ',' && d === 0) { split = k; break }
    }
    out += `var(${(split < 0 ? inner : inner.slice(0, split)).trim()})`
    i = j + 1
  }
}

const BANNED = [
  [/rgba?\(\s*0\s*,\s*0\s*,\s*0/i, 'hardcoded rgba(0, 0, 0, …) black'],
  [/rgba?\(\s*255\s*,\s*255\s*,\s*255/i, 'hardcoded rgba(255, 255, 255, …) white'],
  [/#000(?:000)?\b/i, 'hardcoded #000'],
  [/#fff(?:fff)?\b/i, 'hardcoded #fff'],
  [/\bwhite(?![-a-z])/i, 'bare `white`'],
  [/\bblack(?![-a-z])/i, 'bare `black`']
]

const offences = (css) => {
  const hits = []
  for (const [re, label] of BANNED) {
    for (const m of css.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
      const line = css.slice(0, m.index).split('\n').length
      const rule = css.slice(css.lastIndexOf('}', m.index) + 1, m.index).trim().split('\n').pop()
      hits.push(`${label} at CSS line ${line} (${rule.slice(0, 90)})`)
    }
  }
  return hits
}

test('CSS is extracted from desktop/plugin.js', () => {
  const css = extractCss(SOURCE)
  assert.ok(css.length > 5000, `CSS looks truncated (${css.length} chars)`)
  assert.ok(css.includes('.fc-root'), 'CSS has no .fc-root rule')
  assert.ok(!css.includes('</style>'), 'CSS must not contain a closing style tag')
})

test('stripVarFallbacks keeps names and drops fallbacks (nested commas included)', () => {
  assert.equal(stripVarFallbacks('var(--a)'), 'var(--a)')
  assert.equal(stripVarFallbacks('var(--shadow-md, 0 0 0 1px var(--ui-stroke), 0 9px 30px rgba(0,0,0,.4))'), 'var(--shadow-md)')
  assert.equal(stripVarFallbacks('a: var(--x, var(--y, #000)); b: 1'), 'a: var(--x); b: 1')
})

test('no hardcoded black/white colour outside a var() fallback', () => {
  // the one deliberate exception: the modal scrim mirrors the app's DialogOverlay (bg-black/22), see below
  const css = extractCss(SOURCE).replace(/(\.fc-modal-scrim\s*\{[^}]*?)color-mix\(in srgb, #000 22%, transparent\)/, '$1APP_SCRIM')
  const hits = offences(stripVarFallbacks(css))
  assert.deepEqual(hits, [], `${hits.length} hardcoded colour(s) left in the CSS:\n` + hits.join('\n'))
})

test('shadows come from the app theme shadow scale', () => {
  const css = extractCss(SOURCE)
  const uses = css.match(/var\(--shadow-(?:xs|sm|md|lg|nous)\b/g) || []
  assert.ok(uses.length >= 10, `expected the theme shadow scale to drive the box-shadows, found ${uses.length} use(s)`)
})

test('the modal scrim dims like the app\'s own dialog overlay (black 22 %), in light and dark themes', () => {
  // The app defines no scrim token; its DialogOverlay uses bg-black/22. A surface-coloured veil would not dim
  // at all in the light theme, so this one rule mirrors the app instead of a theme variable.
  const css = extractCss(SOURCE)
  const rule = css.match(/\.fc-modal-scrim\s*\{([^}]*)\}/)
  assert.ok(rule, '.fc-modal-scrim rule not found')
  assert.match(rule[1], /background:\s*color-mix\(in srgb, #000 22%, transparent\)/)
})

test('run log text can be selected and copied (harness 07.11.)', () => {
  const css = extractCss(SOURCE)
  assert.match(css, /\.fc-log-body[^{]*\{[^}]*user-select:\s*text/, '.fc-log-body must allow text selection')
})
