import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { IceServer, PeerConnection, Track } from "node-datachannel";
import { buildSdpFromSignal, callRtcConfig, extractParamsFromSdp, PAIRED_CALL_CANDIDATES, RTC_CONFIG, type CallIceServer, type CallSignal } from "@ghostly/core";
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

/**
 * The ICE servers of a call, as libdatachannel takes them: the apps' STUN servers (RTC_CONFIG; libjuice uses the
 * first), then the profile's own (Settings `iceServers`: a TURN relay, typically), as the apps' calls use them.
 */
export function callIceServers(extra: readonly CallIceServer[] = []): (string | IceServer)[] {
  const out: (string | IceServer)[] = (RTC_CONFIG.iceServers ?? []).flatMap((server) => [server.urls].flat()).slice(0, 2);
  for (const server of callRtcConfig(extra).iceServers?.slice(RTC_CONFIG.iceServers?.length ?? 0) ?? []) {
    for (const url of [server.urls].flat()) {
      const m = /^(stun|turns?):([^:?\s]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(url);
      if (!m) continue;
      const scheme = m[1].toLowerCase(), hostname = m[2], transport = m[4]?.toLowerCase();
      if (scheme === "stun") { out.push(`stun:${hostname}:${m[3] ?? 3478}`); continue; }
      out.push({
        hostname, port: Number(m[3] ?? (scheme === "turns" ? 5349 : 3478)),
        ...(server.username ? { username: server.username } : {}), ...(typeof server.credential === "string" ? { password: server.credential } : {}),
        relayType: scheme === "turns" ? "TurnTls" : transport === "tcp" ? "TurnTcp" : "TurnUdp",
      });
    }
  }
  return out;
}

export type MediaState = "connected" | "failed" | "closed";

export interface MediaOptions {
  rate: CallRate;
  /** A 20 ms frame of the contact's audio. */
  onFrame(frame: Buffer): void;
  onState(state: MediaState): void;
  /** The call's queue of the program's audio. */
  queue?: PlaybackQueue;
  /** The profile's own ICE servers (Settings `iceServers`), after the apps' STUN servers. */
  iceServers?: readonly CallIceServer[];
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
    const pc = new ndc.PeerConnection("ghostly-call", { iceServers: callIceServers(options.iceServers), ...(bind ? { bindAddress: bind } : {}) });
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
      // Every path, as a signal on the chat session may carry (pickCallCandidates); bound to loopback (the tests,
      // GHOSTLY_CALL_BIND=127.0.0.1), that is the one candidate there is.
      const params = extractParamsFromSdp(sdp, { maxCandidates: PAIRED_CALL_CANDIDATES, loopback: !!bind });
      const local: Partial<CallSignal> = { ...params, ss: [ssrc] };
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
      try { media.iceState = pc.iceState(); } catch { /* keeps "new" */ }
      if (offer) mdnsNote(offer, log);
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
    mdnsNote(answer, this.log);
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

/**
 * WebKit (Safari, the macOS app) hides its host addresses behind mDNS names, which other machines, and often this
 * one, cannot resolve: then the call can only connect when the contact's own checks reach this side. The log says so,
 * since that is what a call stuck on "connecting" needs to be understood.
 */
function mdnsNote(signal: CallSignal, log: (line: string) => void): void {
  for (const candidate of signal.c ?? []) {
    const host = candidate.split(" ")[4];
    if (!host?.endsWith(".local")) continue;
    void lookup(host, { all: true }).then(
      (found) => log(`${host} resolves here to ${found.map((a) => a.address).join(", ")}`),
      () => log(`${host} does not resolve here: the call connects only if the contact's checks reach this side`),
    );
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
