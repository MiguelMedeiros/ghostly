/**
 * What an audio file leaves with. A recording made in another app, or a song a tagger went through, says more than its
 * sound: a title or a file name that is where it was recorded (a phone's recorder names it after the place), a comment,
 * a location tag, a picture, the date. The sender removes them before the file is stored and its digest computed, as
 * pictures' and videos' are (pictureMetadata.ts, videoMetadata.ts), without decoding or re-encoding a sample, and the
 * file keeps its size, so no offset in it moves and it plays as it did:
 *
 * - MP4 audio (M4A, a voice note recorded in MP4): videoMetadata.ts's box walk, its `udta` and `meta` emptied.
 * - MP3 and AAC: an ID3v2 tag at the start becomes an empty one (its frames zeros: padding), one at the end (with its
 *   footer), an APEv2 tag's items, a Lyrics3v2 tag and an ID3v1 tag's fields become zeros. One typed as MP3 or AAC
 *   whose first bytes are neither (junk before its first frame) still has the tags at its end emptied.
 * - FLAC: every metadata block but its stream info and seek table (a Vorbis comment, a picture, a cue sheet, an
 *   application's) becomes padding, zeroed.
 * - Ogg Opus, Vorbis, Speex and Theora: the comment header keeps its vendor (the encoder's name) and has no comment,
 *   the bytes after it zeros. FLAC in Ogg: its metadata blocks as a FLAC's. Each page changed has its checksum made again.
 * - WAV (RIFF, RF64 or BW64): every chunk but its format, data and the ones of the sound itself (`fact`, `cue `,
 *   `smpl`, `inst`, an RF64's `ds64`) becomes `JUNK`, zeroed (an INFO list, an `id3 ` chunk, a broadcast `bext` with
 *   its date and originator, iXML, XMP).
 * - AIFF and AIFF-C: every chunk but its sound's (`COMM`, `SSND`, `FVER`, `MARK`, `INST`, `AESD`, `chan`) becomes
 *   `JUNK`, zeroed (NAME, AUTH, ANNO, `(c) `, COMT, an `ID3 ` chunk, an app's `APPL`).
 * - CAF: every chunk but its sound's (`desc`, `data`, `pakt`, `kuki`, `chan`, `peak`, `ovvw`) becomes `free`, zeroed
 *   (its `info` strings, a marker's names in `strg`, `edct` comments, `uuid` chunks).
 * - WavPack: its APEv2 and ID3v1 tags at the end as an MP3's, and the source file's header and trailer each block may
 *   keep for a lossless restore (a WAV's INFO list, an AIFF's NAME) made a sub-block that says nothing, zeroed.
 * - TTA: its tags at the end (and an ID3v2 before it) as an MP3's.
 * - Sun AU: its annotation, zeros.
 * - WebM and Matroska, audio or video: `Tags`, `Attachments`, `Chapters`, the title, the date, the file names and each
 *   track's name become `Void` elements (and the SeekHead's entries for them); the muxer's and the writing app's names
 *   are zeroed. A Vorbis, Theora or FLAC track's CodecPrivate (its Ogg headers or its FLAC metadata blocks) has its
 *   comments emptied as an Ogg's or a FLAC's. Clusters, cues and other track settings are kept as they are.
 *
 * Fail-closed: a file that is one of these by its bytes and whose tags cannot be removed (truncated, malformed) is
 * refused with `NO_AUDIO_METADATA`, never sent as it was. So is a WMA (ASF): its title, place and date are not removed
 * here. Any other file goes as it is (other audio formats too).
 */
import { baseMime } from "./voice";
import { NO_VIDEO_METADATA, isAsf, readingAhead, videoMetadataPatches, type VideoPatch, type VideoSource } from "./videoMetadata";

export const AUDIO_METADATA_LIMITS = {
  /** The largest header, element or tag read whole (an Ogg comment header with a picture in it): past this the file is refused. */
  maxReadBytes: 64 * 1024 * 1024,
  /** The most pages, chunks, blocks or elements walked. */
  maxParts: 1_000_000,
  /** Bytes read first to tell an audio file from another file. */
  headBytes: 64,
} as const;

/** Why an audio file is refused: its tags could not be removed, so it does not go at all. */
export const NO_AUDIO_METADATA = "This audio cannot be sent: Ghostly could not remove the details saved in it, like where it was recorded";

/** Zeros put in a Blob a slice at a time: a Blob's Blob parts are not copied, so a zeroed range of any size holds no more. */
const ZEROS = new Blob([new Uint8Array(1024 * 1024)]);

const text = (b: Uint8Array, at: number, length: number) => String.fromCharCode(...b.subarray(at, at + length));
const u32le = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const syncsafe = (b: Uint8Array, at: number) => (b[at]! << 21) | (b[at + 1]! << 14) | (b[at + 2]! << 7) | b[at + 3]!;
const latin = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** Refuses the file where its bytes are not what this expects. */
function check(ok: boolean): asserts ok {
  if (!ok) throw new Error(NO_AUDIO_METADATA);
}

/** The file read as patches are made: `length` of its bytes from `offset`, all of them or refused. */
type Read = (offset: number, length: number) => Promise<Uint8Array>;

function exactly(source: VideoSource): Read {
  return async (offset, length) => {
    check(offset >= 0 && length >= 0 && length <= AUDIO_METADATA_LIMITS.maxReadBytes && offset + length <= source.size);
    const bytes = await source.read(offset, length);
    check(bytes.length === length);
    return bytes;
  };
}

/** Counts the parts walked, so a file of millions of tiny ones is refused rather than walked forever. */
function counter(): () => void {
  let parts = 0;
  return () => check(++parts <= AUDIO_METADATA_LIMITS.maxParts);
}

// ID3, APE, Lyrics3: MP3's and AAC's tags.

/** An ID3v2 header at `at` of `b`: its version 2 to 4 and its size four 7-bit bytes, or none. */
const isId3 = (b: Uint8Array, at = 0) => b.length >= at + 10 && text(b, at, 3) === "ID3" && b[at + 3]! >= 2 && b[at + 3]! <= 4 && b[at + 4] !== 0xff
  && [6, 7, 8, 9].every((i) => b[at + i]! < 0x80);

/**
 * The ID3v2 tag whose header is `head`, at `at`: made an empty one where it is, its frames (and an extended header)
 * zeros, which is its padding, its flags but the footer's cleared. Returns where it ends.
 */
async function emptyId3(read: Read, size: number, at: number, head: Uint8Array, patches: VideoPatch[]): Promise<number> {
  const body = syncsafe(head, 6), footer = head[3] === 4 && head[5]! & 0x10 ? 10 : 0, end = at + 10 + body + footer;
  check(end <= size);
  const flags = Uint8Array.of(footer ? 0x10 : 0);
  patches.push({ start: at + 5, end: at + 6, bytes: flags });
  if (body) patches.push({ start: at + 10, end: at + 10 + body });
  if (footer) {
    check(text(await read(at + 10 + body, 3), 0, 3) === "3DI");
    patches.push({ start: at + 10 + body + 5, end: at + 10 + body + 6, bytes: flags });
  }
  return end;
}

/**
 * The tags at the end of an MP3 or AAC file (after `start`): an ID3v1 (and its extended part), then any of an APEv2
 * tag, a Lyrics3v2 tag and an ID3v2 tag with a footer, in any order. Each found is emptied where it is.
 */
async function trailingTags(read: Read, size: number, start: number, patches: VideoPatch[]): Promise<void> {
  let end = size;
  if (end - 128 >= start && text(await read(end - 128, 3), 0, 3) === "TAG") {
    // Its fields zeros, its genre none.
    patches.push({ start: end - 125, end: end - 1 }, { start: end - 1, end, bytes: Uint8Array.of(0xff) });
    end -= 128;
    if (end - 227 >= start && text(await read(end - 227, 4), 0, 4) === "TAG+") {
      patches.push({ start: end - 223, end });
      end -= 227;
    }
  }
  const count = counter();
  for (;;) {
    count();
    if (end - 32 >= start) {
      const footer = await read(end - 32, 32);
      if (text(footer, 0, 8) === "APETAGEX") {
        // Its size counts its items and footer; a header before them says so in its flags.
        const length = u32le(footer, 12), header = footer[23]! & 0x80 ? 32 : 0, tagStart = end - length - header;
        check(length >= 32 && tagStart >= start);
        if (header) {
          check(text(await read(tagStart, 8), 0, 8) === "APETAGEX");
          patches.push({ start: tagStart + 16, end: tagStart + 20 });
        }
        if (length > 32) patches.push({ start: tagStart + header, end: end - 32 });
        patches.push({ start: end - 16, end: end - 12 });
        end = tagStart;
        continue;
      }
    }
    if (end - 15 >= start) {
      const footer = await read(end - 15, 15);
      if (text(footer, 6, 9) === "LYRICS200") {
        const length = /^\d{6}$/.test(text(footer, 0, 6)) ? Number(text(footer, 0, 6)) : -1, tagStart = end - 15 - length;
        check(length >= 11 && tagStart >= start && text(await read(tagStart, 11), 0, 11) === "LYRICSBEGIN");
        if (length > 11) patches.push({ start: tagStart + 11, end: end - 15 });
        end = tagStart;
        continue;
      }
    }
    if (end - 10 >= start) {
      const footer = await read(end - 10, 10);
      if (text(footer, 0, 3) === "3DI") {
        check([6, 7, 8, 9].every((i) => footer[i]! < 0x80));
        const tagStart = end - 20 - syncsafe(footer, 6);
        check(tagStart >= start);
        const head = await read(tagStart, 10);
        check(isId3(head));
        check(await emptyId3(read, size, tagStart, head, patches) === end);
        end = tagStart;
        continue;
      }
    }
    return;
  }
}

/** The types an MP3 or AAC file is sent as: one whose first bytes are no frame still has its tags at the end read. */
const MPEG_AUDIO = new Set(["audio/mpeg", "audio/mp3", "audio/mpeg3", "audio/x-mpeg", "audio/x-mp3", "audio/aac", "audio/x-aac", "audio/aacp"]);

/** An MPEG audio frame's or an ADTS header's first bytes: 11 bits set, a version and a layer that are some. */
const isFrame = (b: Uint8Array, at: number) => b.length >= at + 2 && b[at] === 0xff && (b[at + 1]! & 0xe0) === 0xe0 && (b[at + 1]! & 0x18) !== 0x08;

// FLAC.

const FLAC_KEEPS = new Set([0 /* STREAMINFO */, 3 /* SEEKTABLE */]);

/** A FLAC's metadata blocks from `at` (its `fLaC`): all but its stream info and seek table become padding, zeroed. */
async function flac(read: Read, size: number, at: number, patches: VideoPatch[]): Promise<number> {
  const count = counter();
  for (at += 4; ;) {
    count();
    const head = await read(at, 4);
    const last = head[0]! & 0x80, type = head[0]! & 0x7f, end = at + 4 + ((head[1]! << 16) | (head[2]! << 8) | head[3]!);
    check(type !== 127 && end <= size);
    if (!FLAC_KEEPS.has(type)) {
      if (type !== 1) patches.push({ start: at, end: at + 1, bytes: Uint8Array.of(last | 1) });
      if (end > at + 4) patches.push({ start: at + 4, end });
    }
    at = end;
    if (last) return at;
  }
}

// Ogg.

const OGG_CRC = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    table[i] = crc >>> 0;
  }
  return table;
})();

/** Ogg's page checksum, over the page with its checksum's four bytes zeroed. */
function oggCrc(page: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < page.length; i++) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ (i >= 22 && i < 26 ? 0 : page[i]!)) & 0xff]!) >>> 0;
  return crc;
}

/**
 * A comment header with no comment: its magic and vendor kept, its count 0 (and Vorbis's framing bit set), the rest
 * zeros: padding after the comments, which Opus says may be there and Vorbis's, Speex's and Theora's readers do not read.
 */
function noComments(packet: Uint8Array, comments: string, framing: boolean): Uint8Array {
  const magic = comments.length;
  check(text(packet, 0, magic) === comments && packet.length >= magic + 4);
  const count = magic + 4 + u32le(packet, magic);
  check(count + 4 + (framing ? 1 : 0) <= packet.length);
  const out = new Uint8Array(packet.length);
  out.set(packet.subarray(0, count));
  if (framing) out[count + 4] = 1;
  return out;
}

/** A FLAC metadata block that is a whole packet (FLAC in Ogg): kept, or made padding as `flac` makes it. */
function noFlacBlock(packet: Uint8Array): Uint8Array {
  check(packet.length >= 4 && packet.length === 4 + ((packet[1]! << 16) | (packet[2]! << 8) | packet[3]!) && (packet[0]! & 0x7f) !== 127);
  const type = packet[0]! & 0x7f;
  if (FLAC_KEEPS.has(type)) return packet;
  const out = new Uint8Array(packet.length);
  out[0] = type === 1 ? packet[0]! : (packet[0]! & 0x80) | 1;
  return out;
}

/**
 * A codec's headers after its first packet, known by that packet's first bytes: `tagged` says whether one that may
 * hold tags follows (its first packet given, then each header after it), `empty` makes one without them, its length
 * kept.
 */
interface OggCodec { head: string; tagged: (packet: Uint8Array, index: number) => boolean; empty: (packet: Uint8Array) => Uint8Array }
/** A codec whose second packet is its comment header: its magic, and whether a framing bit follows its comments (Vorbis). */
const commentHeader = (head: string, comments: string, framing: boolean): OggCodec => ({ head, tagged: (_, index) => index === 0, empty: (packet) => noComments(packet, comments, framing) });

const OGG_CODECS: OggCodec[] = [
  commentHeader("OpusHead", "OpusTags", false),
  commentHeader("\x01vorbis", "\x03vorbis", true),
  commentHeader("Speex   ", "", false),
  commentHeader("\x80theora", "\x81theora", false),
  // FLAC: its first packet holds the stream info's block, each header after it one metadata block, the last flagged.
  {
    head: "\x7fFLAC",
    tagged: (packet, index) => {
      if (index) return !(packet[0]! & 0x80);
      check(packet.length >= 17 && text(packet, 9, 4) === "fLaC");
      return !(packet[13]! & 0x80);
    },
    empty: noFlacBlock,
  },
];

/**
 * An Ogg file's pages walked: each logical stream's comment header (a chained file has one per link) made one with no
 * comment where it is, across the pages it spans, and those pages' checksums made again.
 */
async function ogg(read: Read, size: number, patches: VideoPatch[]): Promise<void> {
  /**
   * A logical stream: its packets so far, the parts of the one being read (with the page each is on), its codec (null:
   * one not known), and whether a header that may hold tags is still to come.
   */
  interface Stream { packet: number; ranges: [number, number, number][]; codec?: OggCodec | null; tagged: boolean }
  const streams = new Map<number, Stream>();
  /** The bytes put in the pages changed, by where each page starts: by where they go in the file. */
  const pages = new Map<number, [number, Uint8Array][]>();
  const packetOf = async (ranges: [number, number, number][]) => {
    const length = ranges.reduce((sum, [start, end]) => sum + end - start, 0);
    check(length <= AUDIO_METADATA_LIMITS.maxReadBytes);
    const packet = new Uint8Array(length);
    let at = 0;
    for (const [start, end] of ranges) { packet.set(await read(start, end - start), at); at += end - start; }
    return packet;
  };
  const count = counter();
  for (let at = 0; at < size;) {
    count();
    const head = await read(at, 27);
    check(text(head, 0, 4) === "OggS" && head[4] === 0);
    const lacing = await read(at + 27, head[26]!);
    const end = at + 27 + lacing.length + lacing.reduce((sum, l) => sum + l, 0);
    check(end <= size);
    const serial = u32le(head, 14);
    if (head[5]! & 2) streams.set(serial, { packet: 0, ranges: [], tagged: true });
    const stream = streams.get(serial);
    check(!!stream);
    let offset = at + 27 + lacing.length;
    for (const length of lacing) {
      if (stream.tagged) stream.ranges.push([offset, offset + length, at]);
      offset += length;
      if (length === 255) continue;
      // A packet ends.
      if (stream.packet === 0) {
        const first = await packetOf(stream.ranges);
        stream.codec = OGG_CODECS.find((codec) => text(first, 0, codec.head.length) === codec.head) ?? null;
        stream.tagged = !!stream.codec?.tagged(first, 0);
      } else if (stream.tagged && stream.codec) {
        const packet = await packetOf(stream.ranges), emptied = stream.codec.empty(packet);
        stream.tagged = stream.codec.tagged(packet, stream.packet);
        let from = 0;
        for (const [start, until, page] of stream.ranges) {
          if (!pages.has(page)) pages.set(page, []);
          pages.get(page)!.push([start, emptied.subarray(from, from + until - start)]);
          from += until - start;
        }
      }
      stream.packet++;
      stream.ranges = [];
    }
    at = end;
  }
  // A stream cut before its headers with tags ended would go with them.
  for (const stream of streams.values()) check(!stream.tagged);
  for (const [start, changes] of pages) {
    const head = await read(start, 27), lacing = await read(start + 27, head[26]!);
    const end = start + 27 + lacing.length + lacing.reduce((sum, l) => sum + l, 0);
    const page = (await read(start, end - start)).slice();
    for (const [where, bytes] of changes) page.set(bytes, where - start);
    const crc = oggCrc(page);
    page.set([crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24], 22);
    patches.push({ start, end, bytes: page });
  }
}

// WAV.

/** The chunks a WAV's sound is made of, kept; any other becomes `JUNK`. */
const WAV_KEEPS = new Set(["fmt ", "data", "fact", "cue ", "smpl", "inst"]);
const WAV_SPACE = new Set(["JUNK", "junk", "PAD ", "FLLR"]);

/** A WAV's chunks from its `WAVE`; an RF64 or BW64 one (`rf64`) has its `ds64` first, which says `data`'s size when its own is all ones. */
async function wav(read: Read, size: number, rf64: boolean, patches: VideoPatch[]): Promise<void> {
  let dataSize: number | undefined;
  if (rf64) {
    const ds64 = await read(12, 8 + 16);
    check(text(ds64, 0, 4) === "ds64" && u32le(ds64, 4) >= 28);
    dataSize = u32le(ds64, 16) + u32le(ds64, 20) * 2 ** 32;
  }
  const count = counter();
  for (let at = 12; at + 8 <= size;) {
    count();
    const head = await read(at, 8);
    const id = text(head, 0, 4), length = id === "data" && dataSize !== undefined && u32le(head, 4) === 0xffffffff ? dataSize : u32le(head, 4);
    let end = at + 8 + length + (length % 2);
    // Sound that runs to the end: a recorder's that never wrote its size (0, or all ones), or one cut short.
    if (id === "data") end = length ? Math.min(end, size) : size;
    else check(at + 8 + length <= size);
    if (!WAV_KEEPS.has(id) && !(rf64 && at === 12)) {
      if (!WAV_SPACE.has(id)) patches.push({ start: at, end: at + 4, bytes: latin("JUNK") });
      if (length) patches.push({ start: at + 8, end: at + 8 + length });
    }
    at = Math.min(end, size);
  }
}

// AIFF, CAF, WavPack, Sun AU.

/** The chunks an AIFF's or AIFF-C's sound is made of, kept; any other becomes `JUNK`. */
const AIFF_KEEPS = new Set(["COMM", "SSND", "FVER", "MARK", "INST", "AESD", "chan"]);

/** An AIFF's chunks from its form type: big-endian sizes, each padded to an even length. */
async function aiff(read: Read, size: number, patches: VideoPatch[]): Promise<void> {
  const count = counter();
  for (let at = 12; at + 8 <= size;) {
    count();
    const head = await read(at, 8);
    const id = text(head, 0, 4), length = u32be(head, 4);
    let end = at + 8 + length + (length % 2);
    // Sound that runs to the end: a recorder's that never wrote its size, or one cut short.
    if (id === "SSND") end = length ? Math.min(end, size) : size;
    else check(at + 8 + length <= size);
    if (!AIFF_KEEPS.has(id)) {
      if (id !== "JUNK") patches.push({ start: at, end: at + 4, bytes: latin("JUNK") });
      if (length) patches.push({ start: at + 8, end: at + 8 + length });
    }
    at = Math.min(end, size);
  }
}

/** The chunks a CAF's sound is made of, kept; any other becomes `free`. */
const CAF_KEEPS = new Set(["desc", "data", "pakt", "kuki", "chan", "peak", "ovvw"]);

/** A CAF's chunks after its 8-byte header: big-endian 64-bit sizes, `data`'s -1 when it runs to the end. */
async function caf(read: Read, size: number, patches: VideoPatch[]): Promise<void> {
  const count = counter();
  for (let at = 8; at + 12 <= size;) {
    count();
    const head = await read(at, 12);
    const id = text(head, 0, 4), high = u32be(head, 4), length = high * 2 ** 32 + u32be(head, 8);
    const toEnd = id === "data" && high === 0xffffffff && u32be(head, 8) === 0xffffffff;
    check(toEnd || (Number.isSafeInteger(length) && at + 12 + length <= size));
    const end = toEnd ? size : at + 12 + length;
    if (!CAF_KEEPS.has(id)) {
      if (id !== "free") patches.push({ start: at, end: at + 4, bytes: latin("free") });
      if (end > at + 12) patches.push({ start: at + 12, end });
    }
    at = end;
  }
}

/** A WavPack sub-block's own id (its flags apart): the source file's header and trailer, a WAV's or another's. */
const WAVPACK_SOURCE = new Set([0x21 /* RIFF header */, 0x22 /* RIFF trailer */, 0x23 /* other header */, 0x24 /* other trailer */]);

/** A WavPack's blocks from `at`, their source file's header and trailer emptied; returns where they end (its tags). */
async function wavpack(read: Read, size: number, at: number, patches: VideoPatch[]): Promise<number> {
  const count = counter();
  while (at + 32 <= size && text(await read(at, 4), 0, 4) === "wvpk") {
    count();
    const end = at + 8 + u32le(await read(at + 4, 4), 0);
    check(end >= at + 32 && end <= size);
    for (let sub = at + 32; sub < end;) {
      count();
      const head = await read(sub, Math.min(4, end - sub));
      // Its size in 16-bit words: one byte, or three for a large one.
      const large = (head[0]! & 0x80) !== 0, body = sub + (large ? 4 : 2);
      check(body <= end);
      const length = (large ? head[1]! | (head[2]! << 8) | (head[3]! << 16) : head[1]!) * 2;
      check(body + length <= end);
      // An optional sub-block of no id (its flags kept), its body zeros: a decoder skips it, and makes a header of its own.
      if (WAVPACK_SOURCE.has(head[0]! & 0x3f)) {
        patches.push({ start: sub, end: sub + 1, bytes: Uint8Array.of((head[0]! & 0xc0) | 0x20) });
        if (length) patches.push({ start: body, end: body + length });
      }
      sub = body + length;
    }
    at = end;
  }
  return at;
}

/** A Sun AU's annotation: from its 24-byte header to its sound. */
async function au(read: Read, size: number, patches: VideoPatch[]): Promise<void> {
  const offset = u32be(await read(4, 4), 0);
  check(offset >= 24 && offset <= size);
  if (offset > 24) patches.push({ start: 24, end: offset });
}

// WebM and Matroska.

const EBML_HEADER = 0x1a45dfa3, SEGMENT = 0x18538067, CLUSTER = 0x1f43b675, VOID = 0xec, CRC32 = 0xbf;
const SEEK_HEAD = 0x114d9b74, INFO = 0x1549a966, TRACKS = 0x1654ae6b, CUES = 0x1c53bb6b;
/** What a segment's sound and pictures are made of, kept; any other top-level element (Tags, Attachments, Chapters) becomes Void. */
const SEGMENT_KEEPS = new Set([SEEK_HEAD, INFO, TRACKS, CLUSTER, CUES]);
/** What a cluster holds: one of unknown size ends where an element that is none of these starts. */
const CLUSTER_CHILDREN = new Set([0xe7, 0x5854, 0xa7, 0xab, 0xa3, 0xa0, 0xaf, VOID, CRC32]);
/** What Info keeps: the timing, the segment's IDs; the muxer's and writing app's names, zeroed. Any other (a title, a date, file names) becomes Void. */
const INFO_KEEPS = new Set([0x2ad7b1, 0x4489, 0x73a4, 0x4444, 0x3cb923, 0x3eb923, 0x6924]);
const INFO_ZEROED = new Set([0x4d80, 0x5741]);
const TRACK_ENTRY = 0xae, TRACK_NAME = 0x536e, CODEC_ID = 0x86, CODEC_PRIVATE = 0x63a2, SEEK = 0x4dbb, SEEK_ID = 0x53ab;
/** The codecs whose CodecPrivate is their Ogg headers Xiph-laced: the second a comment header, its magic, and whether a framing bit follows its comments. */
const XIPH_PRIVATE = new Map<string, [string, boolean]>([["A_VORBIS", ["\x03vorbis", true]], ["V_THEORA", ["\x81theora", false]]]);

interface Element { id: number; start: number; body: number; end: number; unknown: boolean }

/** The element whose header is at `at` of `b` (`base` its offset in the file); one of unknown size ends at `limit`. */
function element(b: Uint8Array, at: number, limit: number, base = 0): Element {
  check(at < b.length);
  const idLength = Math.clz32(b[at]!) - 23;
  check(idLength >= 1 && idLength <= 4 && at + idLength < b.length);
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + b[at + i]!;
  const sizeAt = at + idLength, sizeLength = Math.clz32(b[sizeAt]!) - 23;
  check(sizeLength >= 1 && sizeLength <= 8 && sizeAt + sizeLength <= b.length);
  let size = b[sizeAt]! & (0xff >> sizeLength), ones = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i++) {
    size = size * 256 + b[sizeAt + i]!;
    ones &&= b[sizeAt + i] === 0xff;
  }
  const body = base + sizeAt + sizeLength;
  return { id, start: base + at, body, end: ones ? limit : body + size, unknown: ones };
}

/** An element's header read from the file at `at`. */
async function elementAt(source: VideoSource, at: number, limit: number): Promise<Element> {
  return element(await source.read(at, 12), 0, limit, at);
}

/** A Void element `length` bytes long: its ID, its size in as many bytes as it takes to fill it, the rest zeros. */
function voidHeader(length: number): Uint8Array {
  for (let sizeLength = 1; sizeLength <= 8; sizeLength++) {
    const body = length - 1 - sizeLength;
    if (body < 0 || body >= 2 ** (7 * sizeLength) - 1) continue;
    const header = new Uint8Array(1 + sizeLength);
    header[0] = VOID;
    for (let i = sizeLength, rest = body; i >= 1; i--, rest = Math.floor(rest / 256)) header[i] = rest % 256;
    header[1]! |= 0x80 >> (sizeLength - 1);
    return header;
  }
  check(false);
}

/** `el` of `b` (read whole, `el`'s offsets in it) made Void where it is. */
function voidIn(b: Uint8Array, el: Element): void {
  const header = voidHeader(el.end - el.start);
  b.fill(0, el.start, el.end);
  b.set(header, el.start);
}

/** The children of `parent` (in `b`, read whole) as elements, each within it. */
function childrenOf(b: Uint8Array, parent: Element): Element[] {
  const found: Element[] = [];
  for (let at = parent.body; at < parent.end;) {
    const child = element(b.subarray(0, parent.end), at, parent.end);
    check(!child.unknown && child.end <= parent.end);
    found.push(child);
    at = child.end;
  }
  return found;
}

/**
 * A track's CodecPrivate (`b`, changed in it) by its codec: a Vorbis or Theora track's headers (their count less one,
 * each size but the last's in Xiph lacing, them) with a comment header that has no comment, its sizes kept; a FLAC
 * track's `fLaC` and metadata blocks as a FLAC's, any byte after the last zeroed. Another codec's is kept as it is.
 */
async function noPrivateTags(b: Uint8Array, codec: string): Promise<void> {
  const xiph = XIPH_PRIVATE.get(codec);
  if (xiph) {
    check(b.length >= 1 && b[0] === 2);
    let at = 1;
    const sizes: number[] = [];
    while (sizes.length < 2) {
      let size = 0;
      for (let byte = 255; byte === 255; size += byte) {
        check(at < b.length);
        byte = b[at++]!;
      }
      sizes.push(size);
    }
    const start = at + sizes[0]!, end = start + sizes[1]!;
    check(end <= b.length);
    b.set(noComments(b.subarray(start, end), ...xiph), start);
  } else if (codec === "A_FLAC") {
    check(b.length >= 4 && text(b, 0, 4) === "fLaC");
    const patches: VideoPatch[] = [];
    const end = await flac(async (offset, length) => {
      check(offset >= 0 && length >= 0 && offset + length <= b.length);
      return b.subarray(offset, offset + length);
    }, b.length, 0, patches);
    for (const patch of patches) {
      if (patch.bytes) b.set(patch.bytes, patch.start);
      else b.fill(0, patch.start, patch.end);
    }
    b.fill(0, end);
  }
}

/**
 * A top-level element of a segment read whole and changed in it: Info without its title, date and file names (its
 * muxer's and writing app's names zeroed), Tracks without their names and the comments in their CodecPrivate, a
 * SeekHead without the entries for what became Void. A CRC-32 in them, wrong once they changed, becomes Void too.
 */
async function stripTopLevel(b: Uint8Array): Promise<void> {
  const top = element(b, 0, b.length);
  check(!top.unknown && top.end === b.length);
  for (const child of childrenOf(b, top)) {
    if (child.id === CRC32) voidIn(b, child);
    else if (top.id === INFO) {
      if (INFO_ZEROED.has(child.id)) b.fill(0, child.body, child.end);
      else if (!INFO_KEEPS.has(child.id) && child.id !== VOID) voidIn(b, child);
    } else if (top.id === TRACKS && child.id === TRACK_ENTRY) {
      const parts = childrenOf(b, child), ids = parts.filter((part) => part.id === CODEC_ID);
      // A CodecID null-padded is the same; two would leave which one a player reads unknown.
      check(ids.length <= 1);
      const codec = ids[0] ? text(b, ids[0].body, ids[0].end - ids[0].body).replace(/\0+$/, "") : "";
      for (const part of parts) {
        if (part.id === TRACK_NAME || part.id === CRC32) voidIn(b, part);
        else if (part.id === CODEC_PRIVATE) await noPrivateTags(b.subarray(part.body, part.end), codec);
      }
    } else if (top.id === SEEK_HEAD && child.id === SEEK) {
      const target = childrenOf(b, child).find((part) => part.id === SEEK_ID);
      let id = 0;
      if (target) for (let i = target.body; i < target.end; i++) id = id * 256 + b[i]!;
      if (!SEGMENT_KEEPS.has(id)) voidIn(b, child);
    }
    if (child.id === VOID) b.fill(0, child.body, child.end);
  }
}

/** Where a cluster of unknown size ends: at the first element that is not a cluster's, or the segment's end. */
async function clusterEnd(source: VideoSource, at: number, limit: number, count: () => void): Promise<number> {
  for (;;) {
    count();
    if (at >= limit) return limit;
    const child = await elementAt(source, at, limit);
    if (!CLUSTER_CHILDREN.has(child.id)) return at;
    check(!child.unknown);
    // A recording cut short ends in the middle of a block: the rest is sound.
    if (child.end >= limit) return limit;
    at = child.end;
  }
}

async function matroska(source: VideoSource, read: Read, patches: VideoPatch[]): Promise<void> {
  const count = counter();
  const toVoid = (el: Element) => {
    const header = voidHeader(el.end - el.start);
    patches.push({ start: el.start, end: el.start + header.length, bytes: header });
    if (el.end > el.start + header.length) patches.push({ start: el.start + header.length, end: el.end });
  };
  for (let at = 0; at < source.size;) {
    count();
    const top = await elementAt(source, at, source.size);
    check(top.end <= source.size);
    if (top.id === EBML_HEADER) check(!top.unknown);
    else if (top.id === VOID) { if (top.end > top.body) patches.push({ start: top.body, end: top.end }); }
    else if (top.id !== SEGMENT) { check(!top.unknown); toVoid(top); }
    else for (let in_ = top.body; in_ < top.end;) {
      count();
      const el = await elementAt(source, in_, top.end);
      if (el.id === CLUSTER) {
        in_ = el.unknown ? await clusterEnd(source, el.body, top.end, count) : Math.min(el.end, top.end);
        continue;
      }
      check(!el.unknown && el.end <= top.end);
      if (el.id === INFO || el.id === TRACKS || el.id === SEEK_HEAD) {
        const bytes = (await read(el.start, el.end - el.start)).slice();
        await stripTopLevel(bytes);
        patches.push({ start: el.start, end: el.end, bytes });
      } else if (el.id === VOID) {
        if (el.end > el.body) patches.push({ start: el.body, end: el.end });
      } else if (!SEGMENT_KEEPS.has(el.id)) toVoid(el);
      in_ = el.end;
    }
    at = top.end;
  }
}

/**
 * What `withoutAudioMetadata` changes in an audio file read from `source` (one not held in a Blob: a file kept in
 * storage): the parts replaced, in order and apart, the rest of its bytes going as they are; undefined when it goes as
 * it is. Throws `NO_AUDIO_METADATA` for one whose tags cannot be removed; an error reading `source` as it is.
 */
export async function audioMetadataPatches(file: VideoSource, mime: string): Promise<VideoPatch[] | undefined> {
  const source = readingAhead(file), read = exactly(source), size = source.size;
  const head = await source.read(0, Math.min(AUDIO_METADATA_LIMITS.headBytes, size));
  const patches: VideoPatch[] = [];
  if (head.length >= 8 && text(head, 4, 4) === "ftyp") {
    try {
      return await videoMetadataPatches(file, mime, true);
    } catch (error) {
      if (error instanceof Error && error.message === NO_VIDEO_METADATA) throw Object.assign(new Error(NO_AUDIO_METADATA), { cause: error });
      throw error;
    }
  } else if (text(head, 0, 4) === "OggS") await ogg(read, size, patches);
  else if (head.length >= 12 && ["RIFF", "RF64", "BW64"].includes(text(head, 0, 4)) && text(head, 8, 4) === "WAVE") await wav(read, size, text(head, 0, 4) !== "RIFF", patches);
  else if (text(head, 0, 4) === "\x1a\x45\xdf\xa3") await matroska(source, read, patches);
  else if (head.length >= 12 && text(head, 0, 4) === "FORM" && ["AIFF", "AIFC"].includes(text(head, 8, 4))) await aiff(read, size, patches);
  else if (head.length >= 8 && text(head, 0, 4) === "caff") await caf(read, size, patches);
  else if (head.length >= 24 && text(head, 0, 4) === ".snd") await au(read, size, patches);
  else if (text(head, 0, 4) === "wvpk") await trailingTags(read, size, await wavpack(read, size, 0, patches), patches);
  else if (text(head, 0, 4) === "TTA1") await trailingTags(read, size, 0, patches);
  else if (isAsf(head)) check(false);
  else if (text(head, 0, 4) === "fLaC") await trailingTags(read, size, await flac(read, size, 0, patches), patches);
  else if (isId3(head) || isFrame(head, 0)) {
    // ID3v2 tags before the sound (one after another, as some taggers leave them), then a FLAC's or a WavPack's blocks, or MPEG frames.
    let at = 0;
    const count = counter();
    for (let next = head; isId3(next); next = at + 10 <= size ? await read(at, 10) : new Uint8Array(0)) {
      count();
      at = await emptyId3(read, size, at, next, patches);
    }
    if (at + 4 <= size && text(await read(at, 4), 0, 4) === "fLaC") at = await flac(read, size, at, patches);
    else if (at + 4 <= size && text(await read(at, 4), 0, 4) === "wvpk") at = await wavpack(read, size, at, patches);
    await trailingTags(read, size, at, patches);
  } else if (MPEG_AUDIO.has(baseMime(mime))) {
    // An MP3 or AAC that starts with neither (junk before its first frame, a stream cut): a player finds its frames past
    // the junk and reads the tags at its end.
    await trailingTags(read, size, 0, patches);
  } else return undefined;
  if (!patches.length) return undefined;
  patches.sort((a, b) => a.start - b.start);
  for (let i = 1; i < patches.length; i++) check(patches[i]!.start >= patches[i - 1]!.end);
  return patches;
}

/**
 * `source` as it is sent: an audio file without its tags, made of `source`'s own bytes but for the parts emptied;
 * undefined when it goes as it is (not one of these, or one with nothing to remove). Throws `NO_AUDIO_METADATA` for
 * one whose tags cannot be removed; an error reading `source` as it is.
 */
export async function withoutAudioMetadata(source: Blob, mime: string): Promise<Blob | undefined> {
  const patches = await audioMetadataPatches({ size: source.size, read: async (offset, length) => new Uint8Array(await source.slice(offset, offset + length).arrayBuffer()) }, mime);
  if (!patches) return undefined;
  const parts: BlobPart[] = [];
  let at = 0;
  for (const patch of patches) {
    if (patch.start > at) parts.push(source.slice(at, patch.start));
    if (patch.bytes) parts.push(patch.bytes as BlobPart);
    else for (let left = patch.end - patch.start; left > 0; left -= ZEROS.size) parts.push(ZEROS.slice(0, Math.min(left, ZEROS.size)));
    at = patch.end;
  }
  if (at < source.size) parts.push(source.slice(at));
  return new Blob(parts, { type: mime });
}
