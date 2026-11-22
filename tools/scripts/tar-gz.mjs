import { execFileSync } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

/**
 * Packs the folder `dir` into the .tar.gz `out`, the same bytes from the same files on every build: the Desktop app
 * pins the translation runtime's SHA-256 (tools/scripts/prepare-translation-runtime.mjs), and anyone can rebuild that
 * archive from its tag to check it. `tar -czf` wrote the copy time and the build user into each header, so two builds
 * of one commit never matched. Written here rather than with tar's flags, which GNU tar and bsdtar (macOS, Windows)
 * spell differently: entries in name order, each folder before its files, every time `mtime`, owner 0:0 with no
 * names, mode 755 for folders and executables and 644 for the rest, and gzip's header without a time. Names over 100
 * bytes or outside ASCII go in a pax header, which both tars read. The deflate bytes are those of Node's own zlib:
 * a rebuild uses the Node version the release build ran.
 */
export async function packTarGz(dir, out, { mtime }) {
  await pipeline(Readable.from(tarBlocks(dir, mtime)), createGzip({ level: 9 }), createWriteStream(out))
}

/** SOURCE_DATE_EPOCH when the build sets one, or else the time of the commit checked out in `cwd`. */
export function sourceDateEpoch(cwd) {
  const time = process.env.SOURCE_DATE_EPOCH || execFileSync('git', ['log', '-1', '--format=%ct'], { cwd, encoding: 'utf8' })
  const seconds = Number(time.trim())
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error(`Not a time in seconds: ${time}`)
  return seconds
}

const BLOCK = 512

async function* tarBlocks(dir, mtime) {
  for await (const { path, name, kind, mode, size } of walk(dir, basename(dir))) {
    yield* header(kind === 'dir' ? `${name}/` : name, { kind, mode, size, mtime })
    if (kind === 'dir') continue
    let read = 0
    for await (const chunk of createReadStream(path)) {
      read += chunk.length
      yield chunk
    }
    if (read !== size) throw new Error(`${path} changed while it was packed`)
    yield padding(size)
  }
  yield Buffer.alloc(2 * BLOCK)
}

/** The folder and everything in it, folders first, each folder's entries in the order of their names' code units. */
async function* walk(path, name) {
  const stats = await lstat(path)
  if (stats.isDirectory()) {
    yield { path, name, kind: 'dir', mode: 0o755, size: 0 }
    const children = (await readdir(path)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    for (const child of children) yield* walk(join(path, child), `${name}/${child}`)
  } else if (stats.isFile()) {
    yield { path, name, kind: 'file', mode: stats.mode & 0o100 ? 0o755 : 0o644, size: stats.size }
  } else {
    throw new Error(`${path}: only files and folders are packed`)
  }
}

function* header(name, { kind, mode, size, mtime }) {
  const bytes = Buffer.from(name, 'utf8')
  const plain = bytes.length <= 100 && /^[\x20-\x7e]*$/.test(name)
  if (!plain) {
    const record = paxRecord('path', name)
    yield ustar({ name: Buffer.from('PaxHeader'), type: 'x', mode: 0o644, size: record.length, mtime })
    yield record
    yield padding(record.length)
  }
  // Behind a pax header, the first 100 bytes of the name only show what the entry is to a tar that ignores pax.
  yield ustar({ name: bytes, type: kind === 'dir' ? '5' : '0', mode, size, mtime })
}

/** `<length> <key>=<value>\n`, the length counting itself. */
function paxRecord(key, value) {
  const rest = Buffer.byteLength(` ${key}=${value}\n`)
  let length = rest + String(rest).length
  if (String(length).length !== String(rest).length) length = rest + String(length).length
  return Buffer.from(`${length} ${key}=${value}\n`, 'utf8')
}

function ustar({ name, type, mode, size, mtime }) {
  const block = Buffer.alloc(BLOCK)
  name.copy(block, 0, 0, 100)
  octal(block, 100, 8, mode)
  octal(block, 108, 8, 0)
  octal(block, 116, 8, 0)
  octal(block, 124, 12, size)
  octal(block, 136, 12, mtime)
  block.write(type, 156, 1, 'ascii')
  block.write('ustar\u000000', 257, 8, 'ascii')
  // uname, gname, devmajor, devminor and prefix stay empty.
  block.fill(' ', 148, 156)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\u0000 `, 148, 8, 'ascii')
  return block
}

function octal(block, at, length, value) {
  const digits = value.toString(8).padStart(length - 1, '0')
  if (digits.length > length - 1) throw new Error(`${value} does not fit a tar header field of ${length} bytes`)
  block.write(`${digits}\u0000`, at, length, 'ascii')
}

const padding = size => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK)
