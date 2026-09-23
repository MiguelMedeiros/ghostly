import { waitForIceGathering } from "./callSignal";
import { wrapDataChannel, type FrameChannel } from "./frames";
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
  setFastPoll: (fast: boolean) => void;
  onOpen: (channel: FrameChannel) => void;
  onClose: () => void;
  onState?: (state: DataLinkState) => void;
}

const CONNECT_TIMEOUT_MS = 90_000;
const ICE_GATHERING_TIMEOUT_MS = 5_000;
/** How long a connection may stay `disconnected` before it is given up. */
const DISCONNECT_GRACE_MS = 12_000;

export class DataLink {
  state: DataLinkState = "idle";
  private pc: RTCPeerConnection | null = null;
  private myOfferTs = 0;
  private lastSignalTs = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: DataLinkOptions) {}

  /** Offers a connection to the peer. Resolves once the offer is published. */
  async connect(): Promise<void> {
    if (this.state !== "idle") return;
    this.setState("offering");
    this.options.setFastPoll(true);
    try {
      const pc = this.createConnection();
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIceGathering(pc, ICE_GATHERING_TIMEOUT_MS);
      if (this.pc !== pc) return;

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
      if (wasOpen) this.options.onClose();
      await this.answer(signal);
    } else if (this.state === "offering" && signal.o === this.myOfferTs && this.pc) {
      this.lastSignalTs = signal.ts;
      try {
        await this.pc.setRemoteDescription({ type: "answer", sdp: buildDataSdp(signal) });
        this.setState("connecting");
      } catch {
        this.reset();
      }
    }
  }

  get fingerprints(): [string, string] | null {
    const local = this.pc?.localDescription?.sdp;
    const remote = this.pc?.remoteDescription?.sdp;
    if (!local || !remote) return null;
    try { return [extractRtcParams(local).f.toLowerCase(), extractRtcParams(remote).f.toLowerCase()]; }
    catch { return null; }
  }

  close(): void {
    this.reset();
  }

  private async answer(offer: RtcSignal): Promise<void> {
    this.setState("answering");
    this.options.setFastPoll(true);
    try {
      const pc = this.createConnection();
      await pc.setRemoteDescription({ type: "offer", sdp: buildDataSdp(offer) });
      await pc.setLocalDescription(await pc.createAnswer());
      await waitForIceGathering(pc, ICE_GATHERING_TIMEOUT_MS);
      if (this.pc !== pc) return;

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

  private createConnection(): RTCPeerConnection {
    const pc = this.options.createPeerConnection();
    this.pc = pc;

    // Negotiated channel: both sides declare it, no in-band open handshake.
    const dc = pc.createDataChannel(DATA_CHANNEL_LABEL, { negotiated: true, id: DATA_CHANNEL_ID, ordered: true });
    dc.addEventListener("open", () => {
      if (this.pc !== pc) return;
      this.clearTimers();
      this.setState("open");
      this.options.setFastPoll(false);
      this.options.publishSignal(null);
      this.options.onOpen(wrapDataChannel(dc));
    });
    dc.addEventListener("close", () => {
      if (this.pc === pc) this.reset();
    });

    pc.addEventListener("connectionstatechange", () => {
      if (this.pc !== pc) return;
      if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.reset();
      else if (pc.connectionState === "disconnected") {
        this.disconnectTimer = setTimeout(() => {
          if (this.pc === pc) this.reset();
        }, DISCONNECT_GRACE_MS);
      }
    });

    this.connectTimer = setTimeout(() => {
      if (this.pc === pc && this.state !== "open") this.reset();
    }, CONNECT_TIMEOUT_MS);
    return pc;
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
    if (wasOpen) this.options.onClose();
  }

  private setState(state: DataLinkState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onState?.(state);
  }
}
