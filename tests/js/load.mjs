// Helper for *.test.mjs: the plugin module as transformed by run.mjs.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const defaultCacheBase = process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
const cache = join(process.env.FLOWCANVAS_CACHE || join(defaultCacheBase, 'hermes', 'cache', 'flowcanvas-dev'), 'js')
/** The SDK stub instance the plugin under test imported (same module URL, so same `host`). */
export async function loadSdkStub() {
  return import(pathToFileURL(join(cache, 'sdk-stub.mjs')).href)
}
export async function loadReactStub() {
  return import(pathToFileURL(join(cache, 'react-stub.mjs')).href)
}
export async function loadPlugin() {
  const mod = await import(pathToFileURL(join(cache, 'plugin.under-test.mjs')).href)
  return mod.default
}
