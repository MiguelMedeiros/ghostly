/**
 * Pictures. A picture is an ordinary file (files/2, files/3 or a held item) whose announcement may also carry an
 * `image` description: its size in pixels as it is shown, so the receiver lays out its box before a byte of it has
 * arrived and the chat does not move when it loads. A peer that does not know `image` ignores it and shows the
 * picture as before; a bad description only means no box.
 *
 * The sender reads the size from the file's first bytes (`imageSize`): no decoding, the same on every platform.
 */
export interface ImageMeta {
  /** Pixels, as it is shown (EXIF orientation applied). */
  width: number;
  height: number;
}

export const IMAGE_LIMITS = {
  /** Pixels on either side: the most a JPEG can say, well past what anyone sends as a picture. */
  maxEdge: 65_535,
  /** How much of a file is read for its size: past a JPEG's EXIF, thumbnails and colour profile. */
  headBytes: 256 * 1024,
} as const;

/** Whether a file is a picture, by its type. */
export function isImageMime(mime: string): boolean {
  return mime.split(";")[0]!.trim().toLowerCase().startsWith("image/");
}

const edge = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= IMAGE_LIMITS.maxEdge;

/** A peer's `image` description, or undefined when it is not one. It never refuses the file. */
export function parseImageMeta(value: unknown, mime?: string): ImageMeta | undefined {
  if (mime !== undefined && !isImageMime(mime)) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { width, height } = value as { width?: unknown; height?: unknown };
  return edge(width) && edge(height) ? { width, height } : undefined;
}

const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const ascii = (b: Uint8Array, at: number, text: string) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

const sized = (width: number, height: number): ImageMeta | undefined => (edge(width) && edge(height) ? { width, height } : undefined);

/** SOFn markers: every frame type but DHT (C4), JPG (C8) and DAC (CC). */
const JPEG_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** The EXIF orientation in an APP1 segment's TIFF block (1 when it says none). */
function exifOrientation(b: Uint8Array, tiff: number, end: number): number {
  if (tiff + 8 > end) return 1;
  const little = ascii(b, tiff, "II");
  if (!little && !ascii(b, tiff, "MM")) return 1;
  const u16 = (at: number) => (little ? u16le(b, at) : u16be(b, at));
  const u32 = (at: number) => (little ? (u16le(b, at) + u16le(b, at + 2) * 65536) : u32be(b, at));
  if (u16(tiff + 2) !== 42) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    // Orientation, a SHORT: its value sits in the first two bytes of the value field.
    if (u16(entry) === 0x0112) { const value = u16(entry + 8); return value >= 1 && value <= 8 ? value : 1; }
  }
  return 1;
}

function jpegSize(b: Uint8Array): ImageMeta | undefined {
  let at = 2, orientation = 1;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return undefined;
    const marker = b[at + 1]!;
    // Fill bytes, then markers that stand alone.
    if (marker === 0xff) { at++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    // The image data or its end, and still no frame header.
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = u16be(b, at + 2);
    if (length < 2) return undefined;
    const end = Math.min(b.length, at + 2 + length);
    if (marker === 0xe1 && ascii(b, at + 4, "Exif\0\0")) orientation = exifOrientation(b, at + 10, end);
    if (JPEG_FRAME.has(marker)) {
      if (at + 9 > b.length) return undefined;
      const height = u16be(b, at + 5), width = u16be(b, at + 7);
      // 5 to 8 turn it a quarter: shown, it is as wide as it is stored tall.
      return orientation >= 5 ? sized(height, width) : sized(width, height);
    }
    at += 2 + length;
  }
  return undefined;
}

function webpSize(b: Uint8Array): ImageMeta | undefined {
  if (b.length < 30) return undefined;
  if (ascii(b, 12, "VP8 ")) {
    // A key frame: its start code, then 14-bit sizes (the top two bits are scaling).
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
    return sized(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (ascii(b, 12, "VP8L")) {
    if (b[20] !== 0x2f) return undefined;
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (ascii(b, 12, "VP8X")) return sized(u24le(b, 24) + 1, u24le(b, 27) + 1);
  return undefined;
}

/**
 * A picture's size as it is shown, read from its first bytes (PNG, JPEG, GIF, WebP), or undefined when they do not
 * say. Only the header is read: a JPEG whose frame header sits past `IMAGE_LIMITS.headBytes` goes without.
 */
export function imageSize(head: Uint8Array): ImageMeta | undefined {
  const b = head;
  try {
    if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, "PNG\r\n\x1a\n") && ascii(b, 12, "IHDR")) return sized(u32be(b, 16), u32be(b, 20));
    if (b.length >= 10 && (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"))) return sized(u16le(b, 6), u16le(b, 8));
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpegSize(b);
    if (b.length >= 16 && ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return webpSize(b);
  } catch { /* not a picture this reads */ }
  return undefined;
}

/**
 * The description a picture is sent with, read from the start of the file, or undefined when it is not a picture
 * or its first bytes do not say (it then goes without one).
 */
export async function readImageMeta(source: Blob, mime: string): Promise<ImageMeta | undefined> {
  if (!isImageMime(mime)) return undefined;
  try {
    return imageSize(new Uint8Array(await source.slice(0, IMAGE_LIMITS.headBytes).arrayBuffer()));
  } catch {
    return undefined;
  }
}
