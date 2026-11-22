import { fromBase64Url, isZ32Key, randomBytes, toBase64Url, utf8Encode } from "./bytes";
import { GROUP_ID } from "./groupCommits";
import { identityFromSeed, publicKeyFromZ32, sign, verify } from "./identity";
import { sanitizeDisplayText } from "./text";

/**
 * A member's request for a pass to its group's call (WISP 602 · Group Calls § The token request): what it sends to
 * `POST <sfu>/sfu/group-token`, signed by its group key over the node's origin, so the node can tell a member of the
 * roster asked, for this node, within the last minute.
 *
 *     {"v":1,"g":"<group>","k":"<member key>","room":"g_<group>","ts":1794700800,"n":"<nonce>","name":"Ana","sig":"…"}
 *
 * Pure: the node's own route, the e2e double and the tests share these checks. Whether `k` is in the roster is the
 * node's to say, since only it follows the group's chain; every refusal here is one 403 there.
 */

export const GROUP_CALL_VERSION = 1;
/** How far a request's `ts` may be from the node's clock, either way, in seconds. */
export const GROUP_CALL_SKEW_S = 60;
/** How long a nonce the node took is kept, in seconds: past it, `ts` alone refuses the request. */
export const GROUP_CALL_NONCE_S = 120;
/** Longest display name a pass carries, in code points. */
export const MAX_GROUP_CALL_NAME = 64;

export interface GroupCallRequest {
  v: typeof GROUP_CALL_VERSION;
  g: string;
  k: string;
  room: string;
  ts: number;
  n: string;
  name?: string;
  sig: string;
}

/** Why a request was refused: for logs and tests only, the node answers each the same way. */
export type GroupCallRefusal = "malformed" | "stale" | "replayed" | "signature";

/** Nonces the node took, each with the time it was taken (unix seconds). */
export type GroupCallNonces = Map<string, number>;

const NONCE = /^[A-Za-z0-9_-]{22}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;

/** A group's call room: `g_` and the group id, a namespace no guest pass may enter. */
export const groupCallRoom = (g: string) => `g_${g}`;

/** Exactly the bytes a member signs: the array form, as a leave statement is. */
export const groupCallRequestBytes = (sfu: string, g: string, room: string, k: string, ts: number, n: string) =>
  utf8Encode(JSON.stringify(["ghostly-sfu/1 token", sfu, g, room, k, ts, n]));

/** A request for `sfu` (the group's `call.sfu`, as read), signed by the member's group key `seed`. */
export function signGroupCallRequest(input: { sfu: string; g: string; name?: string; ts?: number; n?: string }, seed: Uint8Array): GroupCallRequest {
  const k = identityFromSeed(seed).pubKeyZ32;
  const room = groupCallRoom(input.g);
  const ts = input.ts ?? Math.floor(Date.now() / 1000);
  const n = input.n ?? toBase64Url(randomBytes(16));
  const name = input.name === undefined ? undefined : sanitizeDisplayText(input.name, MAX_GROUP_CALL_NAME);
  const sig = toBase64Url(sign(groupCallRequestBytes(input.sfu, input.g, room, k, ts, n), seed));
  return { v: GROUP_CALL_VERSION, g: input.g, k, room, ts, n, ...(name ? { name } : {}), sig };
}

/**
 * The node's checks but the roster, in order: the shape, the time within `GROUP_CALL_SKEW_S` of `now` (ms), a nonce
 * not in `seen`, and the signature over the node's own origin `sfu`. A request that passes has its nonce added to
 * `seen`; entries older than `GROUP_CALL_NONCE_S` are dropped on the way. The name comes back clean and cut to
 * `MAX_GROUP_CALL_NAME` code points, or left out.
 */
export function verifyGroupCallRequest(raw: unknown, sfu: string, now: number, seen: GroupCallNonces): { ok: true; request: GroupCallRequest } | { ok: false; reason: GroupCallRefusal } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "malformed" };
  const f = raw as Record<string, unknown>;
  if (f.v !== GROUP_CALL_VERSION || typeof f.g !== "string" || !GROUP_ID.test(f.g) || !isZ32Key(f.k) || f.room !== groupCallRoom(f.g) ||
    !Number.isSafeInteger(f.ts) || (f.ts as number) <= 0 || typeof f.n !== "string" || !NONCE.test(f.n) || toBase64Url(fromBase64Url(f.n)) !== f.n ||
    (f.name !== undefined && typeof f.name !== "string") || typeof f.sig !== "string" || !SIG.test(f.sig)) return { ok: false, reason: "malformed" };
  const room = groupCallRoom(f.g), ts = f.ts as number, nowS = Math.floor(now / 1000);
  if (Math.abs(nowS - ts) > GROUP_CALL_SKEW_S) return { ok: false, reason: "stale" };
  for (const [n, at] of seen) if (nowS - at > GROUP_CALL_NONCE_S) seen.delete(n);
  if (seen.has(f.n)) return { ok: false, reason: "replayed" };
  let holds = false;
  try { holds = verify(fromBase64Url(f.sig), groupCallRequestBytes(sfu, f.g, room, f.k, ts, f.n), publicKeyFromZ32(f.k)); } catch { /* not a signature */ }
  if (!holds) return { ok: false, reason: "signature" };
  seen.set(f.n, nowS);
  const name = typeof f.name === "string" ? sanitizeDisplayText(f.name, MAX_GROUP_CALL_NAME) : undefined;
  return { ok: true, request: { v: GROUP_CALL_VERSION, g: f.g, k: f.k, room, ts, n: f.n, ...(name ? { name } : {}), sig: f.sig } };
}

/**
 * An admin's request to act on a member in its group's call (WISP 602 · Group Calls § Moderation): what it sends to
 * `POST <sfu>/sfu/group-moderate`, signed by its group key over the node's origin as a token request is, under its own
 * tag, so neither request can stand for the other.
 *
 *     {"v":1,"g":"<group>","k":"<admin key>","room":"g_<group>","act":"mute","target":"<member key>","src":["microphone"],
 *      "ts":1794700800,"n":"<nonce>","sig":"…"}
 *
 * `mute` takes `src` away from `target`, `allow` gives it back, `remove` takes `target` out of the call and keeps it
 * out, `unban` lets it back in, and `state` changes nothing (the reply says who is muted and banned). Whether `k` is
 * the group's admin is the node's to say, from its roster.
 */

/** What an admin can take from a member, in the sorted order a request lists them in. */
export const GROUP_CALL_SOURCES = ["camera", "microphone", "screen_share"] as const;
export type GroupCallSource = (typeof GROUP_CALL_SOURCES)[number];

export const GROUP_CALL_MODERATION_ACTS = ["mute", "allow", "remove", "unban", "state"] as const;
export type GroupCallModerationAct = (typeof GROUP_CALL_MODERATION_ACTS)[number];

export interface GroupCallModeration {
  v: typeof GROUP_CALL_VERSION;
  g: string;
  k: string;
  room: string;
  act: GroupCallModerationAct;
  /** The member acted on; `""` for `state`. */
  target: string;
  /** Non-empty, unique and sorted for `mute` and `allow`; empty for the other acts. */
  src: GroupCallSource[];
  ts: number;
  n: string;
  sig: string;
}

const takesSources = (act: GroupCallModerationAct) => act === "mute" || act === "allow";

/** Exactly the bytes an admin signs: the array form, as the token request's. */
export const groupCallModerationBytes = (sfu: string, g: string, room: string, k: string, act: GroupCallModerationAct, target: string, src: readonly GroupCallSource[], ts: number, n: string) =>
  utf8Encode(JSON.stringify(["ghostly-sfu/1 moderate", sfu, g, room, k, act, target, src, ts, n]));

/** A moderation request for `sfu`, signed by the admin's group key `seed`; `src` is listed unique and sorted. */
export function signGroupCallModeration(
  input: { sfu: string; g: string; act: GroupCallModerationAct; target?: string; src?: readonly GroupCallSource[]; ts?: number; n?: string },
  seed: Uint8Array,
): GroupCallModeration {
  const k = identityFromSeed(seed).pubKeyZ32;
  const room = groupCallRoom(input.g);
  const target = input.act === "state" ? "" : input.target ?? "";
  const src = takesSources(input.act) ? [...new Set(input.src ?? [])].sort() : [];
  const ts = input.ts ?? Math.floor(Date.now() / 1000);
  const n = input.n ?? toBase64Url(randomBytes(16));
  const sig = toBase64Url(sign(groupCallModerationBytes(input.sfu, input.g, room, k, input.act, target, src, ts, n), seed));
  return { v: GROUP_CALL_VERSION, g: input.g, k, room, act: input.act, target, src, ts, n, sig };
}

/** `src` as an act takes it: unique known sources in sorted order, at least one, for `mute` and `allow`; none otherwise. */
function sourcesFit(act: GroupCallModerationAct, src: unknown): src is GroupCallSource[] {
  if (!Array.isArray(src)) return false;
  if (!takesSources(act)) return src.length === 0;
  return src.length > 0 && src.every((s, i) => (GROUP_CALL_SOURCES as readonly unknown[]).includes(s) && (i === 0 || src[i - 1] < s));
}

/**
 * The node's checks of a moderation request but the roster, in order: the shape (a known act, a `target` that is a
 * member key other than `k`, or `""` for `state`, and `src` as the act takes it), the time within `GROUP_CALL_SKEW_S`
 * of `now` (ms), a nonce not in `seen`, and the signature over the node's own origin `sfu`. A request that passes has
 * its nonce added to `seen`; entries older than `GROUP_CALL_NONCE_S` are dropped on the way.
 */
export function verifyGroupCallModeration(raw: unknown, sfu: string, now: number, seen: GroupCallNonces): { ok: true; request: GroupCallModeration } | { ok: false; reason: GroupCallRefusal } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "malformed" };
  const f = raw as Record<string, unknown>;
  const act = f.act as GroupCallModerationAct;
  if (f.v !== GROUP_CALL_VERSION || typeof f.g !== "string" || !GROUP_ID.test(f.g) || !isZ32Key(f.k) || f.room !== groupCallRoom(f.g) ||
    !(GROUP_CALL_MODERATION_ACTS as readonly unknown[]).includes(act) ||
    (act === "state" ? f.target !== "" : !isZ32Key(f.target) || f.target === f.k) || !sourcesFit(act, f.src) ||
    !Number.isSafeInteger(f.ts) || (f.ts as number) <= 0 || typeof f.n !== "string" || !NONCE.test(f.n) || toBase64Url(fromBase64Url(f.n)) !== f.n ||
    typeof f.sig !== "string" || !SIG.test(f.sig)) return { ok: false, reason: "malformed" };
  const room = groupCallRoom(f.g), target = f.target as string, src = f.src as GroupCallSource[], ts = f.ts as number, nowS = Math.floor(now / 1000);
  if (Math.abs(nowS - ts) > GROUP_CALL_SKEW_S) return { ok: false, reason: "stale" };
  for (const [n, at] of seen) if (nowS - at > GROUP_CALL_NONCE_S) seen.delete(n);
  if (seen.has(f.n)) return { ok: false, reason: "replayed" };
  let holds = false;
  try { holds = verify(fromBase64Url(f.sig), groupCallModerationBytes(sfu, f.g, room, f.k, act, target, src, ts, f.n), publicKeyFromZ32(f.k)); } catch { /* not a signature */ }
  if (!holds) return { ok: false, reason: "signature" };
  seen.set(f.n, nowS);
  return { ok: true, request: { v: GROUP_CALL_VERSION, g: f.g, k: f.k, room, act, target, src: [...src], ts, n: f.n, sig: f.sig } };
}
