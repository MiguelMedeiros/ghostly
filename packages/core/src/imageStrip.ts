/**
 * What a picture says about where and on what it was taken, taken out before it is sent, as Signal does. A photo from a
 * phone's gallery carries its GPS position, the time, the device's make, model and serial number, the owner's name, a
 * thumbnail of the uncropped original and its edit history (EXIF, XMP, IPTC, comments), and all of it would reach the
 * contact and every member of a group.
 *
 * Only the bytes that say it go: the picture's own data is copied as it is, never decoded nor encoded again, so its
 * pixels are the same and the file is never larger. Its colour profile stays, and its orientation, in a minimal EXIF of
 * its own, so it neither fades nor turns sideways. JPEG, PNG, WebP and GIF; a file this does not read (another kind,
 * cut short, malformed) goes as it is: a send is never refused for it.
 */
import { isImageMime } from "./image";

/** How much of the file is read at a time: its structure is walked, the file is never read whole into memory. */
const WINDOW = 1024 * 1024;

/** A file's bytes, a window at a time. */
class Bytes {
  private start = 0;
  private window = new Uint8Array(0);
  constructor(private readonly source: Blob) {}

  get size(): number { return this.source.size; }

  /** `n` bytes at `at`; a file that ends before them is not one this reads. */
  async get(at: number, n: number): Promise<Uint8Array> {
    if (at < 0 || n < 0 || at + n > this.source.size) throw new RangeError("Past the end of the file");
    if (at < this.start || at + n > this.start + this.window.length) {
      this.start = at;
      this.window = new Uint8Array(await this.source.slice(at, Math.min(this.source.size, at + Math.max(n, WINDOW))).arrayBuffer());
    }
    return this.window.subarray(at - this.start, at - this.start + n);
  }

  async byte(at: number): Promise<number> { return (await this.get(at, 1))[0]!; }

  /** The bytes from `at` to the end of the window that holds it: at least one, before the end of the file. */
  async from(at: number): Promise<Uint8Array> {
    if (at < this.start || at >= this.start + this.window.length) await this.get(at, 1);
    return this.window.subarray(at - this.start);
  }
}

/** The file as it is sent: the source's bytes it keeps, in order, and the few this writes. */
class Kept {
  readonly parts: BlobPart[] = [];
  /** Its length so far. */
  length = 0;
  /** Whether anything was left out or written. */
  changed = false;
  private from = 0;
  private to = 0;
  constructor(readonly source: Blob) {}

  keep(from: number, to: number): void {
    if (to <= from) return;
    if (from !== this.to) { this.flush(); this.from = from; }
    this.to = to;
    this.length += to - from;
  }

  write(bytes: Uint8Array<ArrayBuffer>): void {
    this.flush();
    this.parts.push(bytes);
    this.length += bytes.length;
    this.changed = true;
  }

  drop(): void { this.changed = true; }

  flush(): void {
    if (this.to > this.from) this.parts.push(this.source.slice(this.from, this.to));
    this.from = this.to;
  }
}

const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const u32le = (b: Uint8Array, at: number) => b[at]! + (b[at + 1]! << 8) + (b[at + 2]! << 16) + ((b[at + 3]! << 24) >>> 0);
const ascii = (b: Uint8Array, at: number, text: string) => at + text.length <= b.length && [...text].every((c, i) => b[at + i] === c.charCodeAt(0));
const text = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const latin1 = (s: string) => [...s].map((c) => c.charCodeAt(0));

const EXIF = "Exif\0\0";

/** The orientation a TIFF block (an EXIF's body) says, 1 when it says none. */
function tiffOrientation(b: Uint8Array): number {
  if (b.length < 8) return 1;
  const little = ascii(b, 0, "II");
  if (!little && !ascii(b, 0, "MM")) return 1;
  const u16 = (at: number) => (little ? b[at]! | (b[at + 1]! << 8) : u16be(b, at));
  const u32 = (at: number) => (little ? u32le(b, at) : u32be(b, at));
  if (u16(2) !== 42) return 1;
  const ifd = u32(4);
  if (ifd + 2 > b.length) return 1;
  for (let i = 0, count = u16(ifd); i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > b.length) return 1;
    if (u16(entry) === 0x0112) { const value = u16(entry + 8); return value >= 1 && value <= 8 ? value : 1; }
  }
  return 1;
}

/** A TIFF block that says the orientation and nothing else: one entry in its first IFD. */
const orientationTiff = (orientation: number) =>
  [0x4d, 0x4d, 0, 42, ...be32(8), 0, 1, 0x01, 0x12, 0, 3, ...be32(1), 0, orientation, 0, 0, ...be32(0)];

// JPEG: its segments up to the image data, each kept or left out by its marker and what it starts with.

const JPEG_STANDALONE = (marker: number) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);

/** Where the entropy-coded data that starts at `at` ends: the next marker, or the end of the file. */
async function scanEnd(bytes: Bytes, at: number): Promise<number> {
  for (let p = at; p + 1 < bytes.size;) {
    const window = await bytes.from(p);
    const ff = window.indexOf(0xff);
    if (ff < 0) { p += window.length; continue; }
    p += ff;
    if (p + 1 >= bytes.size) break;
    const next = await bytes.byte(p + 1);
    // A stuffed 0xFF, a restart marker, or fill before a marker.
    if (next === 0x00 || JPEG_STANDALONE(next)) p += 2;
    else if (next === 0xff) p += 1;
    else return p;
  }
  return bytes.size;
}

async function jpeg(bytes: Bytes, out: Kept): Promise<void> {
  out.keep(0, 2);
  let at = 2, exifSeen = false;
  while (at < bytes.size) {
    const [ff, marker] = await bytes.get(at, 2);
    if (ff !== 0xff) throw new Error("Not a JPEG marker");
    if (marker === 0xff) { out.keep(at, at + 1); at += 1; continue; }
    if (marker === 0xd9) { out.keep(at, at + 2); at += 2; break; }
    if (JPEG_STANDALONE(marker!)) { out.keep(at, at + 2); at += 2; continue; }
    const length = u16be(await bytes.get(at + 2, 2), 0);
    if (length < 2) throw new Error("A JPEG segment shorter than its length");
    const end = at + 2 + length;
    if (end > bytes.size) throw new Error("A JPEG segment past the end of the file");
    if (marker === 0xda) {
      // A scan: its header, then its data up to the next marker.
      const next = await scanEnd(bytes, end);
      out.keep(at, next);
      at = next;
      continue;
    }
    const body = await bytes.get(at + 4, length - 2);
    if (marker === 0xe0 && ascii(body, 0, "JFIF\0") && body.length >= 14) {
      // JFIF, without the thumbnail it may hold.
      if (body[12] || body[13]) out.write(new Uint8Array([0xff, 0xe0, 0, 16, ...body.subarray(0, 12), 0, 0]));
      else out.keep(at, end);
    } else if (marker === 0xe1) {
      // EXIF or XMP: the first EXIF's orientation stays, alone.
      const orientation = !exifSeen && ascii(body, 0, EXIF) ? tiffOrientation(body.subarray(EXIF.length)) : 1;
      exifSeen ||= ascii(body, 0, EXIF);
      if (orientation !== 1) {
        const tiff = orientationTiff(orientation);
        out.write(new Uint8Array([0xff, 0xe1, 0, 2 + EXIF.length + tiff.length, ...latin1(EXIF), ...tiff]));
      } else out.drop();
    } else if ((marker === 0xe2 && ascii(body, 0, "ICC_PROFILE\0")) || (marker === 0xee && ascii(body, 0, "Adobe"))) {
      // The colour profile, and Adobe's colour transform the pixels are decoded with.
      out.keep(at, end);
    } else if ((marker! >= 0xe0 && marker! <= 0xef) || marker === 0xfe) {
      // Every other application segment (IPTC, MPF, FlashPix, JUMBF, a maker's own) and comments.
      out.drop();
    } else {
      out.keep(at, end);
    }
    at = end;
  }
  // Past the end of the picture: another picture (MPF, a gain map), a video (a motion photo), or a maker's trailer.
  if (at < bytes.size) out.drop();
}

// PNG: its chunks, until IEND.

const PNG_TEXT = new Set(["tEXt", "iTXt", "zTXt", "tIME"]);

let crcTable: Uint32Array | undefined;
function crc32(bytes: number[]): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function png(bytes: Bytes, out: Kept): Promise<void> {
  out.keep(0, 8);
  let at = 8;
  for (;;) {
    const head = await bytes.get(at, 8);
    const length = u32be(head, 0), type = text(head, 4, 4);
    const end = at + 12 + length;
    if (end > bytes.size) throw new Error("A PNG chunk past the end of the file");
    if (type === "eXIf") {
      const orientation = tiffOrientation(await bytes.get(at + 8, length));
      if (orientation !== 1) {
        const chunk = [...latin1("eXIf"), ...orientationTiff(orientation)];
        out.write(new Uint8Array([...be32(chunk.length - 4), ...chunk, ...be32(crc32(chunk))]));
      } else out.drop();
    } else if (PNG_TEXT.has(type)) out.drop();
    else out.keep(at, end);
    at = end;
    if (type === "IEND") break;
  }
  if (at < bytes.size) out.drop();
}

// WebP: its RIFF chunks, and VP8X's flags for the ones that go.

const WEBP_XMP_FLAG = 0x04, WEBP_EXIF_FLAG = 0x08;

async function webp(bytes: Bytes, out: Kept): Promise<void> {
  const end = Math.min(bytes.size, 8 + u32le(await bytes.get(4, 4), 0));
  const chunks: { at: number; end: number; type: string }[] = [];
  for (let at = 12; at < end;) {
    const head = await bytes.get(at, 8);
    const size = u32le(head, 4);
    const next = at + 8 + size + (size & 1);
    if (at + 8 + size > end) throw new Error("A WebP chunk past the end of the file");
    chunks.push({ at, end: Math.min(next, end), type: text(head, 0, 4) });
    at = next;
  }
  const exif = chunks.find((chunk) => chunk.type === "EXIF");
  let orientation = 1;
  if (exif) {
    const body = await bytes.get(exif.at + 8, u32le(await bytes.get(exif.at + 4, 4), 0));
    // Some writers put EXIF's own header first.
    orientation = tiffOrientation(ascii(body, 0, EXIF) ? body.subarray(EXIF.length) : body);
  }
  // Its chunks first: the RIFF header before them says their length.
  const body = new Kept(out.source);
  for (const chunk of chunks) {
    if (chunk.type === "VP8X") {
      const head = await bytes.get(chunk.at, chunk.end - chunk.at);
      let flags = head[8]!;
      if (chunks.some((c) => c.type === "XMP ")) flags &= ~WEBP_XMP_FLAG;
      if (exif && orientation === 1) flags &= ~WEBP_EXIF_FLAG;
      if (flags === head[8]) body.keep(chunk.at, chunk.end);
      else body.write(new Uint8Array([...head.subarray(0, 8), flags, ...head.subarray(9)]));
    } else if (chunk.type === "EXIF" && orientation !== 1) {
      const tiff = orientationTiff(orientation);
      body.write(new Uint8Array([...latin1("EXIF"), ...le32(tiff.length), ...tiff]));
    } else if (chunk.type === "EXIF" || chunk.type === "XMP ") body.drop();
    else body.keep(chunk.at, chunk.end);
  }
  body.flush();
  if (!body.changed && end === bytes.size) return;
  out.write(new Uint8Array([...latin1("RIFF"), ...le32(4 + body.length), ...latin1("WEBP")]));
  out.parts.push(...body.parts);
  out.length += body.length;
}

// GIF: its blocks, until the trailer.

/** Where the data sub-blocks that start at `at` end, past their terminator. */
async function subBlocks(bytes: Bytes, at: number): Promise<number> {
  for (;;) {
    const n = await bytes.byte(at);
    at += 1 + n;
    if (!n) return at;
  }
}

/** A colour table's length in bytes, when a GIF's packed field says there is one. */
const colourTable = (packed: number) => (packed & 0x80 ? 3 * (2 << (packed & 7)) : 0);

async function gif(bytes: Bytes, out: Kept): Promise<void> {
  let at = 13 + colourTable((await bytes.get(0, 13))[10]!);
  out.keep(0, at);
  for (;;) {
    const kind = await bytes.byte(at);
    if (kind === 0x3b) { out.keep(at, at + 1); at += 1; break; }
    if (kind === 0x2c) {
      // An image: its descriptor, its own colours, the LZW code size, then its data.
      const end = await subBlocks(bytes, at + 10 + colourTable((await bytes.get(at, 10))[9]!) + 1);
      out.keep(at, end);
      at = end;
      continue;
    }
    if (kind !== 0x21) throw new Error("Not a GIF block");
    const label = await bytes.byte(at + 1);
    const end = await subBlocks(bytes, at + 2);
    // Comments, and XMP in an application extension; NETSCAPE2.0 (how many times it loops) stays.
    const xmp = label === 0xff && end - at >= 14 && ascii(await bytes.get(at + 2, 12), 0, "\x0bXMP DataXMP");
    if (label === 0xfe || xmp) out.drop();
    else out.keep(at, end);
    at = end;
  }
  if (at < bytes.size) out.drop();
}

/**
 * The picture without what it says about where and on what it was taken, or `source` itself when it says none, is not
 * a picture (by `mime`), or is not one this reads. It never throws: a picture it cannot read is sent as it is.
 */
export async function withoutImageMetadata(source: Blob, mime: string = source.type): Promise<Blob> {
  if (!isImageMime(mime) || source.size < 16) return source;
  try {
    const bytes = new Bytes(source);
    const head = await bytes.get(0, 16);
    const read = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? jpeg
      : head[0] === 0x89 && ascii(head, 1, "PNG\r\n\x1a\n") ? png
        : ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP") ? webp
          : ascii(head, 0, "GIF87a") || ascii(head, 0, "GIF89a") ? gif
            : undefined;
    if (!read) return source;
    const out = new Kept(source);
    await read(bytes, out);
    out.flush();
    return out.changed ? new Blob(out.parts, { type: source.type }) : source;
  } catch {
    return source;
  }
}
