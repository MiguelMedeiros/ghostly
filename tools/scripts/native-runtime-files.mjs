import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** `import … from './x.mjs'`, `import './x.mjs'`, `import('./x.mjs')` and `export … from './x.mjs'`. */
const RELATIVE_IMPORT = /\b(?:import|export)\s*(?:[^'"()]*?\bfrom\s*)?\(?\s*['"](\.\/[^'"]+)['"]/g

/**
 * The files of native/transports/hyperdht the Desktop app ships (tools/scripts/prepare-native-runtime.mjs): the
 * package files and every module sidecar.mjs reaches by a relative import. A fixed list missed redial.mjs once, and
 * the Desktop's sidecar then failed to start, so the app had no HyperDHT (bug hunt r11h). The translation runtime
 * (tools/scripts/prepare-translation-runtime.mjs) is copied the same way from its own `entry`.
 */
export function nativeRuntimeFiles(source, entry = 'sidecar.mjs') {
  const modules = new Set()
  const visit = name => {
    if (modules.has(name)) return
    if (name.includes('/')) throw new Error(`${name}: the native runtime is copied flat; keep its modules beside ${entry}`)
    modules.add(name)
    for (const [, path] of readFileSync(resolve(source, name), 'utf8').matchAll(RELATIVE_IMPORT)) visit(path.slice(2))
  }
  visit(entry)
  return ['package.json', 'package-lock.json', ...[...modules].sort()]
}
