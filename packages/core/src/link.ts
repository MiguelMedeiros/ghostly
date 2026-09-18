import { fromBase64Url, utf8Encode } from "./bytes";
import { identityFromSeedB64, type Identity } from "./identity";
import type { LinkParams } from "./invite";
import {
  buildLinkRecords,
  parseLinkRecords,
  type CompactMessage,
  type ResolvedLink,
  type ResolvedMessage,
} from "./records";
import type { ServiceAd } from "./services";
import type { PkarrTransport } from "./transport";

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
  fast: 1_000,
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
const PUBLISH_RETRY_MS = 4_000;
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
  onMessages?(messages: ResolvedMessage[], batch: ResolvedLink): void;
  onPresence?(presence: PeerPresence): void;
  onPeerAck?(ackTimestamp: number): void;
  onCallSignal?(signal: string): void;
  onRtcSignal?(signal: string): void;
  onStatus?(status: LinkStatus): void;
  /** A poll started, or finished with the next one due in `nextInMs`. */
  onPoll?(poll: { polling: boolean; nextInMs: number }): void;
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
}

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
  private readonly intervals: PollIntervals;
  private fastPollUntil = 0;
  private publishRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private connected = false;
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
  }

  get peerPresence(): PeerPresence {
    return this.presence;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.events.onStatus?.("connecting");
    // Presence: a peer that advertises services says so as soon as it is up.
    if (this.getServices() !== undefined || this.myAck > 0) void this.publish().catch(() => {});
    this.scheduleHeartbeat();
    void this.poll();
  }

  /** Stops the loops. With `announce`, first tells the peer we are gone. */
  async stop(announce = true): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.publishRetryTimer) clearTimeout(this.publishRetryTimer);
    this.pollTimer = this.heartbeatTimer = this.publishRetryTimer = null;
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

  async setRtcSignal(signal: string | null): Promise<void> {
    if (this.rtcSignal === signal) return;
    this.rtcSignal = signal;
    await this.publish().catch(() => {});
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

  /** Call after the list of shared services changed. */
  async refreshAdvertisement(): Promise<void> {
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
    // Connected peers signal over the data link; no reason to hurry Pkarr.
    if (this.connected) return this.intervals.connected;
    if (Date.now() < this.fastPollUntil) return this.intervals.fast;
    if (!this.active) return this.intervals.background;
    return Date.now() - this.lastActivity > IDLE_THRESHOLD ? this.intervals.idle : this.intervals.active;
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
    const built = buildLinkRecords(
      this.identity.pubKeyZ32,
      {
        messages: this.sentBuffer,
        ackTimestamp: this.myAck,
        nick: this.nick,
        callSignal: this.callSignal,
        rtcSignal: advertise ? this.rtcSignal : null,
        services: advertise ? this.getServices() : undefined,
      },
      this.encKey,
    );
    await this.transport.publish(this.identity, built.records);
    return built.keptMessages;
  }

  private async poll(): Promise<void> {
    if (!this.running || this.polling) return;
    this.polling = true;
    this.events.onPoll?.({ polling: true, nextInMs: 0 });
    try {
      const packet = await this.transport.resolve(this.peerPubKeyZ32);
      if (!this.running) return;

      let receivedNew = false;
      if (packet) {
        const batch = parseLinkRecords(packet, this.encKey);

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
        if (batch.rtcSignal !== null && batch.rtcSignal !== this.lastRtcSignalIn) {
          this.lastRtcSignalIn = batch.rtcSignal;
          this.events.onRtcSignal?.(batch.rtcSignal);
        }
      }

      if (receivedNew) await this.publish().catch(() => {});
      this.events.onStatus?.("online");
    } catch {
      if (this.running) this.events.onStatus?.("error");
    } finally {
      this.polling = false;
      if (this.running && !this.pollTimer) {
        const interval = this.nextInterval();
        this.events.onPoll?.({ polling: false, nextInMs: interval });
        this.pollTimer = setTimeout(() => {
          this.pollTimer = null;
          void this.poll();
        }, interval);
      }
    }
  }
}
