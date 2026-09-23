import { expect, it } from "vitest";
import { MAX_AVATAR_LENGTH, jpegSize, sanitizeAvatar } from "../src/avatar";

/** Just enough JPEG for its header: SOI, an APP0 segment, a baseline frame header, then scan data. */
function jpeg(width: number, height: number, marker = 0xc0, padding = 0): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, marker, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xda, 0x00, 0x02, ...new Array(padding).fill(0), 0xff, 0xd9]);
}
const url = (bytes: Uint8Array) => "data:image/jpeg;base64," + btoa(String.fromCharCode(...bytes));

it("reads the size a JPEG declares, baseline or progressive", () => {
  expect(jpegSize(jpeg(128, 96))).toEqual({ width: 128, height: 96 });
  expect(jpegSize(jpeg(64, 64, 0xc2))).toEqual({ width: 64, height: 64 });
  expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
  expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeUndefined();
  expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]))).toBeUndefined();
});

it("keeps a small JPEG a contact sends, reads an empty one as removed, and ignores everything else", () => {
  const good = url(jpeg(128, 128));
  expect(sanitizeAvatar(good)).toBe(good);
  expect(sanitizeAvatar("")).toBeNull();
  expect(sanitizeAvatar(null)).toBeNull();
  for (const bad of [
    undefined, 42, {}, "https://tracker.example/pixel.jpg", "javascript:alert(1)",
    "data:image/svg+xml;base64," + btoa("<svg onload=alert(1)>"),
    "data:image/png;base64," + btoa("\x89PNG\r\n\x1a\n"),
    "data:text/html;base64," + btoa("<script>alert(1)</script>"),
    "data:image/jpeg;base64,not base64!",
    "data:image/jpeg;base64," + btoa("not a jpeg at all"),
    url(jpeg(4096, 4096)), // a tiny file claiming a huge picture
    url(jpeg(0, 10)),
    url(jpeg(128, 128, 0xc0, MAX_AVATAR_LENGTH)), // too long
  ]) expect(sanitizeAvatar(bad), String(bad).slice(0, 40)).toBeUndefined();
});
