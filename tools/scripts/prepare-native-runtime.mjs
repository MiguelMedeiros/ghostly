import { existsSync } from 'node:fs'
import { cp, copyFile, mkdir, chmod, readdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { nativeRuntimeFiles } from './native-runtime-files.mjs'
const source = resolve('native/transports/hyperdht')
const target = resolve('apps/desktop/native-runtime')
// Reproducible dependency graph; runtime matches the architecture building the
// desktop app. Cross compilation must provide a matching runtime separately.
// Node refuses to start a .cmd without a shell on Windows (EINVAL since its CVE-2024-27980 fix); the arguments are
// fixed here, so a shell is safe.
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: source, stdio: 'inherit', shell: process.platform === 'win32' })
// Our patches (tools/patches, which the root's postinstall applies to the root's packages) apply to this graph too:
// the ones for packages it has (hyperdht's nat.js), since patch-package fails on a patch whose package is missing.
const patches = resolve(source, 'node_modules/.ghostly-patches')
await rm(patches, { recursive: true, force: true })
await mkdir(patches)
for (const name of await readdir('tools/patches')) {
  const pkg = /^(.+)\+[^+]+\.patch$/.exec(name)?.[1].replaceAll('+', '/')
  if (pkg && existsSync(resolve(source, 'node_modules', pkg))) await copyFile(resolve('tools/patches', name), resolve(patches, name))
}
execFileSync(process.execPath, [resolve('node_modules/patch-package/index.js'), '--patch-dir', 'node_modules/.ghostly-patches', '--error-on-fail'], { cwd: source, stdio: 'inherit' })
await rm(patches, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await copyFile(process.execPath, resolve(target, process.platform === 'win32' ? 'node.exe' : 'node'))
await chmod(resolve(target, process.platform === 'win32' ? 'node.exe' : 'node'), 0o755)
for (const name of nativeRuntimeFiles(source)) await copyFile(resolve(source, name), resolve(target, name))
await rm(resolve(target, 'node_modules'), { recursive: true, force: true })
// Native addons ship prebuilt binaries for every platform (prebuilds/android-arm64, ios-arm64, win32-x64...).
// Only this platform's are copied: the others are dead weight in the app, and the AppImage's linuxdeploy
// runs ldd on every ELF file it finds and aborts on the Android ones ("Failed to run ldd").
const platform = `${process.platform}-${process.arch}`
const foreignPrebuild = path => {
  const dir = /[\\/]prebuilds[\\/]([^\\/]+)/.exec(path)?.[1]
  return dir !== undefined && dir !== platform && !dir.startsWith(`${platform}-`)
}
await cp(resolve(source, 'node_modules'), resolve(target, 'node_modules'), { recursive: true, verbatimSymlinks: true, filter: path => !path.includes('/.bin') && !foreignPrebuild(path) })
console.log(`Prepared HyperDHT runtime for ${process.platform}-${process.arch}`)
