import { describe, expect, it } from "vitest";
import { imageSize } from "../src/image";
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

describe("a picture's metadata, removed before it is sent", () => {
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
    expect(stripPictureMetadata(Uint8Array.from(ascii("GIF89a")), "image/gif")).toBeUndefined();
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
