import { randomBytes } from "node:crypto";
import type { PeerConnection, Track } from "node-datachannel";
import { buildSdpFromSignal, extractParamsFromSdp, RTC_CONFIG, type CallSignal } from "@ghostly/core";
import { CallAudio, type OpusCodec } from "./audio";
import type { CallRate, PlaybackQueue } from "./pcm";

/**
 * A call's media on Node (WISP 601, WISP 11xx § Calls): libdatachannel (node-datachannel, the same native module
 * the CLI's chats use) runs ICE, DTLS-SRTP and RTP; Opus is libopus built to WebAssembly (opusscript). Audio only:
 * a call's video section is answered and nothing is sent or read on it.
 */
export interface CallStack {
  ndc: typeof import("node-datachannel");
  opus(rate: CallRate): OpusCodec;
}

let loading: Promise<CallStack | string> | null = null;

/** The media stack, or why calls are not available here (the reason the call buttons of the contact's app show). */
export function loadCallStack(): Promise<CallStack | string> {
  return (loading ??= (async () => {
    if (process.env.GHOSTLY_WEBRTC === "0") return "Calls are off on this headless Ghostly (GHOSTLY_WEBRTC=0)";
    try {
      const ndc = (await import("node-datachannel")) as unknown as CallStack["ndc"] & { default?: CallStack["ndc"] };
      const lib = (ndc.PeerConnection ? ndc : ndc.default!) as CallStack["ndc"];
      const OpusScript = ((await import("opusscript")) as unknown as { default: typeof import("opusscript") }).default;
      const opus = (rate: CallRate): OpusCodec => {
        const codec = new OpusScript(rate, 1, OpusScript.Application.VOIP);
        // What browsers send for speech; the default of the build is far more.
        codec.setBitrate(32_000);
        return codec as unknown as OpusCodec;
      };
      // Checked once here: a broken wasm build would otherwise fail the first call.
      opus(48000).delete?.();
      return { ndc: lib, opus };
    } catch (error) {
      return `Calls are not available on this headless Ghostly (${error instanceof Error ? error.message : String(error)})`;
    }
  })());
}

/** The STUN servers the apps' calls use (RTC_CONFIG), as libdatachannel spells them. */
function iceServers(): string[] {
  return (RTC_CONFIG.iceServers ?? []).flatMap((server) => [server.urls].flat()).slice(0, 2);
}

/**
 * The candidates a signal carries. The apps keep one host and one server reflexive candidate (a DHT packet's worth);
 * a signal on the chat session may carry eight, and a headless Ghostly on a server or a laptop often has several
 * interfaces (Docker, VPNs, Tailscale) of which the first is not the one the contact reaches. So: every IPv4 host
 * candidate first, then the server reflexive one, then IPv6 hosts, up to eight. The related address is left out.
 */
export function signalCandidates(sdp: string, { loopback = false } = {}): string[] {
  const lines = sdp.split(/\r?\n/).filter((line) => line.startsWith("a=candidate:")).map((line) => line.slice("a=candidate:".length).trim());
  const udp = lines.filter((c) => / udp /i.test(c));
  const address = (c: string) => c.split(" ")[4] ?? "";
  const type = (c: string) => / typ (\S+)/.exec(c)?.[1];
  const ipv4 = (c: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(address(c));
  const usable = (c: string) => (loopback || !/^(169\.254\.|fe80:|::1$|127\.)/i.test(address(c))) && address(c) !== "::" && address(c) !== "0.0.0.0";
  const hosts = udp.filter((c) => type(c) === "host" && usable(c));
  const picked = [
    ...hosts.filter(ipv4).slice(0, 6),
    ...udp.filter((c) => type(c) === "srflx").slice(0, 1),
    ...hosts.filter((c) => !ipv4(c)),
  ].slice(0, 8);
  return picked.map((c) => c.replace(/ raddr \S+ rport \d+/, ""));
}

export type MediaState = "connected" | "failed" | "closed";

export interface MediaOptions {
  rate: CallRate;
  /** A 20 ms frame of the contact's audio. */
  onFrame(frame: Buffer): void;
  onState(state: MediaState): void;
  /** The call's queue of the program's audio. */
  queue?: PlaybackQueue;
  /** A line about the connection (candidates, ICE states, the pair it runs on), for the daemon's log. */
  log?(line: string): void;
}

/** The call's connection as `call list` reports it: the ICE state and, once connected, the pair it runs on. */
export interface IceView { state: string; pair: string | null }

/** A candidate as `call list` and the log show it: address, port and type. */
function describePair(pair: ReturnType<PeerConnection["getSelectedCandidatePair"]>): string | null {
  if (!pair) return null;
  const one = (c: { address: string; port: number; type: string }) => `${c.address}:${c.port} ${c.type}`;
  return `${one(pair.local)} <-> ${one(pair.remote)}`;
}

/** How long a description waits for its candidates: a server reflexive one and a little after it, or this long. */
const GATHER_MS = 5000;
const SETTLE_MS = 400;

/**
 * One call's peer connection. Its SDP never travels: the compact signal does (`local`), and each side rebuilds the
 * other's SDP from it (`buildSdpFromSignal`), so the payload types, SSRC and mids here are the ones that rebuilt SDP
 * uses: audio is mid 0, Opus is 111 unless the contact's offer says otherwise.
 */
export class CallMedia {
  readonly audio: CallAudio;
  private closed = false;
  private iceState = "new";
  private pair: string | null = null;
  private log: (line: string) => void = () => {};

  private constructor(private readonly pc: PeerConnection, private readonly track: Track, private readonly videoTrack: Track | null, readonly local: Partial<CallSignal>, audio: CallAudio) {
    this.audio = audio;
  }

  /** An offer: audio only (the contact's app answers one section, and its video lane stays closed). */
  static async offer(stack: CallStack, options: MediaOptions): Promise<CallMedia> {
    return CallMedia.create(stack, options, null);
  }

  /** The answer to a contact's offer, which is rebuilt into its SDP here. */
  static async answer(stack: CallStack, offer: CallSignal, options: MediaOptions): Promise<CallMedia> {
    return CallMedia.create(stack, options, offer);
  }

  private static async create(stack: CallStack, options: MediaOptions, offer: CallSignal | null): Promise<CallMedia> {
    const { ndc } = stack;
    const bind = process.env.GHOSTLY_CALL_BIND;
    const pc = new ndc.PeerConnection("ghostly-call", { iceServers: iceServers(), ...(bind ? { bindAddress: bind } : {}) });
    try {
      const payloadType = offer?.ap ?? 111;
      const ssrc = randomBytes(4).readUInt32BE(0) || 1;
      const audioSection = new ndc.Audio("0", "SendRecv");
      audioSection.addOpusCodec(payloadType);
      audioSection.addSSRC(ssrc, "ghostly", "stream", "audio0");
      const track = pc.addTrack(audioSection);
      // The contact's offer always has a video section (the apps open one for a camera or a screen later): it is
      // answered, and whatever comes on it is dropped as it comes (libdatachannel keeps what nobody reads).
      let videoTrack: Track | null = null;
      if (offer?.m?.includes("v")) {
        const video = new ndc.Video(String(offer.m.indexOf("v")), "RecvOnly");
        video.addVP8Codec(offer.vp ?? 96);
        videoTrack = pc.addTrack(video);
        videoTrack.onMessage(() => {});
      }
      const gathered = gathering(pc);
      if (offer) pc.setRemoteDescription(buildSdpFromSignal(offer), "offer");
      else pc.setLocalDescription("offer");
      await gathered;
      const sdp = pc.localDescription()?.sdp;
      if (!sdp) throw new Error("No local description");
      const params = extractParamsFromSdp(sdp);
      // Bound to loopback (tests, GHOSTLY_CALL_BIND=127.0.0.1): that is the one candidate there is.
      const local: Partial<CallSignal> = { ...params, c: signalCandidates(sdp, { loopback: !!bind }), ss: [ssrc] };
      // An answer lists the offer's sections, video too: the rebuilt SDP must have as many as the offer.
      if (offer?.m) local.m = [...offer.m];
      const listeners: ((packet: Buffer) => void)[] = [];
      track.onMessage((packet) => { for (const listener of listeners) listener(packet); });
      const audio = new CallAudio({
        rate: options.rate, payloadType, ssrc,
        track: { send: (packet) => { if (track.isOpen()) track.sendMessageBinary(packet); }, onPacket: (listener) => listeners.push(listener) },
        encoder: stack.opus(options.rate), decoder: stack.opus(options.rate), onFrame: options.onFrame, queue: options.queue,
      });
      const media = new CallMedia(pc, track, videoTrack, local, audio);
      const log = (media.log = options.log ?? (() => {}));
      // What each side offered to meet on: when a call does not connect, the log says between which addresses.
      log(`candidates here: ${(local.c ?? []).join(" | ") || "none"}`);
      if (offer) log(`contact's candidates: ${(offer.c ?? []).join(" | ") || "none"}`);
      pc.onIceStateChange((state) => {
        if (media.closed) return;
        media.iceState = state;
        if (state === "connected" || state === "completed") {
          try { media.pair = describePair(pc.getSelectedCandidatePair()); } catch { media.pair = null; }
          log(`ice ${state}${media.pair ? ` over ${media.pair}` : ""}`);
        } else log(`ice ${state}`);
      });
      track.onOpen(() => audio.start());
      if (track.isOpen()) audio.start();
      pc.onStateChange((state) => {
        if (media.closed) return;
        if (state === "connected") options.onState("connected");
        else if (state === "failed" || state === "closed") options.onState(state);
      });
      return media;
    } catch (error) {
      pc.close();
      throw error;
    }
  }

  /** The contact's answer to this side's offer. */
  applyAnswer(answer: CallSignal): void {
    this.log(`contact's candidates: ${(answer.c ?? []).join(" | ") || "none"}`);
    this.pc.setRemoteDescription(buildSdpFromSignal(answer), "answer");
  }

  get ice(): IceView {
    return { state: this.iceState, pair: this.pair };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.audio.stop();
    try { this.track.close(); } catch { /* closed with the connection */ }
    try { this.videoTrack?.close(); } catch { /* same */ }
    try { this.pc.close(); } catch { /* already */ }
  }
}

/** Resolves once the local description has its candidates (see GATHER_MS). */
function gathering(pc: PeerConnection): Promise<void> {
  return new Promise((resolve) => {
    let settle: ReturnType<typeof setTimeout> | null = null;
    const done = () => { clearTimeout(cap); if (settle) clearTimeout(settle); resolve(); };
    const cap = setTimeout(done, GATHER_MS);
    pc.onGatheringStateChange((state) => { if (state === "complete") done(); });
    pc.onLocalCandidate((candidate) => { if (!settle && / typ srflx/.test(candidate)) settle = setTimeout(done, SETTLE_MS); });
  });
}
