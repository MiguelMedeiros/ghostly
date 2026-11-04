import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { toBase64Url, utf8Encode } from "../src/bytes";
import { LIMITS } from "../src/frames";
import { APP_RANGES_CAPABILITY, KNOWN_SESSION_CAPABILITIES } from "../src/pairedCapabilities";
import {
  APP_RANGE_DATA_KIND, APP_RANGE_LIMITS, appRangeCancelFrame, appRangeChunk, appRangeDataFrame, appRangeEndFrame, appRangeErrorFrame, appRangeGetFrame,
  decodeAppRangeData, encodeAppRangeData, parseAppRangeFrame, readAppRangeFrame,
} from "../src/pairedAppRanges";
// covers: apps.ranges.wire

/**
 * The read lane of mini-apps (WISP 1200 § A read lane to the contact: `app-ranges/1`): the `ar-*` frames and the
 * binary kind 0x05. `vectors/app-ranges.json` is what this file builds from fixed labels, checked in: write it again
 * with `APPS_VECTORS_WRITE=1 npx vitest run test/pairedAppRanges.test.ts`.
 */

const FILE = fileURLToPath(new URL("./vectors/app-ranges.json", import.meta.url));
const id16 = (label: string) => toBase64Url(sha256(utf8Encode(`ghostly app ranges vectors: ${label}`)).slice(0, 16));
const hexOf = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => new Uint8Array(hex.match(/../g)!.map(h => parseInt(h, 16)));
/** `length` bytes counting up from 0, wrapping at 256. */
const counting = (length: number) => Uint8Array.from({ length }, (_, i) => i % 256);

function build() {
  const a = id16("chat app id"), s = id16("serve id");
  const MiB = APP_RANGE_LIMITS.requestBytes, KiB16 = APP_RANGE_LIMITS.chunkBytes;
  const get = (fields: Record<string, unknown>) => ({ t: "ar-get", a, s, r: 7, o: 0, n: MiB, ...fields });
  const data = (fields: Record<string, unknown>) => ({ t: "ar-data", a, r: 7, o: 0, d: toBase64Url(counting(3)), ...fields });
  return {
    about: {
      pins: "The ar-* frames of app-ranges/1 and its binary chunk, kind 0x05",
      wisp: "WISP 1200, A read lane to the contact: app-ranges/1",
      test: "packages/core/test/pairedAppRanges.test.ts (APPS_VECTORS_WRITE=1 writes it again)",
      encodings: "ids base64url without padding (the first 16 bytes of SHA-256(\"ghostly app ranges vectors: <label>\")); binary messages and data hex",
    },
    inputs: { a, s },
    valid: [
      { name: "get, 1 MiB from the start", frame: get({}) },
      { name: "get, 1 byte at the last offset of a 2^53 - 1 file", frame: get({ o: Number.MAX_SAFE_INTEGER - 1, n: 1 }) },
      { name: "get, the largest request number", frame: get({ r: APP_RANGE_LIMITS.maxRequest }) },
      { name: "data, 3 bytes", frame: data({}), bytes: "000102" },
      { name: "data, 16 KiB", frame: data({ o: MiB - KiB16, d: toBase64Url(counting(KiB16)) }), bytes: "16384 bytes counting up from 00" },
      { name: "end, of a 700 MiB file", frame: { t: "ar-end", a, r: 7, z: 700 * MiB } },
      { name: "end, of an empty file", frame: { t: "ar-end", a, r: 7, z: 0 } },
      { name: "err, not-served", frame: { t: "ar-err", a, r: 7, e: "not-served" } },
      { name: "err, a code this version does not know (kept: the asker reads it as a failure)", frame: { t: "ar-err", a, r: 7, e: "too-late" } },
      { name: "cancel", frame: { t: "ar-cancel", a, r: 7 } },
      { name: "an unknown key is ignored", frame: { t: "ar-cancel", a, r: 7, x: 1 }, reads: { t: "ar-cancel", a, r: 7 } },
    ],
    invalid: [
      { name: "an unknown t", refusal: "not-ranges", frame: { t: "ar-put", a, r: 7 } },
      { name: "no a", refusal: "bad-a", frame: { t: "ar-cancel", r: 7 } },
      { name: "an a of 21 characters", refusal: "bad-a", frame: { t: "ar-cancel", a: a.slice(1), r: 7 } },
      { name: "get without s", refusal: "bad-s", frame: get({ s: undefined }) },
      { name: "get with an s of 23 characters", refusal: "bad-s", frame: get({ s: `${s}A` }) },
      { name: "a negative r", refusal: "bad-r", frame: { t: "ar-cancel", a, r: -1 } },
      { name: "an r past 2^32 - 1", refusal: "bad-r", frame: { t: "ar-cancel", a, r: 2 ** 32 } },
      { name: "an r that is not whole", refusal: "bad-r", frame: { t: "ar-cancel", a, r: 1.5 } },
      { name: "an r as a string", refusal: "bad-r", frame: { t: "ar-cancel", a, r: "7" } },
      { name: "get with a negative o", refusal: "bad-o", frame: get({ o: -1 }) },
      { name: "get with an o past 2^53 - 1", refusal: "bad-o", frame: get({ o: 2 ** 53 }) },
      { name: "get with n 0", refusal: "bad-n", frame: get({ n: 0 }) },
      { name: "get with n one byte past 1 MiB", refusal: "bad-n", frame: get({ n: MiB + 1 }) },
      { name: "get running past 2^53 - 1", refusal: "bad-n", frame: get({ o: Number.MAX_SAFE_INTEGER, n: 1 }) },
      { name: "data without o", refusal: "bad-o", frame: data({ o: undefined }) },
      { name: "data, empty", refusal: "bad-d", frame: data({ d: "" }) },
      { name: "data one byte past 16 KiB", refusal: "bad-d", frame: data({ d: toBase64Url(counting(KiB16 + 1)) }) },
      { name: "data with padding", refusal: "bad-d", frame: data({ d: "AAE=" }) },
      { name: "data in standard base64", refusal: "bad-d", frame: data({ d: "+/+/" }) },
      // "AAF" and "AAE" both read as 00 01: only the one a writer makes is taken.
      { name: "data not canonical", refusal: "bad-d", frame: data({ d: "AAF" }) },
      { name: "end without z", refusal: "bad-z", frame: { t: "ar-end", a, r: 7 } },
      { name: "end with a negative z", refusal: "bad-z", frame: { t: "ar-end", a, r: 7, z: -1 } },
      { name: "end with a z past 2^53 - 1", refusal: "bad-z", frame: { t: "ar-end", a, r: 7, z: 2 ** 53 } },
      { name: "err without e", refusal: "bad-e", frame: { t: "ar-err", a, r: 7 } },
      { name: "err with an e in capitals", refusal: "bad-e", frame: { t: "ar-err", a, r: 7, e: "BUSY" } },
    ],
    binary: {
      valid: [
        { name: "3 bytes at offset 0", a, r: 7, o: 0, data: "000102", message: hexOf(encodeAppRangeData(a, 7, 0, counting(3))) },
        { name: "1 byte at offset 2^53 - 2, request 2^32 - 1", a, r: APP_RANGE_LIMITS.maxRequest, o: Number.MAX_SAFE_INTEGER - 1, data: "ff", message: hexOf(encodeAppRangeData(a, APP_RANGE_LIMITS.maxRequest, Number.MAX_SAFE_INTEGER - 1, new Uint8Array([0xff]))) },
      ],
      invalid: [
        { name: "the head alone, no data", message: hexOf(encodeAppRangeData(a, 7, 0, counting(1)).slice(0, 29)) },
        { name: "kind 0x04 (a chat file's)", message: `04${hexOf(encodeAppRangeData(a, 7, 0, counting(3)).slice(1))}` },
        { name: "an offset past 2^53 - 1", message: `05${hexOf(encodeAppRangeData(a, 7, 0, counting(1)).slice(1, 21))}0020000000000000ff` },
      ],
    },
  };
}

type Vectors = ReturnType<typeof build>;

describe("app-ranges vectors", () => {
  it("match the checked-in file", () => {
    const built = build();
    if (process.env.APPS_VECTORS_WRITE === "1" || !existsSync(FILE)) writeFileSync(FILE, `${JSON.stringify(built, null, 2)}\n`);
    expect(built).toEqual(JSON.parse(readFileSync(FILE, "utf8")) as Vectors);
  });

  it("are read as the file says", () => {
    const file = JSON.parse(readFileSync(FILE, "utf8")) as Vectors;
    for (const v of file.valid) {
      const reads = "reads" in v ? v.reads : v.frame;
      expect(readAppRangeFrame(v.frame), v.name).toEqual({ ok: true, frame: reads });
    }
    for (const v of file.invalid) expect(readAppRangeFrame(v.frame), v.name).toEqual({ ok: false, refusal: v.refusal });
    for (const v of file.binary.valid) expect(decodeAppRangeData(fromHex(v.message)), v.name).toEqual({ a: v.a, r: v.r, o: v.o, data: fromHex(v.data) });
    for (const v of file.binary.invalid) expect(decodeAppRangeData(fromHex(v.message)), v.name).toBeNull();
  });
});

describe("app range frames", () => {
  const a = id16("chat app id"), s = id16("serve id");

  it("are written only as a reader takes them", () => {
    expect(appRangeGetFrame(a, s, 1, 0, 10)).toEqual({ t: "ar-get", a, s, r: 1, o: 0, n: 10 });
    expect(parseAppRangeFrame(appRangeDataFrame(a, 1, 5, counting(4)))).toEqual({ t: "ar-data", a, r: 1, o: 5, d: toBase64Url(counting(4)) });
    expect(appRangeEndFrame(a, 1, 5)).toEqual({ t: "ar-end", a, r: 1, z: 5 });
    expect(appRangeErrorFrame(a, 1, "busy")).toEqual({ t: "ar-err", a, r: 1, e: "busy" });
    expect(appRangeCancelFrame(a, 1)).toEqual({ t: "ar-cancel", a, r: 1 });
    expect(() => appRangeGetFrame(a, s, 1, 0, APP_RANGE_LIMITS.requestBytes + 1)).toThrow();
    expect(() => appRangeGetFrame(a, "short", 1, 0, 1)).toThrow();
    expect(() => appRangeDataFrame(a, 1, 0, new Uint8Array())).toThrow();
    expect(() => appRangeDataFrame(a, 1, 0, counting(APP_RANGE_LIMITS.chunkBytes + 1))).toThrow();
    expect(() => appRangeEndFrame(a, -1, 0)).toThrow();
    expect(() => appRangeEndFrame(a, 1, -1)).toThrow();
    // A writer sends only the codes this version defines.
    expect(() => appRangeErrorFrame(a, 1, "too-late" as never)).toThrow();
  });

  it("a full chunk as ar-data stays far below the session's frame cap", () => {
    const frame = appRangeDataFrame(a, APP_RANGE_LIMITS.maxRequest, Number.MAX_SAFE_INTEGER - APP_RANGE_LIMITS.chunkBytes, counting(APP_RANGE_LIMITS.chunkBytes));
    expect(utf8Encode(JSON.stringify(frame)).length).toBeLessThan(LIMITS.maxControlFrameBytes / 2);
    expect(appRangeChunk((frame as { d: string }).d)).toEqual(counting(APP_RANGE_LIMITS.chunkBytes));
  });

  it("a binary chunk reads back as it was written, its data a view of the message", () => {
    const bytes = counting(APP_RANGE_LIMITS.chunkBytes);
    const message = encodeAppRangeData(a, 9, 2 ** 40 + 3, bytes);
    expect(message[0]).toBe(APP_RANGE_DATA_KIND);
    expect(message.length).toBe(29 + bytes.length);
    const read = decodeAppRangeData(message)!;
    expect(read).toEqual({ a, r: 9, o: 2 ** 40 + 3, data: bytes });
    expect(read.data.buffer).toBe(message.buffer);
    expect(decodeAppRangeData(new Uint8Array([...message, 0]))).toBeNull();
    expect(() => encodeAppRangeData(a, 9, 0, counting(APP_RANGE_LIMITS.chunkBytes + 1))).toThrow();
    expect(() => encodeAppRangeData(a, 2 ** 32, 0, bytes)).toThrow();
    expect(() => encodeAppRangeData(a, 0, -1, bytes)).toThrow();
  });

  it("app-ranges/1 is a capability a session knows", () => {
    expect(KNOWN_SESSION_CAPABILITIES).toContain(APP_RANGES_CAPABILITY);
    expect(APP_RANGES_CAPABILITY).toBe("app-ranges/1");
  });
});
