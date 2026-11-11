// Gate over `hermes plugins validate --json` (stdin). Passes only when validation passed with no warning at all
// (the Desktop UI uses only the plugin SDK, catalog rule 8). Usage: hermes plugins validate <dir> --json | node <this>
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** {ok, lines[]} for a parsed report. Exported for tests. */
export function judge(report) {
  const lines = []
  let ok = !!(report && report.ok)
  for (const c of (report && report.checks) || []) if (!c.ok) lines.push(`✗ ${c.name}: ${c.detail}`)
  for (const w of (report && report.warnings) || []) {
    lines.push(`⚠ ${String(w)}`)
    ok = false
  }
  if (report && report.ok) lines.push('Validation passed.')
  else lines.push('Validation failed.')
  if (report && report.ok && !ok) lines.push('validate warnings are not allowed')
  return { ok, lines }
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
  const { ok, lines } = judge(report)
  console.log(lines.join('\n'))
  process.exit(ok ? 0 : 1)
}
