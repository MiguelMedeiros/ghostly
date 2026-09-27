import { closeSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A large MP4 made from the committed two-second fixture, for the checks that a video too large for the page plays
 * and seeks from the stored file (#381). CI has no ffmpeg and 100 MB is not committed, so the fixture's samples are
 * laid out `repeats` times with filler between the copies, and its tables (`stts`, `stss`, `stsc`, `stsz`, `stco`,
 * the durations) rewritten to match. The index stays at the front, the samples spread over the whole file: a seek
 * near the end reads near its end. Every copy starts with a key frame, so each is a place to seek to.
 */
export const BIG_VIDEO_SOURCES = {
  h264: fileURLToPath(new URL("./video-fixtures/ghosts-h264.mp4", import.meta.url)),
  /** VP9: what a WebKitGTK without an H.264 decoder (no gstreamer1.0-libav) still plays. */
  vp9: fileURLToPath(new URL("./video-fixtures/ghosts.mp4", import.meta.url)),
};

interface Box { type: string; start: number; size: number; header: number }

function children(buf: Buffer, start: number, end: number): Box[] {
  const out: Box[] = [];
  for (let at = start; at < end;) {
    let size = buf.readUInt32BE(at), header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(at + 8)); header = 16; }
    if (size < header || at + size > end) throw new Error(`Bad box at ${at}`);
    out.push({ type: buf.toString("latin1", at + 4, at + 8), start: at, size, header });
    at += size;
  }
  return out;
}

const CONTAINERS = new Set(["moov", "trak", "edts", "mdia", "minf", "stbl"]);

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

const u32 = (...values: number[]) => {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => out.writeUInt32BE(value, i * 4));
  return out;
};

export interface BigVideo { path: string; size: number; duration: number; repeats: number }

/** Writes the video to `path`: `repeats` copies of the fixture (2 s each), `size` bytes in all. */
export function makeBigVideo(path: string, { size = 100 * 1024 * 1024, repeats = 50, codec = "h264" as keyof typeof BIG_VIDEO_SOURCES } = {}): BigVideo {
  const src = readFileSync(BIG_VIDEO_SOURCES[codec]);
  const top = children(src, 0, src.length);
  const ftyp = top.find((b) => b.type === "ftyp")!;
  const moov = top.find((b) => b.type === "moov")!;
  const tracks = children(src, moov.start + moov.header, moov.start + moov.size).filter((b) => b.type === "trak");
  if (tracks.length !== 1) throw new Error("One video track expected");

  const find = (path: string[]): Box => {
    let boxes = children(src, moov.start + moov.header, moov.start + moov.size);
    let found: Box | undefined;
    for (const type of path) {
      found = boxes.find((b) => b.type === type);
      if (!found) throw new Error(`No ${path.join("/")}`);
      boxes = CONTAINERS.has(type) ? children(src, found.start + found.header, found.start + found.size) : [];
    }
    return found!;
  };
  const body = (b: Box) => src.subarray(b.start + b.header, b.start + b.size);
  const stbl = ["trak", "mdia", "minf", "stbl"];

  // The samples: one chunk in the fixture.
  const stco = body(find([...stbl, "stco"]));
  const stsc = body(find([...stbl, "stsc"]));
  if (stco.readUInt32BE(4) !== 1 || stsc.readUInt32BE(4) !== 1) throw new Error("One chunk expected");
  const stsz = body(find([...stbl, "stsz"]));
  const count = stsz.readUInt32BE(8);
  const sizes = stsz.readUInt32BE(4) ? Array<number>(count).fill(stsz.readUInt32BE(4)) : Array.from({ length: count }, (_, i) => stsz.readUInt32BE(12 + i * 4));
  const chunkStart = stco.readUInt32BE(8);
  const chunk = src.subarray(chunkStart, chunkStart + sizes.reduce((a, b) => a + b, 0));
  const stts = body(find([...stbl, "stts"]));
  const stss = body(find([...stbl, "stss"]));
  const keys = Array.from({ length: stss.readUInt32BE(4) }, (_, i) => stss.readUInt32BE(8 + i * 4));

  const scaled = (b: Box, offset: number) => {
    const out = Buffer.from(body(b));
    if (out[0] !== 0) throw new Error(`${b.type} version 1 not handled`);
    out.writeUInt32BE(out.readUInt32BE(offset) * repeats, offset);
    return out;
  };
  const sttsEntries: number[] = [];
  for (let r = 0; r < repeats; r++) for (let i = 0; i < stts.readUInt32BE(4); i++) sttsEntries.push(stts.readUInt32BE(8 + i * 8), stts.readUInt32BE(12 + i * 8));
  const leaves: Record<string, (b: Box) => Buffer> = {
    mvhd: (b) => scaled(b, 16),
    tkhd: (b) => scaled(b, 20),
    mdhd: (b) => scaled(b, 16),
    elst: (b) => scaled(b, 8),
    stts: () => Buffer.concat([u32(0, sttsEntries.length / 2), u32(...sttsEntries)]),
    stss: () => Buffer.concat([u32(0, keys.length * repeats), u32(...Array.from({ length: repeats }, (_, r) => keys.map((k) => k + r * count)).flat())]),
    stsc: () => u32(0, 1, 1, count, 1),
    stsz: () => Buffer.concat([u32(0, 0, count * repeats), u32(...Array<number[]>(repeats).fill(sizes).flat())]),
  };
  const rebuild = (b: Box, offsets: number[]): Buffer => {
    if (b.type === "stco") return box("stco", u32(0, offsets.length, ...offsets));
    if (CONTAINERS.has(b.type)) return box(b.type, ...children(src, b.start + b.header, b.start + b.size).map((c) => rebuild(c, offsets)));
    return leaves[b.type] ? box(b.type, leaves[b.type]!(b)) : src.subarray(b.start, b.start + b.size);
  };

  // The index's size does not depend on the offsets' values: build it once to measure, once for real.
  const moovSize = rebuild(moov, Array<number>(repeats).fill(0)).length;
  const head = ftyp.size + moovSize + 8;
  const stride = Math.floor((size - head) / repeats);
  if (stride < chunk.length) throw new Error("Too small for that many copies");
  const offsets = Array.from({ length: repeats }, (_, r) => head + r * stride);
  const index = rebuild(moov, offsets);
  const total = head + stride * repeats;

  const fd = openSync(path, "w");
  try {
    writeSync(fd, src.subarray(ftyp.start, ftyp.start + ftyp.size));
    writeSync(fd, index);
    writeSync(fd, u32(total - ftyp.size - index.length));
    writeSync(fd, Buffer.from("mdat", "latin1"));
    const filler = Buffer.alloc(stride - chunk.length);
    for (let r = 0; r < repeats; r++) { writeSync(fd, chunk); writeSync(fd, filler); }
  } finally {
    closeSync(fd);
  }
  if (statSync(path).size !== total) throw new Error("Wrote the wrong size");
  const mvhd = body(find(["mvhd"]));
  return { path, size: total, duration: (mvhd.readUInt32BE(16) * repeats) / mvhd.readUInt32BE(12), repeats };
}
