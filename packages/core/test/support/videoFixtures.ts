import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Videos that say where they were recorded, built from the e2e H.264 fixture: a `udta/©xyz` (Android's MediaMuxer,
 * older iPhones) and a timed metadata track whose sample holds the place (an iPhone's `mebx` location track).
 */
export const PLACE = "+52.3700+004.8900+000.000/";
export const H264_MP4 = readFileSync(fileURLToPath(new URL("../../../../e2e/support/video-fixtures/ghosts-h264.mp4", import.meta.url)));

export const hasPlace = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(Buffer.from(PLACE, "latin1"));

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
export const box = (type: string, ...parts: Buffer[]): Buffer<ArrayBuffer> => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, "latin1"), body]);
};
const full = (type: string, flags: number, ...parts: Buffer[]) => box(type, u32(flags), ...parts);

/** `udta` with a `©xyz`, as MediaMuxer writes it. */
export const xyzUdta = () => {
  const place = Buffer.from(PLACE, "latin1");
  return box("udta", box("\xa9xyz", u16(place.length), u16(0x15c7), place));
};

/**
 * A timed metadata track (`meta` handler, `mebx` entry) with one sample of `length` bytes at `offset` in the file, or
 * a track of another `handler` so made.
 */
export const metadataTrack = (offset: number, length: number, handler = "meta") => box("trak",
  full("tkhd", 1, Buffer.alloc(80)),
  box("mdia",
    full("mdhd", 0, Buffer.alloc(8), u32(1000), u32(1000), Buffer.alloc(4)),
    full("hdlr", 0, u32(0), Buffer.from(handler, "latin1"), Buffer.alloc(12), Buffer.from("Core Media Metadata\0", "latin1")),
    box("minf",
      full("nmhd", 0),
      box("dinf", full("dref", 0, u32(1), full("url ", 1))),
      box("stbl",
        full("stsd", 0, u32(1), box("mebx", Buffer.alloc(6), u16(1), box("keys"))),
        full("stts", 0, u32(1), u32(1), u32(1000)),
        full("stsc", 0, u32(1), u32(1), u32(1), u32(1)),
        full("stsz", 0, u32(0), u32(1), u32(length)),
        full("stco", 0, u32(1), u32(offset))))));

/** The children of `box`'s at `start`..`end`, as [type, start, body, end]. */
function children(b: Buffer, start: number, end: number): [string, number, number, number][] {
  const out: [string, number, number, number][] = [];
  for (let at = start; at + 8 <= end;) {
    const size = b.readUInt32BE(at);
    out.push([b.toString("latin1", at + 4, at + 8), at, at + 8, at + size]);
    at += size;
  }
  return out;
}

/** Every chunk offset in `moov` (at `start`..`end`) moved by `delta`. */
function shiftChunks(b: Buffer, start: number, end: number, delta: number): void {
  for (const [type, , body, until] of children(b, start, end)) {
    if (["trak", "mdia", "minf", "stbl"].includes(type)) shiftChunks(b, body, until, delta);
    else if (type === "stco") for (let i = 0; i < b.readUInt32BE(body + 4); i++) b.writeUInt32BE(b.readUInt32BE(body + 8 + i * 4) + delta, body + 8 + i * 4);
    else if (type === "co64") for (let i = 0; i < b.readUInt32BE(body + 4); i++) b.writeBigUInt64BE(b.readBigUInt64BE(body + 8 + i * 8) + BigInt(delta), body + 8 + i * 8);
  }
}

/**
 * `file` with `extra` boxes added at the end of its `moov` (its samples' offsets moved where `moov` comes before them)
 * and, with `sample`, a metadata track (or a track of another `handler`) whose one sample it is, in a `mdat` added at
 * the end of the file.
 */
export function withMovie(file: Buffer, extra: Buffer[], sample?: Buffer, handler = "meta"): Buffer<ArrayBuffer> {
  const top = children(file, 0, file.length);
  const [, at, , end] = top.find(([type]) => type === "moov")!;
  const added = extra.reduce((sum, b) => sum + b.length, 0) + (sample ? metadataTrack(0, 0).length : 0);
  const moov = Buffer.from(file.subarray(at, end));
  if (top.some(([type, start]) => type === "mdat" && start > at)) shiftChunks(moov, 8, moov.length, added);
  const track = sample ? [metadataTrack(file.length + added + 8, sample.length, handler)] : [];
  const grown = Buffer.concat([moov, ...extra, ...track]);
  grown.writeUInt32BE(grown.length, 0);
  return Buffer.concat([file.subarray(0, at), grown, file.subarray(end), ...(sample ? [box("mdat", sample)] : [])]);
}

/** `file` with `extra` boxes added at the end of its first `trak` (its samples' offsets moved where `moov` comes before them). */
export function withTrack(file: Buffer, extra: Buffer[]): Buffer<ArrayBuffer> {
  const top = children(file, 0, file.length);
  const [, at, , end] = top.find(([type]) => type === "moov")!;
  const moov = Buffer.from(file.subarray(at, end));
  const [, trakAt, , trakEnd] = children(moov, 8, moov.length).find(([type]) => type === "trak")!;
  const trak = Buffer.concat([moov.subarray(trakAt, trakEnd), ...extra]);
  trak.writeUInt32BE(trak.length, 0);
  const grown = Buffer.concat([moov.subarray(0, trakAt), trak, moov.subarray(trakEnd)]);
  grown.writeUInt32BE(grown.length, 0);
  if (top.some(([type, start]) => type === "mdat" && start > at)) shiftChunks(grown, 8, grown.length, grown.length - moov.length);
  return Buffer.concat([file.subarray(0, at), grown, file.subarray(end)]);
}

/** `file` with `first` put before its first box (a tool's `uuid`, a QuickTime preview), its samples' offsets moved. */
export function withFirst(file: Buffer, first: Buffer): Buffer<ArrayBuffer> {
  const [, at, , end] = children(file, 0, file.length).find(([type]) => type === "moov")!;
  const moov = Buffer.from(file.subarray(at, end));
  shiftChunks(moov, 8, moov.length, first.length);
  return Buffer.concat([first, file.subarray(0, at), moov, file.subarray(end)]);
}

/**
 * When a movie says it was made, as a player reads it (ffprobe's `creation_time`, exiftool's `CreateDate`,
 * `TrackCreateDate`, `MediaCreateDate`): each `mvhd`, `tkhd` and `mdhd` in its `moov`, with its version and its
 * creation and modification times (seconds since 1904).
 */
export function headerTimes(b: Buffer): { type: string; version: number; created: number; modified: number }[] {
  const out: { type: string; version: number; created: number; modified: number }[] = [];
  const walk = (start: number, end: number) => {
    for (const [type, , body, until] of children(b, start, end)) {
      if (["moov", "trak", "mdia"].includes(type)) walk(body, until);
      else if (["mvhd", "tkhd", "mdhd"].includes(type)) {
        const version = b[body]!;
        const created = version === 1 ? Number(b.readBigUInt64BE(body + 4)) : b.readUInt32BE(body + 4);
        const modified = version === 1 ? Number(b.readBigUInt64BE(body + 12)) : b.readUInt32BE(body + 8);
        out.push({ type, version, created, modified });
      }
    }
  };
  walk(0, b.length);
  return out;
}
