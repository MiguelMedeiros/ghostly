import { fromBase64Url, toBase64Url } from "./bytes";
import { GROUP_ID, MEMBER_KEY } from "./groupCommits";
import type { Identity } from "./identity";
import { createRelayPayload, newerPacket, parseRelayPayload, RELAY_PAYLOAD_MAX_BYTES, type GhostRecord, type SignedPacket } from "./pkarr";
import { budgetRetryMs, isDiscoveryBudgetError, type PkarrRequestOptions, type PkarrTransport } from "./transport";

/**
 * Edge signaling through members (WISP 9xx · Group Mesh § Signaling through members). An edge of a private group is a
 * paired link, and its presence, offer and answer are Pkarr packets: each costs relay requests, of which an app allows
 * itself 30 a minute per relay, and each is seen at the other end's next poll. A member that joins a group of eight
 * opens seven edges at once, and the admin reads the link's knocks meanwhile: the minute was spent before the edges
 * were up, and what was left waited for it to free (40 to 75 s for a fifth member on two relays, 2026-10-01).
 *
 * Two members about to open an edge usually both have an open link to a third: the admin that just admitted one of
 * them, any member both already reach. That member **carries** the packet: the very bytes a relay would store, signed
 * by the edge's key, which only the two ends can derive. The carrier can neither read nor forge it (to it, as to a
 * relay, it is an opaque signed blob), and the receiver takes it exactly as it takes a relay's answer. The relays still
 * get the packet, a moment later and only the newest one, so an edge that opens through members costs one publish
 * where it cost three and several reads.
 */

/** The `paired-groups` version an app announces when it carries and takes edge signaling through members. */
export const GROUP_VERSION_SIGNALS = 5;
export const GROUP_SIGNAL_FRAME = "group-signal" as const;
/**
 * How long a packet handed to carriers waits before it goes to the relays too. An edge that opens meanwhile publishes
 * its settled packet instead, and this one never goes; with nothing heard from the other end by then (its app is older,
 * or no member reaches both), the relays get it and the edge goes on as before, this much later, once.
 */
export const CARRIED_DEFER_MS = 1_500;
/** Carriers a packet is handed to at most: two members down at once is rare, and every copy costs the receiver a frame. */
export const SIGNAL_CARRIERS = 2;
/** Frames of one member a carrier passes on per minute: a member joining a group of 32 sends about a hundred. */
export const SIGNALS_PER_MINUTE = 240;
/**
 * How long after a carried packet came from the other end the way through members counts as known to work: its own
 * packets then wait before going to the relays (`CARRIED_DEFER_MS`).
 */
export const SIGNAL_PROVEN_MS = 10_000;
/**
 * How long a member keeps a frame it cannot pass on yet: the edge to whom it is for is often a moment from up (the
 * member was just admitted, or its app just came back and its edges open one after the other).
 */
export const SIGNAL_HOLD_MS = 5_000;
/** After a carried packet came from a member, mine goes back the same way at most this often. */
export const SIGNAL_REPLY_MS = 30_000;
/**
 * How far from this clock a carried packet's time may be. Signaling is live: an offer is answered within seconds or
 * given up. A member that kept another's old offer cannot hand it on later as if it were new; a packet from a clock
 * further off than this is left to the relays, as before.
 */
export const SIGNAL_FRESH_MS = 2 * 60_000;
const B64 = /^[A-Za-z0-9_-]+$/;
const MAX_B64 = Math.ceil(RELAY_PAYLOAD_MAX_BYTES * 4 / 3);

/** `p`: the relay payload (signature, timestamp, DNS packet) as a relay would take it. `h`: passed on once already. */
export interface GroupSignalFrame { t: typeof GROUP_SIGNAL_FRAME; g: string; to: string; from: string; p: string; h?: 1 }

export function groupSignalFrame(g: string, from: string, to: string, payload: Uint8Array, hop = false): GroupSignalFrame {
  return { t: GROUP_SIGNAL_FRAME, g, to, from, p: toBase64Url(payload), ...(hop ? { h: 1 as const } : {}) };
}

/** A well-formed `group-signal`, or null. Its packet is checked by whoever it is for (`CarriedTransport.accept`). */
export function readGroupSignal(raw: unknown): { g: string; to: string; from: string; payload: Uint8Array; hop: boolean } | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (f.t !== GROUP_SIGNAL_FRAME || typeof f.g !== "string" || !GROUP_ID.test(f.g)) return null;
  if (typeof f.to !== "string" || !MEMBER_KEY.test(f.to) || typeof f.from !== "string" || !MEMBER_KEY.test(f.from) || f.to === f.from) return null;
  if (typeof f.p !== "string" || f.p.length > MAX_B64 || !B64.test(f.p)) return null;
  if (f.h !== undefined && f.h !== 1) return null;
  try { return { g: f.g, to: f.to, from: f.from, payload: fromBase64Url(f.p), hop: f.h === 1 }; } catch { return null; }
}

export interface CarriedHooks {
  /**
   * Hands my packet for this edge to links that may pass it on. `taken`: how many took it (0: nobody could). `sure`:
   * one of them reaches the other end as far as anyone can tell (a link of the two of us beside the edge, or the
   * admin, which keeps an edge with everyone), so the relays can wait even before anything came back that way.
   */
  carry(payload: Uint8Array): { taken: number; sure: boolean };
  /** The edge's own data link is open: it carries everything, and nothing is handed to anyone. */
  open(): boolean;
  /** A carried packet of the member's is here and no read is under way: look now. */
  look(): void;
  /** `CARRIED_DEFER_MS`, for tests. */
  deferMs?: number;
}

/**
 * The Pkarr transport of one edge, with members carrying its packets beside the relays. Publishes under the edge's own
 * key and reads of the member's key go through it; anything else goes straight to the transport underneath.
 */
export class CarriedTransport implements PkarrTransport {
  /** My last packet while the edge is down: what a member that just became reachable is handed. */
  private mine: Uint8Array | null = null;
  private lastTimestamp = 0n;
  /** The newest packet of the member's that came through a carrier, and the timestamp of the one a read last returned. */
  private carried: SignedPacket | null = null;
  private returned = -1n;
  /** The newest packet of the member's any read returned, from the relays or a carrier: nothing older is taken after it. */
  private seen = -1n;
  /** A read under way: resolved when a carried packet comes meanwhile. */
  private waiting: (() => void) | null = null;
  /** The packet the relays have not got yet. */
  private pending: { identity: Identity; records: GhostRecord[]; options?: PkarrRequestOptions; timer: ReturnType<typeof setTimeout>; heardBefore: number; ended: Promise<"ended">; end: () => void } | null = null;
  /** How many carried packets of the member's came: a deferral that ends with none more says no member reaches it. */
  private heard = 0;
  /** When the last one came (`SIGNAL_PROVEN_MS`). */
  private heardAt = -Infinity;
  /** No member reached the other end: packets go to the relays at once until one does. */
  private quiet = false;
  private stopped = false;
  readonly publishPayload?: PkarrTransport["publishPayload"];
  readonly discovery?: PkarrTransport["discovery"];
  readonly subscribe?: PkarrTransport["subscribe"];
  readonly networkChanged?: PkarrTransport["networkChanged"];
  readonly configure?: PkarrTransport["configure"];

  constructor(private readonly inner: PkarrTransport, private readonly myKey: string, private readonly peerKey: string, private readonly hooks: CarriedHooks) {
    if (inner.publishPayload) this.publishPayload = (key, payload, options) => inner.publishPayload!(key, payload, options);
    if (inner.discovery) this.discovery = () => inner.discovery!();
    if (inner.subscribe) this.subscribe = listener => inner.subscribe!(listener);
    if (inner.networkChanged) this.networkChanged = () => inner.networkChanged!();
    if (inner.configure) this.configure = options => inner.configure!(options);
  }

  describe(): { protocol: string; relays: string[] } { return this.inner.describe(); }

  async publish(identity: Identity, records: GhostRecord[], options?: PkarrRequestOptions): Promise<void> {
    if (this.stopped || identity.pubKeyZ32 !== this.myKey) return this.inner.publish(identity, records, options);
    this.drop();
    // Up: the edge carries everything, and its packet on the relays (it is here, its offer is settled) is nothing
    // anyone waits for. It goes as a background write, behind the links that are signaling (a new offer of its own aside).
    if (this.hooks.open()) { this.mine = null; return this.inner.publish(identity, records, options?.signal ? options : { ...options, background: true }); }
    // The same order as the relays' copy keeps: each packet newer than the last.
    const now = BigInt(Date.now()) * 1000n;
    this.lastTimestamp = now > this.lastTimestamp ? now : this.lastTimestamp + 1n;
    const payload = createRelayPayload(identity, records, this.lastTimestamp);
    this.mine = payload;
    let carried = { taken: 0, sure: false };
    try { carried = this.hooks.carry(payload); } catch { /* nobody took it */ }
    // The relays wait only when the way through members is known to work, or as good as: a member that took the
    // packet may not reach the other end (after a restart, two members answering the same one each hold the other's
    // answer), and an answer held back for nothing is read a poll later.
    const proven = Date.now() - this.heardAt < SIGNAL_PROVEN_MS;
    if (!carried.taken || this.quiet || !(carried.sure || proven)) return this.inner.publish(identity, records, options);
    let end!: () => void;
    const ended = new Promise<"ended">(resolve => { end = () => resolve("ended"); });
    this.pending = { identity, records, options, heardBefore: this.heard, ended, end, timer: setTimeout(() => this.flush(), this.hooks.deferMs ?? CARRIED_DEFER_MS) };
  }

  /** The deferred packet goes to the relays: the edge did not open meanwhile. Tried again while it is still the newest. */
  private flush(): void {
    const pending = this.pending;
    if (!pending || this.stopped) return;
    pending.end();
    // Nothing came back through a member: none reaches the other end (or its app does not take carried packets).
    if (this.heard === pending.heardBefore) this.quiet = true;
    this.inner.publish(pending.identity, pending.records, pending.options).then(
      () => { if (this.pending === pending) this.pending = null; },
      error => {
        if (this.pending !== pending || this.stopped) return;
        pending.heardBefore = this.heard;
        pending.timer = setTimeout(() => this.flush(), isDiscoveryBudgetError(error) ? budgetRetryMs(error, 250, 4_000) : 4_000);
      });
  }

  private drop(): void {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.end(); }
    this.pending = null;
  }

  async resolve(pubKeyZ32: string, options?: PkarrRequestOptions): Promise<SignedPacket | null> {
    if (pubKeyZ32 !== this.peerKey) return this.inner.resolve(pubKeyZ32, options);
    // One that came since the last read: that is the news, and it costs no request.
    if (this.carried && this.carried.timestampMicros > this.returned) return this.take(null);
    // Up, through packets members carried a moment ago: the relays hold nothing newer than what brought the edge up,
    // and the look a link takes right after it opens would be a request for nothing. The slow look of a connected
    // link, a minute on, asks them as before.
    if (this.carried && this.hooks.open() && Date.now() - this.heardAt < SIGNAL_PROVEN_MS) return this.take(null);
    let came!: () => void;
    const carried = new Promise<"carried">(resolve => { came = () => resolve("carried"); });
    this.waiting = came;
    try {
      // My packet is with members and not yet on the relays: the answer comes back the way it went, and a relay asked
      // now would only say it has nothing. The relays are read once that wait is over.
      if (this.pending && await Promise.race([carried, this.pending.ended]) === "carried") return this.take(null);
      const read = this.inner.resolve(pubKeyZ32, options).then(packet => ({ packet }), (error: unknown) => ({ error }));
      const first = await Promise.race([read, carried]);
      if (first === "carried") return this.take(null);
      if ("error" in first) {
        // The relays did not answer (their budget, an outage): what a member carried is what is known.
        if (this.carried) return this.take(null);
        throw first.error;
      }
      return this.take(first.packet);
    } finally {
      if (this.waiting === came) this.waiting = null;
    }
  }

  private take(read: SignedPacket | null): SignedPacket | null {
    if (this.carried) this.returned = this.carried.timestampMicros;
    const newest = newerPacket(read, this.carried);
    if (newest && newest.timestampMicros > this.seen) this.seen = newest.timestampMicros;
    return newest;
  }

  /**
   * A packet a member carried here. True when it is the member's (its signature holds under the edge's key), of now
   * (`SIGNAL_FRESH_MS`) and newer than any seen before, carried or read: the next read answers with it, at once.
   */
  accept(payload: Uint8Array): boolean {
    if (this.stopped) return false;
    let packet: SignedPacket;
    try { packet = parseRelayPayload(this.peerKey, payload); } catch { return false; }
    const age = BigInt(Date.now()) * 1000n - packet.timestampMicros, fresh = BigInt(SIGNAL_FRESH_MS) * 1000n;
    if (age > fresh || age < -fresh || packet.timestampMicros <= this.seen) return false;
    if (this.carried && packet.timestampMicros <= this.carried.timestampMicros) return false;
    this.carried = packet;
    this.heard++;
    this.heardAt = Date.now();
    this.quiet = false;
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) waiting(); else this.hooks.look();
    return true;
  }

  /** My newest packet for this edge while it is down, for a member that can pass it on now; null once it is up. */
  latest(): Uint8Array | null { return this.stopped || this.hooks.open() ? null : this.mine; }

  /** The edge is going: nothing more is deferred or carried, and a last packet goes straight to the relays. */
  stop(): void {
    this.stopped = true;
    this.drop();
    this.mine = null;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.();
  }
}
