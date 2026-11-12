// JS unit tests for desktop/plugin.js without the app: imports are swapped for stubs, then every
// tests/js/*.test.mjs runs against the plugin's pure helpers (default export `_internals`).
// Usage: node tests/js/run.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { run } from 'node:test'
import { spec } from 'node:test/reporters'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const defaultCacheBase = process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
const cache = join(process.env.ARACHNE_FLOW_CACHE || join(defaultCacheBase, 'hermes', 'cache', 'arachne-flow-dev'), 'js')
mkdirSync(cache, { recursive: true })

const stubs = {
  '@hermes/plugin-sdk': 'sdk-stub.mjs',
  'react/jsx-runtime': 'jsx-stub.mjs',
  react: 'react-stub.mjs'
}
for (const file of Object.values(stubs)) writeFileSync(join(cache, file), readFileSync(join(here, 'stubs', file)))

let source = readFileSync(join(root, 'desktop', 'plugin.js'), 'utf8')
for (const [spec_, file] of Object.entries(stubs)) {
  const re = new RegExp(`(from\\s*)(['"])${spec_.replace(/[/.@-]/g, (c) => '\\' + c)}\\2`, 'g')
  source = source.replace(re, `$1$2./${file}$2`)
}
writeFileSync(join(cache, 'plugin.under-test.mjs'), source)

const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).map((f) => join(here, f))
let failed = false
const stream = run({ files, concurrency: false })
stream.on('test:fail', () => { failed = true })
stream.compose(spec).pipe(process.stdout)
stream.on('end', () => { process.exitCode = failed ? 1 : 0 })
