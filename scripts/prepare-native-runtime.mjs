import { cp, copyFile, mkdir, chmod, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
const source = resolve('native-transports/hyperdht')
const target = resolve('src-tauri/native-runtime')
// Reproducible dependency graph; runtime matches the architecture building the
// desktop app. Cross compilation must provide a matching runtime separately.
// Node refuses to start a .cmd without a shell on Windows (EINVAL since its CVE-2024-27980 fix); the arguments are
// fixed here, so a shell is safe.
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: source, stdio: 'inherit', shell: process.platform === 'win32' })
await mkdir(target, { recursive: true })
await copyFile(process.execPath, resolve(target, process.platform === 'win32' ? 'node.exe' : 'node'))
await chmod(resolve(target, process.platform === 'win32' ? 'node.exe' : 'node'), 0o755)
for (const name of ['endpoint.mjs', 'sidecar.mjs', 'package.json', 'package-lock.json']) await copyFile(resolve(source, name), resolve(target, name))
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
