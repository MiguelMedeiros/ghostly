import { fromBase64Url, utf8Encode } from "./bytes";
import { identityFromSeedB64, type Identity } from "./identity";
import type { LinkParams } from "./invite";
import {
  buildLinkRecords,
  isEmptyLinkPacket,
  parseLinkRecords,
  type CompactMessage,
  type ResolvedLink,
  type ResolvedMessage,
} from "./records";
import type { ServiceAd } from "./services";
import type { SignalSight } from "./signal";
import { budgetRetryMs, isDiscoveryBudgetError, type PkarrTransport } from "./transport";
import { traceLink } from "./linkTrace";

/**
 * The Pkarr side of a link: publish my records, poll the peer's. This is the
 * loop Ghostly Desktop runs in `useChat`, without React, so every client can
 * share it.
 */
export interface PollIntervals {
  /** The user is looking at the link. */
  active: number;
  /** …but nothing happened for a minute. */
  idle: number;
  /** Signaling in progress. */
  fast: number;
  /** Nobody is looking. */
  background: number;
  /** The data link is up and carries everything; Pkarr only has to notice re-offers. */
  connected: number;
}

/** What Ghostly Desktop uses against the DHT. */
export const DHT_POLL_INTERVALS: PollIntervals = {
  active: 2_000,
  idle: 8_000,
  fast: 700,
  background: 20_000,
  connected: 30_000,
};

/** Relays rate limit by IP, and several peers may sit behind one address. */
export const RELAY_POLL_INTERVALS: PollIntervals = {
  active: 4_000,
  idle: 10_000,
  fast: 2_000,
  background: 30_000,
  connected: 60_000,
};

/** Signaling that has not finished by then is not going to; stop polling fast. */
const FAST_POLL_MAX_MS = 45_000;
/**
 * An offer to a saved contact (a chat, a group's edge) is looked at fast for an answer this long after it went out,
 * then less often (`OFFER_STEP_MAX`) for the rest of its window. A contact that is there answers within seconds;
 * one that still holds the session this app had before it restarted answers only once that session goes (about 20 s
 * with node-datachannel, 45 s where liveness finds out). An app back with several chats and edges, each looking every
 * 2 s meanwhile, spent the relays' minute in those seconds and could not read the answers when they came: a group's
 * edges were live again 75 and 110 s after a restart (bug hunt r5a, 2026-09-29).
 */
export const OFFER_FAST_MS = 10_000;
/**
 * The longest wait between looks for an answer to an offer once it has been out `OFFER_FAST_MS`, in fast paces: 8 s on
 * the relays (fast 2 s), 2.8 s on the DHT (0.7 s), which costs no relay budget.
 */
export const OFFER_STEP_MAX = 4;
/** An offer to a saved contact is looked at for an answer as long as its attempt lasts (`CONNECT_TIMEOUT_MS`), not 45 s. */
export const OFFER_LOOK_MS = 90_000;
/**
 * How long a link looks fast when its peer, or the peer's offer, is due any moment. The peer that
 * dials does so as soon as it sees the other one here, and its offer lands in its packet a moment
 * after its presence did: without this the side that answers left the offer to a background poll
 * (30 s on the relays), once on a group's entry session and once more per member edge.
 */
export const EXPECT_PEER_MS = 30_000;
/**
 * How long a link keeps looking at the active pace after its contact went away from a live session (it said goodbye,
 * or the session dropped): an app that restarts is back within this, and its dial or offer is seen in seconds.
 */
export const WATCH_PEER_MS = 2 * 60_000;
/** A chat whose contact was never seen (an invite just sent) keeps looking at the active pace this long. */
export const AWAITING_PEER_MS = 10 * 60_000;
const PUBLISH_RETRY_MS = 4_000;
/**
 * A packet the relays' request budget held back goes again when the budget frees a request, and at least this often
 * meanwhile: each refusal keeps it first in line for that request (`WRITE_FIRST_MS`), and costs no request itself.
 */
const BUDGET_RETRY_MIN_MS = 250;
/** Two reads are never closer than this, however long the last one took. */
const MIN_POLL_GAP_MS = 250;
export const IDLE_THRESHOLD = 60_000;
export const MAX_DHT_TEXT_BYTES = 500;
/** Presence is a fresh packet: advertising peers republish this often… */
export const PRESENCE_HEARTBEAT = 4 * 60_000;
/** …and are considered gone once their packet is older than this. */
export const PRESENCE_WINDOW = 10 * 60_000;

/** When this device first read the peer's latest packet, by its own clock (`PeerPresence.seenAt`). */
export const presenceSeenAt = (presence: Pick<PeerPresence, "lastPacketAt" | "seenAt">): number => presence.seenAt ?? presence.lastPacketAt;

export type LinkStatus = "connecting" | "online" | "offline" | "error";

export interface PeerPresence {
  /** Peer advertises services and its packet is fresh. */
  online: boolean;
  /** Timestamp of the peer's latest packet (ms), 0 if none was ever seen. The peer's clock: it names the packet, and is never compared with this one's. */
  lastPacketAt: number;
  /**
   * When this device first read that packet, by its own clock: what "how long ago" is measured from (`presenceSeenAt`).
   * A packet is dated by its own time, held between the read of this run before the one that found it and that one: a
   * few seconds apart while a link is being made, so the peer's clock no longer matters. The first read has no read
   * before it: a peer whose clock is behind looks that much older until its next packet, and no peer's clock makes a
   * packet look newer than the read that found it.
   */
  seenAt?: number;
  nick?: string;
  /** `null` for peers that do not advertise (legacy clients, or offline). */
  services: ServiceAd[] | null;
}

export interface LinkSessionEvents {
  onDiscoveryError?(error: string | null): void;
  onMessages?(messages: ResolvedMessage[], batch: ResolvedLink): void;
  onPresence?(presence: PeerPresence): void;
  onPeerAck?(ackTimestamp: number): void;
  onCallSignal?(signal: string): void;
  /**
   * `sight`: a read of the peer's record that the network answered, earlier in this run, did not have the signal
   * (`SignalSight`): when that read began, and the time of the peer's packet it found, if any. Absent for a signal
   * the first such read found.
   */
  onRtcSignal?(signal: string, sight?: SignalSight): void;
  /**
   * The peer's packet, dated `packetAt` by the peer's clock, was not there at this run's read of `readBefore` and is
   * there at `readAt` (this clock): what its clock says against this one (`ClockWatch.peer`).
   */
  onPeerClock?(packetAt: number, readBefore: number, readAt: number): void;
  /** The peer's packet carries a new `_tr` value (a group link's transports, `parsePacketTransports`). */
  onPeerTransports?(value: string): void;
  onStatus?(status: LinkStatus): void;
  /** A poll started, or finished with the next one due in `nextInMs`. */
  onPoll?(poll: { polling: boolean; nextInMs: number }): void;
  /**
   * A publish finished: how long it took, and whether it carried an `_rtc` signal. `error` when it failed; `waiting`
   * when the relays' request budget held it back (nothing went out, and it goes again once the budget frees a request).
   * `signalOut` when it is the first to carry the current `_rtc` signal: an offer or an answer went out now.
   */
  onPublish?(result: { ms: number; rtc: boolean; error?: string; waiting?: boolean; signalOut?: boolean }): void;
  /** The first read of the peer's key is done (with `firstPublish: "after-first-poll"`, what to publish is decided now). */
  onFirstPoll?(): void;
}

export interface LinkSessionOptions {
  params: LinkParams;
  transport: PkarrTransport;
  nick?: string;
  /** Highest peer message timestamp already stored locally. */
  lastSeenTimestamp?: number;
  /** Services to advertise right now. Return undefined to advertise nothing. */
  getServices?: () => ServiceAd[] | undefined;
  pollIntervals?: PollIntervals;
  events?: LinkSessionEvents;
  /**
   * When this side's first packet goes out. `at-start` (default): as the session starts. `after-first-poll`:
   * once the peer's key was read, unless whoever asked publishes something better by then (a first
   * pairing's joiner, who dials the moment it sees the inviter: its offer then travels in its first packet
   * instead of a second one right behind it, which relays hold back for seconds), and in any case within
   * `FIRST_PUBLISH_MAX_MS`.
   */
  firstPublish?: "at-start" | "after-first-poll";
}

/** With `firstPublish: "after-first-poll"`, the first packet goes out by then whatever happened. */
export const FIRST_PUBLISH_MAX_MS = 2_000;

export class LinkSession {
  readonly identity: Identity;
  readonly peerPubKeyZ32: string;
  private readonly encKey: Uint8Array;
  private readonly transport: PkarrTransport;
  private readonly events: LinkSessionEvents;
  private readonly getServices: () => ServiceAd[] | undefined;

  private nick?: string;
  private sentBuffer: CompactMessage[] = [];
  private myAck: number;
  private lastSeenTimestamp: number;
  private callSignal: string | null = null;
  private rtcSignal: string | null = null;
  private lastCallSignalIn: string | null = null;
  /** The `_rtc` signal the last packet that went out carried. */
  private rtcSignalOut: string | null = null;
  private lastRtcSignalIn: string | null = null;
  /** The `_rtc` signal the peer's packet carried as last read (null: none), whether or not it was new. */
  private peerRtcSignal: string | null = null;
  /** A group link's `_tr` value this side publishes (`setTransports`), and the last the peer's packet carried. */
  private transports: string | null = null;
  private lastTransportsIn: string | null = null;

  private running = false;
  /** Stopped without a last packet (`stop(false)`): nothing more goes out. */
  private silent = false;
  private polling = false;
  private publishing: Promise<void> | null = null;
  private publishAgain = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity = Date.now();
  private readonly startedAt = Date.now();
  private readonly intervals: PollIntervals;
  private fastPollUntil = 0;
  /** An offer to a saved contact is out: from then on its fast window looks less often (`OFFER_FAST_MS`); 0 for none. */
  private fastStepsAfter = 0;
  /** When the last `expectPeer` window ends (or ended): the pace slows down from there step by step. */
  private expectUntil = 0;
  private watchUntil = 0;
  private publishRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private connected = false;
  private readonly firstPublish: "at-start" | "after-first-poll";
  private firstPublishTimer: ReturnType<typeof setTimeout> | null = null;
  private firstPollDone = false;
  /** When this side last published (0: never). */
  lastPublishedAt = 0;
  /** A publish is in flight, or finished this recently: another packet now would only queue behind it at the relays. */
  publishedRecently(withinMs: number): boolean {
    return this.publishing !== null || this.firstPublishTimer !== null || Date.now() - this.lastPublishedAt < withinMs;
  }
  private discoveryErrors: Partial<Record<"publish" | "read", string>> = {};
  /** The last read was not answered by the network: it failed, or the transport handed back a copy it kept (`discoveryRecovered`). */
  private readMissed = false;
  private unsubscribe: (() => void) | null = null;
  private presence: PeerPresence = { online: false, lastPacketAt: 0, services: null };
  /**
   * When the last read of the peer's record that the network answered began (0: none yet in this run). A read that
   * handed back a copy kept from before (`PkarrTransport.readAnsweredAt`) is not one: it says nothing of what the
   * record holds now.
   */
  private lastReadAt = 0;
  /** The latest time of the peer's own packets those reads found, by the peer's clock (0: none; the inviter's empty packet is not the peer's). */
  private peerPacketAt = 0;

  constructor(options: LinkSessionOptions) {
    this.identity = identityFromSeedB64(options.params.seedB64);
    this.peerPubKeyZ32 = options.params.peerPubKeyZ32;
    this.encKey = fromBase64Url(options.params.encKeyB64);
    this.transport = options.transport;
    this.nick = options.nick;
    this.lastSeenTimestamp = options.lastSeenTimestamp ?? 0;
    this.myAck = this.lastSeenTimestamp;
    this.getServices = options.getServices ?? (() => undefined);
    this.intervals = options.pollIntervals ?? DHT_POLL_INTERVALS;
    this.events = options.events ?? {};
    this.firstPublish = options.firstPublish ?? "at-start";
  }

  get peerPresence(): PeerPresence {
    return this.presence;
  }

  /** The `_rtc` signal the peer's packet carries, as last read: null when it carries none. */
  get peerSignal(): string | null {
    return this.peerRtcSignal;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.silent = false;
    this.events.onStatus?.("connecting");
    // Presence: a peer that advertises services says so as soon as it is up…
    if (this.getServices() !== undefined || this.myAck > 0) {
      if (this.firstPublish === "at-start") void this.publish().catch(() => {});
      // …or right after its first look, and by FIRST_PUBLISH_MAX_MS whatever came of it.
      else this.firstPublishTimer = setTimeout(() => { this.firstPublishTimer = null; this.ensureAdvertised(); }, FIRST_PUBLISH_MAX_MS);
    }
    this.scheduleHeartbeat();
    // A relay that answers again after failing: look and publish now, not at this link's pace (which may be minutes).
    this.unsubscribe = this.transport.subscribe?.(change => { if (change === "recovered") this.discoveryRecovered(); }) ?? null;
    void this.poll();
  }

  /**
   * A relay answers again after failing. What this link could not do meanwhile goes now: a publish that waits, and a
   * read when its last one was not answered by the network (it failed, or handed back a copy kept from before) or when
   * the link is looking for its peer (anything but the background and connected paces). A link whose last read was
   * answered missed nothing: it reads at its pace. Every link heard this, so a read each one made the cost of a relay
   * that keeps flipping between throttled and answering grow with the number of chats: 42 reads a flip on a profile
   * whose contacts are mostly away, for nothing those reads could find.
   */
  private discoveryRecovered(): void {
    if (!this.running) return;
    const publish = !!(this.publishRetryTimer || this.discoveryErrors.publish);
    const pace = this.pace(), read = this.readMissed || (pace !== "background" && pace !== "connected");
    if (!publish && !read) return;
    traceLink(this.identity.pubKeyZ32, "discovery-recovered", { publishWaiting: !!this.publishRetryTimer, read });
    if (publish) void this.publish().catch(() => {});
    if (read) this.pollNow();
  }

  /** This side's packet goes out now, unless one already did. */
  ensureAdvertised(): void {
    if (!this.running || this.lastPublishedAt > 0 || this.publishing) return;
    void this.publish().catch(() => {});
  }

  /** Stops the loops. With `announce`, first tells the peer we are gone. */
  async stop(announce = true): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.silent = !announce;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.publishRetryTimer) clearTimeout(this.publishRetryTimer);
    if (this.firstPublishTimer) clearTimeout(this.firstPublishTimer);
    this.pollTimer = this.heartbeatTimer = this.publishRetryTimer = this.firstPublishTimer = null;
    this.rtcSignal = null;
    this.callSignal = null;
    this.events.onStatus?.("offline");
    if (announce) {
      try {
        await this.publishOnce(false);
      } catch {
        // best effort, the packet goes stale on its own
      }
    }
  }

  setNick(nick: string | undefined): void {
    this.nick = nick || undefined;
  }

  /** The user is looking at this link: poll at chat speed. */
  setActive(active: boolean): void {
    this.active = active;
    if (active) this.pollNow();
  }

  /**
   * Signaling in progress: look fast. `offer`: this side's offer to a saved contact, whose answer may be a while
   * (`OFFER_FAST_MS`): fast at first, then less often.
   */
  setFastPoll(fast: boolean, offer = false): void {
    this.fastPollUntil = fast ? Date.now() + (offer ? OFFER_LOOK_MS : FAST_POLL_MAX_MS) : 0;
    this.fastStepsAfter = fast && offer ? Date.now() + OFFER_FAST_MS : 0;
    if (fast) this.pollNow();
  }

  /**
   * The peer, or its offer, is due any moment: poll fast for `EXPECT_PEER_MS` (never cutting a longer fast window short),
   * then slow down step by step (`nextInterval`) rather than at once.
   */
  expectPeer(): void {
    const until = Date.now() + EXPECT_PEER_MS;
    this.expectUntil = Math.max(this.expectUntil, until);
    // Due now: an offer of mine that was looking less often looks fast again, as long as this window.
    const stepping = this.fastStepsAfter > 0 && Date.now() >= this.fastStepsAfter;
    if (this.fastStepsAfter) this.fastStepsAfter = Math.max(this.fastStepsAfter, until);
    if (until <= this.fastPollUntil) { if (stepping) this.pollNow(); return; }
    this.fastPollUntil = until;
    this.pollNow();
  }

  /**
   * The contact just left a live session, and is likely coming back (an app restarting): fast for `EXPECT_PEER_MS`,
   * then the active pace until `WATCH_PEER_MS` passed, whatever the chat's pace would be.
   */
  watchPeer(): void {
    this.watchUntil = Math.max(this.watchUntil, Date.now() + WATCH_PEER_MS);
    this.expectPeer();
  }

  /** The data link carries chat and services while it is up. */
  setDataLinkOpen(open: boolean): void {
    this.connected = open;
    if (!open) this.pollNow();
  }

  async setCallSignal(signal: string | null): Promise<void> {
    this.callSignal = signal;
    this.lastActivity = Date.now();
    await this.publish().catch(() => {});
    this.pollNow();
  }

  /** Includes encryption, DNS encoding and the actual concurrent record budget. */
  fitsRtcSignal(signal: string): boolean {
    try {
      buildLinkRecords(this.identity.pubKeyZ32, { messages: this.sentBuffer, ackTimestamp: this.myAck,
        nick: this.nick, callSignal: this.callSignal, rtcSignal: signal, services: this.getServices(), transports: this.transports }, this.encKey);
      return true;
    } catch { return false; }
  }

  /**
   * A group link's transports and how to dial them (`_tr`, `encodePacketTransports`): published with the next packet,
   * now if it changed. `null` publishes none, which is what every link but a group's with an app lacking WebRTC does.
   */
  setTransports(value: string | null): void {
    if (this.transports === value) return;
    this.transports = value;
    if (!this.running) return;
    // A first packet still held back (`firstPublish`) carries it when it goes; one already out does not.
    if (this.firstPublishTimer && !this.lastPublishedAt && !this.publishing) return;
    void this.publish().catch(() => {});
  }

  async setRtcSignal(signal: string | null, reportFailure = false): Promise<void> {
    if (this.rtcSignal === signal) return;
    this.rtcSignal = signal;
    if (reportFailure) await this.publish();
    else await this.publish().catch(() => {});
    if (signal) this.pollNow();
  }

  /**
   * Hands over the messages the peer has not acknowledged, for delivery over
   * the data link. That channel is reliable, so they leave the Pkarr buffer.
   */
  takeUnacknowledged(): CompactMessage[] {
    const pending = this.sentBuffer;
    if (pending.length === 0) return [];
    this.sentBuffer = [];
    this.events.onPeerAck?.(Math.max(...pending.map((m) => m.t)));
    void this.publish().catch(() => {});
    return pending;
  }

  /** Call after the list of shared services changed. A first publish still being held back will say it all. */
  async refreshAdvertisement(): Promise<void> {
    if (this.firstPublishTimer) return;
    await this.publish().catch(() => {});
  }

  /** Sends a chat message through Pkarr. Returns an error string, or null on success. */
  async sendMessage(text: string, timestamp = Date.now()): Promise<string | null> {
    const byteLength = utf8Encode(text).length;
    if (byteLength > MAX_DHT_TEXT_BYTES) {
      return `Message too large for DHT (${byteLength} bytes, max ${MAX_DHT_TEXT_BYTES}). Try a shorter message or share a link instead.`;
    }
    this.lastActivity = Date.now();
    this.sentBuffer = [...this.sentBuffer, { t: timestamp, m: text }];
    try {
      const kept = await this.publishOnce(true);
      if (kept === 0) return "Message could not be published — DHT payload limit exceeded.";
    } catch (error) {
      // The message stays in the buffer; keep trying instead of losing it.
      if (this.publishRetryTimer) clearTimeout(this.publishRetryTimer);
      this.publishRetryTimer = setTimeout(() => void this.publish().catch(() => {}), this.retryDelay(error));
      // Not an error for the sender: it is queued, and the connection status shows the trouble (a wait for the
      // relays' budget is none).
      if (!isDiscoveryBudgetError(error)) this.events.onStatus?.("error");
      return null;
    }
    this.pollNow();
    return null;
  }

  pollNow(): void {
    if (!this.running) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    void this.poll();
  }

  /**
   * The next poll's wait. After a window that looked fast for the peer (`expectPeer`), the wait grows with the time
   * since the window ended (on the relays: 4, 4, 8, 16 s, then 30 s) up to the pace's own. A
   * peer's offer held back by its relays' budget lands whenever that frees a request: it used to land seconds after
   * the window, and wait out a whole background poll (30 s) there (2026-09-27). About three more reads a window that
   * ends with no offer.
   */
  private nextInterval(): number {
    const pace = this.pace();
    const interval = this.intervals[pace];
    const since = Date.now() - this.expectUntil;
    // An offer out a while: 4, 4, 8 s… between looks (on the relays), as long as its window lasts.
    const stepping = this.fastStepsAfter ? Date.now() - this.fastStepsAfter : -1;
    if (pace === "fast" && stepping >= 0) return Math.min(OFFER_STEP_MAX * interval, Math.max(2 * interval, stepping));
    if (pace === "fast" || pace === "connected" || since < 0) return interval;
    return Math.min(interval, Math.max(2 * this.intervals.fast, since));
  }

  /** How urgently this link looks right now. */
  private pace(): keyof PollIntervals {
    // Connected peers signal over the data link; no reason to hurry Pkarr.
    if (this.connected) return "connected";
    if (Date.now() < this.fastPollUntil) return "fast";
    if (Date.now() < this.watchUntil) return "active";
    // Someone who just sent an invite may look elsewhere while waiting: the join still comes in quickly.
    if (!this.active && this.presence.lastPacketAt === 0 && Date.now() - this.startedAt < AWAITING_PEER_MS) return "active";
    if (!this.active) return "background";
    return Date.now() - this.lastActivity > IDLE_THRESHOLD ? "idle" : "active";
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      if (!this.running) return;
      if (this.getServices() !== undefined) void this.publish().catch(() => {});
      this.scheduleHeartbeat();
    }, PRESENCE_HEARTBEAT);
  }

  /** Coalesces publishes: at most one in flight and one queued behind it. */
  private publish(): Promise<void> {
    if (this.silent) return Promise.resolve();
    if (this.publishing) {
      this.publishAgain = true;
      return this.publishing;
    }
    if (this.publishRetryTimer) clearTimeout(this.publishRetryTimer);
    this.publishRetryTimer = null;
    this.publishing = (async () => {
      try {
        do {
          this.publishAgain = false;
          await this.publishOnce(this.running);
        } while (this.publishAgain && this.running);
      } catch (error) {
        // A signal that is not published is a call that never rings: try again. Held back by the relays' request
        // budget, it goes as soon as the budget frees a request, and nothing is wrong meanwhile.
        if (this.running) {
          if (!isDiscoveryBudgetError(error)) this.discoveryResult("publish", error);
          this.publishRetryTimer = setTimeout(() => void this.publish().catch(() => {}), this.retryDelay(error));
        }
        throw error;
      } finally {
        this.publishing = null;
      }
    })();
    return this.publishing;
  }

  private async publishOnce(advertise: boolean): Promise<number> {
    const rtcSignal = advertise ? this.rtcSignal : null;
    const built = buildLinkRecords(
      this.identity.pubKeyZ32,
      {
        messages: this.sentBuffer,
        ackTimestamp: this.myAck,
        nick: this.nick,
        callSignal: this.callSignal,
        rtcSignal,
        services: advertise ? this.getServices() : undefined,
        transports: advertise ? this.transports : null,
      },
      this.encKey,
    );
    const started = Date.now();
    try {
      // An offer or answer not out yet is what the contact waits for (`PkarrRequestOptions.signal`).
      await this.transport.publish(this.identity, built.records, rtcSignal && rtcSignal !== this.rtcSignalOut ? { signal: true } : undefined);
    } catch (error) {
      const ms = Date.now() - started, waiting = isDiscoveryBudgetError(error);
      traceLink(this.identity.pubKeyZ32, "publish", { ms, rtc: !!rtcSignal, error: String(error), ...(waiting && { waiting, retryInMs: error.retryInMs }) });
      this.events.onPublish?.({ ms, rtc: !!rtcSignal, error: error instanceof Error ? error.message : String(error), ...(waiting && { waiting }) });
      throw error;
    }
    const ms = Date.now() - started;
    this.lastPublishedAt = Date.now();
    // Signaling's fast window counts from when its signal went out: one the relays' budget held back for most of the
    // window (an offer held 50 s) would otherwise have its answer read at the background pace (2026-09-27).
    const signalOut = !!rtcSignal && rtcSignal !== this.rtcSignalOut;
    if (signalOut && this.fastPollUntil > 0) {
      const lapsed = this.fastPollUntil <= Date.now() || (this.fastStepsAfter > 0 && this.fastStepsAfter <= Date.now());
      this.fastPollUntil = Math.max(this.fastPollUntil, Date.now() + (this.fastStepsAfter ? OFFER_LOOK_MS : FAST_POLL_MAX_MS));
      // An offer's first seconds of fast looks count from then too.
      if (this.fastStepsAfter) this.fastStepsAfter = Date.now() + OFFER_FAST_MS;
      // Its next look was put off to a slower pace: it comes at the fast one now.
      if (lapsed) this.pollNow();
    }
    this.rtcSignalOut = rtcSignal;
    traceLink(this.identity.pubKeyZ32, "publish", { ms, rtc: !!rtcSignal, advertise });
    this.events.onPublish?.({ ms, rtc: !!rtcSignal, ...(signalOut && { signalOut }) });
    this.discoveryResult("publish");
    return built.keptMessages;
  }

  /** When a publish that failed goes again: when the relays' budget frees a request, if that held it back. */
  private retryDelay(error: unknown): number {
    return isDiscoveryBudgetError(error) ? budgetRetryMs(error, BUDGET_RETRY_MIN_MS, PUBLISH_RETRY_MS) : PUBLISH_RETRY_MS;
  }

  private discoveryResult(operation: "publish" | "read", error?: unknown): void {
    if (error !== undefined) this.discoveryErrors[operation] = `Could not ${operation} discovery: ${error instanceof Error ? error.message : String(error)}`;
    else delete this.discoveryErrors[operation];
    this.events.onDiscoveryError?.(Object.values(this.discoveryErrors).join(". ") || null);
  }

  private async poll(): Promise<void> {
    if (!this.running || this.polling) return;
    this.polling = true;
    this.events.onPoll?.({ polling: true, nextInMs: 0 });
    const started = Date.now();
    try {
      // A look that can wait (nobody watching, nothing expected) says so: a transport with a request
      // budget spends only part of it on those, and keeps the rest for links that are signaling.
      const pace = this.pace();
      // This side's offer is out, and this read looks for its answer: signaling (`PkarrRequestOptions.signal`).
      const signal = pace === "fast" && this.fastStepsAfter > 0 && this.rtcSignalOut !== null;
      const packet = await this.transport.resolve(this.peerPubKeyZ32, { background: pace === "background" || pace === "connected", urgent: pace === "fast", ...(signal && { signal }) });
      if (!this.running) return;
      this.discoveryResult("read");
      const ms = Date.now() - started;
      const wasOnline = this.presence.online, wasSeen = this.presence.lastPacketAt;
      // What this read finds that the read before did not have came in between, by this device's clock.
      const readBefore = this.lastReadAt, peerPacketBefore = this.peerPacketAt;
      const answered = this.transport.readAnsweredAt?.(this.peerPubKeyZ32);
      const read = answered !== undefined && answered >= started;
      if (read) this.lastReadAt = started;
      this.readMissed = !!this.transport.readAnsweredAt && !read;

      let receivedNew = false;
      // The packet an inviter puts under the contact's key before they join (`emptyLinkRecords`), so
      // their first packet lands faster, says nobody is there yet.
      const batch = packet ? parseLinkRecords(packet, this.encKey) : null;
      if (batch && isEmptyLinkPacket(batch)) {
        if ((globalThis as { __ghostlyLinkTrace?: boolean }).__ghostlyLinkTrace) traceLink(this.identity.pubKeyZ32, "poll", { ms, pace, placeholder: true });
      } else if (batch) {
        if (batch.peerAck > 0) {
          this.sentBuffer = this.sentBuffer.filter((m) => m.t > batch.peerAck);
          this.events.onPeerAck?.(batch.peerAck);
        }

        if (batch.latestTimestamp > 0 && batch.latestTimestamp > this.lastSeenTimestamp) {
          const fresh = batch.messages.filter((m) => m.timestamp > this.lastSeenTimestamp);
          this.lastSeenTimestamp = batch.latestTimestamp;
          this.myAck = batch.latestTimestamp;
          this.lastActivity = Date.now();
          receivedNew = true;
          if (fresh.length > 0) this.events.onMessages?.(fresh, batch);
        }

        if (read && batch.packetTimestamp > this.peerPacketAt) this.peerPacketAt = batch.packetTimestamp;
        // How long ago the peer published is measured on this clock, from when its packet was first read here.
        const seenAt = batch.packetTimestamp === wasSeen ? presenceSeenAt(this.presence) : Math.max(readBefore, Math.min(batch.packetTimestamp, Date.now()));
        const online = batch.services !== null && Date.now() - seenAt < PRESENCE_WINDOW;
        this.presence = {
          online,
          lastPacketAt: batch.packetTimestamp,
          seenAt,
          nick: batch.nick,
          services: online ? batch.services : null,
        };
        // Before presence: a dial that presence starts ranks with them.
        if (batch.transports !== null && batch.transports !== this.lastTransportsIn) {
          this.lastTransportsIn = batch.transports;
          this.events.onPeerTransports?.(batch.transports);
        }
        this.events.onPresence?.(this.presence);
        if (read && readBefore && batch.packetTimestamp !== wasSeen) this.events.onPeerClock?.(batch.packetTimestamp, readBefore, Date.now());

        if (batch.callSignal !== null && batch.callSignal !== this.lastCallSignalIn) {
          this.lastCallSignalIn = batch.callSignal;
          this.events.onCallSignal?.(batch.callSignal);
        }
        this.peerRtcSignal = batch.rtcSignal;
        const newSignal = batch.rtcSignal !== null && batch.rtcSignal !== this.lastRtcSignalIn;
        // A slow read, the contact's first packet, or a signal: the steps of a pairing, timed. Every
        // read when a measurement asked for the whole trace.
        if (ms > 1_500 || (online && !wasOnline) || batch.packetTimestamp !== wasSeen || newSignal || (globalThis as { __ghostlyLinkTrace?: boolean }).__ghostlyLinkTrace)
          traceLink(this.identity.pubKeyZ32, "poll", { ms, pace, online, age: Date.now() - batch.packetTimestamp, seen: Date.now() - seenAt, rtc: newSignal, first: wasSeen === 0 });
        if (newSignal) {
          this.lastRtcSignalIn = batch.rtcSignal!;
          this.events.onRtcSignal?.(batch.rtcSignal!, readBefore ? { since: readBefore, after: peerPacketBefore || null } : undefined);
        }
      } else if (ms > 1_500 || (globalThis as { __ghostlyLinkTrace?: boolean }).__ghostlyLinkTrace) traceLink(this.identity.pubKeyZ32, "poll", { ms, pace, packet: false });

      if (receivedNew) await this.publish().catch(() => {});
      this.events.onStatus?.("online");
      if (!this.firstPollDone) { this.firstPollDone = true; this.events.onFirstPoll?.(); }
    } catch (error) {
      this.readMissed = true;
      if (this.running) {
        traceLink(this.identity.pubKeyZ32, "poll", { ms: Date.now() - started, error: String(error) });
        // A read the relays' request budget held back (nothing known yet to answer from) is a wait: the next poll reads.
        if (!isDiscoveryBudgetError(error)) {
          this.discoveryResult("read", error);
          this.events.onStatus?.("error");
        }
        if (!this.firstPollDone) { this.firstPollDone = true; this.events.onFirstPoll?.(); }
      }
    } finally {
      this.polling = false;
      if (this.running && !this.pollTimer) {
        const interval = this.nextInterval();
        // The interval is a period, counted from the start of this read: a read that took long (a key
        // nobody has yet, a relay asking its DHT) does not push the next one further out.
        const wait = Math.max(MIN_POLL_GAP_MS, interval - (Date.now() - started));
        this.events.onPoll?.({ polling: false, nextInMs: wait });
        this.pollTimer = setTimeout(() => {
          this.pollTimer = null;
          void this.poll();
        }, wait);
      }
    }
  }
}
