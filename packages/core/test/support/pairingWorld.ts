import { vi } from "vitest";
import { GhostLink, type GhostLinkOptions } from "../../src/ghostlink";
import type { DataLinkState } from "../../src/datalink";
import { DHT_POLL_INTERVALS, type PollIntervals } from "../../src/link";
import { createLink, type LinkParams } from "../../src/invite";
import { createIdentity, type Identity } from "../../src/identity";
import type { GhostRecord, SignedPacket } from "../../src/pkarr";
import type { PkarrRequestOptions, PkarrTransport } from "../../src/transport";
import type { PairingProgress } from "../../src/pairingProgress";
import { emptyDhtDeliveryState, type DhtDeliveryState, type DhtDeliveryView } from "../../src/dhtDelivery";
import type { PairingCredentials, PairingState } from "../../src/pairedSession";

/**
 * Two links pairing from an invite, in one process: an in-memory Pkarr with the network's timing
 * modelled (how long a publish takes to return and to become visible, how long a read takes), WebRTC
 * stood in for by peer connections that open once offer and answer met, and fake time. The same shape
 * as leaveDhtOnly.test.ts's harness, for the first pairing rather than the way back from DHT-only.
 */

const realSetTimeout = globalThis.setTimeout;
export const yieldToLoop = () => new Promise<void>(resolve => realSetTimeout(resolve, 0));
const after = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface NetworkModel {
  /** A publish returns after this long… */
  publishMs: number;
  /** …and the packet is readable by the other side this long after the publish began. */
  visibleAfterMs: number;
  /** A read returns after this long, found or not. */
  readMs: number;
  /** A publish fails (throws) while this says so, e.g. for the first n calls. */
  publishFails?: (count: number) => boolean;
}

/**
 * Desktop through the relays, as measured on 2026-09-25 with the Rust client publishing until the packet
 * reads back (pkarr_network.rs): a publish returns in ~0.4 s, is visible in ~0.2 s, a read takes ~0.3 s.
 */
export const DESKTOP_NETWORK: NetworkModel = { publishMs: 400, visibleAfterMs: 200, readMs: 300 };

export class MemoryPkarr {
  private packets = new Map<string, { packet: SignedPacket; visibleAt: number }>();
  publishes = 0;
  reads = 0;
  readsBackground = 0;
  /** Reads per key: which records a budget goes on. */
  readsByKey = new Map<string, number>();
  /** Publishes per key. */
  publishesByKey = new Map<string, number>();
  /** Keys whose reads find nothing while listed: a reader whose last look came just before the packet did. */
  unseen = new Set<string>();
  constructor(private readonly model: NetworkModel) {}

  transport(): PkarrTransport {
    return {
      publish: async (identity: Identity, records: GhostRecord[]) => {
        const count = ++this.publishes;
        this.publishesByKey.set(identity.pubKeyZ32, (this.publishesByKey.get(identity.pubKeyZ32) ?? 0) + 1);
        const at = Date.now();
        if (this.model.publishFails?.(count)) { await after(this.model.publishMs); throw new Error("Publish error: the network is away"); }
        this.packets.set(identity.pubKeyZ32, { packet: { pubKeyZ32: identity.pubKeyZ32, timestampMicros: BigInt(at) * 1000n, records }, visibleAt: at + this.model.visibleAfterMs });
        await after(this.model.publishMs);
      },
      resolve: async (key: string, options?: PkarrRequestOptions) => {
        this.reads++;
        this.readsByKey.set(key, (this.readsByKey.get(key) ?? 0) + 1);
        if (options?.background) this.readsBackground++;
        await after(this.model.readMs);
        const entry = this.packets.get(key);
        return entry && entry.visibleAt <= Date.now() && !this.unseen.has(key) ? entry.packet : null;
      },
      describe: () => ({ protocol: "memory", relays: [] }),
    };
  }
}

let fingerprints = 0;
const byFingerprint = new Map<string, FakePeerConnection>();
function sdp(setup: string, candidates = true): { sdp: string; fingerprint: string } {
  const n = ++fingerprints;
  const fingerprint = n.toString(16).padStart(4, "0").repeat(16);
  const colons = fingerprint.toUpperCase().match(/.{2}/g)!.join(":");
  return { fingerprint, sdp: [
    "v=0", `a=ice-ufrag:u${n}`, "a=ice-pwd:passwordpasswordpassword", `a=fingerprint:sha-256 ${colons}`, `a=setup:${setup}`,
    ...(candidates ? ["a=candidate:1 1 udp 2122260223 127.0.0.1 50000 typ host"] : []), "",
  ].join("\r\n") };
}
const fingerprintOf = (text: string) => /a=fingerprint:sha-256 (\S+)/i.exec(text)![1].replace(/:/g, "").toLowerCase();

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  bufferedAmountLowThreshold = 0;
  peer: FakeChannel | null = null;
  send(data: string | ArrayBuffer) {
    const peer = this.peer;
    queueMicrotask(() => { if (peer?.readyState === "open") peer.dispatchEvent(Object.assign(new Event("message"), { data })); });
  }
  open() { this.readyState = "open"; this.dispatchEvent(new Event("open")); }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
    this.peer?.close();
  }
}

/** ICE and DTLS take this long once offer and answer met (fake ms). */
export const CONNECT_MS = 600;
/**
 * `blocked`: offer and answer meet but nothing connects, every WebRTC attempt fails (a NAT that lets nothing through).
 * `answerFailsAfterMs`: an answering connection whose answer never reached the offer goes `failed` this long after it
 * was made, as ICE gives up (31 s with node-datachannel in the CLI's #398 trace); unset, it waits for its attempt timeout.
 * `blockedFailsAfterMs`: with `blocked`, the offer's connection goes `failed` this long after it took its answer, as
 * ICE does once every check went unanswered; unset, it waits for its attempt timeout.
 * `noCandidates`: the apps (by `owner`) whose connections gather no candidate at all, as a browser's under
 * `disable_non_proxied_udp` (a VPN's extension, a network with no UDP).
 * `srflxAfterMs`: an offer's server reflexive candidate (its STUN server's answer) comes this long after its host one,
 * and its gathering completes then; `Infinity`: never (STUN servers that never answer). Unset: at once.
 * `needsSrflx`: the contact is behind a NAT that lets nothing through to an offer without one: such an offer, answered,
 * goes `failed` 3 s later (ICE gives up).
 */
export const rtc: { blocked: boolean; answerFailsAfterMs?: number; blockedFailsAfterMs?: number; noCandidates: Set<string>; srflxAfterMs?: number; needsSrflx?: boolean } = { blocked: false, noCandidates: new Set() };

class FakePeerConnection extends EventTarget {
  /** The app this connection belongs to, for `killRtc`. */
  owner?: string;
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  iceGatheringState: RTCIceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "new";
  channel!: FakeChannel;
  closed = false;
  getConfiguration() { return { iceServers: [] }; }
  createDataChannel() { this.channel = new FakeChannel(); return this.channel as unknown as RTCDataChannel; }
  async createOffer() { return { type: "offer" as const, sdp: this.made("actpass") }; }
  async createAnswer() { return { type: "answer" as const, sdp: this.made("active") }; }
  private made(setup: string) { const made = sdp(setup, !rtc.noCandidates.has(this.owner ?? "")); byFingerprint.set(made.fingerprint, this); return made.sdp; }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
    const srflxAfter = rtc.srflxAfterMs;
    if (description.type === "offer" && srflxAfter !== undefined && !rtc.noCandidates.has(this.owner ?? "")) {
      this.iceGatheringState = "gathering";
      if (Number.isFinite(srflxAfter)) setTimeout(() => {
        if (this.closed) return;
        const line = "a=candidate:2 1 udp 1686052607 203.0.113.7 50001 typ srflx raddr 127.0.0.1 rport 50000";
        this.localDescription = { ...description, sdp: `${description.sdp}${line}\r\n` };
        this.dispatchEvent(Object.assign(new Event("icecandidate"), { candidate: { candidate: line } }));
        this.iceGatheringState = "complete";
        this.dispatchEvent(new Event("icegatheringstatechange"));
      }, srflxAfter);
    }
    const failAfter = rtc.answerFailsAfterMs;
    if (description.type === "answer" && failAfter !== undefined) setTimeout(() => {
      if (this.closed || this.connectionState === "connected") return;
      this.connectionState = "failed";
      this.dispatchEvent(new Event("connectionstatechange"));
    }, failAfter);
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
    if (description.type !== "answer") return;
    // The answer came back to the offer it answers: the two connect.
    const answerer = byFingerprint.get(fingerprintOf(description.sdp!));
    if (!answerer || answerer.closed || fingerprintOf(answerer.remoteDescription!.sdp!) !== fingerprintOf(this.localDescription!.sdp!)) return;
    if (rtc.needsSrflx && !/ typ srflx/.test(this.localDescription?.sdp ?? "")) {
      setTimeout(() => {
        if (this.closed || this.connectionState === "connected") return;
        this.connectionState = "failed";
        this.dispatchEvent(new Event("connectionstatechange"));
      }, 3_000);
      return;
    }
    if (rtc.blocked) {
      const failAfter = rtc.blockedFailsAfterMs;
      if (failAfter !== undefined) setTimeout(() => {
        if (this.closed || this.connectionState === "connected") return;
        this.connectionState = "failed";
        this.dispatchEvent(new Event("connectionstatechange"));
      }, failAfter);
      return;
    }
    this.channel.peer = answerer.channel; answerer.channel.peer = this.channel;
    setTimeout(() => {
      if (this.closed || answerer.closed) return;
      for (const pc of [this, answerer]) { pc.connectionState = "connected"; pc.channel.open(); }
    }, CONNECT_MS);
  }
  close() { this.closed = true; this.connectionState = "closed"; this.channel?.close(); }
}

const peerConnections = new Set<FakePeerConnection>();
/** A stand-in WebRTC connection owned by the app `owner` (see `killRtc`). */
export function fakePeerConnection(owner?: string): RTCPeerConnection {
  const pc = new FakePeerConnection();
  pc.owner = owner;
  // Gathering that never finds a candidate never says it is complete either: the link waits out its stall time.
  if (rtc.noCandidates.has(owner ?? "")) pc.iceGatheringState = "gathering";
  peerConnections.add(pc);
  return pc as unknown as RTCPeerConnection;
}
/**
 * The app `owner` ends with nothing said: its connections go dead. The contact's side sees its connection
 * `disconnected` once ICE consent checks stop being answered, `disconnectedAfterMs` later. `farFailsAfterMs`: it never
 * does (node-datachannel, the CLI's WebRTC, reports no `disconnected`), and its connection goes `failed` this long after.
 */
export function killRtc(owner: string, disconnectedAfterMs = 5_000, farFailsAfterMs?: number): void {
  for (const pc of [...peerConnections]) {
    if (pc.owner !== owner || pc.closed) continue;
    peerConnections.delete(pc);
    pc.closed = true; pc.connectionState = "closed";
    const channel = pc.channel, far = channel?.peer;
    if (channel) { channel.peer = null; channel.readyState = "closed"; }
    const farPc = [...peerConnections].find(other => other.channel === far);
    if (farPc) setTimeout(() => {
      if (farPc.closed) return;
      farPc.connectionState = farFailsAfterMs === undefined ? "disconnected" : "failed";
      farPc.dispatchEvent(new Event("connectionstatechange"));
    }, farFailsAfterMs ?? disconnectedAfterMs);
  }
}

export interface Side { params: LinkParams; seedB64: string; role: "inviter" | "joiner"; createdAt: number; /** An app from before pairing progress: no tracker, the lower key dials. */ old?: boolean }

/** The two sides of a fresh invite: `mine` stays with the inviter, `invite` is what the joiner pastes. */
export function invitation(): { inviter: Side; joiner: Side } {
  const made = createLink();
  const now = Date.now();
  return {
    inviter: { params: { ...made.mine, profile: "paired-chat/1" }, seedB64: createIdentity().seedB64, role: "inviter", createdAt: now },
    joiner: { params: { ...made.invite, profile: "paired-chat/1" }, seedB64: createIdentity().seedB64, role: "joiner", createdAt: now },
  };
}

/** An invitation of which the given side dials (the lower link key offers). */
export function invitationWhere(dialer: "inviter" | "joiner"): { inviter: Side; joiner: Side } {
  for (;;) {
    const made = invitation();
    const inviterKey = made.joiner.params.peerPubKeyZ32, joinerKey = made.inviter.params.peerPubKeyZ32;
    if ((inviterKey < joinerKey) === (dialer === "inviter")) return made;
  }
}

export interface Opened {
  link: GhostLink; progress: PairingProgress[]; pinned: string[];
  /** With `dht`: the credentials both layers share, what arrived (by id, in order), receipts, pairing states. */
  credentials: PairingCredentials; received: { id?: string; text: string; via: string }[]; receipts: string[]; states: PairingState[];
  dhtState: DhtDeliveryState;
  /** With `dht`: the DHT delivery's last view. */
  dhtView?: DhtDeliveryView;
}

const opened: GhostLink[] = [];

/** One side's link, as the engine opens it for a chat never paired (node.ts `startLink` + the joiner's `expectPeer`). */
export function open(side: Side, pkarr: MemoryPkarr, options: { active?: boolean; pollIntervals?: PollIntervals; dht?: boolean; credentials?: PairingCredentials; dhtState?: DhtDeliveryState;
  /** A group's entry session opens its links so (node.ts `startEdge`). */
  link?: Pick<GhostLinkOptions, "oneShot" | "firstPublish">; onDataLinkState?: (state: DataLinkState) => void } = {}): Opened {
  const progress: PairingProgress[] = [], pinned: string[] = [];
  const received: Opened["received"] = [], receipts: string[] = [], states: PairingState[] = [];
  const credentials: PairingCredentials = options.credentials ?? { seedB64: side.seedB64 };
  const result = { dhtState: options.dhtState ?? emptyDhtDeliveryState() } as Opened;
  const link = new GhostLink({
    params: side.params,
    // Pinned once, by whichever layer verifies first; the engine refuses another key the same way (node.ts pinPeer).
    pairing: { credentials, pinPeer: async key => {
      if (options.dht && pinned.length && pinned[0] !== key) throw new Error("Already paired");
      pinned.push(key);
    }, trustOnFirstUse: true },
    dht: options.dht ? { state: result.dhtState, save: async state => { result.dhtState = state; } } : undefined,
    pairingProgress: side.old ? undefined : { role: side.role, startedAt: side.createdAt },
    transport: pkarr.transport(),
    pollIntervals: options.pollIntervals ?? DHT_POLL_INTERVALS,
    autoConnect: true,
    ...options.link,
    createPeerConnection: () => fakePeerConnection(),
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
    events: {
      onPairingProgress: p => progress.push(p),
      onMessage: m => { received.push({ id: m.id, text: m.text, via: m.via }); },
      onMessageReceipt: id => { receipts.push(id); },
      onPairingState: state => { states.push(state); },
      onDataLinkState: options.onDataLinkState,
      onDhtDelivery: view => { result.dhtView = view; },
    },
  });
  opened.push(link);
  link.start();
  link.session.setActive(options.active ?? true);
  if (!side.old) link.expectPeer();
  return Object.assign(result, { link, progress, pinned, credentials, received, receipts, states });
}

export async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 50) { await vi.advanceTimersByTimeAsync(50); await yieldToLoop(); }
}

/** Live: the pairing says so, or, for a side without pairing progress (an old app), its session is open. */
const live = (side: Opened) => side.link.pairingProgress ? side.link.pairingProgress.stage === "live" : side.link.isDataLinkOpen;

/** Advances until both are live (or `limit` passes): how long it took, in fake ms. */
export async function untilLive(a: Opened, b: Opened, limit: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < limit) {
    if (live(a) && live(b)) return Date.now() - start;
    await run(50);
  }
  return Infinity;
}

export function useFakeWorld(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
}

export async function closeWorld(): Promise<void> {
  // A stop waits for what is in flight (a DHT publish takes fake time too): time keeps running until it is done.
  let stopped = false;
  const stopping = Promise.all(opened.splice(0).map(link => link.stop(false))).finally(() => { stopped = true; });
  for (let i = 0; !stopped && i < 200; i++) { await vi.advanceTimersByTimeAsync(100); await yieldToLoop(); }
  await stopping;
  byFingerprint.clear();
  peerConnections.clear();
  rtc.blocked = false;
  rtc.answerFailsAfterMs = undefined;
  rtc.blockedFailsAfterMs = undefined;
  rtc.noCandidates.clear();
  rtc.srflxAfterMs = undefined;
  rtc.needsSrflx = undefined;
  vi.useRealTimers();
}
