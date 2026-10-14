import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { IceServer, PeerConnection, Track } from "node-datachannel";
import { buildSdpFromSignal, callRtcConfig, extractParamsFromSdp, PAIRED_CALL_CANDIDATES, RTC_CONFIG, type CallIceServer, type CallSignal } from "@ghostly/core";
import { CallAudio, type OpusCodec } from "./audio";
import type { CallRate, PlaybackQueue } from "./pcm";

/**
 * A call's media on Node (WISP 601, WISP 1100 § Calls): libdatachannel (node-datachannel, the same native module
 * the CLI's chats use) runs ICE, DTLS-SRTP and RTP; Opus is libopus built to WebAssembly (opusscript). Audio only:
 * a call's video section is answered closed (`vr: 0`), and nothing is sent or read on it.
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
 * first; none with `GHOSTLY_STUN=0`), then the profile's own (Settings `iceServers`: a TURN relay, typically), as the
 * apps' calls use them.
 */
export function callIceServers(extra: readonly CallIceServer[] = [], env = process.env): (string | IceServer)[] {
  const out: (string | IceServer)[] = env.GHOSTLY_STUN === "0" ? [] : (RTC_CONFIG.iceServers ?? []).flatMap((server) => [server.urls].flat()).slice(0, 2);
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

/**
 * For tests (the e2e of a web app calling back a bot): the first this many answers the process applies are refused
 * as libdatachannel 0.24.5 refuses one in its race (see CallManager's `redial`): the connection closes, and it throws.
 */
let refuseAnswers = Number(process.env.GHOSTLY_CALL_REFUSE_ANSWERS) || 0;

/** How long a description waits for its candidates: a server reflexive one and a little after it, or this long. */
const GATHER_MS = 5000;
const SETTLE_MS = 400;
/**
 * With a candidate in (a host one comes in milliseconds), the server reflexive one is waited for this long at most,
 * not the whole of `GATHER_MS`: a STUN server that answers does in tens of milliseconds, and one that never does (UDP
 * to it blocked, as on many office, school and hotel networks) made every call ring 5 s late and connect 5 s after
 * the answer. The apps' calls and the chats' data link bound theirs the same way (`HOST_GATHER_MS`,
 * `OFFER_HOST_GATHER_MS`).
 */
export const HOST_GATHER_MS = 2000;

/** What a connection needs before the call's audio does (an early answer's: the rate is known only at the answer). */
type ConnectionOptions = Pick<MediaOptions, "iceServers" | "log">;

/** A call's peer connection, its tracks and its description, before and once it has its audio. */
interface Connection {
  pc: PeerConnection;
  track: Track;
  videoTrack: Track | null;
  local: Partial<CallSignal>;
  payloadType: number;
  ssrc: number;
  log: (line: string) => void;
  ice: IceView;
  closed: boolean;
  /** libjuice gave up on it (an early answer's, after about 40 s with nothing to check). */
  failed: boolean;
  /** Who hears its states once it has its audio: none are told before. */
  onState: ((state: MediaState) => void) | null;
}

/**
 * A connection and its description, with its candidates. An early answer's (`held`) takes the contact's offer
 * without its candidates: with none, this side sends the contact no check, so nothing connects, and no audio is sent
 * or read, before the answer adds them.
 */
async function openConnection(stack: CallStack, options: ConnectionOptions, offer: CallSignal | null, held = false): Promise<Connection> {
  const { ndc } = stack;
  const bind = process.env.GHOSTLY_CALL_BIND;
  const pc = new ndc.PeerConnection("ghostly-call", { iceServers: callIceServers(options.iceServers), ...(bind ? { bindAddress: bind } : {}) });
  // Each line says how long after this connection was made it happened: the order of the connection's states and
  // the contact's answer is what explains a call that failed as it connected. The states are heard from the start.
  const born = Date.now();
  const sink = options.log ?? (() => {});
  const log = (line: string) => sink(`+${Date.now() - born}ms ${line}`);
  let conn: Connection | null = null;
  pc.onSignalingStateChange((state) => { if (!conn?.closed) log(`signaling ${state}`); });
  pc.onIceStateChange((state) => {
    if (conn?.closed) return;
    let pair: string | null = null;
    if (state === "connected" || state === "completed") {
      try { pair = describePair(pc.getSelectedCandidatePair()); } catch { /* none yet */ }
    }
    if (conn) { conn.ice.state = state; if (state === "connected" || state === "completed") conn.ice.pair = pair; }
    log(`ice ${state}${pair ? ` over ${pair}` : ""}`);
  });
  pc.onStateChange((state) => {
    if (conn?.closed) return;
    log(`connection ${state}`);
    if (!conn) return;
    if (state === "failed") conn.failed = true;
    if (state === "connected") conn.onState?.("connected");
    else if (state === "failed" || state === "closed") conn.onState?.(state);
  });
  try {
    const payloadType = offer?.ap ?? 111;
    const ssrc = randomBytes(4).readUInt32BE(0) || 1;
    const audioSection = new ndc.Audio("0", "SendRecv");
    audioSection.addOpusCodec(payloadType);
    audioSection.addSSRC(ssrc, "ghostly", "stream", "audio0");
    const track = pc.addTrack(audioSection);
    // The contact's offer always has a video section (the apps open one for a camera or a screen later): it is
    // answered closed, and the answer says so (`vr: 0` below), so the contact's app sends no picture on it. An app
    // that does not know `vr` sends one all the same: it is dropped as it comes (libdatachannel keeps what nobody reads).
    let videoTrack: Track | null = null;
    if (offer?.m?.includes("v")) {
      const video = new ndc.Video(String(offer.m.indexOf("v")), "Inactive");
      video.addVP8Codec(offer.vp ?? 96);
      videoTrack = pc.addTrack(video);
      videoTrack.onMessage(() => {});
    }
    const gathered = gathering(pc);
    if (offer) pc.setRemoteDescription(buildSdpFromSignal(held ? { ...offer, c: [] } : offer), "offer");
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
    // No picture is taken here, and none is sent: the contact's app rebuilds the video section closed (WISP 601).
    if (videoTrack) local.vr = 0;
    conn = { pc, track, videoTrack, local, payloadType, ssrc, log, ice: { state: "new", pair: null }, closed: false, failed: false, onState: null };
    // What each side offered to meet on: when a call does not connect, the log says between which addresses.
    log(`candidates here: ${(local.c ?? []).join(" | ") || "none"}`);
    try { conn.ice.state = pc.iceState(); } catch { /* keeps "new" */ }
    return conn;
  } catch (error) {
    pc.close();
    throw error;
  }
}

function closeConnection(conn: Connection): void {
  conn.closed = true;
  try { conn.track.close(); } catch { /* closed with the connection */ }
  try { conn.videoTrack?.close(); } catch { /* same */ }
  try { conn.pc.close(); } catch { /* already */ }
}

/**
 * The answer's connection, made while the call rings: its description and candidates are ready when the call is
 * answered, so the answer goes at once, where gathering them then took up to HOST_GATHER_MS (a STUN server that never
 * answers). The offer's candidates wait for the answer (see `openConnection`). libjuice gives up on a connection that
 * has nothing to check after about 40 s: a call that rings longer has its early answer made again (CallManager).
 */
export class EarlyAnswer {
  private constructor(private conn: Connection | null, readonly offer: CallSignal) {}

  static async open(stack: CallStack, offer: CallSignal, options: ConnectionOptions): Promise<EarlyAnswer> {
    return new EarlyAnswer(await openConnection(stack, options, offer, true), offer);
  }

  /** Whether it can still answer: not closed, not given up on, not used. */
  get usable(): boolean {
    return !!this.conn && !this.conn.closed && !this.conn.failed;
  }

  /** Its connection, once, for the answer to the offer it was made for. */
  take(offer: CallSignal): Connection | null {
    if (!this.usable || offer !== this.offer) return null;
    const conn = this.conn;
    this.conn = null;
    return conn;
  }

  /** Closed unused: the call ended, or a newer one replaced it. Nothing once taken. */
  close(): void {
    if (this.conn) closeConnection(this.conn);
    this.conn = null;
  }
}

/**
 * One call's peer connection. Its SDP never travels: the compact signal does (`local`), and each side rebuilds the
 * other's SDP from it (`buildSdpFromSignal`), so the payload types, SSRC and mids here are the ones that rebuilt SDP
 * uses: audio is mid 0, Opus is 111 unless the contact's offer says otherwise.
 */
export class CallMedia {
  readonly audio: CallAudio;
  private readonly log: (line: string) => void;

  private constructor(private readonly conn: Connection, audio: CallAudio) {
    this.audio = audio;
    this.log = conn.log;
  }

  get local(): Partial<CallSignal> {
    return this.conn.local;
  }

  /** An offer: audio only (the contact's app answers one section, and its video lane stays closed). */
  static async offer(stack: CallStack, options: MediaOptions): Promise<CallMedia> {
    return CallMedia.create(stack, options, null);
  }

  /**
   * The answer to a contact's offer, which is rebuilt into its SDP here: on the connection made while the call rang
   * when it is still good, else on a new one.
   */
  static async answer(stack: CallStack, offer: CallSignal, options: MediaOptions, early?: EarlyAnswer | null): Promise<CallMedia> {
    return CallMedia.create(stack, options, offer, early?.take(offer) ?? null);
  }

  private static async create(stack: CallStack, options: MediaOptions, offer: CallSignal | null, early: Connection | null = null): Promise<CallMedia> {
    const conn = early ?? await openConnection(stack, options, offer);
    const { pc, track, log } = conn;
    try {
      const listeners: ((packet: Buffer) => void)[] = [];
      track.onMessage((packet) => { for (const listener of listeners) listener(packet); });
      const audio = new CallAudio({
        rate: options.rate, payloadType: conn.payloadType, ssrc: conn.ssrc,
        track: { send: (packet) => { if (track.isOpen()) track.sendMessageBinary(packet); }, onPacket: (listener) => listeners.push(listener) },
        encoder: stack.opus(options.rate), decoder: stack.opus(options.rate), onFrame: options.onFrame, queue: options.queue,
      });
      const media = new CallMedia(conn, audio);
      conn.onState = options.onState;
      if (offer) log(`contact's candidates: ${(offer.c ?? []).join(" | ") || "none"}`);
      if (offer) mdnsNote(offer, log);
      track.onOpen(() => audio.start());
      // The early answer's connection gets the offer's candidates now: its checks start, and the call can connect.
      if (early && offer) {
        log("answered on the connection made as the call rang: the contact's candidates go in now");
        const mid = String(Math.max(0, (offer.m ?? ["a"]).indexOf("a")));
        for (const candidate of offer.c ?? []) pc.addRemoteCandidate(`candidate:${candidate}`, mid);
      }
      if (track.isOpen()) audio.start();
      return media;
    } catch (error) {
      closeConnection(conn);
      throw error;
    }
  }

  /** The contact's answer to this side's offer. */
  applyAnswer(answer: CallSignal): void {
    this.log(`contact's candidates: ${(answer.c ?? []).join(" | ") || "none"}`);
    mdnsNote(answer, this.log);
    if (refuseAnswers > 0) {
      refuseAnswers--;
      this.conn.pc.close();
      throw new Error("libdatachannel error while adding remote description: Got a remote candidate without ICE transport (GHOSTLY_CALL_REFUSE_ANSWERS)");
    }
    this.conn.pc.setRemoteDescription(buildSdpFromSignal(answer), "answer");
    this.log("answer applied");
  }

  get ice(): IceView {
    return this.conn.ice;
  }

  close(): void {
    if (this.conn.closed) return;
    this.audio.stop();
    closeConnection(this.conn);
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

/** Resolves once the local description has its candidates (see GATHER_MS and HOST_GATHER_MS). */
export function gathering(pc: Pick<PeerConnection, "onGatheringStateChange" | "onLocalCandidate">): Promise<void> {
  return new Promise((resolve) => {
    let settle: ReturnType<typeof setTimeout> | null = null;
    let any = false;
    const done = () => { clearTimeout(cap); clearTimeout(bounded); if (settle) clearTimeout(settle); resolve(); };
    const cap = setTimeout(done, GATHER_MS);
    const bounded = setTimeout(() => { if (any) done(); }, HOST_GATHER_MS);
    pc.onGatheringStateChange((state) => { if (state === "complete") done(); });
    pc.onLocalCandidate((candidate) => {
      any = true;
      if (!settle && / typ srflx/.test(candidate)) settle = setTimeout(done, SETTLE_MS);
    });
  });
}
