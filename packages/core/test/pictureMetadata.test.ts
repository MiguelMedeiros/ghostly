import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { exifOrientation, imageSize } from "../src/image";
import { NO_PICTURE_METADATA, PICTURE_METADATA_LIMITS, stripPictureMetadata, withoutPictureMetadata } from "../src/pictureMetadata";
// covers: files.image.metadata

const SECRET = "GHOSTLY-SECRET-GPS 52.37N 4.89E";

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const be16 = (n: number) => [n >> 8, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const joined = (parts: Uint8Array[]) => new Uint8Array(parts.flatMap((part) => [...part]));
const has = (b: Uint8Array, text: string) => Buffer.from(b).includes(Buffer.from(text, "latin1"));
const strip = (b: Uint8Array | number[], mime: string) => joined(stripPictureMetadata(Uint8Array.from(b), mime)!);

// JPEG
const segment = (marker: number, body: number[]) => [0xff, marker, ...be16(body.length + 2), ...body];
/** An APP1 Exif whose IFD0 holds Make (pointing at the secret) and Orientation, big-endian, then the secret. */
function exif(orientation: number): number[] {
  const secret = ascii(SECRET + "\0");
  const entry = (tag: number, type: number, count: number, value: number[]) => [...be16(tag), ...be16(type), ...be32(count), ...value];
  // Header (8) + count (2) + two entries (24) + next IFD (4): the string follows at 38.
  const tiff = [0x4d, 0x4d, 0, 42, ...be32(8), 0, 2, ...entry(0x010f, 2, secret.length, be32(38)), ...entry(0x0112, 3, 1, [0, orientation, 0, 0]), ...be32(0), ...secret];
  return segment(0xe1, [...ascii("Exif\0\0"), ...tiff]);
}
const jfif = segment(0xe0, [...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const icc = segment(0xe2, [...ascii("ICC_PROFILE\0"), 1, 1, 9, 9, 9]);
const dqt = segment(0xdb, [0, ...new Array(64).fill(1)]);
const sof = (width: number, height: number) => segment(0xc0, [8, ...be16(height), ...be16(width), 1, 1, 0x11, 0]);
const dht = segment(0xc4, [0, 0, 1, ...new Array(15).fill(0), 0]);
const sos = segment(0xda, [1, 1, 0, 0, 63, 0]);
/** Scan data with a stuffed FF 00 and a restart, as a decoder reads them. */
const scanData = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78];
const xmp = segment(0xe1, ascii(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${SECRET}</x:xmpmeta>`));
const iptc = segment(0xed, ascii(`Photoshop 3.0\0${SECRET}`));
const comment = segment(0xfe, ascii(SECRET));
const jpeg = (...segments: number[][]) => [0xff, 0xd8, ...segments.flat(), ...sos, ...scanData, 0xff, 0xd9];

// PNG (CRCs are not checked here: a browser draws the stripped file in e2e/web/picture-metadata.spec.ts)
const chunk = (type: string, data: number[]) => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
const ihdr = chunk("IHDR", [...be32(300), ...be32(200), 8, 2, 0, 0, 0]);
const idat = chunk("IDAT", [0x78, 0x9c, 1, 2, 3]);
const iend = chunk("IEND", []);
const pngSignature = [0x89, ...ascii("PNG\r\n\x1a\n")];

// WebP
const riffChunk = (type: string, data: number[]) => [...ascii(type), ...le32(data.length), ...data, ...(data.length & 1 ? [0] : [])];
const riff = (...chunks: number[][]) => [...ascii("RIFF"), ...le32(4 + chunks.flat().length), ...ascii("WEBP"), ...chunks.flat()];
/** VP8X saying ICC, alpha, EXIF and XMP, 300 × 200. */
const vp8x = riffChunk("VP8X", [0x3c, 0, 0, 0, 43, 1, 0, 199, 0, 0]);
const vp8l = riffChunk("VP8L", [0x2f, 43, 0x20, 0x06, 0, 1, 2, 3]);

// HEIF: ftyp, meta (hdlr, iinf with a picture item and an Exif item, iloc), mdat with both.
const box = (type: string, body: number[]) => [...be32(body.length + 8), ...ascii(type), ...body];
const fullBox = (type: string, version: number, body: number[]) => box(type, [version, 0, 0, 0, ...body]);
function heif({ extra = [] as number[][], exifMethod = 0, topExtra = [] as number[][] } = {}): number[] {
  const picture = [0xaa, 0xbb, 0xcc, 0xdd], exifData = [0, 0, 0, 6, ...ascii("Exif\0\0MM"), ...ascii(SECRET)];
  const ftyp = box("ftyp", [...ascii("heic"), 0, 0, 0, 0, ...ascii("mif1heic")]);
  const infe = (id: number, type: string) => fullBox("infe", 2, [...be16(id), 0, 0, ...ascii(type), 0]);
  const iinf = fullBox("iinf", 0, [0, 2, ...infe(1, "hvc1"), ...infe(2, "Exif")]);
  const idat = exifMethod === 1 ? [box("idat", exifData)] : [];
  // iloc v1: offset 4, length 4, base 0, index 0; two items, one extent each. Offsets fixed once the layout is known.
  const iloc = (pictureAt: number, exifAt: number) => fullBox("iloc", 1, [0x44, 0x00, 0, 2,
    0, 1, 0, 0, 0, 0, 0, 1, ...be32(pictureAt), ...be32(picture.length),
    0, 2, 0, exifMethod, 0, 0, 0, 1, ...be32(exifAt), ...be32(exifData.length)]);
  const meta = (at: number[]) => fullBox("meta", 0, [...fullBox("hdlr", 0, [0, 0, 0, 0, ...ascii("pict"), ...new Array(12).fill(0), 0]), ...iinf, ...iloc(at[0]!, at[1]!), ...idat.flat(), ...extra.flat()]);
  const head = [...ftyp, ...meta([0, 0]), ...topExtra.flat()];
  const mdatBody = exifMethod === 1 ? picture : [...picture, ...exifData];
  const start = head.length + 8;
  return [...ftyp, ...meta([start, exifMethod === 1 ? 0 : start + picture.length]), ...topExtra.flat(), ...box("mdat", mdatBody)];
}

// GIF: header, screen (2 × 1, global table of 2 colours), then blocks.
const gifHead = [...ascii("GIF89a"), 2, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
const subBlocks = (data: number[]) => [...(data.length ? [data.length, ...data] : []), 0];
const gifExtension = (label: number, first: number[], rest: number[] = []) => [0x21, label, first.length, ...first, ...subBlocks(rest)];
const gifControl = gifExtension(0xf9, [0, 10, 0, 0]);
const gifLoop = gifExtension(0xff, ascii("NETSCAPE2.0"), [1, 0, 0]);
const gifFrame = [0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0, 2, ...subBlocks([0x4c, 0x01])];

// TIFF, big-endian: IFD0 (size, strips, text tags, Orientation, Exif and GPS pointers), the Exif and GPS IFDs, the strip.
function tiff({ extra = [] as number[][], compression = 1 } = {}): number[] {
  const entry = (tag: number, type: number, count: number, value: number[]) => [...be16(tag), ...be16(type), ...be32(count), ...value];
  const make = ascii(`${SECRET}\0`), gps = ascii(`N\0\0\0`);
  // Layout: header 8, IFD0 at 8 (entries), then values, Exif IFD, GPS IFD, strip.
  const ifd0Count = 9 + extra.length, ifd0End = 8 + 2 + ifd0Count * 12 + 4;
  const makeAt = ifd0End, exifAt = makeAt + make.length, exifSecretAt = exifAt + 2 + 12 + 4, gpsAt = exifSecretAt + make.length, stripAt = gpsAt + 2 + 12 + 4;
  const ifd0 = [...be16(ifd0Count),
    entry(256, 3, 1, [0, 2, 0, 0]), entry(257, 3, 1, [0, 1, 0, 0]), entry(259, 3, 1, [...be16(compression), 0, 0]), entry(271, 2, make.length, be32(makeAt)),
    entry(273, 4, 1, be32(stripAt)), entry(274, 3, 1, [0, 6, 0, 0]), entry(279, 4, 1, be32(2)), entry(0x8769, 4, 1, be32(exifAt)), entry(0x8825, 4, 1, be32(gpsAt)),
    ...extra].flat();
  const exifIfd = [0, 1, ...entry(0x9286, 7, make.length, be32(exifSecretAt)), ...be32(0)];
  const gpsIfd = [0, 1, ...entry(1, 2, 2, gps), ...be32(0)];
  return [0x4d, 0x4d, 0, 42, ...be32(8), ...ifd0, ...be32(0), ...make, ...exifIfd, ...make, ...gpsIfd, 0xab, 0xcd];
}

/** TIFF as macOS `sips` writes it, little-endian: the Exif IFD at 8 (before IFD0), then the strip, then IFD0 last. */
function sipsTiff(): number[] {
  const le16 = (n: number) => [n & 0xff, n >> 8];
  const entry = (tag: number, type: number, count: number, value: number[]) => [...le16(tag), ...le16(type), ...le32(count), ...value];
  const secret = ascii(`${SECRET}\0`);
  const exifAt = 8, secretAt = exifAt + 2 + 2 * 12 + 4, stripAt = secretAt + secret.length, ifd0At = stripAt + 6;
  const exifIfd = [...le16(2), ...entry(0x9003, 2, secret.length, le32(secretAt)), ...entry(0xa002, 4, 1, le32(2)), ...le32(0)];
  const ifd0 = [...le16(9), ...[entry(256, 3, 1, [2, 0, 0, 0]), entry(257, 3, 1, [1, 0, 0, 0]), entry(258, 3, 1, [8, 0, 0, 0]), entry(259, 3, 1, [1, 0, 0, 0]),
    entry(262, 3, 1, [2, 0, 0, 0]), entry(273, 4, 1, le32(stripAt)), entry(277, 3, 1, [3, 0, 0, 0]), entry(279, 4, 1, le32(6)), entry(0x8769, 4, 1, le32(exifAt))].flat(), ...le32(0)];
  return [0x49, 0x49, 42, 0, ...le32(ifd0At), ...exifIfd, ...secret, 255, 0, 0, 0, 0, 255, ...ifd0];
}

/** Every IFD a TIFF reader reaches (the chain from the header, and the Exif, GPS and interoperability IFDs) and its tags. */
function tiffIfds(b: Uint8Array): { at: number; tags: number[] }[] {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength), little = b[0] === 0x49;
  const u16 = (at: number) => view.getUint16(at, little), u32 = (at: number) => view.getUint32(at, little);
  const found: { at: number; tags: number[] }[] = [];
  const read = (at: number): number => {
    const count = u16(at), tags = Array.from({ length: count }, (_, i) => u16(at + 2 + i * 12));
    found.push({ at, tags });
    for (let i = 0; i < count; i++) if ([0x8769, 0x8825, 0xa005].includes(tags[i]!)) read(u32(at + 2 + i * 12 + 8));
    return u32(at + 2 + count * 12);
  };
  for (let at = u32(4); at;) at = read(at);
  return found;
}

/**
 * An Exif's TIFF whose IFD0 holds Make (the secret), the Orientation when there is one, and a pointer to a GPS IFD whose
 * processing method holds the GPS secret: as a camera or `sips` writes it, in either byte order.
 */
const GPS_SECRET = "GHOSTLY-GPS-PROCESSING 52.37N";
function exifTiff(orientation: number | undefined, little = false): number[] {
  const u16 = (n: number) => (little ? [n & 0xff, n >> 8] : be16(n)), u32 = (n: number) => (little ? le32(n) : be32(n));
  const entry = (tag: number, type: number, count: number, value: number[]) => [...u16(tag), ...u16(type), ...u32(count), ...value];
  const make = ascii(`${SECRET}\0`), gps = ascii(GPS_SECRET);
  const count = orientation === undefined ? 2 : 3, makeAt = 8 + 2 + count * 12 + 4, gpsIfdAt = makeAt + make.length, gpsAt = gpsIfdAt + 2 + 12 + 4;
  const ifd0 = [entry(0x010f, 2, make.length, u32(makeAt)), ...(orientation === undefined ? [] : [entry(0x0112, 3, 1, [...u16(orientation), 0, 0])]), entry(0x8825, 4, 1, u32(gpsIfdAt))];
  return [...(little ? [0x49, 0x49, 42, 0] : [0x4d, 0x4d, 0, 42]), ...u32(8), ...u16(count), ...ifd0.flat(), ...u32(0), ...make,
    ...u16(1), ...entry(0x001b, 7, gps.length, u32(gpsAt)), ...u32(0), ...gps];
}

/** What an Exif kept holds: its IFDs and their tags, and the Orientation a browser reads. */
function readExif(tiff: Uint8Array) {
  return { ifds: tiffIfds(tiff), orientation: exifOrientation(tiff, 0, tiff.length) };
}

/** A PNG chunk with its real CRC. */
const crcChunk = (type: string, data: number[]) => [...be32(data.length), ...ascii(type), ...data, ...be32(crc32(Uint8Array.from([...ascii(type), ...data])))];
/** A PNG's chunks, each CRC checked. */
function pngChunks(b: Uint8Array): { type: string; data: Uint8Array }[] {
  expect([...b.subarray(0, 8)]).toEqual(pngSignature);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength), found: { type: string; data: Uint8Array }[] = [];
  for (let at = 8; at < b.length;) {
    const length = view.getUint32(at), type = Buffer.from(b.subarray(at + 4, at + 8)).toString("latin1");
    expect(view.getUint32(at + 8 + length), `${type} CRC`).toBe(crc32(b.subarray(at + 4, at + 8 + length)));
    found.push({ type, data: b.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return found;
}

/** A WebP's chunks, its RIFF size checked against its length and every chunk padded to an even size. */
function webpChunks(b: Uint8Array): { type: string; data: Uint8Array }[] {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength), found: { type: string; data: Uint8Array }[] = [];
  expect(view.getUint32(4, true)).toBe(b.length - 8);
  for (let at = 12; at < b.length;) {
    const length = view.getUint32(at + 4, true);
    found.push({ type: Buffer.from(b.subarray(at, at + 4)).toString("latin1"), data: b.subarray(at + 8, at + 8 + length) });
    at += 8 + length + (length & 1);
    expect(at).toBeLessThanOrEqual(b.length);
  }
  return found;
}

describe("a picture's metadata, removed before it is sent", () => {
  it("GIF: comments, XMP and other application extensions go; frames, timing, the loop and ICC stay byte for byte", () => {
    const icc = gifExtension(0xff, ascii("ICCRGBG1012"), [1, 2, 3]);
    const xmp = gifExtension(0xff, ascii("XMP DataXMP"), ascii(`<x:xmpmeta>${SECRET}</x:xmpmeta>`));
    const comment = gifExtension(0xfe, ascii(SECRET).slice(0, 20), ascii(SECRET).slice(20));
    const sent = [...gifHead, ...gifLoop, ...comment, ...icc, ...gifControl, ...gifFrame, ...xmp, ...gifControl, ...gifFrame, 0x3b, ...ascii(SECRET)];
    const out = strip(sent, "image/gif");
    expect(has(Uint8Array.from(sent), SECRET)).toBe(true);
    expect(has(out, SECRET)).toBe(false);
    expect([...out]).toEqual([...gifHead, ...gifLoop, ...icc, ...gifControl, ...gifFrame, ...gifControl, ...gifFrame, 0x3b]);
    expect(imageSize(out)).toEqual({ width: 2, height: 1 });
    // A GIF with nothing to remove goes byte for byte.
    const pixel = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
    expect(Buffer.from(strip(pixel, "image/gif")).equals(pixel)).toBe(true);
  });

  it("GIF that cannot be read to its end, or with an extension this does not know, is refused", () => {
    const whole = [...gifHead, ...gifControl, ...gifFrame, 0x3b];
    for (const bad of [whole.slice(0, -1), whole.slice(0, 20), [...gifHead, 0x3b], [...gifHead, ...gifExtension(0x55, [1]), ...gifFrame, 0x3b], ascii("GIF89a")])
      expect(() => stripPictureMetadata(Uint8Array.from(bad), "image/gif"), `${bad.length}`).toThrow(NO_PICTURE_METADATA);
  });

  it("TIFF: text tags, the Exif and GPS IFDs are zeroed where they are; the size, strips and Orientation stay, nothing moves", () => {
    const sent = Uint8Array.from(tiff());
    const out = strip(sent, "image/tiff");
    expect(has(sent, SECRET)).toBe(true);
    expect(has(out, SECRET)).toBe(false);
    expect(out.length).toBe(sent.length);
    // Past IFD0's entry count, every byte that changed is now zero.
    const changed = [...sent.keys()].filter((i) => sent[i] !== out[i]);
    expect(changed.filter((i) => i !== 9).every((i) => out[i] === 0)).toBe(true);
    // The strip, the size and the Orientation, unchanged; IFD0 without the Exif and GPS pointers, those IFDs zeroed.
    expect([...out.subarray(-2)]).toEqual([0xab, 0xcd]);
    expect([...out.subarray(8, 10)]).toEqual([0, 7]);
    const exifAt = 8 + 2 + 9 * 12 + 4 + SECRET.length + 1, gpsAt = exifAt + 18 + SECRET.length + 1;
    expect([...out.subarray(exifAt, exifAt + 2)]).toEqual([0, 0]);
    expect([...out.subarray(gpsAt, gpsAt + 18)]).toEqual(new Array(18).fill(0));
    expect([...out.subarray(8 + 2 + 5 * 12, 8 + 2 + 6 * 12)]).toEqual([1, 18, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0]);
  });

  it("TIFF: IFD0 no longer points at the emptied Exif and GPS IFDs, so every IFD a reader reaches has an entry (libtiff refuses one without)", () => {
    for (const sent of [Uint8Array.from(tiff()), Uint8Array.from(sipsTiff())]) {
      const out = strip(sent, "image/tiff");
      expect(has(sent, SECRET)).toBe(true);
      expect(has(out, SECRET)).toBe(false);
      expect(out.length).toBe(sent.length);
      const ifds = tiffIfds(out);
      expect(ifds.map(({ tags }) => tags.length)).toEqual([sent[0] === 0x49 ? 8 : 7]);
      expect(ifds[0]!.tags).toEqual(tiffIfds(sent)[0]!.tags.filter((tag) => tag !== 0x8769 && tag !== 0x8825));
    }
    // The sips picture's strip and IFD0's other entries, byte for byte.
    const sent = Uint8Array.from(sipsTiff()), out = strip(sent, "image/tiff"), ifd0 = sent.length - 2 - 9 * 12 - 4;
    expect([...out.subarray(ifd0 - 6, ifd0)]).toEqual([255, 0, 0, 0, 0, 255]);
    expect([...out.subarray(ifd0 + 2, ifd0 + 2 + 8 * 12)]).toEqual([...sent.subarray(ifd0 + 2, ifd0 + 2 + 8 * 12)]);
  });

  it("TIFF with a part this does not know is refused: a private tag, sub-images, JPEG-compressed strips, a maker note", () => {
    const entry = (tag: number, type: number, value: number[]) => [...be16(tag), ...be16(type), 0, 0, 0, 1, ...value];
    for (const bad of [tiff({ extra: [entry(0xc634, 1, [1, 0, 0, 0])] }), tiff({ extra: [entry(330, 4, be32(8))] }), tiff({ compression: 7 }),
      [0x4d, 0x4d, 0, 42, ...be32(8)], [0x49, 0x49, 43, 0, 8, 0, 0, 0]])
      expect(() => stripPictureMetadata(Uint8Array.from(bad), "image/tiff"), `${bad.length}`).toThrow(NO_PICTURE_METADATA);
    // A maker note in the Exif IFD.
    const withNote = tiff();
    const exifEntry = 8 + 2 + 9 * 12 + 4 + SECRET.length + 1 + 2;
    withNote.splice(exifEntry, 2, 0x92, 0x7c);
    expect(() => stripPictureMetadata(Uint8Array.from(withNote), "image/tiff")).toThrow(NO_PICTURE_METADATA);
  });

  it("JPEG: Exif, XMP, IPTC and comments go; frame, tables, scan, JFIF and ICC stay byte for byte; Orientation stays alone", () => {
    const sent = jpeg(jfif, exif(6), xmp, iptc, icc, comment, dqt, sof(300, 200), dht);
    const out = strip(sent, "image/jpeg");
    expect(has(Uint8Array.from(sent), SECRET)).toBe(true);
    expect(has(out, SECRET)).toBe(false);
    expect(has(out, "xmpmeta")).toBe(false);
    expect(has(out, "Photoshop")).toBe(false);
    // The size it is shown at, turned a quarter by its Orientation, as before.
    expect(imageSize(out)).toEqual({ width: 200, height: 300 });
    expect(imageSize(out)).toEqual(imageSize(Uint8Array.from(sent)));
    // What draws it, unchanged: the stripped file is exactly these segments.
    const orientation = [0xff, 0xe1, 0, 34, ...ascii("Exif\0\0"), 0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
    expect([...out]).toEqual(jpeg(jfif, orientation, icc, dqt, sof(300, 200), dht));
  });

  it("JPEG: an upright photo keeps no Exif at all, and nothing after its end goes with it", () => {
    const out = strip([...jpeg(exif(1), dqt, sof(300, 200), dht), ...ascii(`MotionPhoto ${SECRET}`)], "image/jpeg");
    expect([...out]).toEqual(jpeg(dqt, sof(300, 200), dht));
  });

  it("PNG: text, eXIf and tIME go; IHDR, IDAT, transparency and colour stay", () => {
    const keep = [chunk("sRGB", [0]), chunk("pHYs", [0, 0, 0, 1, 0, 0, 0, 1, 1]), chunk("tRNS", [1, 2])];
    const metadata = [chunk("tEXt", ascii(`Comment\0${SECRET}`)), chunk("iTXt", ascii(`XML:com.adobe.xmp\0\0\0\0\0${SECRET}`)),
      chunk("zTXt", ascii("Raw\0\0x")), chunk("eXIf", ascii(`MM\0*${SECRET}`)), chunk("tIME", [7, 234, 11, 2, 9, 0, 0])];
    const sent = [...pngSignature, ...ihdr, ...metadata.flat(), ...keep.slice(0, 2).flat(), ...idat, ...keep[2]!, ...iend, ...ascii(SECRET)];
    const out = strip(sent, "image/png");
    expect(has(out, SECRET)).toBe(false);
    expect([...out]).toEqual([...pngSignature, ...ihdr, ...keep.slice(0, 2).flat(), ...idat, ...keep[2]!, ...iend]);
    expect(imageSize(out)).toEqual({ width: 300, height: 200 });
  });

  it("WebP: EXIF and XMP chunks go and VP8X stops saying it has them; the image, alpha and ICC stay", () => {
    const iccp = riffChunk("ICCP", [1, 2, 3]);
    const sent = riff(vp8x, iccp, vp8l, riffChunk("EXIF", ascii(`MM\0*${SECRET}`)), riffChunk("XMP ", ascii(SECRET)));
    const out = strip(sent, "image/webp");
    expect(has(out, SECRET)).toBe(false);
    const flagsCleared = riffChunk("VP8X", [0x30, 0, 0, 0, 43, 1, 0, 199, 0, 0]);
    expect([...out]).toEqual(riff(flagsCleared, iccp, vp8l));
    expect(imageSize(out)).toEqual({ width: 300, height: 200 });
  });

  it("PNG: a turned picture keeps an eXIf with its Orientation alone, before IDAT and with a valid CRC; Make and GPS go", () => {
    for (const little of [false, true]) {
      const sent = [...pngSignature, ...crcChunk("IHDR", [...be32(64), ...be32(48), 8, 2, 0, 0, 0]), ...crcChunk("sRGB", [0]),
        ...crcChunk("eXIf", exifTiff(6, little)), ...crcChunk("iTXt", ascii(`XML:com.adobe.xmp\0\0\0\0\0${SECRET}`)),
        ...crcChunk("IDAT", [0x78, 0x9c, 1, 2, 3]), ...crcChunk("IEND", [])];
      expect(has(Uint8Array.from(sent), GPS_SECRET)).toBe(true);
      const out = strip(sent, "image/png");
      const chunks = pngChunks(out);
      expect(chunks.map(({ type }) => type)).toEqual(["IHDR", "sRGB", "eXIf", "IDAT", "IEND"]);
      expect(readExif(chunks[2]!.data)).toEqual({ ifds: [{ at: 8, tags: [0x0112] }], orientation: 6 });
      expect(has(out, SECRET)).toBe(false);
      expect(has(out, GPS_SECRET)).toBe(false);
    }
  });

  it("PNG: an upright picture or one without Orientation keeps no eXIf, nor one after the image data", () => {
    for (const exif of [exifTiff(1), exifTiff(undefined)]) {
      const out = strip([...pngSignature, ...ihdr, ...chunk("eXIf", exif), ...idat, ...iend], "image/png");
      expect([...out]).toEqual([...pngSignature, ...ihdr, ...idat, ...iend]);
    }
    const late = strip([...pngSignature, ...ihdr, ...idat, ...chunk("eXIf", exifTiff(6)), ...iend], "image/png");
    expect([...late]).toEqual([...pngSignature, ...ihdr, ...idat, ...iend]);
  });

  it("WebP: a turned picture keeps an EXIF with its Orientation alone and VP8X says so; Make, GPS and XMP go", () => {
    for (const exif of [exifTiff(6), exifTiff(6, true), [...ascii("Exif\0\0"), ...exifTiff(6, true)]]) {
      const sent = riff(vp8x, vp8l, riffChunk("EXIF", exif), riffChunk("XMP ", ascii(SECRET)));
      const out = strip(sent, "image/webp");
      const chunks = webpChunks(out);
      expect(chunks.map(({ type }) => type)).toEqual(["VP8X", "VP8L", "EXIF"]);
      // ICC and alpha as they were, EXIF (0x08) still said, XMP (0x04) no longer.
      expect(chunks[0]!.data[0]).toBe(0x38);
      expect(readExif(chunks[2]!.data)).toEqual({ ifds: [{ at: 8, tags: [0x0112] }], orientation: 6 });
      expect(has(out, SECRET)).toBe(false);
      expect(has(out, GPS_SECRET)).toBe(false);
      expect(imageSize(out)).toEqual({ width: 300, height: 200 });
    }
  });

  it("WebP: an upright picture or one without Orientation keeps no EXIF and VP8X stops saying it has one", () => {
    for (const exif of [exifTiff(1), exifTiff(undefined)]) {
      const out = strip(riff(vp8x, vp8l, riffChunk("EXIF", exif)), "image/webp");
      expect(webpChunks(out).map(({ type }) => type)).toEqual(["VP8X", "VP8L"]);
      expect([...out]).toEqual(riff(riffChunk("VP8X", [0x30, 0, 0, 0, 43, 1, 0, 199, 0, 0]), vp8l));
    }
  });

  it("HEIC: the Exif item's bytes are zeroed where they are, in the file or in idat; nothing else moves", () => {
    for (const exifMethod of [0, 1]) {
      const sent = Uint8Array.from(heif({ exifMethod }));
      const out = strip(sent, "image/heic");
      expect(has(sent, SECRET)).toBe(true);
      expect(has(out, SECRET)).toBe(false);
      expect(out.length).toBe(sent.length);
      expect(has(out, "\xaa\xbb\xcc\xdd")).toBe(true);
      // Only the Exif item's bytes changed.
      const changed = [...sent.keys()].filter((i) => sent[i] !== out[i]);
      expect(changed.length).toBeGreaterThan(0);
      expect(changed.every((i) => out[i] === 0)).toBe(true);
    }
  });

  it("HEIC with a part this does not know is refused: an XML box, a video track, a uuid box", () => {
    expect(() => stripPictureMetadata(Uint8Array.from(heif({ extra: [fullBox("xml ", 0, ascii(SECRET))] })), "image/heic")).toThrow(NO_PICTURE_METADATA);
    expect(() => stripPictureMetadata(Uint8Array.from(heif({ topExtra: [box("moov", [])] })), "image/heic")).toThrow(NO_PICTURE_METADATA);
    expect(() => stripPictureMetadata(Uint8Array.from(heif({ topExtra: [box("uuid", [...new Array(16).fill(7), ...ascii(SECRET)])] })), "image/heic")).toThrow(NO_PICTURE_METADATA);
  });

  it("a picture whose metadata cannot be removed is refused, never passed through", () => {
    const whole = jpeg(exif(1), dqt, sof(300, 200), dht);
    const bad: [number[], string][] = [
      // Cut before its end, or in the middle of a segment.
      [whole.slice(0, whole.length - 2), "image/jpeg"],
      [whole.slice(0, 30), "image/jpeg"],
      // No frame before its scan.
      [jpeg(exif(1), dqt, dht), "image/jpeg"],
      // A PNG with no IEND, one whose first chunk is not IHDR, one with an unknown critical chunk.
      [[...pngSignature, ...ihdr, ...chunk("tEXt", ascii(SECRET)), ...idat], "image/png"],
      [[...pngSignature, ...idat, ...ihdr, ...iend], "image/png"],
      [[...pngSignature, ...ihdr, ...chunk("CgBI", [1]), ...idat, ...iend], "image/png"],
      // A WebP whose RIFF says more than there is, or that has no image.
      [riff(vp8x, vp8l).slice(0, 30), "image/webp"],
      [riff(vp8x, riffChunk("EXIF", ascii(SECRET))), "image/webp"],
      // Said to be a picture by its type, but not one.
      [ascii("not a picture at all"), "image/jpeg"],
      [[0x89, 0x50, 0x4e, 0x47], "image/png"],
      [ascii(`RIFF....WAVE${SECRET}`), "image/webp"],
      [ascii(SECRET), "image/heic"],
    ];
    for (const [bytes, mime] of bad) expect(() => stripPictureMetadata(Uint8Array.from(bytes), mime), `${mime} ${bytes.length}`).toThrow(NO_PICTURE_METADATA);
  });

  it("any other file goes as it is, whatever its type says, and a picture is known by its bytes whatever its type says", async () => {
    expect(stripPictureMetadata(Uint8Array.from(ascii(`hello ${SECRET}`)), "text/plain")).toBeUndefined();
    expect(stripPictureMetadata(Uint8Array.from(ascii("BM not stripped")), "image/bmp")).toBeUndefined();
    expect(await withoutPictureMetadata(new Blob([`hello ${SECRET}`], { type: "text/plain" }), "text/plain")).toBeUndefined();
    // A JPEG named .bin is still a JPEG.
    const out = await withoutPictureMetadata(new Blob([Uint8Array.from(jpeg(exif(1), dqt, sof(300, 200), dht))]), "application/octet-stream");
    expect(has(new Uint8Array(await out!.arrayBuffer()), SECRET)).toBe(false);
  });

  it("a picture past the size it is read whole at is refused", async () => {
    const huge = { size: PICTURE_METADATA_LIMITS.maxBytes + 1, slice: () => new Blob([Uint8Array.from(jpeg())]) } as unknown as Blob;
    await expect(withoutPictureMetadata(huge, "image/jpeg")).rejects.toThrow(NO_PICTURE_METADATA);
  });
});
