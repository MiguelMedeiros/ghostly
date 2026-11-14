import { isZ32Key, utf8Decode, utf8Encode } from "./bytes";
import { GROUP_ID } from "./groupCommits";
import { openPair, sealPair } from "./groupCrypto";
import type { Identity } from "./identity";
import { readInviteCode } from "./invite";
import { RateWindow } from "./pairedEdits";
import { hasVisible, stripHidden } from "./text";

/**
 * A private message started from a group (WISP 902 § Private messages, 903 § Pair payloads, 801 § An invite handed
 * through a group). A member asks another for a 1:1 chat by handing it a fresh `ghostly1` invite sealed to that member
 * alone: in a community as a pair payload `{ "dm": … }`, in a private group as a `group-pair` frame, on their edge or
 * handed on once by a hub. Nobody else, hubs included, reads the invite. The receiver answers `got` when it shows the
 * request and `no` when its person declines; accepting is joining the invite, which pins the key the request names.
 */

/** The `paired-groups` version an app announces when it takes `group-pair` frames (7 is the file-session request's). */
export const GROUP_VERSION_PAIR = 8;
export const GROUP_PAIR_FRAME = "group-pair" as const;

/** Proposed values, for review. */
export const DM_LIMITS = {
  /** One request per member this often, from one member. */
  everyMs: 10 * 60_000,
  /** And at most this many a day. */
  perDay: 3,
  dayMs: 24 * 60 * 60_000,
  /** After a decline, how long before the same member may ask again. */
  declinedMs: 24 * 60 * 60_000,
  /** With no `got` by then, the sender's app shows the invite to copy (an older app, or a member away). */
  answerMs: 30_000,
  /** The sender's name in the request, in code points. */
  nameChars: 64,
  /** A sealed payload, as a community's pair payload. */
  payloadBytes: 8 * 1024,
} as const;

/** How far from this clock a `group-pair` frame's time may be: it is live, never stored nor caught up. */
export const PAIR_FRESH_MS = 10 * 60_000;
const PAIR_AHEAD_MS = 2 * 60_000;
/** Frames of one member a hub passes on per minute. */
export const PAIRS_PER_MINUTE = 10;
/** Frames whose nonce a receiver or a hub remembers, to take or pass each once within `PAIR_FRESH_MS`. */
export const PAIR_SEEN_KEPT = 1024;
/** Of those, frames from one member a receiver takes while they could still be fresh (12 minutes). */
export const PAIR_SEEN_PER_MEMBER = 64;
/** How long a nonce is kept: a frame up to `PAIR_AHEAD_MS` ahead stays fresh until `PAIR_FRESH_MS` past its time. */
const SEEN_FOR_MS = PAIR_FRESH_MS + PAIR_AHEAD_MS;

/** `k`: the inviter's participation key for the 1:1 chat, the one `c` pins; it names the request in the answers. */
export type DmBody = { t: "req"; c: string; k: string; n?: string } | { t: "got" | "no"; k: string };

const BARE_CODE = /^ghostly1[02-9ac-hj-np-z]+$/;

/** A request for the 1:1 chat of `code`, a `ghostly1` invite this app just made. */
export function dmRequest(code: string, name?: string): DmBody {
  const reading = readInviteCode(code);
  const k = reading.ok ? reading.params.peerParticipationKeyZ32 : undefined;
  const body = k && readDmBody({ t: "req", c: code, k, ...(name ? { n: name } : {}) });
  if (!body) throw new Error("A private-message request needs a ghostly1 invite and a name of at most 64 characters, with no hidden ones");
  return body;
}

export function dmAnswer(t: "got" | "no", k: string): DmBody { return { t, k }; }

/**
 * A well-formed body, or null. A request's code is a bare `ghostly1` code in lower case that reads, and its `k` is the
 * participation key that code carries: what the joiner pins is what the member who sealed it named.
 */
export function readDmBody(raw: unknown): DmBody | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.k !== "string" || !isZ32Key(f.k)) return null;
  if (f.t === "got" || f.t === "no") return { t: f.t, k: f.k };
  if (f.t !== "req" || typeof f.c !== "string" || !BARE_CODE.test(f.c)) return null;
  const reading = readInviteCode(f.c);
  if (!reading.ok || reading.format !== "ghostly1" || reading.params.peerParticipationKeyZ32 !== f.k) return null;
  if (f.n !== undefined && (typeof f.n !== "string" || !f.n.trim() || [...f.n].length > DM_LIMITS.nameChars
    || stripHidden(f.n) !== f.n || !hasVisible(f.n))) return null;
  return { t: "req", c: f.c, k: f.k, ...(f.n !== undefined ? { n: f.n } : {}) };
}

/** The body of a community pair payload, or null when it carries none (a payment, a file session). */
export function readDmPayload(payload: Record<string, unknown>): DmBody | null {
  return payload.dm === undefined ? null : readDmBody(payload.dm);
}

/** `e`, `n`, `c`: the box (`sealPair`). `h`: handed on once by a hub. */
export interface GroupPairFrame { t: typeof GROUP_PAIR_FRAME; g: string; from: string; to: string; ts: number; e: string; n: string; c: string; h?: 1 }

/** The box is bound to its group, both members and its time; the label keeps it apart from a community's pair box. */
const pairAad = (g: string, from: string, to: string, ts: number) => JSON.stringify(["ghostly-group/1 pair", g, from, to, ts]);

const B64 = /^[A-Za-z0-9_-]+$/;
/** The base64url of the largest box: the payload and its 16-byte tag. */
const MAX_BOX = Math.ceil((DM_LIMITS.payloadBytes + 16) * 4 / 3);

/** A payload for one member of group `g`, sealed with my member key. Throws past `DM_LIMITS.payloadBytes`. */
export function sealGroupPair(me: Identity, g: string, to: string, payload: Record<string, unknown>, now = Date.now()): GroupPairFrame {
  const plain = utf8Encode(JSON.stringify(payload));
  if (plain.length > DM_LIMITS.payloadBytes) throw new Error("Too large for a group-pair frame");
  const ts = Math.floor(now);
  return { t: GROUP_PAIR_FRAME, g, from: me.pubKeyZ32, to, ts, ...sealPair(me.seed, me.pubKeyZ32, to, plain, pairAad(g, me.pubKeyZ32, to, ts)) };
}

/** A well-formed `group-pair`, or null. Only `to` can tell whether its box opens. */
export function readGroupPair(raw: unknown): GroupPairFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (f.t !== GROUP_PAIR_FRAME || typeof f.g !== "string" || !GROUP_ID.test(f.g)) return null;
  if (typeof f.from !== "string" || !isZ32Key(f.from) || typeof f.to !== "string" || !isZ32Key(f.to) || f.from === f.to) return null;
  if (typeof f.ts !== "number" || !Number.isSafeInteger(f.ts) || f.ts < 0) return null;
  // A pair box's ephemeral key and nonce, as a community's (32 and 24 bytes): a hub keeps the nonce and cannot open the box.
  if (typeof f.e !== "string" || f.e.length !== 43 || !B64.test(f.e) || typeof f.n !== "string" || f.n.length !== 32 || !B64.test(f.n)) return null;
  if (typeof f.c !== "string" || f.c.length > MAX_BOX || !B64.test(f.c)) return null;
  if (f.h !== undefined && f.h !== 1) return null;
  return { t: GROUP_PAIR_FRAME, g: f.g, from: f.from, to: f.to, ts: f.ts, e: f.e, n: f.n, c: f.c, ...(f.h === 1 ? { h: 1 as const } : {}) };
}

/** Where a frame came from: the session's group, the member at the other end of the edge, who is in the roster. */
export interface GroupPairSource { group: string; edge: string; member(key: string): boolean }

/**
 * Nonces of frames already taken, each until its frame can no longer be fresh. A nonce is never forgotten before then:
 * with `PAIR_SEEN_KEPT` kept, or `perMember` from one member, a new frame is refused instead. So at most
 * `PAIR_SEEN_KEPT` nonces and as many member counts.
 */
class Seen {
  private readonly at = new Map<string, { at: number; from: string }>();
  private readonly counts = new Map<string, number>();
  constructor(private readonly now: () => number, private readonly perMember = PAIR_SEEN_KEPT) {}

  has(nonce: string): boolean { this.drop(); return this.at.has(nonce); }

  /** Whether one more frame from `from` may be kept now. */
  fits(from: string): boolean { this.drop(); return this.at.size < PAIR_SEEN_KEPT && (this.counts.get(from) ?? 0) < this.perMember; }

  /** True the first time it fits; false for a nonce kept already, or with no room for it. */
  add(nonce: string, from: string): boolean {
    if (this.has(nonce) || !this.fits(from)) return false;
    this.at.set(nonce, { at: this.now(), from });
    this.counts.set(from, (this.counts.get(from) ?? 0) + 1);
    return true;
  }

  /** Kept in order of arrival: only those whose frame can no longer be fresh go, the oldest first. */
  private drop(): void {
    const now = this.now();
    for (const [nonce, kept] of this.at) {
      if (now - kept.at <= SEEN_FOR_MS) break;
      this.at.delete(nonce);
      const left = (this.counts.get(kept.from) ?? 1) - 1;
      if (left > 0) this.counts.set(kept.from, left); else this.counts.delete(kept.from);
    }
  }
}

const fresh = (ts: number, now: number) => ts >= now - PAIR_FRESH_MS && ts <= now + PAIR_AHEAD_MS;

/** What one member key takes of the `group-pair` frames that come to it. */
export class GroupPairInbox {
  private readonly seen: Seen;
  constructor(private readonly me: Identity, private readonly now: () => number = Date.now) { this.seen = new Seen(now, PAIR_SEEN_PER_MEMBER); }

  /**
   * The payload of a frame for me, or null. Straight from an edge, only from the member at its other end; handed on,
   * only from a member of the roster. Fresh, opened as from `from`, and once: past `PAIR_SEEN_PER_MEMBER` from one
   * member, or `PAIR_SEEN_KEPT` in all, that could still be fresh, a new frame is refused rather than one forgotten.
   */
  open(raw: unknown, source: GroupPairSource): { from: string; payload: Record<string, unknown> } | null {
    const f = readGroupPair(raw);
    if (!f || f.g !== source.group || f.to !== this.me.pubKeyZ32 || !fresh(f.ts, this.now())) return null;
    if (f.h ? !source.member(f.from) : f.from !== source.edge) return null;
    // A replay, or a frame with no room, is refused before the open costs an X25519: `n` and `from` are in the clear,
    // and only a frame that opens takes its nonce, so a forged box carrying another's nonce blocks nothing.
    if (this.seen.has(f.n) || !this.seen.fits(f.from)) return null;
    const plain = openPair(this.me.seed, this.me.pubKeyZ32, f.from, f, pairAad(f.g, f.from, f.to, f.ts));
    if (!plain || !this.seen.add(f.n, f.from)) return null;
    try {
      const payload: unknown = JSON.parse(utf8Decode(plain));
      return payload && typeof payload === "object" && !Array.isArray(payload) ? { from: f.from, payload: payload as Record<string, unknown> } : null;
    } catch { return null; }
  }
}

/**
 * What a hub does with a `group-pair` that is not for it: passes it on once, marked `h`, to the edge of `to`. Only a
 * frame its sender put on the edge it came on (never one handed on already), for a member of the roster, fresh, and at
 * most `PAIRS_PER_MINUTE` of one member. It checks no box: it cannot open it. With `PAIR_SEEN_KEPT` passed that could
 * still be fresh, it passes none until one can no longer be, rather than forget one it might then pass again.
 */
export class GroupPairRelay {
  private readonly seen: Seen;
  private readonly rates = new Map<string, RateWindow>();
  constructor(private readonly now: () => number = Date.now) { this.seen = new Seen(now); }

  pass(raw: unknown, source: GroupPairSource): GroupPairFrame | null {
    const f = readGroupPair(raw);
    if (!f || f.h || f.g !== source.group || f.from !== source.edge || !source.member(f.to) || !fresh(f.ts, this.now())) return null;
    let rate = this.rates.get(f.from);
    if (!rate) this.rates.set(f.from, rate = new RateWindow(PAIRS_PER_MINUTE, 60_000, this.now));
    if (this.seen.has(f.n) || !this.seen.fits(f.from) || !rate.take()) return null;
    this.seen.add(f.n, f.from);
    return { ...f, h: 1 };
  }
}

export type DmRefusal = "soon" | "day" | "declined";
/** Saved per `<group id> <member key>`: when requests went (or came), and when the last one was declined. */
export type DmGateState = Record<string, { at: number[]; no?: number }>;

/**
 * The request limits, kept by both sides: the sender's app does not ask past them, and the receiver's drops a request
 * past them unanswered, so a modified app gains nothing.
 */
export class DmGate {
  private readonly pairs = new Map<string, { at: number[]; no?: number }>();

  constructor(saved?: DmGateState) {
    for (const [key, entry] of Object.entries(saved ?? {})) {
      if (!Array.isArray(entry?.at) || !entry.at.every(Number.isFinite) || (entry.no !== undefined && !Number.isFinite(entry.no))) continue;
      this.pairs.set(key, { at: [...entry.at], ...(entry.no !== undefined ? { no: entry.no } : {}) });
    }
  }

  /** Why a request between me and `member` in `group` may not go (or be taken) now; null when it may. */
  check(group: string, member: string, now: number): DmRefusal | null {
    const entry = this.entry(group, member, now);
    if (!entry) return null;
    if (entry.no !== undefined) return "declined";
    if (entry.at.some(at => now - at < DM_LIMITS.everyMs)) return "soon";
    return entry.at.length >= DM_LIMITS.perDay ? "day" : null;
  }

  /** `check`, and the request counted when it may go. */
  take(group: string, member: string, now: number): DmRefusal | null {
    const refused = this.check(group, member, now);
    if (refused) return refused;
    const key = `${group} ${member}`, entry = this.pairs.get(key);
    if (entry) entry.at.push(now); else this.pairs.set(key, { at: [now] });
    return null;
  }

  /** A request between me and `member` was declined: none for `DM_LIMITS.declinedMs`. */
  declined(group: string, member: string, now: number): void {
    const key = `${group} ${member}`;
    this.pairs.set(key, { at: this.pairs.get(key)?.at ?? [], no: now });
  }

  /** What is still within a window at `now`, to save. */
  state(now = Date.now()): DmGateState {
    const out: DmGateState = {};
    for (const key of [...this.pairs.keys()]) {
      const [group, member] = key.split(" ");
      const entry = this.entry(group, member, now);
      if (entry) out[key] = { at: [...entry.at], ...(entry.no !== undefined ? { no: entry.no } : {}) };
    }
    return out;
  }

  /** The entry with what fell out of every window at `now` dropped. */
  private entry(group: string, member: string, now: number): { at: number[]; no?: number } | undefined {
    const key = `${group} ${member}`, entry = this.pairs.get(key);
    if (!entry) return undefined;
    entry.at = entry.at.filter(t => now - t < DM_LIMITS.dayMs);
    if (entry.no !== undefined && now - entry.no >= DM_LIMITS.declinedMs) delete entry.no;
    if (!entry.at.length && entry.no === undefined) { this.pairs.delete(key); return undefined; }
    return entry;
  }
}
