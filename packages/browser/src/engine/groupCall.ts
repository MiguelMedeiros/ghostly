import { engineError, randomBytes, sign, toBase64Url, utf8Encode, type GroupMeta } from "@ghostly/core";

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
const MAX_REPLY_CHARS = 64 * 1024;
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

/** The reply's pass, or null when it is not one for this room and key. */
export function parseGroupCallPass(raw: unknown, room: string, identity: string): GroupCallPass | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== "string" || typeof r.token !== "string" || !r.token || r.room !== room || r.identity !== identity) return null;
  try { if (!["wss:", "ws:"].includes(new URL(r.url).protocol)) return null; } catch { return null; }
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
      response = await doFetch(`${ask.sfu}/sfu/group-token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(GROUP_CALL_TIMEOUT_MS) });
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
    if (response.ok) try { const text = await response.text(); raw = text.length <= MAX_REPLY_CHARS ? JSON.parse(text) : null; } catch { raw = null; }
    const pass = parseGroupCallPass(raw, room, ask.k);
    if (!pass) throw engineError("groupCallFailed", { host });
    return pass;
  }
}
