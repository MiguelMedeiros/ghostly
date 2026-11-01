import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { imageSize } from "../src/image";
import { withoutImageMetadata } from "../src/imageStrip";
import { ICC_SEGMENT, avatar, cameraGif, cameraJpeg, cameraPng, cameraWebp, secretsIn } from "./support/photos";
// covers: files.image.no-metadata

const read = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const strip = async (bytes: Uint8Array<ArrayBuffer>, type: string) => read(await withoutImageMetadata(new Blob([bytes], { type })));
const latin1 = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** The EXIF a stripped JPEG keeps when its photo is turned: the orientation alone. */
const orientationExif = (orientation: number) => [0xff, 0xe1, 0, 34, ...latin1("Exif\0\0"),
  0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];

/** A PNG's chunks, by type and bytes. */
function pngChunks(bytes: Uint8Array): { type: string; bytes: Uint8Array }[] {
  const chunks = [];
  for (let at = 8; at < bytes.length;) {
    const end = at + 12 + new DataView(bytes.buffer, bytes.byteOffset + at).getUint32(0);
    chunks.push({ type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), bytes: bytes.subarray(at, end) });
    at = end;
  }
  return chunks;
}

describe("a photo sent without its location and device details", () => {
  const jpeg = avatar("avatar.jpg");

  it("JPEG: EXIF (GPS, serial, owner, thumbnail), XMP, IPTC, MPF, comments and what follows the picture go; its colour profile and every byte of the picture stay", async () => {
    const photo = cameraJpeg(jpeg);
    expect(secretsIn(photo)).toHaveLength(8);
    const sent = await strip(photo, "image/jpeg");
    expect(secretsIn(sent)).toEqual([]);
    // The picture's own segments and data, byte for byte: the same pixels.
    expect(sent).toEqual(new Uint8Array([0xff, 0xd8, ...ICC_SEGMENT, ...jpeg.subarray(2)]));
    expect(sent.length).toBeLessThan(photo.length);
  });

  it("JPEG: a turned photo keeps its orientation, in an EXIF that says nothing else", async () => {
    for (const orientation of [3, 6, 8]) {
      const photo = cameraJpeg(jpeg, orientation);
      const sent = await strip(photo, "image/jpeg");
      expect(secretsIn(sent)).toEqual([]);
      expect(sent).toEqual(new Uint8Array([0xff, 0xd8, ...orientationExif(orientation), ...ICC_SEGMENT, ...jpeg.subarray(2)]));
      expect(imageSize(sent)).toEqual(imageSize(photo));
    }
    expect(imageSize(await strip(cameraJpeg(jpeg, 6), "image/jpeg"))).toEqual({ width: imageSize(jpeg)!.height, height: imageSize(jpeg)!.width });
  });

  it("JPEG: image data past the first window is copied as it is, stuffed bytes and restart markers included", async () => {
    // 1.8 MB of data after the picture's own, a 0xFF in it every three bytes: some at a window's edge.
    const pattern = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd3];
    const large = new Uint8Array(jpeg.length + 300_000 * pattern.length);
    large.set(jpeg.subarray(0, jpeg.length - 2));
    for (let at = jpeg.length - 2; at < large.length - 2; at += pattern.length) large.set(pattern, at);
    large.set([0xff, 0xd9], large.length - 2);
    const sent = await strip(cameraJpeg(large, 1, jpeg), "image/jpeg");
    const expected = new Uint8Array(2 + ICC_SEGMENT.length + large.length - 2);
    expected.set([0xff, 0xd8, ...ICC_SEGMENT]);
    expected.set(large.subarray(2), 2 + ICC_SEGMENT.length);
    expect(Buffer.from(sent).equals(Buffer.from(expected))).toBe(true);
  });

  it("PNG: eXIf, text, international and compressed text and its time go; every other chunk stays as it is", async () => {
    const png = avatar("avatar.png");
    const photo = cameraPng(png, crc32);
    const sent = await strip(photo, "image/png");
    expect(secretsIn(sent)).toEqual([]);
    // The fixture's own encoder wrote a time and three texts: they go too.
    const kept = pngChunks(png).filter((chunk) => !["tIME", "tEXt"].includes(chunk.type));
    expect(sent).toEqual(new Uint8Array([...png.subarray(0, 8), ...kept.flatMap((chunk) => [...chunk.bytes])]));
    const turned = pngChunks(await strip(cameraPng(png, crc32, 6), "image/png"));
    const exif = turned.find((chunk) => chunk.type === "eXIf")!;
    expect(turned.map((chunk) => chunk.type)).toEqual(["IHDR", "eXIf", ...kept.slice(1).map((chunk) => chunk.type)]);
    expect([...exif.bytes.subarray(8, -4)]).toEqual(orientationExif(6).slice(10));
    expect(new DataView(exif.bytes.buffer, exif.bytes.byteOffset + exif.bytes.length - 4).getUint32(0)).toBe(crc32(exif.bytes.subarray(4, -4)));
  });

  it("WebP: EXIF and XMP chunks go and VP8X stops saying it has them; a turned photo keeps a minimal EXIF", async () => {
    const webp = avatar("avatar-extended.webp");
    const sent = await strip(cameraWebp(webp), "image/webp");
    expect(sent).toEqual(webp);
    const turned = await strip(cameraWebp(webp, 6), "image/webp");
    expect(secretsIn(turned)).toEqual([]);
    expect(new DataView(turned.buffer).getUint32(4, true)).toBe(turned.length - 8);
    expect(turned[20]).toBe(webp[20]! | 0x08);
    expect([...turned.subarray(webp.length)]).toEqual([...latin1("EXIF"), 26, 0, 0, 0, ...orientationExif(6).slice(10)]);
  });

  it("GIF: comments and XMP go, the picture stays as it is", async () => {
    const gif = avatar("avatar.gif");
    const photo = cameraGif(gif);
    expect(secretsIn(photo).length).toBeGreaterThan(0);
    expect(await strip(photo, "image/gif")).toEqual(gif);
  });

  it("a picture that says nothing goes as the same file", async () => {
    for (const [name, type] of [["avatar.jpg", "image/jpeg"], ["avatar-extended.webp", "image/webp"], ["avatar-lossy.webp", "image/webp"], ["avatar.gif", "image/gif"]]) {
      const source = new Blob([avatar(name!)], { type });
      expect(await withoutImageMetadata(source), name).toBe(source);
    }
  });

  it("a file it cannot read, or that is not a picture, goes as it is: the send is never refused for it", async () => {
    const photo = cameraJpeg(jpeg);
    const cases: [Blob, string?][] = [
      // Cut short inside its EXIF.
      [new Blob([photo.subarray(0, 200)], { type: "image/jpeg" })],
      // Another kind (HEIC), or not a picture at all.
      [new Blob([new Uint8Array([0, 0, 0, 24, ...latin1("ftypheic"), ...new Array(16).fill(0)])], { type: "image/heic" })],
      [new Blob([new Uint8Array(latin1("not a picture, but it says it is one"))], { type: "image/jpeg" })],
      [new Blob([photo], { type: "application/octet-stream" })],
      [new Blob([photo], { type: "image/jpeg" }), "video/mp4"],
      // Bytes that cannot be read.
      [{ type: "image/jpeg", size: photo.length, slice: () => ({ arrayBuffer: () => Promise.reject(new Error("gone")) }) } as unknown as Blob],
    ];
    for (const [source, mime] of cases) expect(await withoutImageMetadata(source, mime)).toBe(source);
  });
});
