// What packages/iroh-web/pkg is built from: its hash goes in pkg/BUILD.json (tools/scripts/build-iroh-web.mjs),
// and tools/scripts/test/irohWebBuild.test.ts compares it with the sources as they are now.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function irohWebSourceHash(root) {
  const crate = join(root, 'native/transports/iroh-web')
  const files = ['Cargo.toml', 'Cargo.lock', ...readdirSync(join(crate, 'src')).sort().map((name) => `src/${name}`)]
  const hash = createHash('sha256')
  // Line endings normalised: a checkout on Windows hashes the same.
  for (const file of files) hash.update(`${file}\n`).update(readFileSync(join(crate, file), 'utf8').replace(/\r\n/g, '\n'))
  return hash.digest('hex')
}

// A text file of pkg as wasm-bindgen wrote it, line endings normalised like the sources'.
export function irohWebFileHash(path) {
  return createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).digest('hex')
}
