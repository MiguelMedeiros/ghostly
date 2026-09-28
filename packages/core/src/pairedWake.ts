import { toBase64Url, utf8Encode, randomBytes } from "./bytes";
import { checkPushEndpoint, pushRequest, vapidKeysMatch, type PushRequest, type PushTarget, type VapidKeys } from "./webPush";

/**
 * Wake-up push (WISP 401 § Wake-up push): a contact whose web app is closed can be woken by this app, with no
 * server of Ghostly's. The contact's app subscribes to its browser's push service and shares, with each paired
 * contact and only on the live session, where to post and how:
 *
 *     {"t":"paired-wake","w":{"e":"https://fcm.googleapis.com/fcm/send/…","p":"<p256dh>","a":"<auth>",
 *                             "vp":"<VAPID public>","vk":"<VAPID private>","k":"<token>"}}
 *     {"t":"paired-wake","w":null}                       (stopped: forget what I shared)
 *
 * When a message to that contact cannot go live (the contact's app is closed), this app posts an encrypted push
 * of a few bytes to the endpoint: `{"wake":1,"k":"<token>"}`. It says nothing about the message: the contact's
 * app shows "New message", opens on a tap, connects and fetches the message itself. The token is the contact's
 * own name for this chat, different for every contact, so its app knows which chat (and whether it is muted)
 * without the push service learning anything: it sees only that a push happened, and when.
 *
 * It needs `wake/1` in `paired-capabilities` on both sides. The VAPID key pair belongs to that one subscription,
 * so sharing its private half lets a contact post to that subscription and nothing else. Rotating it (a new
 * subscription, new tokens) is how the contact's app revokes everyone it no longer shares with.
 */

export { WAKE_SESSION_CAPABILITY as WAKE_CAPABILITY } from "./pairedCapabilities";
export const WAKE_FRAME = "paired-wake";

/** At most one wake-up per contact in this long. A burst of messages is one push. */
export const WAKE_INTERVAL_MS = 5 * 60_000;
/** A wake-up that has not reached the phone within this is no use: the push service may drop it. */
export const WAKE_TTL_SECONDS = 60 * 60;
/** The VAPID subject push services ask for: who to contact about abuse. The project, never a person. */
export const WAKE_SUBJECT = "https://ghostly.tools";

/** What a contact shares: its push subscription, the key pair it was made with, and its token for this chat. */
export interface WakeTarget extends PushTarget {
  vapid: VapidKeys;
  token: string;
}

export type WakeFrame = {
  t: typeof WAKE_FRAME;
  w: { e: string; p: string; a: string; vp: string; vk: string; k: string } | null;
};

/** A fresh per-contact token: 16 random bytes, base64url. */
export function newWakeToken(): string {
  return toBase64Url(randomBytes(16));
}

export function wakeFrame(target: WakeTarget | null): WakeFrame {
  return {
    t: WAKE_FRAME,
    w: target && { e: target.endpoint, p: target.p256dh, a: target.auth, vp: target.vapid.publicKey, vk: target.vapid.privateKey, k: target.token },
  };
}

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const B64URL = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * What a `paired-wake` frame says: the contact's target, null when it stopped sharing, or undefined when the frame
 * is malformed (then it says nothing, and what the contact said before stands). The endpoint must be an https
 * push service on a public host name, and the key pair must be a pair.
 */
export function parseWakeFrame(frame: Record<string, unknown>): WakeTarget | null | undefined {
  if (frame.w === null) return null;
  const w = frame.w as Record<string, unknown> | undefined;
  if (!w || typeof w !== "object") return undefined;
  const { e, p, a, vp, vk, k } = w;
  if (typeof e !== "string" || ![p, a, vp, vk].every((v) => typeof v === "string" && B64URL.test(v)) || typeof k !== "string" || !TOKEN.test(k)) return undefined;
  try { checkPushEndpoint(e); } catch { return undefined; }
  const target: WakeTarget = { endpoint: e, p256dh: p as string, auth: a as string, vapid: { publicKey: vp as string, privateKey: vk as string }, token: k };
  if (!vapidKeysMatch(target.vapid)) return undefined;
  return target;
}

/**
 * What a wake-up is for: a message waits, or a call does (the caller rings until the contact's app is live, then
 * calls). The receiving app picks its own words for each; the push says nothing more.
 */
export type WakeKind = "message" | "call";

/** At most one call wake-up per contact in this long: a caller who tries again at once is not a new push. */
export const WAKE_CALL_INTERVAL_MS = 30_000;
/** How long a caller waits for the woken contact's app to come live before giving up. */
export const WAKE_CALL_WAIT_MS = 60_000;
/** A call wake-up is useless once the caller stopped waiting: the push service may drop it after this. */
export const WAKE_CALL_TTL_SECONDS = 60;

/** The wake-up's plaintext: the contact's token for this chat, and whether it is for a call. Nothing else. */
export function wakePayload(token: string, kind: WakeKind = "message"): Uint8Array {
  return utf8Encode(JSON.stringify(kind === "call" ? { wake: 1, k: token, c: 1 } : { wake: 1, k: token }));
}

/** A wake-up as the receiving service worker reads it: the token and its kind; null for anything else. */
export function readWake(text: string | null | undefined): { token: string; kind: WakeKind } | null {
  if (!text || text.length > 200) return null;
  try {
    const value = JSON.parse(text) as { wake?: unknown; k?: unknown; c?: unknown };
    if (value?.wake !== 1 || typeof value.k !== "string" || !TOKEN.test(value.k)) return null;
    return { token: value.k, kind: value.c === 1 ? "call" : "message" };
  } catch {
    return null;
  }
}

/** The token a wake-up carries; null for anything else. */
export function readWakePayload(text: string | null | undefined): string | null {
  return readWake(text)?.token ?? null;
}

/** The request that wakes the contact. Throws `WebPushError` when the target cannot be used. */
export function wakeRequest(target: WakeTarget, now = Date.now(), kind: WakeKind = "message"): PushRequest {
  return pushRequest(target, target.vapid, wakePayload(target.token, kind), {
    subject: WAKE_SUBJECT, ttlSeconds: kind === "call" ? WAKE_CALL_TTL_SECONDS : WAKE_TTL_SECONDS, now,
  });
}

/** One wake-up per contact per `WAKE_INTERVAL_MS`. Kept in memory: a restart may send one more, never a flood. */
export class WakeLimiter {
  private readonly last = new Map<string, number>();
  constructor(private readonly interval = WAKE_INTERVAL_MS) {}
  /** Whether a wake-up to `contact` may go now; if so, it counts as sent. */
  take(contact: string, now = Date.now()): boolean {
    const before = this.last.get(contact);
    if (before !== undefined && now - before < this.interval) return false;
    this.last.set(contact, now);
    return true;
  }
  /** The contact answered (it is live again): the next time it is away, it may be woken at once. */
  reset(contact: string): void {
    this.last.delete(contact);
  }
}

/**
 * What a push relay is asked (Settings → Network → Push relay): a browser page may not post to a push service
 * itself (the services answer without CORS), so it can hand the finished request to a relay the person chose,
 * which posts it as it is. The relay learns what the push service learns, plus this device's address.
 *
 *     POST <relay>   {"endpoint":"https://…","headers":{"Authorization":"vapid …",…},"body":"<base64url>"}
 */
export function relayRequest(request: PushRequest): { endpoint: string; headers: Record<string, string>; body: string } {
  return { endpoint: request.url, headers: request.headers, body: toBase64Url(request.body) };
}

