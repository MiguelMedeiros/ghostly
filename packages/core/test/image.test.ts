import { describe, expect, it } from "vitest";
import { IMAGE_LIMITS, imageSize, isImageMime, parseImageMeta, readImageMeta } from "../src/image";
// covers: files.image.meta

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part)));
const be16 = (n: number) => [n >> 8, n & 0xff];
const le16 = (n: number) => [n & 0xff, n >> 8];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

const png = (width: number, height: number) => bytes([0x89], "PNG\r\n\x1a\n", be32(13), "IHDR", be32(width), be32(height), [8, 6, 0, 0, 0]);
const gif = (width: number, height: number, version = "GIF89a") => bytes(version, le16(width), le16(height), [0, 0, 0]);

/** A segment: marker, then its length (which counts itself) and body. */
const segment = (marker: number, body: number[]) => [0xff, marker, ...be16(body.length + 2), ...body];
const sof = (marker: number, width: number, height: number) => segment(marker, [8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
/** An APP1 EXIF segment whose first IFD holds one tag besides Orientation, in either byte order. */
function exif(orientation: number, little: boolean): number[] {
  const u16 = little ? le16 : be16;
  const u32 = (n: number) => (little ? [...le16(n & 0xffff), ...le16(n >>> 16)] : be32(n));
  const entry = (tag: number, type: number, value: number) => [...u16(tag), ...u16(type), ...u32(1), ...u16(value), 0, 0];
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(2), ...entry(0x010f, 2, 0), ...entry(0x0112, 3, orientation), ...u32(0)];
  return segment(0xe1, [...[..."Exif\0\0"].map((c) => c.charCodeAt(0)), ...tiff]);
}
const jpeg = (...segments: number[][]) => new Uint8Array([0xff, 0xd8, ...segments.flat(), 0xff, 0xda, 0, 2, 0xff, 0xd9]);
const jfif = segment(0xe0, [..."JFIF\0".split("").map((c) => c.charCodeAt(0)), 1, 1, 0, 0, 1, 0, 1, 0, 0]);

const riff = (chunk: string, body: number[]) => bytes("RIFF", [...le16(body.length + 12), 0, 0], "WEBP", chunk, [...le16(body.length), 0, 0], body);

describe("image metadata", () => {
  it("keeps a picture's size", () => {
    expect(parseImageMeta({ width: 4032, height: 3024 }, "image/jpeg")).toEqual({ width: 4032, height: 3024 });
    expect(parseImageMeta({ width: 1, height: IMAGE_LIMITS.maxEdge }, "image/png")).toEqual({ width: 1, height: IMAGE_LIMITS.maxEdge });
    // No type to check against: the caller checks it.
    expect(parseImageMeta({ width: 2, height: 2 })).toEqual({ width: 2, height: 2 });
    // Anything else in it is left behind.
    expect(parseImageMeta({ width: 2, height: 3, extra: "x" }, "image/gif")).toEqual({ width: 2, height: 3 });
  });

  it("drops a description of anything but a picture", () => {
    for (const mime of ["application/octet-stream", "video/mp4", "audio/ogg", "text/html"])
      expect(parseImageMeta({ width: 2, height: 2 }, mime)).toBeUndefined();
    expect(isImageMime("image/webp; charset=x")).toBe(true);
  });

  it("drops malformed descriptions instead of refusing the file", () => {
    for (const bad of [null, "x", 5, [], [1, 2], {}, { width: 0, height: 1 }, { width: -1, height: 1 }, { width: 1.5, height: 1 },
      { width: 1, height: IMAGE_LIMITS.maxEdge + 1 }, { width: "10", height: 10 }, { width: 10 }, { width: NaN, height: 1 }, { width: Infinity, height: 1 }])
      expect(parseImageMeta(bad, "image/png")).toBeUndefined();
  });
});

describe("reading a picture's size from its first bytes", () => {
  it("PNG and GIF", () => {
    expect(imageSize(png(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSize(gif(88, 31))).toEqual({ width: 88, height: 31 });
    expect(imageSize(gif(300, 200, "GIF87a"))).toEqual({ width: 300, height: 200 });
  });

  it("JPEG: baseline and progressive, past other segments", () => {
    expect(imageSize(jpeg(jfif, sof(0xc0, 1920, 1080)))).toEqual({ width: 1920, height: 1080 });
    expect(imageSize(jpeg(jfif, segment(0xdb, new Array(64).fill(1)), segment(0xc4, new Array(30).fill(0)), sof(0xc2, 800, 600)))).toEqual({ width: 800, height: 600 });
    // Fill bytes before a marker are allowed.
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, ...sof(0xc1, 10, 20)]))).toEqual({ width: 10, height: 20 });
  });

  it("JPEG: the EXIF orientation turns it as it is shown, in either byte order", () => {
    for (const little of [true, false]) {
      for (const orientation of [1, 2, 3, 4])
        expect(imageSize(jpeg(exif(orientation, little), sof(0xc0, 4032, 3024)))).toEqual({ width: 4032, height: 3024 });
      for (const orientation of [5, 6, 7, 8])
        expect(imageSize(jpeg(exif(orientation, little), sof(0xc0, 4032, 3024)))).toEqual({ width: 3024, height: 4032 });
    }
    // An orientation out of range is none.
    expect(imageSize(jpeg(exif(9, true), sof(0xc0, 40, 30)))).toEqual({ width: 40, height: 30 });
  });

  it("WebP: lossy, lossless and extended", () => {
    expect(imageSize(riff("VP8 ", [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(550), ...le16(368), 0, 0]))).toEqual({ width: 550, height: 368 });
    // Lossless: 14 bits of width - 1, then 14 of height - 1.
    const bits = (400 - 1) | ((300 - 1) << 14);
    expect(imageSize(riff("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0, 0, 0, 0]))).toEqual({ width: 400, height: 300 });
    expect(imageSize(riff("VP8X", [0x10, 0, 0, 0, ...le24(1000 - 1), ...le24(2000 - 1), 0, 0, 0, 0]))).toEqual({ width: 1000, height: 2000 });
  });

  it("says nothing of what it cannot read", () => {
    for (const head of [
      new Uint8Array(0), bytes("hello world, not a picture"), png(640, 480).slice(0, 20), gif(1, 1).slice(0, 8), png(0, 10), gif(10, 0),
      // A JPEG whose frame header lies past what was read, or that starts its data first, or whose length is broken.
      jpeg(jfif).slice(0, 12), jpeg(jfif), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]), new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00]),
      // A lossy WebP without its start code, an unknown chunk.
      riff("VP8 ", [0, 0, 0, 0, 0, 0, ...le16(10), ...le16(10), 0, 0]), riff("ABCD", new Array(14).fill(0)),
    ]) expect(imageSize(head)).toBeUndefined();
    // Truncated EXIF is no orientation, not a failure.
    expect(imageSize(jpeg(segment(0xe1, [..."Exif\0\0MM".split("").map((c) => c.charCodeAt(0))]), sof(0xc0, 5, 7)))).toEqual({ width: 5, height: 7 });
  });

  it("reads only the head of a file, and only of a picture", async () => {
    const blob = new Blob([png(1200, 900), new Uint8Array(IMAGE_LIMITS.headBytes * 2)]);
    expect(await readImageMeta(blob, "image/png")).toEqual({ width: 1200, height: 900 });
    expect(await readImageMeta(blob, "application/octet-stream")).toBeUndefined();
    expect(await readImageMeta(new Blob([bytes("not a picture")]), "image/jpeg")).toBeUndefined();
  });
});
