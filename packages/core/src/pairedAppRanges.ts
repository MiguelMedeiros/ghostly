import { concatBytes, fromBase64Url, randomBytes, toBase64Url } from "./bytes";
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
  /** Requests a server takes in flight per app; one more is answered `busy`. An asker keeps the rest waiting. */
  inFlight: 4,
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

/** Why a read of the contact's file failed, as the app hears it (a broker code). */
export type AppRangeReadError = "not-served" | "changed" | "gone" | "offline" | "peer-closed" | "failed";

/**
 * A request of the contact's to answer: read `length` bytes of `file` at `offset`, send them, then `finish`. Every
 * task is settled once, live or not (`finish`, `fail` or `release`): until then it holds one of its app's places.
 */
export interface AppRangeTask {
  readonly app: string;
  readonly request: number;
  /** What this side's app served, as it named it (a linked file's id). */
  readonly file: string;
  readonly offset: number;
  readonly length: number;
  /** False once the asker cancelled, the serve ended, the app closed or the session ended: send nothing more for it. */
  readonly live: boolean;
}

interface Serving { app: string; request: number; serve: string; file: string; offset: number; length: number; live: boolean }

interface Asking {
  app: string;
  serve: string;
  offset: number;
  length: number;
  request?: number;
  chunks: Uint8Array[];
  got: number;
  resolve(read: { bytes: Uint8Array; size: number }): void;
  reject(error: Error): void;
}

const slot = (app: string, request: number) => `${app}:${request}`;

/**
 * The read lane of one chat, both ways (WISP 1200 § A read lane to the contact). As the side that serves it keeps the
 * serve ids it gave out on this session and answers the contact's `ar-get` for those only, at most
 * `APP_RANGE_LIMITS.inFlight` per app (`busy` past it); the bytes themselves are read and sent by the session, which
 * calls `finish`, `fail` or `release` for each task. A task cancelled or unserved stops being live and its request
 * number frees at once, but it holds its place until then: the read under it may still be going. As the side that asks it sends at most `inFlight` requests per app, keeps
 * the rest waiting, and puts each answer back together, in order, from the offset asked. Serves and requests last one
 * session: `reset` ends them all, `closeApp` those of one app.
 */
export class AppRanges {
  private readonly serves = new Map<string, { app: string; file: string }>();
  /** The live tasks, by request. */
  private readonly serving = new Map<string, Serving>();
  /** Every task not settled yet, live or not: what counts toward `inFlight`. */
  private readonly held = new Set<Serving>();
  private readonly asking = new Map<string, Asking>();
  private readonly waiting = new Map<string, Asking[]>();
  private nextRequest = 0;

  constructor(private readonly send: (frame: AppRangeFrame) => void, private readonly newServeId = () => toBase64Url(randomBytes(16))) {}

  /** Lets the contact's `app` read `file` on this session: the serve id to tell it. */
  serve(app: string, file: string): string {
    if (!isChatAppId(app)) throw new Error("Not a chat app id");
    let id = this.newServeId();
    while (this.serves.has(id)) id = this.newServeId();
    this.serves.set(id, { app, file });
    return id;
  }

  /** Ends one serve: requests under it still being sent stop. False when it was not served. */
  unserve(serveId: string): boolean {
    const serve = this.serves.get(serveId);
    if (!serve) return false;
    this.serves.delete(serveId);
    for (const task of this.serving.values()) if (task.serve === serveId) this.drop(task);
    return true;
  }

  /** The serve ids `app` has given out on this session (what the panel's "Sharing with" line shows). */
  servesOf(app: string): string[] {
    return [...this.serves].filter(([, serve]) => serve.app === app).map(([id]) => id);
  }

  /** An `ar-get` from the contact: the task to read and send, or null when it was refused (the refusal is sent) or dropped. */
  receiveGet(frame: Extract<AppRangeFrame, { t: "ar-get" }>): AppRangeTask | null {
    const { a: app, r: request } = frame;
    // A request number still in flight is the asker's own mistake: answering it would end the first one.
    if (this.serving.has(slot(app, request))) return null;
    const serve = this.serves.get(frame.s);
    if (!serve || serve.app !== app) { this.send(appRangeErrorFrame(app, request, "not-served")); return null; }
    if ([...this.held].filter(task => task.app === app).length >= APP_RANGE_LIMITS.inFlight) { this.send(appRangeErrorFrame(app, request, "busy")); return null; }
    const task: Serving = { app, request, serve: frame.s, file: serve.file, offset: frame.o, length: frame.n, live: true };
    this.serving.set(slot(app, request), task);
    this.held.add(task);
    return task;
  }

  /** An `ar-cancel` from the contact: that request sends nothing more, and its place frees once the owner settles it. */
  receiveCancel(frame: Extract<AppRangeFrame, { t: "ar-cancel" }>): void {
    const task = this.serving.get(slot(frame.a, frame.r));
    if (task) this.drop(task);
  }

  /** Every byte of `task` was sent: `ar-end` goes with the file's size, unless the task was dropped meanwhile. */
  finish(task: AppRangeTask, size: number): void {
    if (this.take(task)) this.send(appRangeEndFrame(task.app, task.request, size));
  }

  /** The file under `task` could not be read: `ar-err` goes in place of the rest, unless the task was dropped meanwhile. */
  fail(task: AppRangeTask, error: "changed" | "gone"): void {
    if (this.take(task)) this.send(appRangeErrorFrame(task.app, task.request, error));
  }

  /** `task` ends with nothing more sent (it was no longer live, or could not go on): its place frees. */
  release(task: AppRangeTask): void {
    this.take(task);
  }

  /** Reads `length` bytes at `offset` of what the contact's `app` serves as `serve`: the bytes (fewer at the end) and the file's size. */
  read(app: string, serve: string, offset: number, length: number): Promise<{ bytes: Uint8Array; size: number }> {
    appRangeGetFrame(app, serve, 0, offset, length);
    return new Promise((resolve, reject) => {
      const ask: Asking = { app, serve, offset, length, chunks: [], got: 0, resolve, reject };
      const queue = this.waiting.get(app) ?? [];
      queue.push(ask);
      this.waiting.set(app, queue);
      this.pump(app);
    });
  }

  /** Bytes of a request of ours, from `ar-data` or a binary chunk. Out of order or past what was asked fails the request. */
  receiveData(app: string, request: number, offset: number, data: Uint8Array): void {
    const ask = this.asking.get(slot(app, request));
    if (!ask) return;
    if (offset !== ask.offset + ask.got || ask.got + data.length > ask.length) {
      this.send(appRangeCancelFrame(app, request));
      return this.settle(ask, "failed");
    }
    ask.chunks.push(data.slice());
    ask.got += data.length;
  }

  /** The contact's `ar-end` or `ar-err` for a request of ours. */
  receiveAnswer(frame: Extract<AppRangeFrame, { t: "ar-end" | "ar-err" }>): void {
    const ask = this.asking.get(slot(frame.a, frame.r));
    if (!ask) return;
    if (frame.t === "ar-err") return this.settle(ask, (["not-served", "changed", "gone"] as const).find(code => code === frame.e) ?? "failed");
    // Fewer bytes than asked only at the end of the file, and none past it.
    if (ask.got !== Math.max(0, Math.min(ask.length, frame.z - ask.offset))) return this.settle(ask, "failed");
    this.settle(ask);
    ask.resolve({ bytes: concatBytes(...ask.chunks), size: frame.z });
  }

  /** `app` closed on either side: its serves end, what it was sending stops and what it asked fails with `error`. */
  closeApp(app: string, error: AppRangeReadError = "peer-closed"): void {
    for (const [id, serve] of this.serves) if (serve.app === app) this.serves.delete(id);
    for (const task of this.held) if (task.app === app) { this.drop(task); this.held.delete(task); }
    for (const ask of this.waiting.get(app) ?? []) ask.reject(new Error(error));
    this.waiting.delete(app);
    for (const ask of this.asking.values()) if (ask.app === app) this.settle(ask, error);
  }

  /** The session ended: no serve id lasts into the next, and every request fails with `offline`. */
  reset(): void {
    const apps = new Set([...this.serves.values()].map(serve => serve.app).concat([...this.held].map(task => task.app), [...this.waiting.keys()], [...this.asking.values()].map(ask => ask.app)));
    for (const app of apps) this.closeApp(app, "offline");
  }

  /** `task` is no longer live and its request number frees; its place stays held until it is settled. */
  private drop(task: Serving): void {
    task.live = false;
    if (this.serving.get(slot(task.app, task.request)) === task) this.serving.delete(slot(task.app, task.request));
  }

  /** Settles `task`, freeing its place; false when it was no longer live (nothing more goes for it). */
  private take(task: AppRangeTask): boolean {
    const held = task as Serving;
    if (!this.held.delete(held)) return false;
    const live = held.live;
    this.drop(held);
    return live;
  }

  /** Ends `ask` (failing it with `error` when given) and sends the next one waiting for its app. */
  private settle(ask: Asking, error?: AppRangeReadError): void {
    if (ask.request === undefined || this.asking.get(slot(ask.app, ask.request)) !== ask) return;
    this.asking.delete(slot(ask.app, ask.request));
    if (error) ask.reject(new Error(error));
    this.pump(ask.app);
  }

  private pump(app: string): void {
    const queue = this.waiting.get(app);
    let inFlight = [...this.asking.values()].filter(ask => ask.app === app).length;
    while (queue?.length && inFlight < APP_RANGE_LIMITS.inFlight) {
      const ask = queue.shift()!;
      let request = this.nextRequest;
      while (this.asking.has(slot(app, request))) request = request === APP_RANGE_LIMITS.maxRequest ? 0 : request + 1;
      this.nextRequest = request === APP_RANGE_LIMITS.maxRequest ? 0 : request + 1;
      ask.request = request;
      this.asking.set(slot(app, request), ask);
      inFlight++;
      this.send(appRangeGetFrame(app, ask.serve, request, ask.offset, ask.length));
    }
    if (queue && !queue.length) this.waiting.delete(app);
  }
}
