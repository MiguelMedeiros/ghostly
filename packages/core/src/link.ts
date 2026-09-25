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
import type { PkarrTransport } from "./transport";
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
 * How long a link looks fast when its peer, or the peer's offer, is due any moment. The peer that
 * dials does so as soon as it sees the other one here, and its offer lands in its packet a moment
 * after its presence did: without this the side that answers left the offer to a background poll
 * (30 s on the relays), once on a group's entry session and once more per member edge.
 */
export const EXPECT_PEER_MS = 30_000;
/** A chat whose contact was never seen (an invite just sent) keeps looking at the active pace this long. */
export const AWAITING_PEER_MS = 10 * 60_000;
const PUBLISH_RETRY_MS = 4_000;
/** Two reads are never closer than this, however long the last one took. */
const MIN_POLL_GAP_MS = 250;
export const IDLE_THRESHOLD = 60_000;
export const MAX_DHT_TEXT_BYTES = 500;
/** Presence is a fresh packet: advertising peers republish this often… */
export const PRESENCE_HEARTBEAT = 4 * 60_000;
/** …and are considered gone once their packet is older than this. */
export const PRESENCE_WINDOW = 10 * 60_000;

export type LinkStatus = "connecting" | "online" | "offline" | "error";

export interface PeerPresence {
  /** Peer advertises services and its packet is fresh. */
  online: boolean;
  /** Timestamp of the peer's latest packet (ms), 0 if none was ever seen. */
  lastPacketAt: number;
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
  onRtcSignal?(signal: string): void;
  onStatus?(status: LinkStatus): void;
  /** A poll started, or finished with the next one due in `nextInMs`. */
  onPoll?(poll: { polling: boolean; nextInMs: number }): void;
  /** A publish finished: how long it took, and whether it carried an `_rtc` signal. `error` when it failed. */
  onPublish?(result: { ms: number; rtc: boolean; error?: string }): void;
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
  private lastRtcSignalIn: string | null = null;

  private running = false;
  private polling = false;
  private publishing: Promise<void> | null = null;
  private publishAgain = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity = Date.now();
  private readonly startedAt = Date.now();
  private readonly intervals: PollIntervals;
  private fastPollUntil = 0;
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
  private presence: PeerPresence = { online: false, lastPacketAt: 0, services: null };

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

  start(): void {
    if (this.running) return;
    this.running = true;
    this.events.onStatus?.("connecting");
    // Presence: a peer that advertises services says so as soon as it is up…
    if (this.getServices() !== undefined || this.myAck > 0) {
      if (this.firstPublish === "at-start") void this.publish().catch(() => {});
      // …or right after its first look, and by FIRST_PUBLISH_MAX_MS whatever came of it.
      else this.firstPublishTimer = setTimeout(() => { this.firstPublishTimer = null; this.ensureAdvertised(); }, FIRST_PUBLISH_MAX_MS);
    }
    this.scheduleHeartbeat();
    void this.poll();
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

  setFastPoll(fast: boolean): void {
    this.fastPollUntil = fast ? Date.now() + FAST_POLL_MAX_MS : 0;
    if (fast) this.pollNow();
  }

  /** The peer, or its offer, is due any moment: poll fast for `EXPECT_PEER_MS` (never cutting a longer fast window short). */
  expectPeer(): void {
    const until = Date.now() + EXPECT_PEER_MS;
    if (until <= this.fastPollUntil) return;
    this.fastPollUntil = until;
    this.pollNow();
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
        nick: this.nick, callSignal: this.callSignal, rtcSignal: signal, services: this.getServices() }, this.encKey);
      return true;
    } catch { return false; }
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
    } catch {
      // The message stays in the buffer; keep trying instead of losing it.
      if (this.publishRetryTimer) clearTimeout(this.publishRetryTimer);
      this.publishRetryTimer = setTimeout(() => void this.publish().catch(() => {}), PUBLISH_RETRY_MS);
      // Not an error for the sender: it is queued, and the connection status shows the trouble.
      this.events.onStatus?.("error");
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

  private nextInterval(): number {
    return this.intervals[this.pace()];
  }

  /** How urgently this link looks right now. */
  private pace(): keyof PollIntervals {
    // Connected peers signal over the data link; no reason to hurry Pkarr.
    if (this.connected) return "connected";
    if (Date.now() < this.fastPollUntil) return "fast";
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
        // A signal that is not published is a call that never rings: try again.
        if (this.running) {
          this.discoveryResult("publish", error);
          this.publishRetryTimer = setTimeout(() => void this.publish().catch(() => {}), PUBLISH_RETRY_MS);
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
      },
      this.encKey,
    );
    const started = Date.now();
    try {
      await this.transport.publish(this.identity, built.records);
    } catch (error) {
      const ms = Date.now() - started;
      traceLink(this.identity.pubKeyZ32, "publish", { ms, rtc: !!rtcSignal, error: String(error) });
      this.events.onPublish?.({ ms, rtc: !!rtcSignal, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const ms = Date.now() - started;
    this.lastPublishedAt = Date.now();
    traceLink(this.identity.pubKeyZ32, "publish", { ms, rtc: !!rtcSignal, advertise });
    this.events.onPublish?.({ ms, rtc: !!rtcSignal });
    this.discoveryResult("publish");
    return built.keptMessages;
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
      const packet = await this.transport.resolve(this.peerPubKeyZ32, { background: pace === "background" || pace === "connected", urgent: pace === "fast" });
      if (!this.running) return;
      this.discoveryResult("read");
      const ms = Date.now() - started;
      const wasOnline = this.presence.online, wasSeen = this.presence.lastPacketAt;

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

        const online = batch.services !== null && Date.now() - batch.packetTimestamp < PRESENCE_WINDOW;
        this.presence = {
          online,
          lastPacketAt: batch.packetTimestamp,
          nick: batch.nick,
          services: online ? batch.services : null,
        };
        this.events.onPresence?.(this.presence);

        if (batch.callSignal !== null && batch.callSignal !== this.lastCallSignalIn) {
          this.lastCallSignalIn = batch.callSignal;
          this.events.onCallSignal?.(batch.callSignal);
        }
        const newSignal = batch.rtcSignal !== null && batch.rtcSignal !== this.lastRtcSignalIn;
        // A slow read, the contact's first packet, or a signal: the steps of a pairing, timed. Every
        // read when a measurement asked for the whole trace.
        if (ms > 1_500 || (online && !wasOnline) || batch.packetTimestamp !== wasSeen || newSignal || (globalThis as { __ghostlyLinkTrace?: boolean }).__ghostlyLinkTrace)
          traceLink(this.identity.pubKeyZ32, "poll", { ms, pace, online, age: Date.now() - batch.packetTimestamp, rtc: newSignal, first: wasSeen === 0 });
        if (newSignal) {
          this.lastRtcSignalIn = batch.rtcSignal!;
          this.events.onRtcSignal?.(batch.rtcSignal!);
        }
      } else if (ms > 1_500 || (globalThis as { __ghostlyLinkTrace?: boolean }).__ghostlyLinkTrace) traceLink(this.identity.pubKeyZ32, "poll", { ms, pace, packet: false });

      if (receivedNew) await this.publish().catch(() => {});
      this.events.onStatus?.("online");
      if (!this.firstPollDone) { this.firstPollDone = true; this.events.onFirstPoll?.(); }
    } catch (error) {
      if (this.running) {
        traceLink(this.identity.pubKeyZ32, "poll", { ms: Date.now() - started, error: String(error) });
        this.discoveryResult("read", error);
        this.events.onStatus?.("error");
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
