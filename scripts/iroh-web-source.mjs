// What packages/iroh-web/pkg is built from: its hash goes in pkg/BUILD.json (scripts/build-iroh-web.mjs),
// and scripts/test/irohWebBuild.test.ts compares it with the sources as they are now.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function irohWebSourceHash(root) {
  const crate = join(root, 'native-transports/iroh-web')
  const files = ['Cargo.toml', 'Cargo.lock', ...readdirSync(join(crate, 'src')).sort().map((name) => `src/${name}`)]
  const hash = createHash('sha256')
  // Line endings normalised: a checkout on Windows hashes the same.
  for (const file of files) hash.update(`${file}\n`).update(readFileSync(join(crate, file), 'utf8').replace(/\r\n/g, '\n'))
  return hash.digest('hex')
}
