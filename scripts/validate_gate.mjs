// Gate over `hermes plugins validate --json` (stdin). Passes when validation passed and there is no warning —
// with ONE existing project-gate exception (not catalog-maintainer approval): a single "desktop surface review" warning whose
// only cue is `raw bridge window.hermesDesktop (desktop/plugin.js:<n>)`, where line <n> calls openWindow.
// Any other or additional warning keeps the gate red. Usage: hermes plugins validate <dir> --json | node <this>
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REVIEW = 'desktop surface review (catalog rule 8: SDK surface only): '
const BRIDGE = /^raw bridge window\.hermesDesktop \(desktop\/plugin\.js:(\d+)\)$/

/** {ok, lines[]} for a parsed report; `source` is desktop/plugin.js. Exported for tests. */
export function judge(report, source) {
  const lines = []
  let ok = !!(report && report.ok)
  for (const c of (report && report.checks) || []) if (!c.ok) lines.push(`✗ ${c.name}: ${c.detail}`)
  const warnings = (report && report.warnings) || []
  let allowed = null
  for (const w of warnings) {
    const text = String(w)
    if (allowed === null && text.startsWith(REVIEW)) {
      const cues = text.slice(REVIEW.length).replace(/\. Use ctx\.files[\s\S]*$/, '').split('; ')
      const m = cues.length === 1 ? BRIDGE.exec(cues[0]) : null
      const line = m ? String(source || '').split('\n')[Number(m[1]) - 1] || '' : ''
      if (m && line.includes('openWindow') && line.includes('hermesDesktop')) {
        allowed = Number(m[1])
        lines.push(`allowed: raw bridge for openWindow only (desktop/plugin.js:${allowed})`)
        continue
      }
    }
    lines.push(`⚠ ${text}`)
    ok = false
  }
  if (report && report.ok) lines.push('Validation passed.')
  else lines.push('Validation failed.')
  if (report && report.ok && !ok) lines.push('validate warnings are not allowed')
  return { ok, lines, allowed }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const raw = readFileSync(0, 'utf8')
  const start = raw.indexOf('{')
  let report = null
  try {
    report = JSON.parse(raw.slice(start))
  } catch {
    console.log(raw.trim())
    console.log('validate output is not JSON')
    process.exit(1)
  }
  const { ok, lines } = judge(report, readFileSync(join(ROOT, 'desktop', 'plugin.js'), 'utf8'))
  console.log(lines.join('\n'))
  process.exit(ok ? 0 : 1)
}
