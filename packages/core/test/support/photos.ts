/**
 * Photos as a phone's gallery or a camera hands them over: real pictures (the avatar fixtures, made by real encoders)
 * with what cameras write around them, in the layouts they write it. EXIF with the device's make, model and serial
 * number, the owner's name, the time, a GPS position and a thumbnail; XMP with the position again; IPTC; a comment; MPF
 * and a second picture past the end of the first. Each kind of metadata names `SECRETS`, so a test can say none of it
 * reached the contact.
 */
import { readFileSync } from "node:fs";

const AVATARS = new URL("../../../../e2e/support/avatar-fixtures/", import.meta.url);
/** Bytes a Blob takes as they are. */
type Bytes = Uint8Array<ArrayBuffer>;

export const avatar = (name: string): Bytes =>new Uint8Array(readFileSync(new URL(name, AVATARS)));

/** What the metadata says, each where a camera writes it: none of it may reach the contact. */
export const SECRETS = ["SN-0042-GHOST", "Canon EOS R6", "Ana Souza", "2026:10:31 18:02:11", "48,51.24N", "Rua Augusta 12", "MPF\0", "SECOND-PICTURE"];

const latin1 = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be16 = (n: number) => [n >> 8, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/** An IFD entry: tag, type (2 ASCII, 3 SHORT, 4 LONG, 5 RATIONAL as numerator/denominator pairs), values. */
type Entry = [tag: number, type: 2 | 3 | 4 | 5, values: number[] | string];

/** An IFD at `offset` of a big-endian TIFF block, its values longer than four bytes after it. */
function ifd(entries: Entry[], offset: number, next = 0): number[] {
  const out = be16(entries.length);
  const data: number[] = [];
  const dataAt = offset + 2 + 12 * entries.length + 4;
  for (const [tag, type, values] of entries) {
    const raw = typeof values === "string" ? latin1(`${values}\0`) : type === 3 ? values.flatMap(be16) : values.flatMap(be32);
    const count = typeof values === "string" ? raw.length : type === 5 ? values.length / 2 : values.length;
    out.push(...be16(tag), ...be16(type), ...be32(count));
    if (raw.length <= 4) out.push(...raw, ...new Array(4 - raw.length).fill(0));
    else { out.push(...be32(dataAt + data.length)); data.push(...raw); if (data.length & 1) data.push(0); }
  }
  return [...out, ...be32(next), ...data];
}

/** The TIFF block of a camera's EXIF: IFD0, the Exif IFD, the GPS IFD and IFD1 with a thumbnail. */
export function cameraTiff(orientation: number, thumbnail: Uint8Array = new Uint8Array(0)): number[] {
  const exif: Entry[] = [[0x9003, 2, "2026:10:31 18:02:11"], [0xa431, 2, "SN-0042-GHOST"], [0xa434, 2, "RF24-105mm F4 L"]];
  const gps: Entry[] = [[0x0001, 2, "N"], [0x0002, 5, [48, 1, 51, 1, 2400, 100]], [0x0003, 2, "E"], [0x0004, 5, [2, 1, 17, 1, 4000, 100]]];
  const ifd0 = (exifAt: number, gpsAt: number): Entry[] => [
    [0x010f, 2, "Canon"], [0x0110, 2, "Canon EOS R6"], [0x0112, 3, [orientation]], [0x013b, 2, "Ana Souza"],
    [0x8769, 4, [exifAt]], [0x8825, 4, [gpsAt]],
  ];
  const exifAt = 8 + ifd(ifd0(0, 0), 8).length;
  const gpsAt = exifAt + ifd(exif, exifAt).length;
  const ifd1At = gpsAt + ifd(gps, gpsAt).length;
  const thumbAt = ifd1At + ifd([[0x0201, 4, [0]], [0x0202, 4, [0]]], ifd1At).length;
  return [
    ...latin1("MM"), 0, 42, ...be32(8),
    ...ifd(ifd0(exifAt, gpsAt), 8, ifd1At), ...ifd(exif, exifAt), ...ifd(gps, gpsAt),
    ...ifd([[0x0201, 4, [thumbAt]], [0x0202, 4, [thumbnail.length]]], ifd1At), ...thumbnail,
  ];
}

export const XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description
  xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" exif:GPSLatitude="48,51.24N"
  tiff:Model="Canon EOS R6" exif:BodySerialNumber="SN-0042-GHOST"/></rdf:RDF></x:xmpmeta>`;

const segment = (marker: number, body: number[]) => [0xff, marker, ...be16(body.length + 2), ...body];
/** A colour profile's segment: kept, or the photo's colours change. */
export const ICC_SEGMENT = segment(0xe2, [...latin1("ICC_PROFILE\0"), 1, 1, ...latin1("a colour profile, kept".padEnd(128, "."))]);

const concat = (...parts: ArrayLike<number>[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  parts.reduce((at, part) => { out.set(part, at); return at + part.length; }, 0);
  return out;
};

/**
 * `clean` (a JPEG) as a camera writes it: every kind of metadata before its own segments, a second picture after it.
 * Its EXIF holds `thumbnail` (`clean` itself by default: a small one).
 */
export function cameraJpeg(clean: Uint8Array, orientation = 1, thumbnail = clean): Bytes {
  return concat(
    [0xff, 0xd8],
    segment(0xe1, [...latin1("Exif\0\0"), ...cameraTiff(orientation, thumbnail)]),
    segment(0xe1, [...latin1("http://ns.adobe.com/xap/1.0/\0"), ...latin1(XMP)]),
    ICC_SEGMENT,
    segment(0xe2, [...latin1("MPF\0"), ...latin1("MM"), 0, 42]),
    segment(0xed, [...latin1("Photoshop 3.0\0"), ...latin1("8BIM"), 4, 4, 0, 0, ...be32(14), 0x1c, 2, 0x50, 0, 9, ...latin1("Ana Souza"), 0]),
    segment(0xfe, latin1("Taken at Rua Augusta 12")),
    clean.subarray(2),
    [0xff, 0xd8, ...segment(0xfe, latin1("SECOND-PICTURE")), 0xff, 0xd9],
  );
}

/** A PNG chunk, its CRC included. */
export function pngChunk(type: string, data: number[], crc: (bytes: Uint8Array) => number): number[] {
  const body = [...latin1(type), ...data];
  return [...be32(data.length), ...body, ...be32(crc(new Uint8Array(body)))];
}

/** `clean` (a PNG) with an eXIf, text, international text and a time after its header. */
export function cameraPng(clean: Uint8Array, crc: (bytes: Uint8Array) => number, orientation = 1): Bytes {
  const afterHeader = 8 + 25;
  return new Uint8Array([
    ...clean.subarray(0, afterHeader),
    ...pngChunk("eXIf", cameraTiff(orientation), crc),
    ...pngChunk("tEXt", latin1("Author\0Ana Souza"), crc),
    ...pngChunk("iTXt", [...latin1("XML:com.adobe.xmp\0\0\0\0\0"), ...latin1(XMP)], crc),
    ...pngChunk("tIME", [0x07, 0xea, 10, 31, 18, 2, 11], crc),
    ...clean.subarray(afterHeader),
  ]);
}

/** `clean` (an extended WebP: VP8X first) with EXIF and XMP chunks, VP8X saying it has them. */
export function cameraWebp(clean: Uint8Array, orientation = 1): Bytes {
  const chunk = (type: string, data: number[]) => [...latin1(type), ...le32(data.length), ...data, ...(data.length & 1 ? [0] : [])];
  const vp8x = clean.subarray(12, 12 + 18);
  const flagged = [...vp8x.subarray(0, 8), vp8x[8]! | 0x04 | 0x08, ...vp8x.subarray(9)];
  const chunks = [...flagged, ...clean.subarray(30), ...chunk("EXIF", cameraTiff(orientation)), ...chunk("XMP ", latin1(XMP))];
  return new Uint8Array([...latin1("RIFF"), ...le32(4 + chunks.length), ...latin1("WEBP"), ...chunks]);
}

/** `clean` (a GIF) with a comment and XMP (with its magic trailer) after its header and colours. */
export function cameraGif(clean: Uint8Array): Bytes {
  const packed = clean[10]!;
  const afterHeader = 13 + (packed & 0x80 ? 3 * (2 << (packed & 7)) : 0);
  const subBlocks = (bytes: number[]) => {
    const out: number[] = [];
    for (let i = 0; i < bytes.length; i += 255) out.push(Math.min(255, bytes.length - i), ...bytes.slice(i, i + 255));
    return [...out, 0];
  };
  // XMP goes raw, then 257 bytes that walk back to the terminator for a reader that reads it as sub-blocks.
  const magic = [1, ...Array.from({ length: 256 }, (_, i) => 255 - i), 0];
  return new Uint8Array([
    ...clean.subarray(0, afterHeader),
    0x21, 0xfe, ...subBlocks(latin1("Ana Souza, Rua Augusta 12")),
    0x21, 0xff, 11, ...latin1("XMP DataXMP"), ...latin1(XMP), ...magic,
    ...clean.subarray(afterHeader),
  ]);
}

/** Whether `bytes` say any of `SECRETS`. */
export function secretsIn(bytes: Uint8Array): string[] {
  const text = String.fromCharCode(...bytes);
  return SECRETS.filter((secret) => text.includes(secret));
}
