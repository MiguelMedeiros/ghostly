/**
 * What a picture leaves with. A photo's file says more than its pixels: its Exif and XMP hold where it was taken, the
 * device, the time, often a thumbnail of the uncropped original. The sender removes them before the file is stored and
 * its digest computed, so what the contact (or anyone in a community) receives is the picture alone: JPEG, PNG, WebP
 * and HEIF (HEIC, AVIF), without decoding or re-encoding a pixel.
 *
 * Fail-closed: a file that is one of these pictures, by its bytes or by its type, and whose metadata cannot be removed
 * (truncated, malformed, a part this does not know) is refused with `NO_PICTURE_METADATA`, never sent as it was. So is
 * a JPEG XL or a JPEG 2000 in its boxes (their Exif, XMP and GeoJP2 boxes are not removed here). Any other file goes
 * as it is.
 */
import { exifOrientation } from "./image";

export const PICTURE_METADATA_LIMITS = {
  /** The largest picture read whole to remove its metadata: past this it is refused. */
  maxBytes: 256 * 1024 * 1024,
  /** Bytes read first to tell a picture from another file. */
  headBytes: 64,
} as const;

/** Why a picture is refused: its metadata could not be removed, so it does not go at all. */
export const NO_PICTURE_METADATA = "This picture cannot be sent: Ghostly could not remove the details saved in it, like where it was taken";

/** The types of the pictures stripped here: a file of one of them whose bytes are not that picture is refused. */
const STRIPPED_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/pjpeg", "image/png", "image/apng", "image/webp",
  "image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence", "image/avif", "image/gif", "image/tiff", "image/tiff-fx",
]);

/** HEIF brands (HEIC, AVIF, the generic `mif1`): an MP4 video's `ftyp` names none of them. */
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "mif2", "msf1", "avif", "avis"]);

type Kind = "jpeg" | "png" | "webp" | "heif" | "gif" | "tiff" | "boxes";

/** The signature box a JPEG XL (`JXL `) or a JPEG 2000 (`jP  `) in boxes starts with. */
const SIGNATURE_BOXES = new Set(["JXL ", "jP  "]);

const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const u32le = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const text = (b: Uint8Array, at: number, length: number) => String.fromCharCode(...b.subarray(at, at + length));
const starts = (b: Uint8Array, at: number, prefix: string) => at + prefix.length <= b.length && text(b, at, prefix.length) === prefix;

/** A picture this strips, by its first bytes. */
function kindOf(b: Uint8Array): Kind | undefined {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b[0] === 0x89 && starts(b, 1, "PNG\r\n\x1a\n")) return "png";
  if (b.length >= 12 && starts(b, 0, "RIFF") && starts(b, 8, "WEBP")) return "webp";
  if (starts(b, 0, "GIF87a") || starts(b, 0, "GIF89a")) return "gif";
  // TIFF, and BigTIFF (refused): camera raw files (DNG, CR2, NEF, ARW) are TIFF too.
  if (starts(b, 0, "II*\0") || starts(b, 0, "MM\0*") || starts(b, 0, "II+\0") || starts(b, 0, "MM\0+")) return "tiff";
  if (b.length >= 12 && u32be(b, 0) === 12 && SIGNATURE_BOXES.has(text(b, 4, 4)) && u32be(b, 8) === 0x0d0a870a) return "boxes";
  if (b.length >= 16 && starts(b, 4, "ftyp")) {
    const end = Math.min(b.length, u32be(b, 0));
    for (let at = 8; at + 4 <= end; at += 4) if (at !== 12 && HEIF_BRANDS.has(text(b, at, 4))) return "heif";
  }
  return undefined;
}

/** Refuses the picture where its bytes are not what this expects. */
function check(ok: boolean): asserts ok {
  if (!ok) throw new Error(NO_PICTURE_METADATA);
}

// JPEG: the segments that draw the picture stay (frames, tables, scans, restart intervals, JFIF without its thumbnail,
// the ICC profile, Adobe's colour transform) and the camera's Orientation, alone in an Exif of its own; every other
// APPn (Exif, XMP, IPTC, MPF), comments, and whatever follows the image's end (a gain map, a motion photo's video) go.
// As Android's Camera strips its photos (CameraPhoto.kt).

/** SOFn markers: every frame type but DHT (C4), JPG (C8) and DAC (CC). */
const JPEG_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegKeeps(marker: number, b: Uint8Array, payload: number): boolean {
  if ((marker >= 0xc0 && marker <= 0xcf) || (marker >= 0xda && marker <= 0xdf)) return true;
  if (marker === 0xe0) return starts(b, payload, "JFIF\0");
  if (marker === 0xe2) return starts(b, payload, "ICC_PROFILE\0");
  if (marker === 0xee) return starts(b, payload, "Adobe");
  return false;
}

/** An Exif (its TIFF), big-endian, whose IFD0 holds `orientation` alone: all a picture keeps of its Exif. */
const orientationTiff = (orientation: number) => Uint8Array.of(
  0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0,
);

/** An APP1 Exif whose IFD0 holds `orientation` alone. */
const orientationOnly = (orientation: number) => Uint8Array.of(0xff, 0xe1, 0, 34, 0x45, 0x78, 0x69, 0x66, 0, 0, ...orientationTiff(orientation));

function stripJpeg(b: Uint8Array): Uint8Array[] {
  const parts = [b.subarray(0, 2)];
  let at = 2, framed = false, scanned = false, exif = false;
  for (;;) {
    check(at < b.length && b[at] === 0xff);
    while (at < b.length && b[at] === 0xff) at++;
    check(at < b.length);
    const marker = b[at++]!;
    if (marker === 0xd9) {
      check(framed && scanned);
      parts.push(Uint8Array.of(0xff, 0xd9));
      return parts;
    }
    // TEM and restarts stand alone.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { parts.push(Uint8Array.of(0xff, marker)); continue; }
    check(marker !== 0x00 && marker !== 0xd8 && at + 2 <= b.length);
    const length = u16be(b, at);
    check(length >= 2 && at + length <= b.length);
    if (marker === 0xe0 && length > 16 && starts(b, at + 2, "JFIF\0")) {
      // JFIF's header without its thumbnail: no thumbnail's width and height, and no pixels after them.
      parts.push(Uint8Array.of(0xff, 0xe0, 0, 16, ...b.subarray(at + 2, at + 14), 0, 0));
    } else if (jpegKeeps(marker, b, at + 2)) {
      parts.push(Uint8Array.of(0xff, marker), b.subarray(at, at + length));
      if (JPEG_FRAME.has(marker)) framed = true;
    } else if (marker === 0xe1 && !scanned && !exif && starts(b, at + 2, "Exif\0\0")) {
      exif = true;
      const orientation = exifOrientation(b, at + 8, at + length);
      if (orientation >= 2) parts.push(orientationOnly(orientation));
    }
    at += length;
    if (marker !== 0xda) continue;
    check(framed);
    scanned = true;
    // The scan's image data, where FF 00 is a data byte and FF D0 to D7 a restart, up to the marker that ends it.
    let end = at;
    for (;;) {
      end = b.indexOf(0xff, end);
      check(end >= 0);
      let next = end + 1;
      while (next < b.length && b[next] === 0xff) next++;
      check(next < b.length);
      if (b[next] !== 0x00 && !(b[next]! >= 0xd0 && b[next]! <= 0xd7)) break;
      end = next + 1;
    }
    parts.push(b.subarray(at, end));
    at = end;
  }
}

// PNG: the critical chunks and the ancillary ones that change how it is drawn (transparency, colour, animation)
// stay, and the camera's Orientation, alone in an eXIf of its own before the image data; text (tEXt, iTXt, zTXt), the
// rest of the Exif, tIME and every other chunk go, and anything after IEND.

const PNG_CRITICAL = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
const PNG_DRAWS = new Set(["tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "bKGD", "pHYs", "cICP", "mDCV", "cLLI", "acTL", "fcTL", "fdAT"]);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

/** A PNG chunk: its length, type, data and the CRC of its type and data. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let crc = ~0;
  for (const byte of out.subarray(4, 8 + data.length)) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  view.setUint32(8 + data.length, ~crc >>> 0);
  return out;
}

function stripPng(b: Uint8Array): Uint8Array[] {
  const parts = [b.subarray(0, 8)];
  let at = 8, exif = false, imaged = false;
  for (;;) {
    check(at + 12 <= b.length);
    const length = u32be(b, at), type = text(b, at + 4, 4);
    check(at + 12 + length <= b.length && (at > 8 || type === "IHDR"));
    // A critical chunk this does not know (its first letter upper case) may hold anything a decoder needs.
    const critical = (b[at + 4]! & 0x20) === 0;
    check(!critical || PNG_CRITICAL.has(type));
    if (critical || PNG_DRAWS.has(type)) parts.push(b.subarray(at, at + 12 + length));
    else if (type === "eXIf" && !exif && !imaged) {
      // The first one, read before the image data as browsers do; its Orientation alone, where it was.
      exif = true;
      const orientation = exifOrientation(b, at + 8, at + 8 + length);
      if (orientation >= 2) parts.push(pngChunk("eXIf", orientationTiff(orientation)));
    }
    if (type === "IDAT") imaged = true;
    at += 12 + length;
    if (type === "IEND") return parts;
  }
}

// WebP: the image, its alpha, animation and ICC profile stay, and the camera's Orientation, alone in an EXIF of its
// own; XMP, the rest of the Exif and unknown chunks go, and VP8X says it has an EXIF only when one is left.

const WEBP_KEEPS = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP"]);

function stripWebp(b: Uint8Array): Uint8Array[] {
  check(b.length >= 20);
  const riffEnd = 8 + u32le(b, 4);
  check(riffEnd <= b.length && riffEnd % 2 === 0);
  const parts: Uint8Array[] = [];
  let at = 12, size = 4, drawn = false, exif = false, vp8x: Uint8Array | undefined;
  while (at < riffEnd) {
    check(at + 8 <= riffEnd);
    const type = text(b, at, 4), length = u32le(b, at + 4), end = at + 8 + length + (length & 1);
    check(end <= riffEnd && (at > 12 || type === "VP8 " || type === "VP8L" || type === "VP8X"));
    let chunk: Uint8Array | undefined;
    if (WEBP_KEEPS.has(type)) {
      chunk = b.subarray(at, end);
      if (type === "VP8X") {
        check(length >= 10);
        // Its flags: EXIF (0x08) and XMP (0x04) are gone, until an Orientation is kept.
        chunk = vp8x = chunk.slice();
        chunk[8] = chunk[8]! & ~0x0c;
      }
      if (type === "VP8 " || type === "VP8L" || type === "ANMF") drawn = true;
    } else if (type === "EXIF" && !exif && vp8x) {
      // The first one, in an extended WebP (a simple one has none); some writers put JPEG's "Exif\0\0" before its TIFF.
      exif = true;
      const tiff = starts(b, at + 8, "Exif\0\0") ? at + 14 : at + 8;
      const orientation = exifOrientation(b, tiff, at + 8 + length);
      if (orientation >= 2) {
        const data = orientationTiff(orientation);
        chunk = new Uint8Array(8 + data.length);
        chunk.set([0x45, 0x58, 0x49, 0x46, data.length]);
        chunk.set(data, 8);
        vp8x[8] = vp8x[8]! | 0x08;
      }
    }
    if (chunk) {
      parts.push(chunk);
      size += chunk.length;
    }
    at = end;
  }
  check(drawn);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 12));
  new DataView(header.buffer).setUint32(4, size, true);
  return [header, ...parts];
}

// HEIF (HEIC, AVIF): its Exif and XMP are items of the `meta` box whose bytes sit elsewhere in the file. They are
// overwritten with zeros where they are, so no offset in the file moves, and so are the bodies of `free` and `skip`
// boxes (an editor's leftovers), their headers kept. The item properties (`iprp`'s `ipco`) that say what the picture
// is about rather than how it is drawn are zeroed the same way: they stay where they are, as `ipma` points at them by
// position. A part this does not know, at the top, in `meta` or among the properties (a video track, an XML box, a
// `uuid` box, camera parameters), or a picture's bytes inside a `free` or `skip` box, refuses the picture.

const HEIF_TOP = new Set(["ftyp", "meta", "mdat", "free", "skip"]);
const HEIF_META = new Set(["hdlr", "dinf", "pitm", "iloc", "iinf", "iref", "iprp", "idat", "grpl", "free", "skip"]);
/** Items that hold metadata: Exif, and XMP (or any other document) as a MIME item. */
const HEIF_METADATA_ITEMS = new Set(["Exif", "mime", "uri "]);
/**
 * Item properties that only draw the picture: the codec's configuration (HEVC, AV1, AVC, VVC, JPEG, JPEG 2000,
 * uncompressed and its components, layered HEVC with its operating points and layers), the size (`ispe`), the bits
 * per channel (`pixi`), colour (`colr`, its light levels and display volumes `clli`, `mdcv`, `cclv`, `amve`), geometry
 * (`irot`, `imir`, `clap`, `pasp`, `rloc`, `iscl`), what an auxiliary image is (`auxC`: alpha, depth, a gain map), and
 * AV1's operating point and layers (`a1op`, `a1lx`).
 */
const HEIF_DRAWS = new Set([
  "hvcC", "av1C", "avcC", "vvcC", "jpgC", "j2kH", "uncC", "cmpd", "lhvC", "oinf", "tols", "lsel",
  "ispe", "pixi", "colr", "clli", "mdcv", "cclv", "amve", "irot", "imir", "clap", "pasp", "rloc", "iscl", "auxC", "a1op", "a1lx",
]);
/** Item properties about the picture: its user description (name, description, tags), accessibility text, creation and modification times, TAI clock and timestamp; and `free`, `skip`. */
const HEIF_ABOUT = new Set(["udes", "altt", "crtt", "mdft", "taic", "itai", "free", "skip"]);

interface Box { type: string; start: number; body: number; end: number }

function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const found: Box[] = [];
  for (let at = start; at < end;) {
    check(at + 8 <= end);
    let size = u32be(b, at), body = at + 8;
    const type = text(b, at + 4, 4);
    if (size === 1) {
      check(at + 16 <= end);
      size = u32be(b, at + 8) * 2 ** 32 + u32be(b, at + 12);
      body = at + 16;
    } else if (size === 0) size = end - at;
    if (type === "uuid") body += 16;
    check(size >= body - at && at + size <= end);
    found.push({ type, start: at, body, end: at + size });
    at += size;
  }
  return found;
}

function stripHeif(b: Uint8Array): Uint8Array[] {
  const top = boxes(b, 0, b.length);
  check(top[0]?.type === "ftyp" && top.every((box) => HEIF_TOP.has(box.type)));
  const metas = top.filter((box) => box.type === "meta");
  check(metas.length === 1);
  const meta = metas[0]!;
  // A FullBox: version and flags first.
  const children = boxes(b, meta.body + 4, meta.end);
  check(children.every((box) => HEIF_META.has(box.type)));
  const one = (type: string) => {
    const of = children.filter((box) => box.type === type);
    check(of.length <= 1);
    return of[0];
  };
  const iinf = one("iinf"), iloc = one("iloc"), idat = one("idat");
  check(!!iinf && !!iloc);

  // The metadata items, by id.
  const metadata = new Set<number>();
  const infeVersion = b[iinf.body]!;
  const entries = boxes(b, iinf.body + 4 + (infeVersion === 0 ? 2 : 4), iinf.end);
  for (const infe of entries) {
    check(infe.type === "infe" && infe.body + 4 <= infe.end);
    const version = b[infe.body]!;
    // Versions 0 and 1 have no item type: this cannot tell what they hold.
    check(version === 2 || version === 3);
    let at = infe.body + 4;
    const id = version === 2 ? u16be(b, at) : u32be(b, at);
    at += version === 2 ? 2 : 4;
    check(at + 6 <= infe.end);
    if (HEIF_METADATA_ITEMS.has(text(b, at + 2, 4))) metadata.add(id);
  }

  // The item properties: one `ipco`, and the `ipma` that associate them with items.
  const iprp = one("iprp"), properties: Box[] = [];
  if (iprp) {
    const held = boxes(b, iprp.body, iprp.end);
    const ipco = held.filter((box) => box.type === "ipco");
    check(ipco.length === 1 && held.every((box) => box.type === "ipco" || box.type === "ipma"));
    properties.push(...boxes(b, ipco[0]!.body, ipco[0]!.end));
    check(properties.every((box) => HEIF_DRAWS.has(box.type) || HEIF_ABOUT.has(box.type)));
  }

  /** `free` and `skip` boxes, at the top and in `meta`, and the properties about the picture: their bodies go as zeros. */
  const space = [
    ...[...top, ...children].filter((box) => box.type === "free" || box.type === "skip"),
    ...properties.filter((box) => HEIF_ABOUT.has(box.type)),
  ];

  // Where their bytes are (iloc), overwritten in a copy.
  const out = b.slice();
  const version = b[iloc.body]!;
  check(version <= 2);
  let at = iloc.body + 4;
  /** The next field of `size` bytes (0, 2, 4 or 8), big-endian. */
  const read = (size: number): number => {
    check(at + size <= iloc.end);
    const value = size === 0 ? 0 : size === 2 ? u16be(b, at) : size === 4 ? u32be(b, at) : size === 8 ? u32be(b, at) * 2 ** 32 + u32be(b, at + 4) : NaN;
    check(Number.isSafeInteger(value));
    at += size;
    return value;
  };
  const read2 = () => read(2);
  check(at + 2 <= iloc.end);
  const offsetSize = b[at]! >> 4, lengthSize = b[at]! & 15, baseSize = b[at + 1]! >> 4, indexSize = version > 0 ? b[at + 1]! & 15 : 0;
  check([offsetSize, lengthSize, baseSize, indexSize].every((size) => size === 0 || size === 4 || size === 8));
  at += 2;
  const count = read(version < 2 ? 2 : 4);
  for (let i = 0; i < count; i++) {
    const id = version < 2 ? read2() : read(4);
    const method = version > 0 ? read2() & 15 : 0;
    const reference = read2();
    const base = read(baseSize);
    const extents = read2();
    for (let e = 0; e < extents; e++) {
      if (indexSize) read(indexSize);
      const offset = read(offsetSize), length = read(lengthSize);
      if (!metadata.has(id)) {
        // The picture's bytes (to the file's end for a length of 0) are in no space zeroed below.
        const start = base + offset, end = length ? start + length : b.length;
        check(reference !== 0 || method !== 0 || !space.some((box) => start < box.end && end > box.body));
        continue;
      }
      // Its bytes in this file (0) or in `idat` (1): a length of 0 (to the end) or another file, refused.
      check(reference === 0 && length > 0 && (method === 0 || (method === 1 && !!idat)));
      const start = (method === 1 ? idat!.body : 0) + base + offset, limit = method === 1 ? idat!.end : b.length;
      check(start + length <= limit);
      out.fill(0, start, start + length);
    }
  }
  for (const box of space) out.fill(0, box.body, box.end);
  return [out];
}

// GIF: the frames, their colour tables and timing (graphic control, plain text), the animation's loop (NETSCAPE2.0,
// ANIMEXTS1.0) and its ICC profile stay byte for byte; comments, XMP and every other application extension go, and
// whatever follows its end.

const GIF_APPS_KEPT = new Set(["NETSCAPE2.0", "ANIMEXTS1.0", "ICCRGBG1012"]);

function stripGif(b: Uint8Array): Uint8Array[] {
  check(b.length >= 13);
  /** A colour table's bytes, from the flags that say it is there and its size. */
  const table = (flags: number) => (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);
  /** The end of the data sub-blocks at `at`, past their empty block. */
  const blocks = (at: number) => {
    for (;;) {
      check(at < b.length);
      const length = b[at]!;
      at += 1 + length;
      if (!length) return at;
    }
  };
  let at = 13 + table(b[10]!), framed = false;
  check(at <= b.length);
  const parts = [b.subarray(0, at)];
  for (;;) {
    check(at < b.length);
    const introducer = b[at]!;
    if (introducer === 0x3b) {
      check(framed);
      parts.push(Uint8Array.of(0x3b));
      return parts;
    }
    if (introducer === 0x2c) {
      // Image descriptor, its local colour table, the LZW code size, the image data.
      check(at + 10 <= b.length);
      const data = at + 10 + table(b[at + 9]!);
      check(data < b.length);
      const end = blocks(data + 1);
      parts.push(b.subarray(at, end));
      framed = true;
      at = end;
      continue;
    }
    check(introducer === 0x21 && at + 2 < b.length);
    const label = b[at + 1]!, end = blocks(at + 2);
    const app = label === 0xff && b[at + 2] === 11 && GIF_APPS_KEPT.has(text(b, at + 3, 11));
    if (label === 0xf9 || label === 0x01 || app) parts.push(b.subarray(at, end));
    else check(label === 0xfe || label === 0xff);
    at = end;
  }
}

// TIFF: what draws it stays where it is (size, strips or tiles, colour, Orientation, ICC profile); its text tags (Make,
// Model, DateTime, Artist, Software, its description), XMP, IPTC and Photoshop's resources are overwritten with zeros
// where they are, the Exif and GPS IFDs zeroed and their pointers taken out of the IFD that holds them (its other
// entries move up in place), so no offset in the file moves. A tag this does not
// know, sub-images, JPEG-compressed data (whose own segments could hold an Exif) or a maker note refuses the picture:
// so camera raw files (DNG, CR2, NEF, ARW), and BigTIFF, are refused.

const TIFF_DRAWS = new Set([
  254, 255, 256, 257, 258, 259, 262, 263, 264, 265, 266, 273, 274, 277, 278, 279, 280, 281, 282, 283, 284, 286, 287, 290,
  291, 292, 293, 296, 297, 301, 317, 318, 319, 320, 321, 322, 323, 324, 325, 332, 334, 336, 338, 339, 340, 341, 529, 530,
  531, 532, 0x8773,
]);
/** Text and documents about the picture: DocumentName to HostComputer, InkNames, XMP, Copyright, IPTC, Photoshop, Windows' XP tags, PrintIM. */
const TIFF_METADATA = new Set([269, 270, 271, 272, 285, 305, 306, 315, 316, 333, 700, 0x8298, 0x83bb, 0x8649, 0x4746, 0x4749, 0x9c9b, 0x9c9c, 0x9c9d, 0x9c9e, 0x9c9f, 0xc4a5]);
/** The IFDs of Exif, GPS and interoperability, emptied whole. */
const TIFF_METADATA_IFDS = new Set([0x8769, 0x8825, 0xa005]);
/** Compression without JPEG: none, CCITT, LZW, Deflate, PackBits. */
const TIFF_COMPRESSION = new Set([1, 2, 3, 4, 5, 8, 32773, 32946]);
/** Bytes per value of each field type. */
const TIFF_TYPE_BYTES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

function stripTiff(b: Uint8Array): Uint8Array[] {
  const little = b[0] === 0x49;
  const u16 = (at: number) => { check(at + 2 <= b.length); return little ? b[at]! | (b[at + 1]! << 8) : u16be(b, at); };
  const u32 = (at: number) => { check(at + 4 <= b.length); return little ? u32le(b, at) : u32be(b, at); };
  check(b.length >= 8 && u16(2) === 42);
  const out = b.slice(), seen = new Set<number>();
  /** An IFD's entries: tag, type, the value's first byte (in the entry or where it points) and its bytes. */
  const entries = (ifd: number) => {
    check(ifd >= 8 && !seen.has(ifd) && seen.size < 1024);
    seen.add(ifd);
    const count = u16(ifd), next = ifd + 2 + count * 12;
    u32(next);
    return {
      next,
      list: Array.from({ length: count }, (_, i) => {
        const at = ifd + 2 + i * 12, tag = u16(at), type = u16(at + 2);
        check(type >= 1 && type < TIFF_TYPE_BYTES.length);
        const bytes = TIFF_TYPE_BYTES[type]! * u32(at + 4);
        const value = bytes <= 4 ? at + 8 : u32(at + 8);
        check(Number.isSafeInteger(bytes) && value + bytes <= b.length);
        return { at, tag, type, value, bytes };
      }),
    };
  };
  /** An Exif, GPS or interoperability IFD: every value zeroed, then the IFD itself, so it holds no entry. */
  const empty = (ifd: number) => {
    const { next, list } = entries(ifd);
    for (const entry of list) {
      check(entry.tag !== 0x927c);
      if (TIFF_METADATA_IFDS.has(entry.tag)) empty(u32(entry.value));
      out.fill(0, entry.value, entry.value + entry.bytes);
    }
    out.fill(0, ifd, next + 4);
  };
  for (let ifd = u32(4); ifd;) {
    const { next, list } = entries(ifd);
    // The entries kept move up over the pointers to the emptied IFDs: libtiff refuses an IFD without an entry.
    let kept = 0;
    for (const { at, tag, value, bytes } of list) {
      if (tag === 259) check(TIFF_COMPRESSION.has(u16(value)));
      if (TIFF_METADATA_IFDS.has(tag)) {
        empty(u32(value));
        continue;
      }
      if (TIFF_METADATA.has(tag)) out.fill(0, value, value + bytes);
      else check(TIFF_DRAWS.has(tag));
      out.copyWithin(ifd + 2 + kept++ * 12, at, at + 12);
    }
    check(kept > 0);
    const end = ifd + 2 + kept * 12;
    out.set(little ? [kept & 0xff, kept >> 8] : [kept >> 8, kept & 0xff], ifd);
    out.set(b.subarray(next, next + 4), end);
    out.fill(0, end + 4, next + 4);
    ifd = u32(next);
  }
  return [out];
}

/** A JPEG XL or a JPEG 2000 in boxes: refused. */
function refuse(): never {
  throw new Error(NO_PICTURE_METADATA);
}

const STRIP: Record<Kind, (b: Uint8Array) => Uint8Array[]> = { jpeg: stripJpeg, png: stripPng, webp: stripWebp, heif: stripHeif, gif: stripGif, tiff: stripTiff, boxes: refuse };

/**
 * A picture's bytes without its metadata, as parts to put in a Blob; undefined when the file is not a picture this
 * strips (by its bytes and its type), so it goes as it is. Throws `NO_PICTURE_METADATA` when it is one but its
 * metadata cannot be removed.
 */
export function stripPictureMetadata(bytes: Uint8Array, mime: string): Uint8Array[] | undefined {
  const kind = kindOf(bytes);
  if (!kind) {
    if (STRIPPED_TYPES.has(mime.split(";")[0]!.trim().toLowerCase())) throw new Error(NO_PICTURE_METADATA);
    return undefined;
  }
  return STRIP[kind](bytes);
}

/**
 * Whether a file is a picture whose metadata goes before it is sent, by its first `PICTURE_METADATA_LIMITS.headBytes`
 * bytes or by its type: then it is read whole and stripped (`stripPictureMetadata`), else it goes as it is.
 */
export function isStrippedPicture(head: Uint8Array, mime: string): boolean {
  return !!kindOf(head) || STRIPPED_TYPES.has(mime.split(";")[0]!.trim().toLowerCase());
}

/**
 * `source` as it is sent: without its metadata when it is a picture (`stripPictureMetadata`), or undefined when it is
 * not one and goes as it is. Only its first bytes are read for any other file. Throws `NO_PICTURE_METADATA` for a
 * picture that cannot be stripped or is past `PICTURE_METADATA_LIMITS.maxBytes`; an error reading `source` as it is.
 */
export async function withoutPictureMetadata(source: Blob, mime: string): Promise<Blob | undefined> {
  const head = new Uint8Array(await source.slice(0, PICTURE_METADATA_LIMITS.headBytes).arrayBuffer());
  if (!isStrippedPicture(head, mime)) return undefined;
  if (source.size > PICTURE_METADATA_LIMITS.maxBytes) throw new Error(NO_PICTURE_METADATA);
  const parts = stripPictureMetadata(new Uint8Array(await source.arrayBuffer()), mime);
  return parts && new Blob(parts as BlobPart[], { type: mime });
}
