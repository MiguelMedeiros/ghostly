import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { createLink, type LinkParams } from "../src/invite";
import { createIdentity, type Identity } from "../src/identity";
import { emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import type { GhostRecord, SignedPacket } from "../src/pkarr";
import type { PkarrTransport } from "../src/transport";

// covers: invite.delivery-mode, chat.paired.reconnect, transport.webrtc

/**
 * Leaving DHT-only, end to end in one process: two paired links on one in-memory Pkarr, WebRTC stood in
 * for by peer connections that open once offer and answer met, fake time. B reloads while the chat is
 * DHT-only, then both leave it; the link must be live again seconds after the second one did, whoever
 * dials and whoever switched first (the matrix once waited 70 s, and once more than 3 minutes).
 */

const realSetTimeout = globalThis.setTimeout;
const yieldToLoop = () => new Promise<void>(resolve => realSetTimeout(resolve, 0));

class MemoryPkarr {
  packets = new Map<string, SignedPacket>();
  transport(): PkarrTransport {
    return {
      publish: async (identity: Identity, records: GhostRecord[]) => {
        this.packets.set(identity.pubKeyZ32, { pubKeyZ32: identity.pubKeyZ32, timestampMicros: BigInt(Date.now()) * 1000n, records });
      },
      resolve: async (key: string) => this.packets.get(key) ?? null,
      describe: () => ({ protocol: "memory", relays: [] }),
    };
  }
}

let fingerprints = 0;
const byFingerprint = new Map<string, FakePeerConnection>();
function sdp(setup: string): { sdp: string; fingerprint: string } {
  const n = ++fingerprints;
  const fingerprint = n.toString(16).padStart(4, "0").repeat(16);
  const colons = fingerprint.toUpperCase().match(/.{2}/g)!.join(":");
  return { fingerprint, sdp: [
    "v=0", `a=ice-ufrag:u${n}`, "a=ice-pwd:passwordpasswordpassword", `a=fingerprint:sha-256 ${colons}`, `a=setup:${setup}`,
    "a=candidate:1 1 udp 2122260223 127.0.0.1 50000 typ host", "",
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

class FakePeerConnection extends EventTarget {
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
  private made(setup: string) { const made = sdp(setup); byFingerprint.set(made.fingerprint, this); return made.sdp; }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
    if (description.type !== "answer") return;
    // The answer came back to the offer it answers: the two connect.
    const answerer = byFingerprint.get(fingerprintOf(description.sdp!));
    if (!answerer || answerer.closed || fingerprintOf(answerer.remoteDescription!.sdp!) !== fingerprintOf(this.localDescription!.sdp!)) return;
    this.channel.peer = answerer.channel; answerer.channel.peer = this.channel;
    realSetTimeout(() => {
      if (this.closed || answerer.closed) return;
      for (const pc of [this, answerer]) { pc.connectionState = "connected"; pc.channel.open(); }
    }, 0);
  }
  close() { this.closed = true; this.connectionState = "closed"; this.channel?.close(); }
}

interface Side { params: LinkParams; seedB64: string; peerKey: string; state: DhtDeliveryState }

function side(params: LinkParams, me: Identity, peer: Identity): Side {
  return { params: { ...params, profile: "paired-chat/1", deliveryMode: "dht" }, seedB64: me.seedB64, peerKey: peer.pubKeyZ32,
    // Paired through the DHT a while ago: each has read the other's envelopes, and both are DHT-only.
    state: { ...emptyDhtDeliveryState(), sequence: 3, peerSequence: 3, peerMode: "dht" } };
}

const links: GhostLink[] = [];
function open(s: Side, pkarr: MemoryPkarr, active: boolean): GhostLink {
  const link = new GhostLink({
    params: s.params,
    pairing: { credentials: { seedB64: s.seedB64, peerKey: s.peerKey, requireSignedSignals: true }, pinPeer: async () => {}, trustOnFirstUse: true },
    dht: { state: s.state, save: async state => { s.state = state; } },
    transport: pkarr.transport(),
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
    localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
  });
  links.push(link);
  link.start();
  link.session.setActive(active);
  return link;
}

async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 100) { await vi.advanceTimersByTimeAsync(100); await yieldToLoop(); }
}

/** Advances until both are open (or `limit` passes): how long it took, in fake ms. */
async function untilLive(a: GhostLink, b: GhostLink, limit: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < limit) {
    if (a.isDataLinkOpen && b.isDataLinkOpen) return Date.now() - start;
    await run(100);
  }
  return Infinity;
}

/** A pair of which the given one dials (the lower key offers). */
function pairWhere(dialer: "a" | "b") {
  for (;;) {
    const invitation = createLink();
    const [pa, pb] = [createIdentity(), createIdentity()];
    const a = side(invitation.mine, pa, pb), b = side(invitation.invite, pb, pa);
    const aKey = invitation.invite.peerPubKeyZ32, bKey = invitation.mine.peerPubKeyZ32;
    if ((aKey < bKey) === (dialer === "a")) return { a, b };
  }
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); });
afterEach(async () => {
  await Promise.all(links.splice(0).map(link => link.stop(false)));
  byFingerprint.clear();
  vi.useRealTimers();
});

describe("leaving DHT-only after the contact reloaded", () => {
  for (const dialer of ["a", "b"] as const) for (const gap of [0, 300, 3_000, 20_000]) for (const active of [true, false]) {
    it(`is live in seconds · ${dialer.toUpperCase()} dials · A leaves ${gap / 1000} s after B · chats ${active ? "open" : "in the background"}`, async () => {
      const pkarr = new MemoryPkarr();
      const pair = pairWhere(dialer);
      const a = open(pair.a, pkarr, active);
      let b = open(pair.b, pkarr, active);
      await run(10_000);
      // B reloads: a new link from what B saved, the old one gone without a word.
      await b.stop(false);
      b = open(pair.b, pkarr, active);
      await run(3_000);

      await b.setDeliveryMode("stream");
      await run(gap);
      await a.setDeliveryMode("stream");
      const took = await untilLive(a, b, 60_000);
      expect(took, "live after both left DHT-only").toBeLessThanOrEqual(10_000);
    }, 60_000);
  }
});
