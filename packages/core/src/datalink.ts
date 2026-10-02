import { sdpHasCandidates, waitForIceGathering } from "./callSignal";
import { symmetricNat, type DirectEvidence } from "./directPath";
import { wrapDataChannel, type FrameChannel } from "./frames";
import { traceLink } from "./linkTrace";
import {
  DATA_CHANNEL_ID,
  DATA_CHANNEL_LABEL,
  RTC_SIGNAL_MAX_AGE_MS,
  buildDataSdp,
  extractRtcParams,
  parseRtcSignal,
  type RtcSignal,
} from "./signal";

/**
 * The WebRTC data link of one link: a single RTCPeerConnection carrying the
 * negotiated `ghostly/1` DataChannel. Offer and answer travel through the
 * `_rtc` record; once the channel is open Pkarr is out of the picture and all
 * application traffic flows peer to peer (or through TURN, if ICE needs it).
 */
export type DataLinkState = "idle" | "offering" | "answering" | "connecting" | "open";

export interface DataLinkOptions {
  myPubKeyZ32: string;
  peerPubKeyZ32: string;
  createPeerConnection: () => RTCPeerConnection;
  /** Publishes (or clears, with null) my `_rtc` record. */
  publishSignal: (signal: string | null) => void;
  /** Signaling in progress (or over): look fast for the peer's signal. `offer`: for the answer to this side's offer. */
  setFastPoll: (fast: boolean, offer?: boolean) => void;
  onOpen: (channel: FrameChannel) => void;
  onClose: () => void;
  onState?: (state: DataLinkState) => void;
  /**
   * How long an attempt (offer or answer out, channel not yet open) may take before it is given up, so the
   * next one can start, asked as each one starts. Default `CONNECT_TIMEOUT_MS`; a first pairing, whose contact
   * is right there reading its invite, uses a short one until it is over.
   */
  attemptTimeoutMs?: () => number | undefined;
  /**
   * The open connection went `disconnected` (true: ICE consent checks unanswered, the contact may be gone or its app
   * restarted; the connection is given `DISCONNECT_GRACE_MS`), or came back from it (false).
   */
  onDisconnected?: (disconnected: boolean) => void;
  /**
   * Whether the peer's packet, as last read, still carries its offer of that time (`RtcSignal.ts`). An answer to it
   * that did not connect is then made again (`REANSWERS`); without this, never.
   */
  offerStanding?: (offerTs: number) => boolean;
  /**
   * This side's attempt was given up because the answerer answered its offer again (its connection for the answer
   * applied here is gone): the answerer is there, so the caller may dial again now rather than at its next look.
   */
  onAnswerReplaced?: () => void;
  /**
   * What an attempt said about direct connections from this device (`directPath.ts`): it opened (and, later, closed);
   * it did not connect and this device had no public candidate for it, or a public port per STUN server; or this
   * side's offer was answered and no path connected.
   */
  onDirect?: (evidence: DirectEvidence) => void;
}

/**
 * An attempt ended from outside (another transport went live first) that had both descriptions for this long and no
 * connection says what one that failed does: a path that exists connects within a second or two.
 */
export const STALLED_EVIDENCE_MS = 5_000;
/** A candidate another network can reach: server reflexive (STUN answered), relayed (TURN), or learnt from the peer. */
const PUBLIC_CANDIDATE = /^a=candidate:.* typ (srflx|relay|prflx)\b/m;

export const CONNECT_TIMEOUT_MS = 90_000;
const ICE_GATHERING_TIMEOUT_MS = 5_000;
/**
 * A connection with no candidate at all by then has stalled: Chromium, rarely and under load, gathers none, and an
 * offer or answer without one can never connect. It is made again in its place, up to `GATHER_ATTEMPTS` in all.
 */
export const GATHER_STALL_MS = 3_000;
export const GATHER_ATTEMPTS = 3;
/** How long a connection may stay `disconnected` before it is given up. */
const DISCONNECT_GRACE_MS = 12_000;
/**
 * An answer whose connection failed, while the peer still offers (`offerStanding`), is made again for the same offer,
 * up to this many times. The offerer's connection waits for an answer for its whole attempt (`CONNECT_TIMEOUT_MS`), and
 * its read of the answer may be held back by its relays' budget; the answerer's ICE gives up after about 30 s of no
 * reply. Going idle then left the link with an offer this side had answered once and would not answer again, until the
 * offerer's attempt ran out: a community's edge was live again 110 s after a member restarted (2026-09-30).
 */
export const REANSWERS = 2;
/** An offer this close to the end of the offerer's attempt is not answered again: the new answer would come too late. */
const REANSWER_MARGIN_MS = 15_000;

export class DataLink {
  state: DataLinkState = "idle";
  private pc: RTCPeerConnection | null = null;
  private myOfferTs = 0;
  private lastSignalTs = 0;
  /** The peer's description as this connection was given it: Chrome shows it as `remoteDescription` only once applied. */
  private remoteSdp: string | null = null;
  /** When the connection had both descriptions (`connecting`). */
  private connectingSince = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** The offer this side answered in the current attempt, and how many times it answered it again. */
  private answered: { offer: RtcSignal; again: number } | null = null;

  constructor(private readonly options: DataLinkOptions) {}

  /** Offers a connection to the peer. Resolves once the offer is published. */
  async connect(): Promise<void> {
    if (this.state !== "idle") return;
    this.answered = null;
    this.setState("offering");
    this.options.setFastPoll(true, true);
    try {
      const pc = await this.gathered(true, async (pc) => { await pc.setLocalDescription(await pc.createOffer()); });
      if (!pc) return;

      this.myOfferTs = Date.now();
      const signal: RtcSignal = { t: "o", ts: this.myOfferTs, ...extractRtcParams(pc.localDescription!.sdp) };
      this.options.publishSignal(JSON.stringify(signal));
    } catch {
      this.reset();
    }
  }

  /** Feeds a decrypted `_rtc` value from the peer's packet. */
  async handleSignal(json: string): Promise<void> {
    const signal = parseRtcSignal(json);
    if (!signal || signal.ts <= this.lastSignalTs) return;
    if (Math.abs(Date.now() - signal.ts) > RTC_SIGNAL_MAX_AGE_MS) return;

    if (signal.t === "o") {
      if (this.state === "offering") {
        // Both sides offered at once: the lower public key keeps its offer.
        if (this.options.myPubKeyZ32 < this.options.peerPubKeyZ32) return;
      } else if (this.state === "answering") {
        return;
      }
      // A fresh offer while connected means the peer lost the old connection.
      this.lastSignalTs = signal.ts;
      const wasOpen = this.state === "open";
      this.teardown();
      if (wasOpen) { this.options.onDirect?.("closed"); this.options.onClose(); }
      this.answered = { offer: signal, again: 0 };
      await this.answer(signal);
    } else if (this.state === "connecting" && this.myOfferTs && signal.o === this.myOfferTs && this.pc) {
      // A newer answer to the offer this side already took an answer for: the answerer made it again (`REANSWERS`),
      // its connection for the one applied here is gone, and this one can never come up. It is given up now, rather
      // than at the end of its attempt (a hub that read a member's first answer late held a dead one 40 s, 2026-09-30).
      traceLink(this.options.myPubKeyZ32, "answer-replaced", { appliedMs: signal.ts - this.lastSignalTs });
      this.lastSignalTs = signal.ts;
      this.reset();
      this.options.onAnswerReplaced?.();
    } else if (this.state === "offering" && signal.o === this.myOfferTs && this.pc) {
      this.lastSignalTs = signal.ts;
      const pc = this.pc;
      try {
        this.remoteSdp = buildDataSdp(signal);
        await pc.setRemoteDescription({ type: "answer", sdp: this.remoteSdp });
        // On a quick path the channel is open before this resolves: never step back from open.
        if (this.pc === pc && this.state === "offering") this.setState("connecting");
      } catch {
        if (this.pc === pc) this.reset();
      }
    }
  }

  /**
   * On a quick path the channel opens before setRemoteDescription resolves (see `handleSignal`), when the connection
   * does not show the answer yet: the one it was given counts, as DTLS already checked the peer against it.
   */
  get fingerprints(): [string, string] | null {
    const local = this.pc?.localDescription?.sdp;
    const remote = this.pc?.remoteDescription?.sdp ?? (this.pc ? this.remoteSdp : null);
    if (!local || !remote) return null;
    try { return [extractRtcParams(local).f.toLowerCase(), extractRtcParams(remote).f.toLowerCase()]; }
    catch { return null; }
  }

  close(): void {
    // Given up for another transport that went live while this one had long had both descriptions: evidence all the same.
    const evidence = Date.now() - this.connectingSince >= STALLED_EVIDENCE_MS ? this.directEvidence() : null;
    this.answered = null;
    this.reset();
    if (evidence) this.options.onDirect?.(evidence);
  }

  /**
   * What this attempt says about direct connections if it ends now without opening: nothing unless both descriptions
   * were exchanged (this side's offer answered, or its answer out). Then, what this device gathered: no public
   * candidate, a public port per STUN server, or (for the side that offered) candidates that read as reachable.
   */
  private directEvidence(): DirectEvidence | null {
    if (this.state !== "connecting" || !this.pc) return null;
    const local = this.pc.localDescription?.sdp ?? "";
    return !PUBLIC_CANDIDATE.test(local) ? "no-public" : symmetricNat(local) ? "symmetric" : this.myOfferTs ? "no-path" : null;
  }

  /**
   * The attempt on this connection failed (it timed out, ICE failed or closed, its channel closed). An answer the
   * offerer may not have read yet is made again for the same offer while it still stands (`REANSWERS`); anything
   * else goes back to idle.
   */
  private failed(): void {
    const answered = this.state === "connecting" ? this.answered : null;
    const left = answered ? CONNECT_TIMEOUT_MS - (Date.now() - answered.offer.ts) : 0;
    const evidence = this.directEvidence();
    if (answered && answered.again < REANSWERS && left > REANSWER_MARGIN_MS && this.options.offerStanding?.(answered.offer.ts)) {
      answered.again++;
      traceLink(this.options.myPubKeyZ32, "reanswer", { again: answered.again, leftMs: left });
      this.teardown();
      void this.answer(answered.offer);
      return;
    }
    this.reset();
    if (evidence) this.options.onDirect?.(evidence);
  }

  private async answer(offer: RtcSignal): Promise<void> {
    this.setState("answering");
    this.options.setFastPoll(true);
    try {
      const pc = await this.gathered(false, async (pc) => {
        await pc.setRemoteDescription({ type: "offer", sdp: buildDataSdp(offer) });
        await pc.setLocalDescription(await pc.createAnswer());
      });
      if (!pc) return;

      const signal: RtcSignal = {
        t: "a",
        ts: Date.now(),
        o: offer.ts,
        ...extractRtcParams(pc.localDescription!.sdp),
      };
      this.options.publishSignal(JSON.stringify(signal));
      this.setState("connecting");
    } catch {
      this.reset();
    }
  }

  /**
   * Makes the connection (`describe` sets its description) and waits for its candidates. One that found none by
   * `GATHER_STALL_MS` is replaced by a new one, up to `GATHER_ATTEMPTS` in all; when none finds any, the link goes back
   * to idle at once rather than hold, for its whole timeout, an attempt that cannot connect. Null when the link moved
   * on meanwhile (closed, or another signal took over) or gave up.
   */
  private async gathered(offer: boolean, describe: (pc: RTCPeerConnection) => Promise<void>): Promise<RTCPeerConnection | null> {
    let stalled: RTCPeerConnection | null = null;
    for (let attempt = 1; ; attempt++) {
      // The new connection takes the old one's place first: closing that one then resets nothing.
      const pc = this.createConnection();
      stalled?.close();
      await describe(pc);
      if (this.pc !== pc) return null;
      const gathering = Date.now();
      await waitForIceGathering(pc, ICE_GATHERING_TIMEOUT_MS, { stallMs: GATHER_STALL_MS });
      if (this.pc !== pc) return null;
      const ms = Date.now() - gathering;
      if (sdpHasCandidates(pc.localDescription?.sdp)) {
        traceLink(this.options.myPubKeyZ32, "ice-gathered", { ms, offer, ...(attempt > 1 ? { attempt } : {}) });
        return pc;
      }
      traceLink(this.options.myPubKeyZ32, "ice-stalled", { ms, offer, attempt });
      if (attempt >= GATHER_ATTEMPTS) { this.reset(); this.options.onDirect?.("no-public"); return null; }
      stalled = pc;
    }
  }

  private createConnection(): RTCPeerConnection {
    const pc = this.options.createPeerConnection();
    this.pc = pc;

    // Negotiated channel: both sides declare it, no in-band open handshake.
    const dc = pc.createDataChannel(DATA_CHANNEL_LABEL, { negotiated: true, id: DATA_CHANNEL_ID, ordered: true });
    dc.addEventListener("open", () => {
      if (this.pc !== pc) return;
      this.clearTimers();
      this.answered = null;
      this.setState("open");
      this.options.setFastPoll(false);
      this.options.publishSignal(null);
      this.options.onDirect?.("open");
      this.options.onOpen(wrapDataChannel(dc));
    });
    dc.addEventListener("close", () => {
      if (this.pc === pc) this.failed();
    });

    pc.addEventListener("connectionstatechange", () => {
      if (this.pc !== pc) return;
      if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); if (pc.connectionState === "connected") this.options.onDisconnected?.(false); }
      this.disconnectTimer = null;
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.failed();
      else if (pc.connectionState === "disconnected") {
        if (this.state === "open") this.options.onDisconnected?.(true);
        this.disconnectTimer = setTimeout(() => {
          if (this.pc === pc) this.failed();
        }, DISCONNECT_GRACE_MS);
      }
    });

    this.startAttemptTimer(pc);
    return pc;
  }

  /** The attempt on `pc` gives up this long from now (`CONNECT_TIMEOUT_MS`) unless it opens. */
  private startAttemptTimer(pc: RTCPeerConnection): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (this.pc === pc && this.state !== "open") {
        traceLink(this.options.myPubKeyZ32, "attempt-timeout", { state: this.state });
        this.failed();
      }
    }, this.options.attemptTimeoutMs?.() ?? CONNECT_TIMEOUT_MS);
  }

  /**
   * This side's offer or answer reached the relays only now (their budget, or an outage, held it back): the attempt
   * counts from here, so the other side has as long to read it as if it had gone out at once.
   */
  signalWentOut(): void {
    if (this.pc && this.connectTimer && this.state !== "open" && this.state !== "idle") this.startAttemptTimer(this.pc);
  }

  private clearTimers(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.connectTimer = this.disconnectTimer = null;
  }

  private teardown(): boolean {
    this.clearTimers();
    const pc = this.pc;
    this.pc = null;
    this.myOfferTs = 0;
    this.remoteSdp = null;
    if (!pc) return false;
    pc.close();
    return true;
  }

  private reset(): void {
    const wasOpen = this.state === "open";
    const hadConnection = this.teardown();
    if (this.state === "idle" && !hadConnection) return;
    this.setState("idle");
    this.options.setFastPoll(false);
    this.options.publishSignal(null);
    if (wasOpen) { this.options.onDirect?.("closed"); this.options.onClose(); }
  }

  private setState(state: DataLinkState): void {
    if (this.state === state) return;
    this.state = state;
    if (state === "connecting") this.connectingSince = Date.now();
    this.options.onState?.(state);
  }
}
