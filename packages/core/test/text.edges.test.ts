import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MAX_AVATAR_SIDE, jpegSize, sanitizeAvatar } from "../src/avatar";
import { MAX_NICK_LENGTH, sanitizeDisplayText, sanitizeNick } from "../src/text";

// covers: core.text-limits, profiles.picture.sanitize

describe("nicknames from a peer", () => {
  it("is undefined for anything that is not a string", () => {
    for (const v of [undefined, null, 5, {}, ["Alice"], true]) expect(sanitizeNick(v)).toBeUndefined();
  });

  it("cuts at 64 code points, never inside a surrogate pair", () => {
    const nick = sanitizeNick("\u{1f47b}".repeat(MAX_NICK_LENGTH + 5))!;
    expect([...nick]).toHaveLength(MAX_NICK_LENGTH);
    expect(nick).toBe("\u{1f47b}".repeat(MAX_NICK_LENGTH));
  });

  it("never returns hidden or direction-changing characters, empty text, or more than the limit", () => {
    const special = fc.constantFrom("\u202e", "\u2066", "\u200b", "\u200c", "\u200d", "\ufeff", "\u0000", "\n", "\u2028", "\u2029", " ", "\u{1f47b}", "\u0301", "e");
    const mixed = fc.array(fc.oneof(special, fc.string({ maxLength: 4 })), { maxLength: 30 }).map(parts => parts.join(""));
    fc.assert(fc.property(mixed, fc.integer({ min: 1, max: 80 }), (text, max) => {
      const out = sanitizeDisplayText(text, max);
      if (out === undefined) return;
      expect(out.length).toBeGreaterThan(0);
      expect([...out].length).toBeLessThanOrEqual(max);
      expect(out).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
      expect(out.replace(/[\u200c\u200d]/g, "")).not.toMatch(/\p{Cf}/u);
      expect(out).toBe(out.trim());
    }), { numRuns: 200 });
  });
});

/** SOI, then the given segments, then a scan. */
const jpeg = (...segments: number[][]) => new Uint8Array([0xff, 0xd8, ...segments.flat(), 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
const sof = (w: number, h: number, marker = 0xc0) => [0xff, marker, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
const dataUrl = (bytes: Uint8Array) => "data:image/jpeg;base64," + btoa(String.fromCharCode(...bytes));

describe("avatar pictures from a peer", () => {
  it("skips standalone markers before the frame header", () => {
    expect(jpegSize(jpeg([0xff, 0xd0], [0xff, 0x01], [0xff, 0xd8], sof(16, 32)))).toEqual({ width: 16, height: 32 });
  });

  it("skips DHT, JPG and DAC segments, which share the SOF marker range", () => {
    for (const marker of [0xc4, 0xc8, 0xcc]) expect(jpegSize(jpeg([0xff, marker, 0x00, 0x04, 0, 0]))).toBeUndefined();
    expect(jpegSize(jpeg([0xff, 0xc4, 0x00, 0x04, 0, 0], sof(8, 8, 0xc1)))).toEqual({ width: 8, height: 8 });
  });

  it("finds no size in bytes between segments, a segment length under two, one running past the end, or a frame header too short", () => {
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0x00, 0xc0, 0, 0x11, 0, 0, 0]))).toBeUndefined();
    expect(jpegSize(jpeg([0xff, 0xe0, 0x00, 0x01]))).toBeUndefined();
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x40, 0, 0]))).toBeUndefined();
    expect(jpegSize(jpeg([0xff, 0xc0, 0x00, 0x05, 0, 0, 0]))).toBeUndefined();
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeUndefined();
  });

  it("accepts the largest side allowed and refuses one pixel more", () => {
    expect(sanitizeAvatar(dataUrl(jpeg(sof(MAX_AVATAR_SIDE, MAX_AVATAR_SIDE))))).toBeTypeOf("string");
    expect(sanitizeAvatar(dataUrl(jpeg(sof(MAX_AVATAR_SIDE + 1, 1))))).toBeUndefined();
    expect(sanitizeAvatar(dataUrl(jpeg(sof(1, MAX_AVATAR_SIDE + 1))))).toBeUndefined();
    expect(sanitizeAvatar(dataUrl(jpeg(sof(1, 0))))).toBeUndefined();
  });

  it("refuses base64 with the wrong length or misplaced padding", () => {
    const good = dataUrl(jpeg(sof(8, 8)));
    expect(sanitizeAvatar(good.slice(0, -1))).toBeUndefined();
    expect(sanitizeAvatar(good.replace(/=*$/, "") + "===")).toBeUndefined();
    expect(sanitizeAvatar("data:image/jpeg;base64,")).toBeUndefined();
  });

  it("never throws, and keeps only what starts as a JPEG data URL", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 64 }), bytes => {
      const out = sanitizeAvatar(dataUrl(bytes));
      if (typeof out === "string") expect(out.startsWith("data:image/jpeg;base64,/9j/")).toBe(true);
    }), { numRuns: 300 });
  });
});
