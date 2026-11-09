/**
 * What a video leaves with. An MP4 or QuickTime file says more than its frames: its `udta` and `meta` boxes hold where
 * it was recorded (`©xyz`, `com.apple.quicktime.location.ISO6709`), the device, often its software; a timed metadata
 * track (an iPhone's location and motion, a GoPro's GPS) holds them sample by sample, a caption track (a drone's, a
 * dashcam's) a line of them each second; the movie's, each track's and
 * each track's media header (`mvhd`, `tkhd`, `mdhd`) say when it was recorded, to the second, and a camera's timecode
 * track the time of day. The sender removes them before the file is stored and its digest computed, without decoding
 * or re-encoding a frame: each such box becomes a `free` box of the same size, zeroed, the headers' creation and
 * modification times are zeroed (0 is "unknown"), the space already left in it (`free`, `skip`, `wide`: what an edit in
 * place left behind, a recorder's GPS log) is zeroed after its header, so are the names of its handlers and of the
 * compressor that made its frames, and each metadata, timecode and caption track's samples are zeroed where they are, so no
 * offset in the file moves and it plays as it did. Only the boxes' headers, `moov` and `moof` are read; the
 * media goes untouched.
 *
 * Fail-closed: a file that is an MP4 or QuickTime video, by its bytes or by its type, and whose metadata cannot be
 * removed (truncated, malformed, a part of its movie this does not know) is refused with `NO_VIDEO_METADATA`, never sent as it was.
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
  /** Bytes read at once for a box's header or a small box, so the next headers and `moof`s are read with it. */
  readAhead: 64 * 1024,
} as const;

/** Why a video is refused: its metadata could not be removed, so it does not go at all. */
export const NO_VIDEO_METADATA = "This video cannot be sent: Ghostly could not remove the details saved in it, like where it was recorded";

/** The types of the videos stripped here: a file of one of them whose bytes are not one is refused. */
const STRIPPED_TYPES = new Set(["video/mp4", "video/quicktime", "video/x-m4v", "video/3gpp", "video/3gpp2"]);

/**
 * The first box of an MP4 (`ftyp`), of a QuickTime file written without one, or of one a tool or a preview was put
 * before (`uuid`, `pnot`): a file that starts with one is a movie, refused when it is not one.
 */
const FIRST_BOXES = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip", "uuid", "pnot", "PICT"]);

/** Boxes that hold metadata wherever they are: emptied into `free`. */
const METADATA = new Set(["udta", "meta", "uuid"]);
/**
 * Space left in a file (padding, or an old `moov` or `udta` an edit in place left behind), and what a recorder puts
 * there (a dashcam's GPS log, a thumbnail): kept where it is, its body zeroed.
 */
const SPACE = new Set(["free", "skip", "wide"]);
/**
 * At the top: what makes the movie, kept (`moov` and `moof` looked into). Any other box is emptied, unless the movie's
 * samples are in it: the ones known at a movie's top (a preview picture, an event message, the wall-clock time a
 * fragment was made, `prft`) and a device's own (Samsung's `sefd`, a GPS track's `gps0`) alike.
 */
const TOP_KEEPS = new Set(["ftyp", "styp", "moov", "mdat", "moof", "mfra", "sidx", "ssix", "pdin", ...SPACE]);
/** The boxes emptied that are known at a movie's top: a file that starts with one is read as boxes. */
const TOP_EMPTIED = new Set([...METADATA, "pnot", "PICT", "emsg", "Xtra", "prft"]);
const MOOV_KEEPS = new Set(["mvhd", "trak", "mvex", "iods", "ctab", ...SPACE]);
const TRAK_KEEPS = new Set(["tkhd", "edts", "mdia", "tref", "tapt", "load", "txas", "matt", ...SPACE]);
/** Boxes looked into below a track (and in a fragment) for the metadata boxes in them. */
const CONTAINERS = new Set(["mdia", "minf", "dinf", "stbl", "edts", "mvex", "traf"]);
/** Track handlers kept as they are: picture, sound, timecode, hints. `meta` tracks have their samples zeroed, `tmcd` ones and `CAPTIONS` too. */
const HANDLERS = new Set(["vide", "soun", "tmcd", "hint", "auxv", "pict", "sdsm", "odsm", "subp"]);
/**
 * Text, subtitle and caption tracks: what a recorder writes there is a log (a drone's or a dashcam's GPS, home point,
 * date and time each second), so their samples are zeroed, in `moov`'s tables and in fragments alike; they show nothing.
 */
const CAPTIONS = new Set(["text", "sbtl", "subt", "clcp"]);
/** The handlers whose sample descriptions are a visual one's, a compressor's name in each. */
const VISUAL = new Set(["vide", "auxv", "pict"]);

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

/**
 * Every metadata box in a container's children (and in theirs, for the containers below a track) emptied, every
 * free space's body zeroed, and every handler's name (an `hdlr`'s after its 24 bytes of fields: "Core Media Video",
 * an encoder's or an app's) zeroed in place, its type kept.
 */
function emptyWithin(b: Uint8Array, start: number, end: number): void {
  for (const box of boxes(b, start, end)) {
    if (METADATA.has(box.type)) empty(b, box);
    else if (SPACE.has(box.type)) b.fill(0, box.body, box.end);
    else if (box.type === "hdlr") b.fill(0, Math.min(box.body + 24, box.end), box.end);
    else if (CONTAINERS.has(box.type)) emptyWithin(b, box.body, box.end);
  }
}

/**
 * A visual track's sample descriptions with the name of the compressor that made them zeroed (32 bytes at 42 of each
 * entry's body, MP4's `compressorname` and QuickTime's alike: an encoder's version, a camera's).
 */
function zeroCompressorNames(b: Uint8Array, stbl: Box): void {
  const stsd = child(b, stbl, "stsd");
  check(!!stsd && stsd.body + 8 <= stsd.end);
  for (const entry of boxes(b, stsd.body + 8, stsd.end)) {
    check(entry.body + 74 <= entry.end);
    b.fill(0, entry.body + 42, entry.body + 74);
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

/** A sample table's chunks, from its `stco` or `co64`: how many, and where each starts in the file. */
function chunkOffsets(b: Uint8Array, stbl: Box): { chunks: number; offsetOf: (i: number) => number } {
  const stco = child(b, stbl, "stco"), co64 = child(b, stbl, "co64");
  check(!!stco !== !!co64);
  const offsets = (stco ?? co64)!;
  check(offsets.body + 8 <= offsets.end);
  const chunks = u32be(b, offsets.body + 4);
  check(offsets.body + 8 + chunks * (co64 ? 8 : 4) <= offsets.end);
  const offsetOf = (i: number) => co64 ? u32be(b, co64.body + 8 + i * 8) * 2 ** 32 + u32be(b, co64.body + 12 + i * 8) : u32be(b, stco!.body + 8 + i * 4);
  return { chunks, offsetOf };
}

/** The byte ranges of a track's samples in the file, one per chunk, from its sample table. */
function sampleRanges(b: Uint8Array, stbl: Box): [number, number][] {
  const stsz = child(b, stbl, "stsz"), stz2 = child(b, stbl, "stz2"), stsc = child(b, stbl, "stsc");
  check(!!stsc && !!stsz !== !!stz2);
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
  const { chunks, offsetOf } = chunkOffsets(b, stbl);

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

/** Each track's default sample size in fragments, from `moov`'s `mvex/trex` boxes, by track ID. */
function defaultSampleSizes(moov: Uint8Array): Map<number, number> {
  const sizes = new Map<number, number>();
  const mvex = child(moov, header(moov, 0, moov.length), "mvex");
  for (const trex of mvex ? boxes(moov, mvex.body, mvex.end) : []) {
    if (trex.type !== "trex") continue;
    check(trex.body + 24 <= trex.end);
    sizes.set(u32be(moov, trex.body + 4), u32be(moov, trex.body + 16));
  }
  return sizes;
}

/**
 * The byte ranges of a fragment's samples in the file, one per track run (`trun`), from its `moof` read whole (`at` its
 * offset in the file): each run starts at its data offset from its track fragment's base (`tfhd`'s base data offset,
 * else the `moof`'s start for the first track fragment or one that says so, else where the previous one's data ended),
 * or where the previous run ended; its length is its samples' sizes, its own or `tfhd`'s or `trex`'s default. Each
 * with its track's ID.
 */
function fragmentRanges(b: Uint8Array, at: number, sizes: Map<number, number>): [number, number, number][] {
  const ranges: [number, number, number][] = [];
  let previous = at;
  for (const traf of boxes(b, header(b, 0, b.length).body, b.length)) {
    if (traf.type !== "traf") continue;
    const tfhd = child(b, traf, "tfhd");
    check(!!tfhd && tfhd.body + 8 <= tfhd.end);
    const flags = u32be(b, tfhd.body) & 0xffffff;
    let field = tfhd.body + 8, base = flags & 0x20000 ? at : previous;
    if (flags & 0x1) {
      check(field + 8 <= tfhd.end);
      base = u32be(b, field) * 2 ** 32 + u32be(b, field + 4);
      field += 8;
    }
    if (flags & 0x2) field += 4;
    if (flags & 0x8) field += 4;
    const track = u32be(b, tfhd.body + 4);
    let size = sizes.get(track);
    if (flags & 0x10) {
      check(field + 4 <= tfhd.end);
      size = u32be(b, field);
    }
    let next = base;
    for (const trun of boxes(b, traf.body, traf.end)) {
      if (trun.type !== "trun") continue;
      check(trun.body + 8 <= trun.end);
      const runFlags = u32be(b, trun.body) & 0xffffff, count = u32be(b, trun.body + 4);
      let field = trun.body + 8;
      if (runFlags & 0x1) {
        check(field + 4 <= trun.end);
        next = base + (u32be(b, field) | 0);
        field += 4;
      }
      if (runFlags & 0x4) field += 4;
      const stride = [0x100, 0x200, 0x400, 0x800].filter((flag) => runFlags & flag).length * 4;
      check(field + count * stride <= trun.end);
      let length = 0;
      if (runFlags & 0x200) {
        const sizeAt = field + (runFlags & 0x100 ? 4 : 0);
        for (let i = 0; i < count; i++) length += u32be(b, sizeAt + i * stride);
      } else if (count) {
        check(size !== undefined);
        length = count * size;
      }
      check(Number.isSafeInteger(next) && Number.isSafeInteger(next + length));
      if (length) ranges.push([next, next + length, track]);
      next += length;
    }
    previous = next;
  }
  return ranges;
}

/** Whether every data reference of a track is this file (a self-contained `url ` or `alis`). */
function selfContained(b: Uint8Array, minf: Box): boolean {
  const dref = child(b, child(b, minf, "dinf"), "dref");
  if (!dref) return false;
  return boxes(b, dref.body + 8, dref.end).every((entry) => entry.body + 4 <= entry.end && (b[entry.body + 3]! & 1) === 1);
}

/**
 * `moov` with its metadata boxes emptied and its headers' times zeroed, read whole: whether it has a video track, the
 * byte ranges of its metadata, timecode and caption tracks' samples (zeroed by the caller where they are), whether it
 * has a metadata or timecode track, every track's sample table, and the IDs of its caption tracks (their samples in
 * fragments zeroed too).
 */
function stripMoov(b: Uint8Array): { video: boolean; fragmented: boolean; metadata: boolean; zeroed: [number, number][]; tables: Box[]; captions: Set<number> } {
  let video = false, fragmented = false, metadata = false;
  const zeroed: [number, number][] = [], tables: Box[] = [], captions = new Set<number>();
  for (const box of boxes(b, header(b, 0, b.length).body, b.length)) {
    if (METADATA.has(box.type)) { empty(b, box); continue; }
    check(MOOV_KEEPS.has(box.type));
    if (SPACE.has(box.type)) b.fill(0, box.body, box.end);
    if (box.type === "mvhd") zeroTimes(b, box);
    if (box.type === "mvex") { fragmented = true; emptyWithin(b, box.body, box.end); }
    if (box.type !== "trak") continue;
    let mdia: Box | undefined, tkhd: Box | undefined;
    for (const part of boxes(b, box.body, box.end)) {
      if (METADATA.has(part.type)) { empty(b, part); continue; }
      check(TRAK_KEEPS.has(part.type));
      if (part.type === "tkhd") { check(!tkhd); tkhd = part; zeroTimes(b, part); }
      if (part.type === "mdia") { check(!mdia); mdia = part; }
    }
    check(!!mdia);
    const hdlr = child(b, mdia, "hdlr"), minf = child(b, mdia, "minf"), mdhd = child(b, mdia, "mdhd");
    check(!!hdlr && !!minf && hdlr.body + 12 <= hdlr.end);
    if (mdhd) zeroTimes(b, mdhd);
    const handler = text(b, hdlr.body + 8, 4);
    const stbl = child(b, minf, "stbl");
    check(!!stbl);
    tables.push(stbl);
    if (handler === "meta") {
      check(selfContained(b, minf));
      // The track itself, not its table in `moov`: a fragmented movie's tables are empty, its samples in fragments.
      metadata = true;
      for (const range of sampleRanges(b, stbl)) zeroed.push(range);
    } else if (handler === "tmcd" && selfContained(b, minf)) {
      // A camera's timecode starts at the time of day it recorded: it starts at 0 instead.
      metadata = true;
      for (const range of sampleRanges(b, stbl)) zeroed.push(range);
    } else if (CAPTIONS.has(handler)) {
      check(selfContained(b, minf) && !!tkhd);
      // Its ID (after the times, 32 or 64 bits each), for its samples in fragments.
      const id = tkhd.body + 4 + (b[tkhd.body] === 1 ? 16 : 8);
      check(id + 4 <= tkhd.end);
      captions.add(u32be(b, id));
      for (const range of sampleRanges(b, stbl)) zeroed.push(range);
    } else check(HANDLERS.has(handler));
    if (handler === "vide") video = true;
    if (VISUAL.has(handler)) zeroCompressorNames(b, stbl);
    emptyWithin(b, box.body, box.end);
  }
  return { video, fragmented, metadata, zeroed, tables, captions };
}

/** A video as it is read: its size, and `length` of its bytes from `offset` (fewer only at its end). */
export interface VideoSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/**
 * Whether `start` to `end` of the file meets one of `ranges` (in file order, apart): the first one that ends past
 * `start` is the only one that can, found by halves, so a fragment per range is not checked against every other.
 */
function meets(ranges: [number, number][], start: number, end: number): boolean {
  let low = 0, high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle]![1] > start) high = middle;
    else low = middle + 1;
  }
  return low < ranges.length && ranges[low]![0] < end;
}

/**
 * `source` read a window at a time: a read that fits in `readAhead` bytes reads that many from where it starts, and
 * the reads after it within them (the next boxes' headers, a fragment's `moof`) are served from it, as copies (they
 * are changed in place). A Blob's read costs about the same whatever its size, so a fragment costs one, not three.
 */
function readingAhead(source: VideoSource): VideoSource {
  let start = 0, window: Uint8Array = new Uint8Array(0);
  return {
    size: source.size,
    async read(offset, length) {
      const end = start + window.length;
      if (offset < start || (offset + length > end && end < source.size)) {
        if (length > VIDEO_METADATA_LIMITS.readAhead) return source.read(offset, length);
        start = offset;
        window = await source.read(offset, VIDEO_METADATA_LIMITS.readAhead);
      }
      return window.slice(offset - start, offset - start + length);
    },
  };
}

/** A part of a video replaced as it is sent, `start` to `end` of the file: by `bytes`, or by zeros. */
export interface VideoPatch { start: number; end: number; bytes?: Uint8Array }

/** A whole box's header in the file at `at`, read from it; undefined where none fits (bytes after the last box). */
async function headerAt(source: VideoSource, at: number): Promise<Box | undefined> {
  const head = await source.read(at, 16);
  try {
    return header(head, 0, source.size, at);
  } catch {
    return undefined;
  }
}

/** A box read whole, within the limit. */
async function whole(source: VideoSource, box: Box): Promise<Uint8Array> {
  check(box.end - box.start <= VIDEO_METADATA_LIMITS.maxBoxBytes);
  const bytes = await source.read(box.start, box.end - box.start);
  check(bytes.length === box.end - box.start);
  return bytes;
}

/**
 * What a file is by its first box: a movie (`FIRST_BOXES`), a file of boxes that is one when it holds a `moov` (any
 * other box found at the top of a movie: a stream's segment holds none), or another file. An HEIF picture is
 * pictureMetadata.ts's.
 */
function containerOf(head: Uint8Array, mime: string): "movie" | "boxes" | undefined {
  const first = head.length >= 8 ? text(head, 4, 4) : "";
  if (isStrippedPicture(head, mime)) return undefined;
  if (FIRST_BOXES.has(first)) return "movie";
  return TOP_KEEPS.has(first) || TOP_EMPTIED.has(first) ? "boxes" : undefined;
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
export async function videoMetadataPatches(file: VideoSource, mime: string): Promise<VideoPatch[] | undefined> {
  const source = readingAhead(file);
  const head = await source.read(0, VIDEO_METADATA_LIMITS.headBytes);
  const typed = STRIPPED_TYPES.has(mime.split(";")[0]!.trim().toLowerCase());
  const container = containerOf(head, mime);
  if (!container) {
    if (typed && !isStrippedPicture(head, mime)) throw new Error(NO_VIDEO_METADATA);
    return undefined;
  }

  /** What replaces the file's bytes, by where it starts: a box rewritten, or zeros (no `bytes`). */
  const patches: VideoPatch[] = [];

  // The top-level boxes, by their headers alone.
  const top: Box[] = [];
  /** What goes as zeros at the top, in file order: the boxes emptied, the space's bodies, and the bytes after the last box. */
  const dropped: [number, number][] = [];
  let trailer = false;
  for (let at = 0; at < source.size;) {
    check(top.length < VIDEO_METADATA_LIMITS.maxBoxes);
    const box = await headerAt(source, at);
    // Bytes after the last whole box (a recorder's zeros, a phone's trailer) are no box: they go as zeros.
    if (!box || (top.length && box.type === "\0\0\0\0")) {
      patches.push({ start: at, end: source.size });
      dropped.push([at, source.size]);
      // A box of zeros to the end was let through before as it is; bytes that are no box were not.
      trailer = !box || box.end !== source.size;
      break;
    }
    top.push(box);
    if (SPACE.has(box.type)) dropped.push([box.body, box.end]);
    else if (!TOP_KEEPS.has(box.type)) dropped.push([box.start, box.end]);
    at = box.end;
  }
  const moovs = top.filter((box) => box.type === "moov");
  // A stream's segment goes as it is; boxes that are not all known ones, or bytes that are no box, are refused.
  if (!moovs.length && container === "boxes" && !typed) {
    check(!trailer && top.every((box) => TOP_KEEPS.has(box.type) || TOP_EMPTIED.has(box.type)));
    return undefined;
  }
  check(moovs.length === 1);

  const moov = await whole(source, moovs[0]!);
  const { video, fragmented, metadata, zeroed, tables, captions } = stripMoov(moov);
  if (!video && !typed) return undefined;
  patches.push({ start: moovs[0]!.start, end: moovs[0]!.end, bytes: moov });

  // No sample is where zeros go.
  if (dropped.length) for (const stbl of tables) {
    const { chunks, offsetOf } = chunkOffsets(moov, stbl);
    for (let i = 0; i < chunks; i++) {
      const offset = offsetOf(i);
      check(!meets(dropped, offset, offset + 1));
    }
  }

  // A metadata or timecode track's samples in fragments are not looked for: such a video is refused.
  check(!fragmented || !metadata);
  const sizes = (dropped.length || captions.size) && fragmented ? defaultSampleSizes(moov) : undefined;
  for (const box of top) {
    if (box.type === "moof") {
      const moof = await whole(source, box);
      // No fragment's sample is where zeros go either; a caption track's samples are zeroed.
      if (dropped.length || captions.size) {
        for (const [start, end, track] of fragmentRanges(moof, box.start, sizes ?? new Map())) {
          check(!meets(dropped, start, end));
          if (captions.has(track)) zeroed.push([start, end]);
        }
      }
      emptyWithin(moof, box.body - box.start, moof.length);
      patches.push({ start: box.start, end: box.end, bytes: moof });
    } else if (SPACE.has(box.type)) {
      // Its header kept, its body zeros.
      if (box.body < box.end) patches.push({ start: box.body, end: box.end });
    } else if (!TOP_KEEPS.has(box.type)) {
      // Its header made `free`, its body zeros.
      const head = await source.read(box.start, box.body - box.start);
      empty(head, { type: box.type, start: 0, body: head.length, end: head.length });
      patches.push({ start: box.start, end: box.body, bytes: head }, { start: box.body, end: box.end });
    }
  }

  // The metadata, timecode and caption samples, each within a `mdat`: zeros where they were, ranges that touch made one.
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
