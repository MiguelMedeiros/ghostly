#!/usr/bin/env node
/**
 * The press kit: public/brand/ghostly-press-kit/ (every file, which the /brand page links one by one) and
 * public/brand/ghostly-press-kit.zip (all of them). Built from lib/brand (brand.json) on every build and dev start
 * (prebuild, predev), never committed: change brand.json and the kit follows.
 *
 * PNGs are rendered from the same SVGs with sharp (in node_modules through Next, prebuilt for the Alpine image too).
 * The zip is written here (deflate from node:zlib, fixed dates), so the same sources give the same bytes.
 *
 *   node scripts/brand-kit.mjs          write the kit
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import sharp from "sharp";
import { KIT_DIR, KIT_ZIP, kitEntries } from "../lib/brand/kit.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public/brand");

/** An SVG at an exact pixel height, transparent around the shape. */
export async function renderPng(svg, height) {
  const h = Number(/height="([\d.]+)"/.exec(svg)[1]);
  return sharp(Buffer.from(svg), { density: (72 * height) / h })
    .resize({ height })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Every entry's bytes, in the kit's order. */
export async function kitFiles(root = ROOT) {
  const files = [];
  for (const e of kitEntries()) {
    let data;
    if (e.text !== undefined) data = Buffer.from(e.text, "utf8");
    else if (e.bytes) data = e.bytes;
    else if (e.png) data = await renderPng(e.png.svg, e.png.height);
    else data = readFileSync(join(root, e.copy));
    files.push({ path: e.path, data });
  }
  return files;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of `files` ({path, data}), deflated, every entry dated 2026-10-13 so the bytes depend on the content only. */
export function zip(files) {
  const DATE = ((2026 - 1980) << 9) | (10 << 5) | 13;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { path, data } of files) {
    const name = Buffer.from(path, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const store = packed.length >= data.length;
    const body = store ? data : packed;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = await kitFiles();
  rmSync(OUT, { recursive: true, force: true });
  for (const { path, data } of files) {
    const to = join(OUT, KIT_DIR, path);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, data);
  }
  const archive = zip(files.map((f) => ({ path: `${KIT_DIR}/${f.path}`, data: f.data })));
  writeFileSync(join(OUT, KIT_ZIP), archive);
  console.log(`brand kit: ${files.length} files, ${KIT_ZIP} ${(archive.length / 1024).toFixed(0)} KB in public/brand/`);
}
