import { describe, expect, it } from "vitest";
import { FILE_DATA_KIND, FILE_LIMITS, decodeFileData, encodeFileData } from "../src/chatFiles";
import { toBase64Url } from "../src/bytes";

const ID = "AbCdEfGh_-0123456789xy";
const bytes = (length: number, seed = 7) => Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 0xff);

describe("files/4: a chunk as a binary message", () => {
  it("lays out the kind, the id, the offset and the bytes as WISP 501 says", () => {
    const message = encodeFileData("abcdefgh", 0x0102_0304_0506, Uint8Array.of(0xde, 0xad, 0xbe, 0xef));
    expect([...message]).toEqual([
      0x04, 8, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
      0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
      0xde, 0xad, 0xbe, 0xef,
    ]);
    expect(message[0]).toBe(FILE_DATA_KIND);
  });

  it("reads back what it wrote, at any offset a file can have", () => {
    for (const offset of [0, 1, 16 * 1024, 2 ** 32 - 1, 2 ** 32, 2 ** 32 + 5, 200 * 1024 * 1024, Number.MAX_SAFE_INTEGER]) {
      const data = bytes(1 + (offset % 977));
      expect(decodeFileData(encodeFileData(ID, offset, data))).toEqual({ id: ID, offset, data });
    }
    const full = bytes(FILE_LIMITS.chunkBytes);
    expect(decodeFileData(encodeFileData("a".repeat(64), 1, full))).toEqual({ id: "a".repeat(64), offset: 1, data: full });
  });

  it("costs 32 bytes more than a full chunk where the JSON frame cost a third more", () => {
    const chunk = bytes(FILE_LIMITS.chunkBytes), offset = 150 * 1024 * 1024;
    const binary = encodeFileData(ID, offset, chunk).length;
    const json = JSON.stringify({ t: "pf-data", id: ID, offset, data: toBase64Url(chunk) }).length;
    expect(binary).toBe(16_416);
    expect(json).toBe(21_920);
    expect(binary / chunk.length).toBeLessThan(1.002);
    expect(json / chunk.length).toBeGreaterThan(1.33);
  });

  it("reads a message that is a view into a larger buffer", () => {
    const message = encodeFileData(ID, 4096, bytes(100));
    const padded = new Uint8Array(message.length + 10);
    padded.set(message, 5);
    expect(decodeFileData(padded.subarray(5, 5 + message.length))).toEqual({ id: ID, offset: 4096, data: bytes(100) });
  });

  it("refuses to write what no receiver would take", () => {
    expect(() => encodeFileData("short", 0, bytes(1))).toThrow("Invalid file data");
    expect(() => encodeFileData("has a space", 0, bytes(1))).toThrow();
    expect(() => encodeFileData("a".repeat(65), 0, bytes(1))).toThrow();
    expect(() => encodeFileData(ID, -1, bytes(1))).toThrow();
    expect(() => encodeFileData(ID, 1.5, bytes(1))).toThrow();
    expect(() => encodeFileData(ID, Number.MAX_SAFE_INTEGER + 1, bytes(1))).toThrow();
    expect(() => encodeFileData(ID, 0, new Uint8Array(0))).toThrow();
    expect(() => encodeFileData(ID, 0, bytes(FILE_LIMITS.chunkBytes + 1))).toThrow();
  });

  it("drops a message that is not a well-formed one", () => {
    const good = encodeFileData(ID, 9, bytes(3));
    const changed = (at: number, value: number) => { const copy = good.slice(); copy[at] = value; return copy; };
    expect(decodeFileData(good)).not.toBeNull();
    expect(decodeFileData(new Uint8Array(0))).toBeNull();
    expect(decodeFileData(Uint8Array.of(FILE_DATA_KIND))).toBeNull();
    // Another kind: the body chunks of a compatibility chat, or one nobody defined.
    for (const kind of [0, 1, 2, 3, 5, 0x7b, 0xff]) expect(decodeFileData(changed(0, kind))).toBeNull();
    // An id shorter or longer than an id is, or longer than the message.
    for (const length of [0, 7, 65, 200, 255]) expect(decodeFileData(changed(1, length))).toBeNull();
    // A byte no id holds.
    for (const byte of [0x20, 0x2f, 0x00, 0x80, 0xff]) expect(decodeFileData(changed(4, byte))).toBeNull();
    // The header alone, with no data after it.
    expect(decodeFileData(good.subarray(0, 2 + ID.length + 8))).toBeNull();
    expect(decodeFileData(good.subarray(0, 2 + ID.length + 3))).toBeNull();
    // More data than a chunk.
    const long = new Uint8Array(2 + ID.length + 8 + FILE_LIMITS.chunkBytes + 1);
    long.set(good.subarray(0, 2 + ID.length + 8));
    expect(decodeFileData(long)).toBeNull();
    expect(decodeFileData(long.subarray(0, long.length - 1))).not.toBeNull();
    // An offset past 2^53 - 1.
    expect(decodeFileData(changed(2 + ID.length + 1, 0x20))).toBeNull();
    expect(decodeFileData(changed(2 + ID.length, 0x01))).toBeNull();
    expect(decodeFileData(changed(2 + ID.length + 1, 0x1f))?.offset).toBe(0x1f * 2 ** 48 + 9);
  });
});
