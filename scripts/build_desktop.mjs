#!/usr/bin/env node
// Builds desktop/plugin.js from desktop/src/*.js (joined in file-name order, byte for byte).
//
// Hermes Desktop evaluates the page from a blob: URL, so the shipped page must stay ONE file that imports only
// the plugin SDK and React. The sources are split by area for review and editing; they share one module scope
// (no imports between them), so joining is the whole build. No dependencies.
//
//   node scripts/build_desktop.mjs          write desktop/plugin.js
//   node scripts/build_desktop.mjs --check  exit 1 when desktop/plugin.js is not the build of desktop/src
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'desktop', 'src')
const out = join(root, 'desktop', 'plugin.js')

const parts = readdirSync(srcDir).filter((f) => /^\d\d-[\w-]+\.js$/.test(f)).sort()
if (!parts.length) {
  console.error('build_desktop: no desktop/src/NN-name.js files')
  process.exit(1)
}
for (const f of parts.slice(1)) {
  const text = readFileSync(join(srcDir, f), 'utf8')
  if (/^\s*import\s/m.test(text)) {
    console.error(`build_desktop: ${f} has an import; only 00-core.js may import (one module scope)`)
    process.exit(1)
  }
}
const built = Buffer.concat(parts.map((f) => readFileSync(join(srcDir, f))))

if (process.argv.includes('--check')) {
  const current = existsSync(out) ? readFileSync(out) : Buffer.alloc(0)
  if (!current.equals(built)) {
    console.error('build_desktop: desktop/plugin.js is out of date or edited directly; edit desktop/src/*.js and run ' +
      'node scripts/build_desktop.mjs')
    process.exit(1)
  }
  console.log(`ok (${parts.length} parts, ${built.length} bytes)`)
} else {
  writeFileSync(out, built)
  console.log(`desktop/plugin.js <- ${parts.length} parts (${built.length} bytes)`)
}
