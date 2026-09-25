// Builds Iroh for browsers (native-transports/iroh-web) into packages/iroh-web/pkg.
// The output is committed, so the web app, the extension and their Docker/CI
// builds need no Rust. Run it after changing the crate or bumping iroh:
//
//   node scripts/build-iroh-web.mjs
//
// wasm-bindgen's output is not byte-for-byte reproducible (the order of its
// exports varies between runs), so CI cannot rebuild and compare. Instead
// pkg/BUILD.json records a hash of the crate's sources and of the wasm, and
// scripts/test/irohWebBuild.test.ts fails when either no longer matches: a
// crate changed without a rebuild, or a pkg file edited by hand.
//
// Needs: the wasm32-unknown-unknown target, a clang that targets wasm32 (ring's
// C code; Apple's clang does not, Homebrew's llvm does: set CC_wasm32_unknown_unknown
// or have /opt/homebrew/opt/llvm), and wasm-bindgen-cli at the crate's pinned version.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { irohWebSourceHash } from './iroh-web-source.mjs'

const root = resolve(import.meta.dirname, '..')
const crate = join(root, 'native-transports/iroh-web')
const pkg = join(root, 'packages/iroh-web/pkg')

const manifest = readFileSync(join(crate, 'Cargo.toml'), 'utf8')
const bindgen = /wasm-bindgen = "=([\d.]+)"/.exec(manifest)?.[1]
const iroh = /iroh = \{ version = "=([\d.]+)"/.exec(manifest)?.[1]
const desktopIroh = /iroh = "=([\d.]+)"/.exec(readFileSync(join(root, 'native-transports/Cargo.toml'), 'utf8'))?.[1]
if (!bindgen || !iroh) throw new Error('Pin wasm-bindgen and iroh with "=" in native-transports/iroh-web/Cargo.toml')
if (iroh !== desktopIroh) throw new Error(`Browser iroh ${iroh} differs from the Desktop's ${desktopIroh}: bump both together`)

const run = (cmd, args, env = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...env } }).toString().trim()
const installed = run('wasm-bindgen', ['--version']).split(' ')[1]
if (installed !== bindgen) throw new Error(`wasm-bindgen ${installed} found, ${bindgen} needed: cargo install wasm-bindgen-cli --version ${bindgen} --locked`)

const clang = process.env.CC_wasm32_unknown_unknown
  ?? ['/opt/homebrew/opt/llvm/bin/clang', '/usr/local/opt/llvm/bin/clang'].find(existsSync)
  ?? 'clang'
const ar = process.env.AR_wasm32_unknown_unknown ?? clang.replace(/clang$/, 'llvm-ar')
const target = process.env.IROH_WEB_TARGET_DIR ?? join(root, 'target/iroh-web')
// Paths out of the binary, so a rebuild on another machine gives the same bytes.
const remap = [`--remap-path-prefix=${crate}=/iroh-web`, `--remap-path-prefix=${process.env.CARGO_HOME ?? join(process.env.HOME, '.cargo')}=/cargo`, `--remap-path-prefix=${root}=/ghostly`]
run('cargo', ['build', '--quiet', '--release', '--locked', '--target', 'wasm32-unknown-unknown', '--manifest-path', join(crate, 'Cargo.toml')], {
  CARGO_TARGET_DIR: target,
  CC_wasm32_unknown_unknown: clang,
  AR_wasm32_unknown_unknown: existsSync(ar) ? ar : 'llvm-ar',
  RUSTFLAGS: ['--cfg getrandom_backend="wasm_js"', ...remap].join(' '),
})

mkdirSync(pkg, { recursive: true })
run('wasm-bindgen', ['--target', 'web', '--out-dir', pkg, join(target, 'wasm32-unknown-unknown/release/ghostly_iroh_web.wasm')])

const wasm = readFileSync(join(pkg, 'ghostly_iroh_web_bg.wasm'))
const build = {
  iroh,
  wasmBindgen: bindgen,
  rustc: run('rustc', ['--version']),
  source: irohWebSourceHash(root),
  sha256: createHash('sha256').update(wasm).digest('hex'),
  bytes: wasm.length,
  gzipBytes: gzipSync(wasm, { level: 9 }).length,
}
writeFileSync(join(pkg, 'BUILD.json'), JSON.stringify(build, null, 2) + '\n')
console.log(`Built Iroh ${iroh} for browsers: ${(build.bytes / 1e6).toFixed(2)} MB wasm, ${(build.gzipBytes / 1e6).toFixed(2)} MB gzip`)
