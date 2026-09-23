import { cp, copyFile, mkdir, chmod, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
const source = resolve('native-transports/hyperdht')
const target = resolve('src-tauri/native-runtime')
// Reproducible dependency graph; runtime matches the architecture building the
// desktop app. Cross compilation must provide a matching runtime separately.
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: source, stdio: 'inherit' })
await mkdir(target, { recursive: true })
await copyFile(process.execPath, resolve(target, process.platform === 'win32' ? 'node.exe' : 'node'))
await chmod(resolve(target, process.platform === 'win32' ? 'node.exe' : 'node'), 0o755)
for (const name of ['endpoint.mjs', 'sidecar.mjs', 'package.json', 'package-lock.json']) await copyFile(resolve(source, name), resolve(target, name))
await rm(resolve(target, 'node_modules'), { recursive: true, force: true })
await cp(resolve(source, 'node_modules'), resolve(target, 'node_modules'), { recursive: true, verbatimSymlinks: true, filter: path => !path.includes('/.bin') })
console.log(`Prepared HyperDHT runtime for ${process.platform}-${process.arch}`)
