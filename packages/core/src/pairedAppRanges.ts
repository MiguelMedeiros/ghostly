import { fromBase64Url, toBase64Url } from "./bytes";
import { isChatAppId } from "./pairedApps";

/**
 * The read lane of mini-apps in a 1:1 chat (WISP 1200 § A read lane to the contact: `app-ranges/1`): the contact's app
 * reads, in ranges, a file this side's app serves, over the chat's session but not through `apps/1`.
 *
 *     {"t":"ar-get","a":"<chat app id>","s":"<serve id>","r":7,"o":0,"n":1048576}
 *     {"t":"ar-data","a":"<chat app id>","r":7,"o":0,"d":"<base64url>"}
 *     {"t":"ar-end","a":"<chat app id>","r":7,"z":734003200}
 *     {"t":"ar-err","a":"<chat app id>","r":7,"e":"not-served"}
 *     {"t":"ar-cancel","a":"<chat app id>","r":7}
 *
 * The asker sends `ar-get` (request `r`, a number of its own, for `n` bytes at offset `o` of serve `s`) and may send
 * `ar-cancel`; the server answers with the bytes in chunks of at most `APP_RANGE_LIMITS.chunkBytes`, then `ar-end`
 * once every byte asked was sent (fewer at the end of the file), with `z` the served file's size, or `ar-err` instead of
 * any. A read of one byte at 0 is how the asker learns the size. Where `files/4` is on,
 * a chunk is a binary message of kind `APP_RANGE_DATA_KIND` (`encodeAppRangeData`) in place of `ar-data`. It needs
 * `app-ranges/1` in `paired-capabilities` on both sides. A reader ignores keys it does not know, so a later version
 * can add some.
 */

export const APP_RANGE_FRAMES = new Set(["ar-get", "ar-data", "ar-end", "ar-err", "ar-cancel"]);

export const APP_RANGE_LIMITS = {
  /** One `ar-get`, at most: as one `remote.read` of the app. */
  requestBytes: 1024 * 1024,
  /** One chunk, `ar-data` or binary: as a chat file's. */
  chunkBytes: 16 * 1024,
  /** The largest request number: it is 4 bytes in a binary chunk. */
  maxRequest: 0xffff_ffff,
} as const;

/**
 * What an `ar-err` says. `not-served`: no serve of that id on this session (never given, or ended); `changed` and
 * `gone`: the file under it, as `files.read` says them; `busy`: past the requests the server takes in flight. A
 * later version may add one: an asker reads a code it does not know as a failure.
 */
export const APP_RANGE_ERRORS = ["not-served", "changed", "gone", "busy"] as const;
export type AppRangeError = typeof APP_RANGE_ERRORS[number];

export type AppRangeFrame =
  | { t: "ar-get"; a: string; s: string; r: number; o: number; n: number }
  | { t: "ar-data"; a: string; r: number; o: number; d: string }
  | { t: "ar-end"; a: string; r: number; z: number }
  | { t: "ar-err"; a: string; r: number; e: string }
  | { t: "ar-cancel"; a: string; r: number };

/** Why a reader refuses an `ar-*` frame (the vectors' `refusal`). */
export type AppRangeRefusal = "not-ranges" | "bad-a" | "bad-s" | "bad-r" | "bad-o" | "bad-n" | "bad-d" | "bad-e" | "bad-z";

/** A serve id as it is on the wire: 22 base64url characters (16 random bytes, no padding), as a chat app id. */
export const isServeId = isChatAppId;

const isRequest = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= APP_RANGE_LIMITS.maxRequest;
const isOffset = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const ERROR_CODE = /^[a-z][a-z-]{0,31}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** The bytes of `d`, or null when it is not 1 to `chunkBytes` bytes of canonical base64url without padding. */
export function appRangeChunk(d: unknown): Uint8Array | null {
  if (typeof d !== "string" || !d.length || d.length % 4 === 1 || d.length > Math.ceil(APP_RANGE_LIMITS.chunkBytes * 4 / 3) || !BASE64URL.test(d)) return null;
  let bytes: Uint8Array;
  try { bytes = fromBase64Url(d); } catch { return null; }
  return bytes.length && bytes.length <= APP_RANGE_LIMITS.chunkBytes && toBase64Url(bytes) === d ? bytes : null;
}

export function appRangeGetFrame(app: string, serve: string, request: number, offset: number, length: number): AppRangeFrame {
  const frame = { t: "ar-get" as const, a: app, s: serve, r: request, o: offset, n: length };
  if (!readAppRangeFrame(frame).ok) throw new Error("Not an app range request");
  return frame;
}

export function appRangeDataFrame(app: string, request: number, offset: number, data: Uint8Array): AppRangeFrame {
  const frame = { t: "ar-data" as const, a: app, r: request, o: offset, d: toBase64Url(data) };
  if (!readAppRangeFrame(frame).ok) throw new Error("Not app range data");
  return frame;
}

export function appRangeEndFrame(app: string, request: number, size: number): AppRangeFrame {
  if (!isChatAppId(app) || !isRequest(request) || !isOffset(size)) throw new Error("Not an app range end");
  return { t: "ar-end", a: app, r: request, z: size };
}

export function appRangeErrorFrame(app: string, request: number, error: AppRangeError): AppRangeFrame {
  if (!isChatAppId(app) || !isRequest(request) || !APP_RANGE_ERRORS.includes(error)) throw new Error("Not an app range error");
  return { t: "ar-err", a: app, r: request, e: error };
}

export function appRangeCancelFrame(app: string, request: number): AppRangeFrame {
  if (!isChatAppId(app) || !isRequest(request)) throw new Error("Not an app range cancel");
  return { t: "ar-cancel", a: app, r: request };
}

/**
 * An `ar-*` frame as the peer sent it, or why a reader must refuse it: an unknown `t`, no valid `a`, an `ar-get`
 * without a valid `s`, a request number that is not 0 to 2^32 - 1, an offset that is not a safe whole number at or
 * above 0, an `n` that is not 1 to `requestBytes` (or runs past 2^53 - 1), a `d` that is not 1 to `chunkBytes` bytes of
 * canonical base64url, an `e` that is not a code (lower case letters and `-`, at most 32), an `ar-end` whose `z` is not
 * a size (a safe whole number at or above 0). Other keys are ignored.
 */
export function readAppRangeFrame(frame: Record<string, unknown>): { ok: true; frame: AppRangeFrame } | { ok: false; refusal: AppRangeRefusal } {
  const refuse = (refusal: AppRangeRefusal) => ({ ok: false as const, refusal });
  const t = frame?.t;
  if (typeof t !== "string" || !APP_RANGE_FRAMES.has(t)) return refuse("not-ranges");
  if (!isChatAppId(frame.a)) return refuse("bad-a");
  const a = frame.a;
  if (t === "ar-get" && !isServeId(frame.s)) return refuse("bad-s");
  if (!isRequest(frame.r)) return refuse("bad-r");
  const r = frame.r;
  switch (t) {
    case "ar-get": {
      if (!isOffset(frame.o)) return refuse("bad-o");
      const n = frame.n;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > APP_RANGE_LIMITS.requestBytes || !Number.isSafeInteger(frame.o + n)) return refuse("bad-n");
      return { ok: true, frame: { t, a, s: frame.s as string, r, o: frame.o, n } };
    }
    case "ar-data": {
      if (!isOffset(frame.o)) return refuse("bad-o");
      if (!appRangeChunk(frame.d)) return refuse("bad-d");
      return { ok: true, frame: { t, a, r, o: frame.o, d: frame.d as string } };
    }
    case "ar-err":
      return typeof frame.e === "string" && ERROR_CODE.test(frame.e) ? { ok: true, frame: { t, a, r, e: frame.e } } : refuse("bad-e");
    case "ar-end":
      return isOffset(frame.z) ? { ok: true, frame: { t, a, r, z: frame.z } } : refuse("bad-z");
    default:
      return { ok: true, frame: { t: "ar-cancel", a, r } };
  }
}

/** An `ar-*` frame as the peer sent it, or null when a reader must refuse it (`readAppRangeFrame` says why). */
export function parseAppRangeFrame(frame: Record<string, unknown>): AppRangeFrame | null {
  const read = readAppRangeFrame(frame);
  return read.ok ? read.frame : null;
}

/**
 * `app-ranges/1` beside `files/4` (WISP 100 § Text and binary messages): a chunk as one binary message of the session,
 * in place of the base64url text of an `ar-data` frame:
 *
 *   kind 0x05 (1) | chat app id (16) | request (4, big endian) | offset (8, big endian) | data (1 to `chunkBytes`)
 */
export const APP_RANGE_DATA_KIND = 0x05;
const HEAD = 1 + 16 + 4 + 8;

/** The binary message for the bytes of request `request` of app `app` at `offset`. Throws on what no receiver would take. */
export function encodeAppRangeData(app: string, request: number, offset: number, data: Uint8Array): Uint8Array {
  if (!isChatAppId(app) || !isRequest(request) || !isOffset(offset) || !data.length || data.length > APP_RANGE_LIMITS.chunkBytes) throw new Error("Invalid app range data");
  const id = fromBase64Url(app);
  if (id.length !== 16) throw new Error("Invalid app range data");
  const out = new Uint8Array(HEAD + data.length);
  out[0] = APP_RANGE_DATA_KIND;
  out.set(id, 1);
  const view = new DataView(out.buffer);
  view.setUint32(17, request);
  view.setUint32(21, Math.floor(offset / 2 ** 32));
  view.setUint32(25, offset % 2 ** 32);
  out.set(data, HEAD);
  return out;
}

/** What a binary message from the contact says, or null when it is not well-formed app range data. `data` is a view of `message`. */
export function decodeAppRangeData(message: Uint8Array): { a: string; r: number; o: number; data: Uint8Array } | null {
  if (message.length <= HEAD || message[0] !== APP_RANGE_DATA_KIND || message.length - HEAD > APP_RANGE_LIMITS.chunkBytes) return null;
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const high = view.getUint32(21);
  // Past 2^53 - 1 an offset is no longer a whole number here.
  if (high > 0x1fffff) return null;
  return { a: toBase64Url(message.slice(1, 17)), r: view.getUint32(17), o: high * 2 ** 32 + view.getUint32(25), data: message.subarray(HEAD) };
}
