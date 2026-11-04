/**
 * What a video leaves with. An MP4 or QuickTime file says more than its frames: its `udta` and `meta` boxes hold where
 * it was recorded (`©xyz`, `com.apple.quicktime.location.ISO6709`), the device, often its software; a timed metadata
 * track (an iPhone's location and motion, a GoPro's GPS) holds them sample by sample; the movie's, each track's and
 * each track's media header (`mvhd`, `tkhd`, `mdhd`) say when it was recorded, to the second, and a camera's timecode
 * track the time of day. The sender removes them before the file is stored and its digest computed, without decoding
 * or re-encoding a frame: each such box becomes a `free` box of the same size, zeroed, the headers' creation and
 * modification times are zeroed (0 is "unknown"), and each metadata and timecode track's samples are zeroed where they
 * are, so no offset in the file moves and it plays as it did. Only the boxes' headers, `moov` and `moof` are read; the
 * media goes untouched.
 *
 * Fail-closed: a file that is an MP4 or QuickTime video, by its bytes or by its type, and whose metadata cannot be
 * removed (truncated, malformed, a part this does not know) is refused with `NO_VIDEO_METADATA`, never sent as it was.
 * A picture (HEIF is pictureMetadata.ts's), a file without a video track (an M4A) and any other file go as they are.
 */
import { isStrippedPicture } from "./pictureMetadata";

export const VIDEO_METADATA_LIMITS = {
  /** The largest `moov` or `moof` read whole, and the most bytes of a metadata track's chunk: past this the video is refused. */
  maxBoxBytes: 64 * 1024 * 1024,
  /** The most top-level boxes walked (a fragmented MP4 has two per fragment). */
  maxBoxes: 100_000,
  /** Bytes read first to tell a video from another file. */
  headBytes: 64,
} as const;

/** Why a video is refused: its metadata could not be removed, so it does not go at all. */
export const NO_VIDEO_METADATA = "This video cannot be sent: Ghostly could not remove the details saved in it, like where it was recorded";

/** The types of the videos stripped here: a file of one of them whose bytes are not one is refused. */
const STRIPPED_TYPES = new Set(["video/mp4", "video/quicktime", "video/x-m4v", "video/3gpp", "video/3gpp2"]);

/** The first box of an MP4 (`ftyp`) or of a QuickTime file written without one. */
const FIRST_BOXES = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip"]);

/** Boxes that hold metadata wherever they are: emptied into `free`. */
const METADATA = new Set(["udta", "meta", "uuid"]);
/**
 * At the top: what makes the movie, kept (`moov` and `moof` looked into); a preview picture, an event message, the
 * wall-clock time a fragment was made (`prft`), emptied.
 */
const TOP_KEEPS = new Set(["ftyp", "styp", "moov", "mdat", "moof", "mfra", "sidx", "ssix", "pdin", "free", "skip", "wide"]);
const TOP_EMPTIED = new Set([...METADATA, "pnot", "PICT", "emsg", "Xtra", "prft"]);
const MOOV_KEEPS = new Set(["mvhd", "trak", "mvex", "iods", "ctab", "free", "skip", "wide"]);
const TRAK_KEEPS = new Set(["tkhd", "edts", "mdia", "tref", "tapt", "load", "txas", "matt", "free", "skip", "wide"]);
/** Boxes looked into below a track (and in a fragment) for the metadata boxes in them. */
const CONTAINERS = new Set(["mdia", "minf", "dinf", "stbl", "edts", "mvex", "traf"]);
/** Track handlers kept as they are: picture, sound, text and subtitles, timecode, hints. `meta` tracks have their samples zeroed, `tmcd` ones too. */
const HANDLERS = new Set(["vide", "soun", "text", "sbtl", "subt", "clcp", "tmcd", "hint", "auxv", "pict", "sdsm", "odsm", "subp"]);

/** Zeros put in a Blob a part at a time. */
const ZEROS = new Uint8Array(1024 * 1024);

const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const text = (b: Uint8Array, at: number, length: number) => String.fromCharCode(...b.subarray(at, at + length));

/** Refuses the video where its bytes are not what this expects. */
function check(ok: boolean): asserts ok {
  if (!ok) throw new Error(NO_VIDEO_METADATA);
}

interface Box { type: string; start: number; body: number; end: number }

/** A box's header at `at` of `b` (`base` its offset in the file), up to `end` (a size of 0 runs to it). */
function header(b: Uint8Array, at: number, end: number, base = 0): Box {
  check(at + 8 <= b.length);
  let size = u32be(b, at), body = at + 8;
  const type = text(b, at + 4, 4);
  if (size === 1) {
    check(at + 16 <= b.length);
    size = u32be(b, at + 8) * 2 ** 32 + u32be(b, at + 12);
    body = at + 16;
  } else if (size === 0) size = end - (base + at);
  if (type === "uuid") body += 16;
  check(Number.isSafeInteger(size) && size >= body - at && base + at + size <= end);
  return { type, start: base + at, body: base + body, end: base + at + size };
}

function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const found: Box[] = [];
  for (let at = start; at < end;) {
    check(at + 8 <= end);
    const box = header(b.subarray(0, end), at, end);
    found.push(box);
    at = box.end;
  }
  return found;
}

/** A box made `free` where it is: its size kept, everything after its size zeroed. */
function empty(b: Uint8Array, box: Box): void {
  b.set([0x66, 0x72, 0x65, 0x65], box.start + 4);
  b.fill(0, box.start + (u32be(b, box.start) === 1 ? 16 : 8), box.end);
}

/** Every metadata box in a container's children (and in theirs, for the containers below a track) emptied. */
function emptyWithin(b: Uint8Array, start: number, end: number): void {
  for (const box of boxes(b, start, end)) {
    if (METADATA.has(box.type)) empty(b, box);
    else if (CONTAINERS.has(box.type)) emptyWithin(b, box.body, box.end);
  }
}

/** A `mvhd`, `tkhd` or `mdhd` with its creation and modification times zeroed: 32 bits each in version 0, 64 in 1. */
function zeroTimes(b: Uint8Array, box: Box): void {
  const version = b[box.body]!, bytes = version === 1 ? 16 : 8;
  check(version <= 1 && box.body + 4 + bytes <= box.end);
  b.fill(0, box.body + 4, box.body + 4 + bytes);
}

const child = (b: Uint8Array, parent: Box | undefined, type: string): Box | undefined => {
  if (!parent) return undefined;
  const of = boxes(b, parent.body, parent.end).filter((box) => box.type === type);
  check(of.length <= 1);
  return of[0];
};

/** The byte ranges of a track's samples in the file, one per chunk, from its sample table. */
function sampleRanges(b: Uint8Array, stbl: Box): [number, number][] {
  const stsz = child(b, stbl, "stsz"), stz2 = child(b, stbl, "stz2"), stsc = child(b, stbl, "stsc");
  const stco = child(b, stbl, "stco"), co64 = child(b, stbl, "co64");
  check(!!stsc && !!stsz !== !!stz2 && !!stco !== !!co64);
  const need = (box: Box, at: number, bytes: number) => check(at + bytes <= box.end);

  // Each sample's size.
  const sizeTable = (stsz ?? stz2)!;
  need(sizeTable, sizeTable.body, 12);
  const count = u32be(b, sizeTable.body + 8);
  let sizeOf: (i: number) => number;
  /** Samples of one size: a chunk's length is counted, not added up a sample at a time. */
  let uniform = 0;
  if (stsz) {
    uniform = u32be(b, stsz.body + 4);
    if (!uniform) need(stsz, stsz.body + 12, count * 4);
    sizeOf = (i) => u32be(b, stsz.body + 12 + i * 4);
  } else {
    const field = b[stz2!.body + 7]!;
    check(field === 4 || field === 8 || field === 16);
    need(stz2!, stz2!.body + 12, Math.ceil((count * field) / 8));
    const at = stz2!.body + 12;
    sizeOf = field === 16 ? (i) => (b[at + i * 2]! << 8) | b[at + i * 2 + 1]!
      : field === 8 ? (i) => b[at + i]!
      : (i) => (i & 1 ? b[at + (i >> 1)]! & 15 : b[at + (i >> 1)]! >> 4);
  }

  // Each chunk's offset.
  const offsets = (stco ?? co64)!;
  need(offsets, offsets.body, 8);
  const chunks = u32be(b, offsets.body + 4);
  need(offsets, offsets.body + 8, chunks * (co64 ? 8 : 4));
  const offsetOf = (i: number) => co64 ? u32be(b, co64.body + 8 + i * 8) * 2 ** 32 + u32be(b, co64.body + 12 + i * 8) : u32be(b, stco!.body + 8 + i * 4);

  // How many samples each chunk holds.
  need(stsc, stsc.body, 8);
  const runs = u32be(b, stsc.body + 4);
  need(stsc, stsc.body + 8, runs * 12);
  const ranges: [number, number][] = [];
  let sample = 0;
  for (let run = 0; run < runs; run++) {
    const first = u32be(b, stsc.body + 8 + run * 12), perChunk = u32be(b, stsc.body + 12 + run * 12);
    const last = run + 1 < runs ? u32be(b, stsc.body + 8 + (run + 1) * 12) : chunks + 1;
    check(first >= 1 && last > first && last <= chunks + 1);
    for (let chunk = first; chunk < last; chunk++) {
      const start = offsetOf(chunk - 1);
      check(sample + perChunk <= count);
      let length = uniform * perChunk;
      if (!uniform) for (let i = 0; i < perChunk; i++) length += sizeOf(sample + i);
      sample += perChunk;
      check(Number.isSafeInteger(start) && length <= VIDEO_METADATA_LIMITS.maxBoxBytes);
      if (length) ranges.push([start, start + length]);
    }
  }
  check(sample === count);
  return ranges;
}

/** Whether every data reference of a track is this file (a self-contained `url ` or `alis`). */
function selfContained(b: Uint8Array, minf: Box): boolean {
  const dref = child(b, child(b, minf, "dinf"), "dref");
  if (!dref) return false;
  return boxes(b, dref.body + 8, dref.end).every((entry) => entry.body + 4 <= entry.end && (b[entry.body + 3]! & 1) === 1);
}

/**
 * `moov` with its metadata boxes emptied and its headers' times zeroed, read whole: whether it has a video track, and
 * the byte ranges of its metadata and timecode tracks' samples (zeroed by the caller where they are), and whether a
 * metadata track has any.
 */
function stripMoov(b: Uint8Array): { video: boolean; fragmented: boolean; metadata: boolean; zeroed: [number, number][] } {
  let video = false, fragmented = false, metadata = false;
  const zeroed: [number, number][] = [];
  for (const box of boxes(b, header(b, 0, b.length).body, b.length)) {
    if (METADATA.has(box.type)) { empty(b, box); continue; }
    check(MOOV_KEEPS.has(box.type));
    if (box.type === "mvhd") zeroTimes(b, box);
    if (box.type === "mvex") { fragmented = true; emptyWithin(b, box.body, box.end); }
    if (box.type !== "trak") continue;
    let mdia: Box | undefined;
    for (const part of boxes(b, box.body, box.end)) {
      if (METADATA.has(part.type)) { empty(b, part); continue; }
      check(TRAK_KEEPS.has(part.type));
      if (part.type === "tkhd") zeroTimes(b, part);
      if (part.type === "mdia") { check(!mdia); mdia = part; }
    }
    check(!!mdia);
    const hdlr = child(b, mdia, "hdlr"), minf = child(b, mdia, "minf"), mdhd = child(b, mdia, "mdhd");
    check(!!hdlr && !!minf && hdlr.body + 12 <= hdlr.end);
    if (mdhd) zeroTimes(b, mdhd);
    const handler = text(b, hdlr.body + 8, 4);
    const stbl = child(b, minf, "stbl");
    check(!!stbl);
    if (handler === "meta") {
      check(selfContained(b, minf));
      const ranges = sampleRanges(b, stbl);
      metadata ||= ranges.length > 0;
      for (const range of ranges) zeroed.push(range);
    } else if (handler === "tmcd" && selfContained(b, minf)) {
      // A camera's timecode starts at the time of day it recorded: it starts at 0 instead.
      for (const range of sampleRanges(b, stbl)) zeroed.push(range);
    } else check(HANDLERS.has(handler));
    if (handler === "vide") video = true;
    emptyWithin(b, box.body, box.end);
  }
  return { video, fragmented, metadata, zeroed };
}

/** A video as it is read: its size, and `length` of its bytes from `offset` (fewer only at its end). */
export interface VideoSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** A part of a video replaced as it is sent, `start` to `end` of the file: by `bytes`, or by zeros. */
export interface VideoPatch { start: number; end: number; bytes?: Uint8Array }

/** A box's header in the file at `at`, read from it. */
async function headerAt(source: VideoSource, at: number): Promise<Box> {
  const head = await source.read(at, 16);
  return header(head, 0, source.size, at);
}

/** A box read whole, within the limit. */
async function whole(source: VideoSource, box: Box): Promise<Uint8Array> {
  check(box.end - box.start <= VIDEO_METADATA_LIMITS.maxBoxBytes);
  const bytes = await source.read(box.start, box.end - box.start);
  check(bytes.length === box.end - box.start);
  return bytes;
}

/** An MP4 or QuickTime file, by its first box: an HEIF picture is pictureMetadata.ts's. */
function isVideoContainer(head: Uint8Array, mime: string): boolean {
  return head.length >= 8 && FIRST_BOXES.has(text(head, 4, 4)) && !isStrippedPicture(head, mime);
}

/**
 * `source` as it is sent: an MP4 or QuickTime video without its metadata, made of `source`'s own bytes but for the
 * boxes and samples zeroed; undefined when it goes as it is (not one of these videos, a file without a video track).
 * Throws `NO_VIDEO_METADATA` for a video whose metadata cannot be removed; an error reading `source` as it is.
 */
export async function withoutVideoMetadata(source: Blob, mime: string): Promise<Blob | undefined> {
  const patches = await videoMetadataPatches({ size: source.size, read: async (offset, length) => new Uint8Array(await source.slice(offset, offset + length).arrayBuffer()) }, mime);
  if (!patches) return undefined;
  const parts: BlobPart[] = [];
  let at = 0;
  for (const patch of patches) {
    if (patch.start > at) parts.push(source.slice(at, patch.start));
    if (patch.bytes) parts.push(patch.bytes as BlobPart);
    else for (let left = patch.end - patch.start; left > 0; left -= ZEROS.length) parts.push(ZEROS.subarray(0, Math.min(left, ZEROS.length)) as BlobPart);
    at = patch.end;
  }
  if (at < source.size) parts.push(source.slice(at));
  return new Blob(parts, { type: mime });
}

/**
 * What `withoutVideoMetadata` changes in a video read from `source` (one not held in a Blob: a file kept in storage):
 * the parts replaced, in order and apart, the rest of its bytes going as they are; undefined when it goes as it is.
 * Throws `NO_VIDEO_METADATA` as it does.
 */
export async function videoMetadataPatches(source: VideoSource, mime: string): Promise<VideoPatch[] | undefined> {
  const head = await source.read(0, VIDEO_METADATA_LIMITS.headBytes);
  const typed = STRIPPED_TYPES.has(mime.split(";")[0]!.trim().toLowerCase());
  if (!isVideoContainer(head, mime)) {
    if (typed && !isStrippedPicture(head, mime)) throw new Error(NO_VIDEO_METADATA);
    return undefined;
  }

  /** What replaces the file's bytes, by where it starts: a box rewritten, or zeros (no `bytes`). */
  const patches: VideoPatch[] = [];

  // The top-level boxes, by their headers alone.
  const top: Box[] = [];
  for (let at = 0; at < source.size;) {
    check(top.length < VIDEO_METADATA_LIMITS.maxBoxes);
    const box = await headerAt(source, at);
    // Zeros after the last box (a recorder's padding) are no box: they go as zeros, whatever follows.
    if (top.length && box.type === "\0\0\0\0" && box.end === source.size) {
      patches.push({ start: at, end: source.size });
      break;
    }
    check(TOP_KEEPS.has(box.type) || TOP_EMPTIED.has(box.type));
    top.push(box);
    at = box.end;
  }
  const moovs = top.filter((box) => box.type === "moov");
  check(moovs.length === 1);

  const moov = await whole(source, moovs[0]!);
  const { video, fragmented, metadata, zeroed } = stripMoov(moov);
  if (!video && !typed) return undefined;
  patches.push({ start: moovs[0]!.start, end: moovs[0]!.end, bytes: moov });

  // A metadata track's samples in fragments are not looked for: such a video is refused.
  check(!fragmented || !metadata);
  for (const box of top) {
    if (box.type === "moof") {
      const moof = await whole(source, box);
      emptyWithin(moof, box.body - box.start, moof.length);
      patches.push({ start: box.start, end: box.end, bytes: moof });
    } else if (TOP_EMPTIED.has(box.type)) {
      // Its header made `free`, its body zeros.
      const head = await source.read(box.start, box.body - box.start);
      empty(head, { type: box.type, start: 0, body: head.length, end: head.length });
      patches.push({ start: box.start, end: box.body, bytes: head }, { start: box.body, end: box.end });
    }
  }

  // The metadata and timecode samples, each within a `mdat`: zeros where they were, ranges that touch made one.
  const mdats = top.filter((box) => box.type === "mdat");
  const merged: [number, number][] = [];
  for (const [start, end] of zeroed.sort((a, b) => a[0] - b[0])) {
    check(mdats.some((mdat) => start >= mdat.body && end <= mdat.end));
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  for (const [start, end] of merged) patches.push({ start, end });

  let at = 0;
  for (const patch of patches.sort((a, b) => a.start - b.start)) {
    check(patch.start >= at);
    at = patch.end;
  }
  return patches;
}
