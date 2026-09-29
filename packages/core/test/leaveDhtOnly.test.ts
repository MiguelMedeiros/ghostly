import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BLOCKED_DIAL_WAIT_MS, GhostLink } from "../src/ghostlink";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { createLink, type LinkParams } from "../src/invite";
import { createIdentity, type Identity } from "../src/identity";
import { emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import type { GhostRecord, SignedPacket } from "../src/pkarr";
import type { PkarrTransport } from "../src/transport";
import type { FrameChannel } from "../src/frames";
import type { NativeEndpoint } from "../src/pairedTransports";

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
  /** DHT mailboxes whose next read still answers this envelope: a relay that has not caught up with a newer one. */
  private stale = new Map<string, SignedPacket>();
  /** Reads that answered an older envelope than the one published. */
  staleServed = 0;
  lagMailboxes(): void {
    for (const [key, packet] of this.packets) if (packet.records.some(record => record.label === "_dm")) this.stale.set(key, packet);
  }
  transport(): PkarrTransport {
    return {
      publish: async (identity: Identity, records: GhostRecord[]) => {
        this.packets.set(identity.pubKeyZ32, { pubKeyZ32: identity.pubKeyZ32, timestampMicros: BigInt(Date.now()) * 1000n, records });
      },
      resolve: async (key: string) => {
        const old = this.stale.get(key), now = this.packets.get(key) ?? null;
        this.stale.delete(key);
        if (old && old !== now) { this.staleServed++; return old; }
        return now;
      },
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

function side(params: LinkParams, me: Identity, peer: Identity, mode: "dht" | "stream" = "dht"): Side {
  return { params: { ...params, profile: "paired-chat/1", deliveryMode: mode }, seedB64: me.seedB64, peerKey: peer.pubKeyZ32,
    // Paired through the DHT a while ago: each has read the other's envelopes, and both are on `mode`.
    state: { ...emptyDhtDeliveryState(), sequence: 3, peerSequence: 3, peerMode: mode } };
}

const links: GhostLink[] = [];
/** `advertises: false`: its link packets carry no presence, as an offer's packet with no room left for it. */
function open(s: Side, pkarr: MemoryPkarr, active: boolean, advertises = true): GhostLink {
  const link = new GhostLink({
    params: s.params,
    pairing: { credentials: { seedB64: s.seedB64, peerKey: s.peerKey, requireSignedSignals: true }, pinPeer: async () => {}, trustOnFirstUse: true },
    dht: { state: s.state, save: async state => { s.state = state; } },
    transport: pkarr.transport(),
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
    localFetch: vi.fn(), getServices: () => advertises ? [] : undefined, getHostedHttpService: () => undefined,
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
function pairWhere(dialer: "a" | "b", mode: "dht" | "stream" = "dht") {
  for (;;) {
    const invitation = createLink();
    const [pa, pb] = [createIdentity(), createIdentity()];
    const a = side(invitation.mine, pa, pb, mode), b = side(invitation.invite, pb, pa, mode);
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

describe("back from a hold after the contact read the mailbox", () => {
  /** A and B live, then A holds the chat on the DHT (`chat disconnect --hold`) and B reads A's mailbox saying so. */
  async function held(dialer: "a" | "b", advertises: boolean) {
    const pkarr = new MemoryPkarr();
    const pair = pairWhere(dialer, "stream");
    const a = open(pair.a, pkarr, false, advertises);
    const b = open(pair.b, pkarr, false);
    expect(await untilLive(a, b, 60_000), "live at first").toBeLessThan(Infinity);
    await a.setDeliveryMode("dht");
    for (let waited = 0; b.dhtDelivery?.peerMode !== "dht" && waited < 60_000; waited += 1_000) await run(1_000);
    expect(b.dhtDelivery?.peerMode).toBe("dht");
    await run(5_000);
    return { pkarr, a, b };
  }

  // What tells B that A is back: A's presence on the link's key, or, when A's packet has no room for it, A's offer.
  for (const [dialer, shows] of [["a", "presence"], ["a", "offer"], ["b", "presence"]] as const) {
    it(`is live in seconds when the first read of the mailbox is stale · ${dialer.toUpperCase()} dials · A's ${shows} shows it`, async () => {
      const { pkarr, a, b } = await held(dialer, shows === "presence");
      // A is back: its link packet reaches B before a relay has A's new envelope, so the read it prompts is stale.
      pkarr.lagMailboxes();
      await a.setDeliveryMode("stream");
      const took = await untilLive(a, b, 60_000);
      expect(pkarr.staleServed, "a read answered the envelope from before").toBeGreaterThan(0);
      expect(took, "live after A left the hold").toBeLessThanOrEqual(10_000);
    }, 60_000);
  }

  // A's dial on B's native endpoint (Iroh) came while B still read A as DHT-only: B closed it, and A's whole attempt
  // ended with "The peer closed this connection…", its next one after a backoff. It waits for the read now.
  for (const back of [true, false]) {
    it(`keeps a dial that came while the mailbox said DHT-only · ${back ? "taken once it says A left" : "closed if A stays"}`, async () => {
      const { a, b } = await held("a", false);
      const endpoint: NativeEndpoint = { transport: "iroh/1", descriptor: { id: "b:iroh/1" }, onConnection: null, onDescriptor: null,
        connect: async () => { throw new Error("not in this test"); }, close: async () => {} };
      b.registerEndpoint(endpoint);
      const sent: unknown[] = [];
      const dial: FrameChannel & { closed: boolean } = { closed: false, bufferedAmount: 0, onMessage: null, onClose: null,
        send: data => { sent.push(data); }, drained: async () => {}, close() { if (this.closed) return; this.closed = true; this.onClose?.(); } };
      endpoint.onConnection!({ channel: dial, binding: { transport: "iroh/1", context: "00".repeat(32), identities: ["aa".repeat(32), "bb".repeat(32)] } });
      await run(100);
      expect(dial.closed, "kept while B reads A's mailbox again").toBe(false);
      if (back) {
        await a.setDeliveryMode("stream");
        for (let waited = 0; b.dhtDelivery?.peerMode !== "stream" && waited < BLOCKED_DIAL_WAIT_MS; waited += 100) await run(100);
        expect(b.dhtDelivery?.peerMode).toBe("stream");
        expect(dial.closed, "taken, not closed").toBe(false);
        expect(sent.length, "B opened a session on it").toBeGreaterThan(0);
      } else {
        await run(BLOCKED_DIAL_WAIT_MS + 500);
        expect(dial.closed, "closed once the wait is over").toBe(true);
      }
    }, 60_000);
  }
});
