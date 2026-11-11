import { PLACE, box, metadataTrack, xyzUdta } from "./videoFixtures";

/**
 * Audio files that say where they were recorded, as a phone's recorder or a tagger writes them: the place in a title,
 * a comment or a location tag. Their sound (`MP3_FRAMES`, `FLAC_FRAMES`, `OPUS_PACKETS`, `WAV_DATA`, `WEBM_BLOCK`) is
 * a pattern that must come out as it went in.
 */
export { PLACE, hasPlace } from "./videoFixtures";

const latin = (s: string) => Buffer.from(s, "latin1");
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u24be = (n: number) => Buffer.from([n >> 16, (n >> 8) & 255, n & 255]);
const syncsafe = (n: number) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);

/** Ten MPEG-1 Layer III frames (128 kb/s, 44.1 kHz), their bodies a pattern. */
export const MP3_FRAMES = Buffer.concat(Array.from({ length: 10 }, (_, i) => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413, i + 1)])));

const id3Frame = (id: string, body: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32BE(body.length); return Buffer.concat([latin(id), size, Buffer.alloc(2), body]); };
/** An ID3v2.3 tag: a title, a comment and a user tag that say where, and some padding. */
export const id3v2 = () => {
  const frames = Buffer.concat([
    id3Frame("TIT2", Buffer.concat([Buffer.from([0]), latin(`Recording at ${PLACE}`)])),
    id3Frame("COMM", Buffer.concat([Buffer.from([0]), latin("eng"), Buffer.from([0]), latin(PLACE)])),
    id3Frame("TXXX", Buffer.concat([Buffer.from([0]), latin("location\0"), latin(PLACE)])),
    Buffer.alloc(64),
  ]);
  return Buffer.concat([latin("ID3"), Buffer.from([3, 0, 0]), syncsafe(frames.length), frames]);
};
/** An ID3v1 tag (128 bytes at the end): its title the place. */
export const id3v1 = () => Buffer.concat([latin("TAG"), latin(PLACE.padEnd(30, "\0")), Buffer.alloc(30), Buffer.alloc(30), latin("2026"), Buffer.alloc(30), Buffer.from([12])]);
/** An APEv2 tag with its header and footer, one item `Location` the place. */
export const apev2 = () => {
  const item = Buffer.concat([u32le(PLACE.length), u32le(0), latin("Location\0"), latin(PLACE)]);
  const part = (flags: number) => Buffer.concat([latin("APETAGEX"), u32le(2000), u32le(item.length + 32), u32le(1), u32le(flags), Buffer.alloc(8)]);
  return Buffer.concat([part(0xa0000000), item, part(0x80000000)]);
};
/** An MP3 as a tagger leaves it: ID3v2 before its frames, APEv2 and ID3v1 after them. */
export const taggedMp3 = () => Buffer.concat([id3v2(), MP3_FRAMES, apev2(), id3v1()]);

/** A FLAC's STREAMINFO, a Vorbis comment, a picture, padding, then its frames. */
export const FLAC_FRAMES = Buffer.concat([Buffer.from([0xff, 0xf8]), Buffer.alloc(200, 7)]);
const flacBlock = (type: number, last: boolean, body: Buffer) => Buffer.concat([Buffer.from([(last ? 0x80 : 0) | type]), u24be(body.length), body]);
const vorbisComment = (framing: boolean) => {
  const vendor = latin("reference libFLAC 1.4.3"), comments = [`TITLE=Recording at ${PLACE}`, `LOCATION=${PLACE}`].map(latin);
  return Buffer.concat([u32le(vendor.length), vendor, u32le(comments.length), ...comments.flatMap((c) => [u32le(c.length), c]), ...(framing ? [Buffer.from([1])] : [])]);
};
export const taggedFlac = () => Buffer.concat([latin("fLaC"),
  flacBlock(0, false, Buffer.alloc(34, 3)),
  flacBlock(4, false, vorbisComment(false)),
  flacBlock(6, false, Buffer.concat([u32be(3), u32be(9), latin("image/png"), u32be(PLACE.length), latin(PLACE), Buffer.alloc(20)])),
  flacBlock(1, true, Buffer.alloc(16)),
  FLAC_FRAMES]);

/** A WAV with an INFO list and an `id3 ` chunk that say where, around its `fmt ` and `data`. */
export const WAV_DATA = Buffer.alloc(1000, 9);
const chunk = (id: string, body: Buffer) => Buffer.concat([latin(id), u32le(body.length), body, Buffer.alloc(body.length & 1)]);
export const taggedWav = () => {
  const inam = chunk("INAM", latin(`${PLACE}\0`));
  const body = Buffer.concat([latin("WAVE"), chunk("fmt ", Buffer.alloc(16, 1)), chunk("LIST", Buffer.concat([latin("INFO"), inam])), chunk("data", WAV_DATA), chunk("id3 ", id3v2())]);
  return Buffer.concat([latin("RIFF"), u32le(body.length), body]);
};

/** Ogg's page checksum (CRC-32, polynomial 0x04c11db7, not reflected), over the page with its checksum zeroed. */
export function oggCrc(page: Uint8Array): number {
  let crc = 0;
  for (const byte of page) {
    crc ^= byte << 24;
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}
/** One Ogg page of `serial` holding `segments` (each up to 255 bytes, as laced). */
function oggPage(serial: number, sequence: number, type: number, granule: number, segments: Buffer[]): Buffer {
  const head = Buffer.alloc(27);
  head.write("OggS", 0, "latin1");
  head[5] = type;
  head.writeBigInt64LE(BigInt(granule), 6);
  head.writeUInt32LE(serial, 14);
  head.writeUInt32LE(sequence, 18);
  head[26] = segments.length;
  const page = Buffer.concat([head, Buffer.from(segments.map((s) => s.length)), ...segments]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}
/** `packets` of one Ogg stream laid out in pages of at most `perPage` segments, each packet's first page its own. */
function oggStream(serial: number, packets: Buffer[], perPage = 255): Buffer {
  const pages: Buffer[] = [];
  let sequence = 0;
  packets.forEach((packet, index) => {
    const segments: Buffer[] = [];
    for (let at = 0; ; at += 255) {
      segments.push(packet.subarray(at, at + 255));
      if (packet.length - at < 255) break;
    }
    for (let at = 0; at < segments.length; at += perPage) {
      const type = (index === 0 ? 2 : 0) | (at ? 1 : 0) | (index === packets.length - 1 && at + perPage >= segments.length ? 4 : 0);
      pages.push(oggPage(serial, sequence++, type, index > 1 ? 960 * (index - 1) : 0, segments.slice(at, at + perPage)));
    }
  });
  return Buffer.concat(pages);
}
export const OPUS_PACKETS = [Buffer.alloc(120, 0x55), Buffer.alloc(80, 0x66)];
/**
 * An Ogg Opus file: its head, its tags (a title and a location, and a picture that makes them span three pages), its
 * sound. The tags' pages are laid out 40 segments at a time.
 */
export const taggedOpus = () => {
  const vendor = latin("libopus 1.5"), comments = [`TITLE=Recording at ${PLACE}`, `LOCATION=${PLACE}`, `METADATA_BLOCK_PICTURE=${"A".repeat(20000)}${PLACE}`].map(latin);
  const tags = Buffer.concat([latin("OpusTags"), u32le(vendor.length), vendor, u32le(comments.length), ...comments.flatMap((c) => [u32le(c.length), c])]);
  return oggStream(0x1234, [Buffer.concat([latin("OpusHead"), Buffer.from([1, 1, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, 0])]), tags, ...OPUS_PACKETS], 40);
};
/** An Ogg Vorbis file: its identification, comment (with the framing bit) and setup headers, then sound. */
export const taggedVorbis = () => {
  const comment = Buffer.concat([Buffer.from([3]), latin("vorbis"), vorbisComment(true)]);
  return oggStream(0x99, [Buffer.concat([Buffer.from([1]), latin("vorbis"), Buffer.alloc(23, 1)]), comment, Buffer.concat([Buffer.from([5]), latin("vorbis"), Buffer.alloc(300, 2)]), ...OPUS_PACKETS]);
};
/**
 * FLAC in Ogg, as `ffmpeg -c copy` writes a FLAC into an `.oga`: its first packet the mapping's header with the stream
 * info, then one metadata block a packet (a Vorbis comment, a picture, the last one flagged), then its frames.
 */
export const taggedOggFlac = () => {
  const head = Buffer.concat([latin("\x7fFLAC"), Buffer.from([1, 0, 0, 2]), latin("fLaC"), flacBlock(0, false, Buffer.alloc(34, 3))]);
  const picture = flacBlock(6, true, Buffer.concat([u32be(3), u32be(9), latin("image/png"), u32be(PLACE.length), latin(PLACE), Buffer.alloc(20)]));
  return oggStream(0x77, [head, flacBlock(4, false, vorbisComment(false)), picture, FLAC_FRAMES, FLAC_FRAMES]);
};
/** An Ogg Theora video with a Vorbis sound track: Theora's comment header (Vorbis's, no framing bit) names the place too. */
export const taggedTheora = () => {
  const comment = Buffer.concat([latin("\x81theora"), vorbisComment(false)]);
  const theora = oggStream(0x55, [Buffer.concat([latin("\x80theora"), Buffer.alloc(35, 1)]), comment, Buffer.concat([latin("\x82theora"), Buffer.alloc(200, 2)]), ...OPUS_PACKETS]);
  return Buffer.concat([theora, taggedVorbis()]);
};

/**
 * An RF64 (or BW64) WAV: `ds64` first with the sizes, `data`'s size all ones there; a broadcast `bext` before the sound
 * and an INFO list after it say where.
 */
export const taggedRf64 = (magic: "RF64" | "BW64" = "RF64") => {
  const u64le = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const inam = chunk("INAM", latin(`${PLACE}\0`));
  const rest = Buffer.concat([chunk("fmt ", Buffer.alloc(16, 1)), chunk("bext", Buffer.concat([latin(`Recorder at ${PLACE}`.padEnd(256, "\0")), Buffer.alloc(346)]))]);
  const data = Buffer.concat([latin("data"), u32le(0xffffffff), WAV_DATA]);
  const after = chunk("LIST", Buffer.concat([latin("INFO"), inam]));
  const ds64Size = 28, riffSize = 4 + 8 + ds64Size + rest.length + data.length + after.length;
  const ds64 = chunk("ds64", Buffer.concat([u64le(riffSize), u64le(WAV_DATA.length), u64le(WAV_DATA.length / 2), u32le(0)]));
  return Buffer.concat([latin(magic), u32le(0xffffffff), latin("WAVE"), ds64, rest, data, after]);
};

/** An MP3 cut from a stream: junk before its first frame, then its frames, an APEv2 and an ID3v1 tag. */
export const junkFirstMp3 = () => Buffer.concat([Buffer.alloc(300), Buffer.from([0x12, 0x34]), MP3_FRAMES, apev2(), id3v1()]);

/** Matroska/WebM: an element of `id` (its bytes as written) holding `parts`; `unknown` writes its size as unknown. */
const ebml = (id: number[], parts: Buffer[], unknown = false) => {
  const body = Buffer.concat(parts);
  const size = unknown ? Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) : Buffer.concat([Buffer.from([0x01]), Buffer.from(body.length.toString(16).padStart(14, "0"), "hex")]);
  return Buffer.concat([Buffer.from(id), size, body]);
};
const str = (id: number[], s: string) => ebml(id, [latin(s)]);
export const WEBM_BLOCK = Buffer.concat([Buffer.from([0x81, 0, 0, 0x80]), Buffer.alloc(300, 0x77)]);
/**
 * A WebM as a tool that copies tags writes it: its title, date, track name and a `Tags` element that say where (one
 * the SeekHead points to), a cluster of unknown size as MediaRecorder writes them.
 */
export const taggedWebm = () => {
  const head = ebml([0x1a, 0x45, 0xdf, 0xa3], [str([0x42, 0x82], "webm")]);
  const tags = ebml([0x12, 0x54, 0xc3, 0x67], [ebml([0x73, 0x73], [ebml([0x67, 0xc8], [str([0x45, 0xa3], "LOCATION"), str([0x44, 0x87], PLACE)])])]);
  const info = ebml([0x15, 0x49, 0xa9, 0x66], [ebml([0x2a, 0xd7, 0xb1], [Buffer.from([0x0f, 0x42, 0x40])]), str([0x4d, 0x80], "Lavf61"), str([0x57, 0x41], `Recorder ${PLACE}`),
    str([0x7b, 0xa9], `Recording at ${PLACE}`), ebml([0x44, 0x61], [Buffer.alloc(8, 1)]), ebml([0x44, 0x89], [Buffer.from([0x44, 0x7a, 0, 0])])]);
  const tracks = ebml([0x16, 0x54, 0xae, 0x6b], [ebml([0xae], [ebml([0xd7], [Buffer.from([1])]), str([0x86], "A_OPUS"), str([0x53, 0x6e], PLACE)])]);
  const cluster = ebml([0x1f, 0x43, 0xb6, 0x75], [ebml([0xe7], [Buffer.from([0])]), ebml([0xa3], [WEBM_BLOCK]), ebml([0xa3], [WEBM_BLOCK])], true);
  const seek = (target: number[], position: number) => ebml([0x4d, 0xbb], [ebml([0x53, 0xab], [Buffer.from(target)]), ebml([0x53, 0xac], [u32be(position)])]);
  const seekHead = (tagsAt: number) => ebml([0x11, 0x4d, 0x9b, 0x74], [seek([0x15, 0x49, 0xa9, 0x66], 0), seek([0x12, 0x54, 0xc3, 0x67], tagsAt)]);
  // Tags after the cluster: a cluster of unknown size ends where an element that is not its child starts.
  const tagsAt = seekHead(0).length + info.length + tracks.length + cluster.length;
  return Buffer.concat([head, ebml([0x18, 0x53, 0x80, 0x67], [seekHead(tagsAt), info, tracks, cluster, tags], true)]);
};

/** An M4A: a movie with a sound track alone (`soun`), a `©xyz` in its `udta`. */
export const taggedM4a = () => {
  const head = box("ftyp", latin("M4A \0\0\0\0M4A isom"));
  const moov = (offset: number) => box("moov", box("mvhd", Buffer.alloc(100)), metadataTrack(offset, 4, "soun"), xyzUdta());
  return Buffer.concat([head, moov(head.length + moov(0).length + 8), box("mdat", latin("aac!"))]);
};
