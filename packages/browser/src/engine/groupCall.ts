import {
  GROUP_CALL_SOURCES, engineError, isZ32Key, randomBytes, sign, signGroupCallModeration, toBase64Url, utf8Encode,
  type GroupCallModerationAct, type GroupCallSource, type GroupMeta,
} from "@ghostly/core";

/**
 * A member asks its group's call node for a pass (WISP 602 · Group Calls § The token request): signed with its member
 * key, sent to the node the admin named in the group's metadata (`call.sfu`), and the reply checked before a page uses it.
 */

/** What the node answers, as checked here (WISP 602 § The reply). */
export interface GroupCallPass {
  url: string;
  token: string;
  room: string;
  identity: string;
  expiresIn: number;
  iceServers?: RTCIceServer[];
}

/** The request as it goes to `<sfu>/sfu/group-token`. */
export interface GroupCallRequest { v: 1; g: string; k: string; room: string; ts: number; n: string; name?: string; sig: string }

/** Tries of a refused request (the node may not have taken the commit that let me in yet), and the waits between them. */
export const GROUP_CALL_RETRY_MS = [3_000, 7_000] as const;
/** How long one request may take. */
export const GROUP_CALL_TIMEOUT_MS = 10_000;
/** The most of a reply read: a pass with a few TURN servers is a couple of kilobytes. */
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_NAME = 64;
const MAX_SFU = 200;
/** WISP 602: a pass lets one join for at most an hour. */
const MAX_EXPIRES_IN = 3600;

/**
 * The node a group's metadata names for its calls, when `call.sfu` holds (an `https` origin in its one spelling);
 * undefined for none. Stands in until the metadata parses `call` itself (`parseGroupMetaBody`), then reads it there.
 */
export function groupCallSfu(meta: GroupMeta | undefined): string | undefined {
  if (!meta) return undefined;
  let body: unknown;
  try { body = JSON.parse(meta.body); } catch { return undefined; }
  const sfu = (body as { call?: { sfu?: unknown } } | null)?.call?.sfu;
  if (typeof sfu !== "string" || sfu.length > MAX_SFU) return undefined;
  try {
    const url = new URL(sfu);
    return url.protocol === "https:" && url.origin === sfu ? sfu : undefined;
  } catch { return undefined; }
}

/** WISP 602 § Signed bytes. */
export const groupCallRequestBytes = (sfu: string, g: string, room: string, k: string, ts: number, n: string): Uint8Array =>
  utf8Encode(JSON.stringify(["ghostly-sfu/1 token", sfu, g, room, k, ts, n]));

/**
 * A token request signed by the member key whose seed is `seed`. Stands in for core's `signGroupCallRequest`: the same
 * request, the same signature (the WISP's test vector).
 */
export function signGroupCallRequest(sfu: string, fields: { g: string; k: string; ts: number; n: string; name?: string }, seed: Uint8Array): GroupCallRequest {
  const room = `g_${fields.g}`;
  const sig = toBase64Url(sign(groupCallRequestBytes(sfu, fields.g, room, fields.k, fields.ts, fields.n), seed));
  return { v: 1, g: fields.g, k: fields.k, room, ts: fields.ts, n: fields.n, ...(fields.name ? { name: fields.name } : {}), sig };
}

/**
 * Where a pass may send its LiveKit client: `wss://`, or `ws://` to this machine (a node for tests or development), as a
 * relay's address. LiveKit puts the token in the address, so a `ws://` one elsewhere would hand the pass to the path.
 */
function passUrlHolds(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "wss:" || (parsed.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname));
  } catch { return false; }
}

/** The reply's pass, or null when it is not one for this room and key. */
export function parseGroupCallPass(raw: unknown, room: string, identity: string): GroupCallPass | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== "string" || typeof r.token !== "string" || !r.token || r.room !== room || r.identity !== identity) return null;
  if (!passUrlHolds(r.url)) return null;
  if (typeof r.expiresIn !== "number" || !Number.isFinite(r.expiresIn) || r.expiresIn <= 0) return null;
  const iceServers = Array.isArray(r.iceServers) ? r.iceServers.flatMap(iceServer) : undefined;
  return { url: r.url, token: r.token, room, identity, expiresIn: Math.min(r.expiresIn, MAX_EXPIRES_IN), ...(iceServers?.length ? { iceServers } : {}) };
}

function iceServer(raw: unknown): RTCIceServer[] {
  if (!raw || typeof raw !== "object") return [];
  const s = raw as Record<string, unknown>;
  const urls = typeof s.urls === "string" ? [s.urls] : Array.isArray(s.urls) ? s.urls.filter((u): u is string => typeof u === "string") : [];
  if (!urls.length) return [];
  return [{ urls, ...(typeof s.username === "string" && { username: s.username }), ...(typeof s.credential === "string" && { credential: s.credential }) }];
}

export interface GroupCallAsk {
  sfu: string;
  g: string;
  /** My member key in the group, and its seed. */
  k: string;
  seed: Uint8Array;
  /** The name members know me by; the node prefers its own. */
  name?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Asks the group's node for a pass: a fresh request each try (its own `ts` and nonce). A `403` is asked again after
 * `GROUP_CALL_RETRY_MS`, since a node that has not taken the commit that let me in yet refuses me for a few seconds.
 * Every way it fails is one engine error a page says in a line.
 */
export async function fetchGroupCallToken(ask: GroupCallAsk): Promise<GroupCallPass> {
  const doFetch = ask.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = ask.now ?? Date.now, sleep = ask.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const host = new URL(ask.sfu).host, room = `g_${ask.g}`;
  const name = ask.name ? [...ask.name].slice(0, MAX_NAME).join("") : undefined;
  for (let attempt = 0; ; attempt++) {
    const request = signGroupCallRequest(ask.sfu, { g: ask.g, k: ask.k, ts: Math.floor(now() / 1000), n: toBase64Url(randomBytes(16)), name }, ask.seed);
    let response: Response;
    try {
      // No redirect: one would send my key, name and signed request to a host the group never named.
      response = await doFetch(`${ask.sfu}/sfu/group-token`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(GROUP_CALL_TIMEOUT_MS),
        redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
      });
    } catch (error) {
      throw (error as { name?: string } | null)?.name === "TimeoutError" ? engineError("hostTimedOut", { host }) : engineError("hostUnreachable", { host });
    }
    if (response.status === 403 && attempt < GROUP_CALL_RETRY_MS.length) {
      await sleep(GROUP_CALL_RETRY_MS[attempt]);
      continue;
    }
    if (response.status === 403) throw engineError("groupCallRefused", { host });
    if (response.status === 429) throw engineError("groupCallBusy", { host });
    let raw: unknown = null;
    if (response.ok) try { const text = await readCapped(response, MAX_REPLY_BYTES); raw = text === null ? null : JSON.parse(text); } catch { raw = null; }
    const pass = parseGroupCallPass(raw, room, ask.k);
    if (!pass) throw engineError("groupCallFailed", { host });
    return pass;
  }
}

/** The room's state after an act (WISP 602 § Moderation, the reply): the sources taken from each key, and who is banned. */
export interface GroupCallRoomState { muted: Record<string, GroupCallSource[]>; banned: string[] }

/**
 * Why a moderation request did nothing. `not_admin`: I am not the group's admin, so nothing was sent. `refused`: the
 * node's 403. `rate_limited`: its 429, again after `retryAfter` seconds. `unsupported`: the group names no node, or
 * its node is older than the route (404 or 405). `unreachable`: no answer in time, or one that is not a room's state.
 */
export type GroupCallModerationCode = "not_admin" | "refused" | "rate_limited" | "unsupported" | "unreachable";
export type GroupCallModerationResult = { ok: true; state: GroupCallRoomState } | { ok: false; code: GroupCallModerationCode; retryAfter?: number };

/** A 429 that says no time (or says it badly) is asked again after the node's window, a minute; one that says more, an hour at most. */
const DEFAULT_RETRY_AFTER_S = 60;
const MAX_RETRY_AFTER_S = 3600;

export interface GroupCallModerationAsk {
  sfu: string;
  g: string;
  /** The seed of my member key in the group, the admin's. */
  seed: Uint8Array;
  act: GroupCallModerationAct;
  target?: string;
  src?: readonly GroupCallSource[];
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Sends the admin's signed request to `<sfu>/sfu/group-moderate` (WISP 602 § Moderation) once, as a token request goes
 * (no redirect, no cookie, the same timeout and capped read), and says what came back as a code, never as a throw.
 */
export async function sendGroupCallModeration(ask: GroupCallModerationAsk): Promise<GroupCallModerationResult> {
  const doFetch = ask.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = ask.now ?? Date.now;
  const request = signGroupCallModeration({ sfu: ask.sfu, g: ask.g, act: ask.act, target: ask.target, src: ask.src, ts: Math.floor(now() / 1000) }, ask.seed);
  let response: Response;
  try {
    response = await doFetch(`${ask.sfu}/sfu/group-moderate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(GROUP_CALL_TIMEOUT_MS),
      redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
    });
  } catch { return { ok: false, code: "unreachable" }; }
  if (response.status === 403) return { ok: false, code: "refused" };
  if (response.status === 429) return { ok: false, code: "rate_limited", retryAfter: retryAfterS(response.headers.get("Retry-After"), now()) };
  if (response.status === 404 || response.status === 405) return { ok: false, code: "unsupported" };
  let raw: unknown = null;
  if (response.ok) try { const text = await readCapped(response, MAX_REPLY_BYTES); raw = text === null ? null : JSON.parse(text); } catch { raw = null; }
  const state = parseGroupCallRoomState(raw);
  return state ? { ok: true, state } : { ok: false, code: "unreachable" };
}

/** `Retry-After` in seconds, given as seconds or as an HTTP date. */
function retryAfterS(header: string | null, now: number): number {
  const value = header?.trim() ?? "";
  if (/^\d{1,10}$/.test(value)) return Math.min(Number(value), MAX_RETRY_AFTER_S);
  const at = value ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? Math.min(Math.max(0, Math.ceil((at - now) / 1000)), MAX_RETRY_AFTER_S) : DEFAULT_RETRY_AFTER_S;
}

/**
 * The reply's room state, or null when it is none: its keys are member keys and its sources known ones, listed once and
 * sorted, as the WISP has the node write them. A key with no source left is not muted.
 */
export function parseGroupCallRoomState(raw: unknown): GroupCallRoomState | null {
  const state = (raw as { state?: unknown } | null)?.state as { muted?: unknown; banned?: unknown } | null | undefined;
  if (!state || typeof state !== "object" || !state.muted || typeof state.muted !== "object" || Array.isArray(state.muted) || !Array.isArray(state.banned)) return null;
  const muted: Record<string, GroupCallSource[]> = {};
  for (const [key, src] of Object.entries(state.muted)) {
    if (!isZ32Key(key) || !Array.isArray(src)) return null;
    const known = GROUP_CALL_SOURCES.filter(s => src.includes(s));
    if (known.length) muted[key] = known;
  }
  if (!state.banned.every(isZ32Key)) return null;
  return { muted, banned: [...new Set(state.banned as string[])].sort() };
}

/**
 * The reply's text, or null past `max` bytes: read as it comes and stopped there, so a node's endless (or gzip-bombed)
 * reply never sits whole in the engine's memory.
 */
async function readCapped(response: Response, max: number): Promise<string | null> {
  if (Number(response.headers.get("content-length")) > max) { await response.body?.cancel().catch(() => {}); return null; }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      size += next.value.byteLength;
      if (size > max) return null;
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder().decode(all);
}
