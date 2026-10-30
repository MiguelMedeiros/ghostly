import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { nativeRuntimeFiles } from './native-runtime-files.mjs'

/**
 * Builds the translation runtime of this platform (native/translation: `bare` + QVAC's Bergamot addon + the stdio
 * script) into native/translation/dist/ghostly-translation-runtime-<version>-<platform>/, and packs it as a .tar.gz
 * beside it with its SHA-256. It is not part of the Desktop bundle: the app downloads that archive with the first
 * language model, and checks it against the SHA-256 it pins. Cross builds are not supported: each platform's runner
 * builds its own, as for native-runtime/ (prepare-native-runtime.mjs).
 */
const source = resolve('native/translation')
const platform = `${process.platform}-${process.arch}`
const { version } = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'))
const name = `ghostly-translation-runtime-${version}-${platform}`
const dist = resolve(source, 'dist')
const target = resolve(dist, name)

// Node refuses to start a .cmd without a shell on Windows (EINVAL since its CVE-2024-27980 fix); the arguments are
// fixed here, so a shell is safe. No package of this graph has an install script.
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: source, stdio: 'inherit', shell: process.platform === 'win32' })

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
// The `bare` binary of this platform, from bare-runtime's package for it, at the top of the folder.
const bare = process.platform === 'win32' ? 'bare.exe' : 'bare'
await copyFile(createRequire(resolve(source, 'package.json'))('bare-runtime')(), resolve(target, bare))
await chmod(resolve(target, bare), 0o755)
for (const file of nativeRuntimeFiles(source, 'runtime.mjs')) await copyFile(resolve(source, file), resolve(target, file))

/**
 * What the runtime never loads, left out of the archive:
 * - other platforms' prebuilds, and the fabric's headers and CMake files (prebuilds/include, prebuilds/share);
 * - the fabric's GPU and RPC backends (CUDA, HIP, Vulkan... 310 MB on Linux): Bergamot runs on the CPU only;
 * - bare-runtime's packages: their binary is the `bare` copied above.
 */
const GPU_BACKEND = /[\\/][^\\/]*ggml-(cuda|hip|vulkan|opencl|metal|rpc|sycl|musa|cann|kompute)[^\\/]*$/i
const foreignPrebuild = path => {
  const dir = /[\\/]prebuilds[\\/]([^\\/]+)/.exec(path)?.[1]
  return dir !== undefined && dir !== platform && !dir.startsWith(`${platform}-`)
}
const unused = path => /[\\/]\.bin([\\/]|$)/.test(path) || foreignPrebuild(path) || GPU_BACKEND.test(path) || /[\\/]node_modules[\\/]bare-runtime(-[^\\/]+)?([\\/]|$)/.test(path)
await cp(resolve(source, 'node_modules'), resolve(target, 'node_modules'), { recursive: true, verbatimSymlinks: true, filter: path => !unused(path) })

const archive = `${name}.tar.gz`
await rm(resolve(dist, archive), { force: true })
// tar is on every runner (bsdtar on Windows and macOS, GNU tar on Linux); relative names keep a drive letter out of it.
execFileSync('tar', ['-czf', archive, name], { cwd: dist, stdio: 'inherit' })
const hash = createHash('sha256')
for await (const chunk of createReadStream(resolve(dist, archive))) hash.update(chunk)
const sha256 = hash.digest('hex')
await writeFile(resolve(dist, `${archive}.sha256`), `${sha256}  ${archive}\n`)
const { size } = await stat(resolve(dist, archive))
console.log(`Prepared the translation runtime for ${platform}: native/translation/dist/${archive}, ${(size / 1e6).toFixed(1)} MB, sha256 ${sha256}`)
