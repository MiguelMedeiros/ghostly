import { verifyEvent } from "nostr-tools/pure";

/**
 * A bounded Nostr relay client (NIP-01) for the social layer: reads one filter from a few relays, or
 * sends one signed event to them. Every socket has a deadline, a frame budget and a frame-size cap; every
 * event is signature-checked on a fresh copy before it is returned, never on a verification flag a relay
 * or an SDK object carries. Relays the person configured only: nothing here discovers relays from what it
 * reads (a kind-3 relay list, a NIP-65 record), so the set of servers that learn what was looked up stays
 * the set the person can see.
 */

export interface NostrEvent { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string }

export interface NostrFilter {
  kinds: number[];
  authors?: string[];
  ids?: string[];
  "#p"?: string[];
  "#e"?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

export interface RelayReadOptions {
  /** Per relay, from opening the socket to closing it. Default 8 s. */
  timeoutMs?: number;
  /** Events accepted per relay before the subscription is closed. Default 64. */
  maxEvents?: number;
  /** Longest frame read, in UTF-16 code units. Default 64 KiB. */
  maxFrameBytes?: number;
  /** Longest event content accepted, in UTF-16 code units. Default 16 KiB. */
  maxContentLength?: number;
  signal?: AbortSignal;
  makeSocket?: (url: string) => WebSocket;
}

export interface RelayReadResult {
  /** Verified, deduplicated by id, newest first. */
  events: NostrEvent[];
  /** Relays that answered the subscription (an EOSE or at least one event). */
  answered: string[];
  /** Relays that could not be reached or timed out. */
  failed: string[];
}

export interface RelayPublishResult {
  accepted: string[];
  rejected: { relay: string; reason: string }[];
}

const HEX64 = /^[a-f0-9]{64}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The default relays, shown in the settings so the person sees who is asked. */
export const DEFAULT_NOSTR_RELAYS: readonly string[] = ["wss://relay.damus.io", "wss://nos.lol"];
export const MAX_NOSTR_RELAYS = 8;

/**
 * A relay address the person typed: `wss://` only (`ws://` on loopback, for local tests), no
 * credentials, no fragment. Returns the canonical form, or throws a message the person can act on.
 */
export function normalizeNostrRelay(input: string): string {
  const value = input.trim();
  if (!value || value.length > 256) throw new Error("Enter a relay address (wss://…)");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Not a relay address: ${value.slice(0, 40)}`); }
  if (url.username || url.password || url.hash || url.search) throw new Error("A relay address has no credentials, query or fragment");
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && LOOPBACK.has(url.hostname))) throw new Error("Use secure wss:// relays (ws:// is allowed only on loopback for local testing)");
  return url.href.replace(/\/$/, "");
}

/** The person's relay list, validated and deduplicated; at least one, at most `MAX_NOSTR_RELAYS`. */
export function normalizeNostrRelays(relays: readonly string[]): string[] {
  const out = [...new Set(relays.map(normalizeNostrRelay))];
  if (out.length === 0) throw new Error("Enter at least one relay address (wss://…)");
  if (out.length > MAX_NOSTR_RELAYS) throw new Error(`At most ${MAX_NOSTR_RELAYS} relays`);
  return out;
}

/**
 * Strict shape of an event off the wire, then its id and BIP-340 signature, checked here on a copy.
 * Returns the copy, or undefined for anything that is not a valid signed event within the bounds.
 */
export function checkedEvent(raw: unknown, maxContentLength = 16 * 1024, now = Date.now()): NostrEvent | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== "string" || !HEX64.test(e.id) || typeof e.pubkey !== "string" || !HEX64.test(e.pubkey) ||
    typeof e.sig !== "string" || !/^[a-f0-9]{128}$/.test(e.sig) || !Number.isSafeInteger(e.kind) || (e.kind as number) < 0 ||
    !Number.isSafeInteger(e.created_at) || (e.created_at as number) < 0 || (e.created_at as number) * 1000 > now + 15 * 60_000 ||
    typeof e.content !== "string" || e.content.length > maxContentLength || !Array.isArray(e.tags) || e.tags.length > 2000 ||
    !e.tags.every(t => Array.isArray(t) && t.length <= 8 && t.every(x => typeof x === "string" && x.length <= 1024))) return;
  const copy: NostrEvent = { id: e.id, pubkey: e.pubkey, created_at: e.created_at as number, kind: e.kind as number, tags: (e.tags as string[][]).map(t => [...t]), content: e.content, sig: e.sig };
  try { if (!verifyEvent(copy)) return; } catch { return; }
  // verifyEvent marks the object it checked; the caller gets an unmarked copy so nothing downstream trusts a flag.
  return { ...copy, tags: copy.tags.map(t => [...t]) };
}

const subscriptionId = () => "ghostly-" + Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, "0")).join("");

/** Newest first, ties broken by the lexicographically smaller id (NIP-01's rule for replaceable events). */
export const byNewest = (a: NostrEvent, b: NostrEvent) => b.created_at - a.created_at || a.id.localeCompare(b.id);

/** Reads everything matching `filter` from each relay, until EOSE, the event budget or the deadline. */
export async function readRelays(relays: readonly string[], filter: NostrFilter, options: RelayReadOptions = {}): Promise<RelayReadResult> {
  const { timeoutMs = 8_000, maxEvents = 64, maxFrameBytes = 64 * 1024, maxContentLength = 16 * 1024, signal, makeSocket = url => new WebSocket(url) } = options;
  signal?.throwIfAborted();
  const seen = new Map<string, NostrEvent>();
  const answered: string[] = [];
  const failed: string[] = [];
  await Promise.all(relays.map(relay => new Promise<void>(resolve => {
    let socket: WebSocket;
    try { socket = makeSocket(relay); } catch { failed.push(relay); resolve(); return; }
    const sub = subscriptionId();
    let count = 0, replied = false, done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try { if (socket.readyState === 1) socket.send(JSON.stringify(["CLOSE", sub])); socket.close(); } catch { /* already closed */ }
      (ok ? answered : failed).push(relay);
      resolve();
    };
    const onAbort = () => finish(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish(replied), timeoutMs);
    socket.onopen = () => { if (done) { socket.close(); return; } socket.send(JSON.stringify(["REQ", sub, filter])); };
    socket.onerror = () => finish(replied);
    socket.onclose = () => finish(replied);
    socket.onmessage = message => {
      if (done) return;
      if (typeof message.data !== "string" || message.data.length > maxFrameBytes) { finish(replied); return; }
      let frame: unknown;
      try { frame = JSON.parse(message.data); } catch { return; }
      if (!Array.isArray(frame) || frame[1] !== sub) return;
      if (frame[0] === "EOSE") { replied = true; finish(true); return; }
      if (frame[0] === "CLOSED") { finish(replied); return; }
      if (frame[0] !== "EVENT") return;
      const event = checkedEvent(frame[2], maxContentLength);
      if (!event || !filter.kinds.includes(event.kind) || (filter.authors && !filter.authors.includes(event.pubkey))) return;
      replied = true;
      if (!seen.has(event.id)) seen.set(event.id, event);
      if (++count >= maxEvents) finish(true);
    };
  })));
  return { events: [...seen.values()].sort(byNewest), answered, failed };
}

/** Sends one signed event to each relay and waits for its OK (NIP-20 semantics within NIP-01). */
export async function publishToRelays(relays: readonly string[], event: NostrEvent, options: Pick<RelayReadOptions, "timeoutMs" | "signal" | "makeSocket"> = {}): Promise<RelayPublishResult> {
  const { timeoutMs = 8_000, signal, makeSocket = url => new WebSocket(url) } = options;
  signal?.throwIfAborted();
  const accepted: string[] = [];
  const rejected: { relay: string; reason: string }[] = [];
  const payload = JSON.stringify(["EVENT", event]);
  await Promise.all(relays.map(relay => new Promise<void>(resolve => {
    let socket: WebSocket;
    try { socket = makeSocket(relay); } catch { rejected.push({ relay, reason: "Could not open a connection" }); resolve(); return; }
    let done = false;
    const finish = (reason?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try { socket.close(); } catch { /* already closed */ }
      if (reason === undefined) accepted.push(relay); else rejected.push({ relay, reason });
      resolve();
    };
    const onAbort = () => finish("Cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish("No answer from the relay"), timeoutMs);
    socket.onopen = () => { if (done) { socket.close(); return; } socket.send(payload); };
    socket.onerror = () => finish("Could not reach the relay");
    socket.onclose = () => finish("The relay closed the connection");
    socket.onmessage = message => {
      if (done || typeof message.data !== "string" || message.data.length > 16 * 1024) return;
      let frame: unknown;
      try { frame = JSON.parse(message.data); } catch { return; }
      if (!Array.isArray(frame) || frame[0] !== "OK" || frame[1] !== event.id) return;
      if (frame[2] === true) finish();
      else finish(typeof frame[3] === "string" && frame[3] ? frame[3].slice(0, 200) : "Refused by the relay");
    };
  })));
  return { accepted, rejected };
}
