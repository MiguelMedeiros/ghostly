import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, fromZ32, toBase64Url, toZ32, utf8Encode } from "./bytes";

/**
 * Mini-apps talking in a 1:1 chat (WISP 1200 § In a chat: `apps/1`): the same app on both sides sends JSON to the
 * other over the live session, in one frame with three forms.
 *
 *     {"t":"paired-app","a":"<chat app id>","o":"open","v":"1.2.0"}
 *     {"t":"paired-app","a":"<chat app id>","o":"close"}
 *     {"t":"paired-app","a":"<chat app id>","d":<JSON value>}
 *
 * It needs `apps/1` in `paired-capabilities` on both sides. Live only: never on the DHT, never held, never queued for
 * later; while the session is not live a send fails with `offline`. An `open` goes when the person opens the app in
 * the chat, again on an update, and again on every session that comes back while the app is open. The receiver
 * enforces the limits (the sender's client may be the attacker): at most `APP_DATA_MAX_BYTES` of data, at most
 * `APP_RATE_LIMIT` frames a second per app, data only for an app open on both sides, at most `APP_PEER_OPEN_MAX`
 * apps the peer has open, and nothing unless both sides offer `apps/1`.
 *
 * The chat app id names one app in one chat: the first 16 bytes of HMAC-SHA-256 keyed by the two pinned participation
 * keys over the app reference `<publisher key in z-base32>/<name>`. One app's id differs in each chat, so ids cannot
 * be matched across a person's chats; it travels only inside the encrypted session.
 */

export const APP_FRAME = "paired-app";

/** The largest `d`, as compact UTF-8 JSON. The session's 60 KiB cap on any frame still holds above it. */
export const APP_DATA_MAX_BYTES = 32 * 1024;
/** Frames a receiver takes per app per `APP_RATE_WINDOW_MS`; the rest are dropped unread. */
export const APP_RATE_LIMIT = 50;
export const APP_RATE_WINDOW_MS = 1_000;
/** Data frames a sender sends per app per window: under the receiver's limit, so an `open` or `close` always fits. */
export const APP_SEND_LIMIT = APP_RATE_LIMIT - 2;
/** Distinct apps the peer may have open on one session; an `open` for one more is dropped. */
export const APP_PEER_OPEN_MAX = 16;
/** The longest version an `open` carries. */
export const APP_VERSION_MAX = 64;

/** Why a send did not go. */
export type AppSendError =
  /** This side has not opened the app in this chat. */
  | "not-open"
  /** The value is over `APP_DATA_MAX_BYTES` as JSON (or is not JSON). */
  | "too-large"
  /** The session is not live. Nothing is kept to send later. */
  | "offline"
  /** The peer has not opened the app on this session, or its app does not offer `apps/1`. */
  | "peer-closed"
  /** Over `APP_SEND_LIMIT` data frames in the window for this app. */
  | "too-fast";

export type AppFrame =
  | { t: typeof APP_FRAME; a: string; o: "open"; v: string }
  | { t: typeof APP_FRAME; a: string; o: "close" }
  | { t: typeof APP_FRAME; a: string; d: unknown };

/**
 * What the peer said about one app, as the engine passes it on. `close` with `offline` is not a frame: the session
 * ended (or `apps/1` stopped being agreed) while the peer had the app open.
 */
export type AppFrameEvent =
  | { app: string; o: "open"; v: string }
  | { app: string; o: "close"; offline?: true }
  | { app: string; d: unknown };

const DOMAIN = "ghostly-apps/1";
const APP_ID = /^[A-Za-z0-9_-]{22}$/;
/** The manifest's `name` (WISP 1200 § Manifest). */
const APP_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** Semantic versioning 2.0.0, as a manifest's `version` is. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** A chat app id as it is on the wire: 22 base64url characters (16 bytes, no padding). */
export function isChatAppId(value: unknown): value is string {
  return typeof value === "string" && APP_ID.test(value);
}

/** A version an `open` may carry: semantic versioning, at most `APP_VERSION_MAX` characters. */
export function isAppVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= APP_VERSION_MAX && SEMVER.test(value);
}

/** An app reference, `<publisher key in z-base32>/<name>`: a canonical 52-character key and a manifest name. */
export function isAppRef(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 52 + 1 + 32) return false;
  const slash = value.indexOf("/");
  if (slash !== 52 || !APP_NAME.test(value.slice(53))) return false;
  const key = value.slice(0, 52);
  try { const bytes = fromZ32(key); return bytes.length === 32 && toZ32(bytes) === key; } catch { return false; }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * The chat app id of `ref` in the chat between these two participation keys (raw, 32 bytes each, in either order):
 * HMAC-SHA-256 keyed by SHA-256(`ghostly-apps/1`, 0x00, the lower key, the higher key), over the UTF-8 reference;
 * its first 16 bytes, base64url without padding.
 */
export function chatAppId(keyA: Uint8Array, keyB: Uint8Array, ref: string): string {
  if (keyA.length !== 32 || keyB.length !== 32) throw new Error("A participation key is 32 bytes");
  if (!isAppRef(ref)) throw new Error("Not an app reference");
  const [low, high] = compareBytes(keyA, keyB) <= 0 ? [keyA, keyB] : [keyB, keyA];
  const key = sha256(concatBytes(utf8Encode(DOMAIN), new Uint8Array([0]), low, high));
  return toBase64Url(hmac(sha256, key, utf8Encode(ref)).slice(0, 16));
}

/** The size of a value as compact UTF-8 JSON; Infinity when it is not JSON (undefined, a function, a cycle, a BigInt). */
export function appDataBytes(value: unknown): number {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { return Infinity; }
  return json === undefined ? Infinity : utf8Encode(json).length;
}

export function appOpenFrame(app: string, version: string): AppFrame {
  if (!isChatAppId(app) || !isAppVersion(version)) throw new Error("Not an app open");
  return { t: APP_FRAME, a: app, o: "open", v: version };
}

export function appCloseFrame(app: string): AppFrame {
  if (!isChatAppId(app)) throw new Error("Not an app close");
  return { t: APP_FRAME, a: app, o: "close" };
}

export function appDataFrame(app: string, data: unknown): AppFrame {
  if (!isChatAppId(app) || appDataBytes(data) > APP_DATA_MAX_BYTES) throw new Error("Not app data");
  return { t: APP_FRAME, a: app, d: data };
}

/** Why a reader refuses a `paired-app` frame (the vectors' `refusal`). */
export type AppFrameRefusal = "not-app" | "bad-a" | "o-and-d" | "no-o-or-d" | "too-large" | "unknown-o" | "bad-v";

/**
 * A `paired-app` frame as the peer sent it, or why a reader must refuse it: no valid `a` (22 base64url characters),
 * both or neither of `o` and `d`, an unknown `o`, an `open` without a valid `v`, or a `d` over `APP_DATA_MAX_BYTES`.
 * Other keys are ignored, so a later version can add some.
 */
export function readAppFrame(frame: Record<string, unknown>): { ok: true; frame: AppFrame } | { ok: false; refusal: AppFrameRefusal } {
  const refuse = (refusal: AppFrameRefusal) => ({ ok: false as const, refusal });
  if (frame?.t !== APP_FRAME) return refuse("not-app");
  if (!isChatAppId(frame.a)) return refuse("bad-a");
  const own = (key: string) => Object.prototype.hasOwnProperty.call(frame, key);
  const hasO = own("o"), hasD = own("d");
  if (hasO && hasD) return refuse("o-and-d");
  if (!hasO && !hasD) return refuse("no-o-or-d");
  if (hasD) return appDataBytes(frame.d) <= APP_DATA_MAX_BYTES ? { ok: true, frame: { t: APP_FRAME, a: frame.a, d: frame.d } } : refuse("too-large");
  if (frame.o === "close") return { ok: true, frame: { t: APP_FRAME, a: frame.a, o: "close" } };
  if (frame.o !== "open") return refuse("unknown-o");
  return isAppVersion(frame.v) ? { ok: true, frame: { t: APP_FRAME, a: frame.a, o: "open", v: frame.v } } : refuse("bad-v");
}

/** A `paired-app` frame as the peer sent it, or null when a reader must refuse it (`readAppFrame` says why). */
export function parseAppFrame(frame: Record<string, unknown>): AppFrame | null {
  const read = readAppFrame(frame);
  return read.ok ? read.frame : null;
}

/** Frames per app in a sliding window, for at most `max` apps at once. */
class RateWindows {
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly max: number) {}

  /** Counts one frame for `app` at `now`; false when it is over the limit (not counted then). */
  take(app: string, now: number): boolean {
    let window = this.windows.get(app);
    if (!window) {
      if (this.windows.size >= this.max) this.prune(now);
      if (this.windows.size >= this.max) return false;
      window = [];
      this.windows.set(app, window);
    }
    while (window.length && now - window[0] >= APP_RATE_WINDOW_MS) window.shift();
    if (window.length >= this.limit) return false;
    window.push(now);
    return true;
  }

  private prune(now: number): void {
    for (const [app, window] of this.windows) if (!window.length || now - window[window.length - 1] >= APP_RATE_WINDOW_MS) this.windows.delete(app);
  }

  clear(): void { this.windows.clear(); }
}

/**
 * The apps of one chat on its live sessions. `open` (this side's apps, by chat app id, with their versions) lasts
 * across sessions, so each new one says `open` again; what the peer has open lasts one session.
 */
export class AppSessions {
  private readonly peer = new Map<string, string>();
  private received = new RateWindows(APP_RATE_LIMIT, 4 * APP_PEER_OPEN_MAX);
  private sent = new RateWindows(APP_SEND_LIMIT, 4 * APP_PEER_OPEN_MAX);

  constructor(readonly open: Map<string, string> = new Map(), private readonly now: () => number = Date.now) {}

  /** The peer has this app open on this session, at this version. */
  peerVersion(app: string): string | undefined { return this.peer.get(app); }

  /** The apps the peer has open on this session. */
  get peerOpen(): ReadonlyMap<string, string> { return this.peer; }

  /**
   * A `paired-app` frame from the peer, on a session where both sides offer `apps/1`. Counted before it is read; the
   * event to pass on, or null when it was dropped (malformed, over the rate, a data frame for an app not open on both
   * sides, an `open` past `APP_PEER_OPEN_MAX`, a `close` of an app the peer did not have open).
   */
  receive(frame: Record<string, unknown>): AppFrameEvent | null {
    if (!isChatAppId(frame?.a) || !this.received.take(frame.a, this.now())) return null;
    const parsed = parseAppFrame(frame);
    if (!parsed) return null;
    const app = parsed.a;
    if ("d" in parsed) return this.open.has(app) && this.peer.has(app) ? { app, d: parsed.d } : null;
    if (parsed.o === "close") return this.peer.delete(app) ? { app, o: "close" } : null;
    if (!this.peer.has(app) && this.peer.size >= APP_PEER_OPEN_MAX) return null;
    this.peer.set(app, parsed.v);
    return { app, o: "open", v: parsed.v };
  }

  /** Whether a data frame for `app` may go now, the session being live with `apps/1` agreed; counted when it may. */
  canSend(app: string, data: unknown): AppSendError | null {
    if (!this.open.has(app)) return "not-open";
    if (appDataBytes(data) > APP_DATA_MAX_BYTES) return "too-large";
    if (!this.peer.has(app)) return "peer-closed";
    return this.sent.take(app, this.now()) ? null : "too-fast";
  }

  /**
   * The session ended, or `apps/1` is no longer agreed: what the peer had open is gone, and each such app hears a
   * `close` with `offline`. This side's open apps stay, and say `open` again on the next session.
   */
  sessionEnded(): AppFrameEvent[] {
    const closed = [...this.peer.keys()].map((app): AppFrameEvent => ({ app, o: "close", offline: true }));
    this.peer.clear();
    this.received.clear();
    this.sent.clear();
    return closed;
  }
}
