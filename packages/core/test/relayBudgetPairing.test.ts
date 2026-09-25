import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { createLink, type LinkParams } from "../src/invite";
import { createIdentity, type Identity } from "../src/identity";
import { emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import { REQUESTS_PER_MINUTE, RelayTransport } from "../src/relay";

// covers: core.relay-client, chat.paired.reconnect, invite.delivery-mode, chat.dht.errors

/**
 * The relays' request budget (30 a minute per relay here, reads and publishes together, shared by every chat of the
 * app) runs out in the minute of a pairing: the first contact, a switch to DHT only and back. The e2e then saw
 * "Could not publish connection details: … Discovery request budget reached … Reconnect to retry", and a pairing left
 * in `error`. Held back by the budget is a wait: every publication goes when the budget frees a request, the chat
 * goes live on its own, and nothing says "error" meanwhile.
 *
 * Two paired links, each with its own `RelayTransport` (its own budget, as two browsers have) over one relay in
 * memory, WebRTC stood in for by peer connections that open once offer and answer met, fake time.
 */

const realSetTimeout = globalThis.setTimeout;
const yieldToLoop = () => new Promise<void>(resolve => realSetTimeout(resolve, 0));

/** A relay kept in memory: the newest payload per key, requests counted. */
class MemoryRelay {
  packets = new Map<string, Uint8Array>();
  requests: { at: number; who: string; method: string }[] = [];
  fetchFor(who: string): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = new URL(String(input)).pathname.slice(1);
      this.requests.push({ at: Date.now(), who, method: init?.method ?? "GET" });
      if (init?.method === "PUT") { this.packets.set(key, new Uint8Array(init.body as ArrayBuffer)); return new Response(null, { status: 204 }); }
      const packet = this.packets.get(key);
      return packet ? new Response(packet as BodyInit) : new Response(null, { status: 404 });
    }) as typeof fetch;
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

interface Side { name: string; params: LinkParams; seedB64: string; peerKey: string; state: DhtDeliveryState; relays: RelayTransport }

/** What either side ever said was wrong. */
const trouble: string[] = [];
const links: GhostLink[] = [];

function side(name: string, relay: MemoryRelay, params: LinkParams, me: Identity, peer: Identity): Side {
  return { name, params: { ...params, profile: "paired-chat/1", deliveryMode: "stream" }, seedB64: me.seedB64, peerKey: peer.pubKeyZ32,
    // Paired a while ago, over the stream.
    state: { ...emptyDhtDeliveryState(), sequence: 3, peerSequence: 3, peerMode: "stream" },
    relays: new RelayTransport({ fetch: relay.fetchFor(name) }) };
}

function open(s: Side): GhostLink {
  const link = new GhostLink({
    params: s.params,
    pairing: { credentials: { seedB64: s.seedB64, peerKey: s.peerKey, requireSignedSignals: true }, pinPeer: async () => {}, trustOnFirstUse: true },
    dht: { state: s.state, save: async state => { s.state = state; } },
    transport: s.relays,
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
    localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    events: {
      onPairingState: state => { if (state.status === "error") trouble.push(`${s.name} pairing: ${state.error}`); },
      onDiscoveryError: error => { if (error) trouble.push(`${s.name} discovery: ${error}`); },
      onDhtDelivery: view => { if (view.error) trouble.push(`${s.name} dht: ${view.error}`); },
      onStatus: status => { if (status === "error") trouble.push(`${s.name} status: error`); },
    },
  });
  links.push(link);
  link.start();
  link.setChatActive(true);
  return link;
}

async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 100) { await vi.advanceTimersByTimeAsync(100); await yieldToLoop(); }
}

/** Advances until both are live (or `limit` passes): how long it took, in fake ms. */
async function untilLive(a: GhostLink, b: GhostLink, limit: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < limit) {
    if (a.isDataLinkOpen && b.isDataLinkOpen) return Date.now() - start;
    await run(100);
  }
  return Infinity;
}

/** Everything else the app does spends the rest of this minute on both relays (other chats, groups, a burst of polls). */
async function spendBudget(relays: RelayTransport): Promise<void> {
  for (let i = 0; i < 4 * REQUESTS_PER_MINUTE; i++) {
    try { await relays.resolve(createIdentity().pubKeyZ32); } catch { return; }
  }
  throw new Error("the budget never ran out");
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); trouble.length = 0; });
afterEach(async () => {
  await Promise.all(links.splice(0).map(link => link.stop(false)));
  byFingerprint.clear();
  vi.useRealTimers();
});

describe("the relays' request budget runs out in the middle of a pairing", () => {
  for (const spent of ["leaver", "both"] as const) {
    it(`leaving DHT only with the budget spent (${spent === "both" ? "on both sides" : "on the side that leaves"}): waits for the budget, goes live on its own, never says error`, async () => {
      const relay = new MemoryRelay();
      const invitation = createLink();
      const [pa, pb] = [createIdentity(), createIdentity()];
      const A = side("A", relay, invitation.mine, pa, pb), B = side("B", relay, invitation.invite, pb, pa);
      const a = open(A), b = open(B);
      expect(await untilLive(a, b, 30_000)).toBeLessThan(30_000);

      await a.setDeliveryMode("dht");
      await run(30_000);
      expect(a.isDataLinkOpen || b.isDataLinkOpen).toBe(false);
      expect(trouble).toEqual([]);

      // The minute is spent at once: nothing A publishes (its presence, its "stream" envelope, its offer or answer)
      // goes out for a minute.
      await spendBudget(A.relays);
      if (spent === "both") await spendBudget(B.relays);
      const outBefore = relay.requests.filter(r => r.who === "A" && r.method === "PUT").length;
      await a.setDeliveryMode("stream");
      await run(20_000);
      expect(relay.requests.filter(r => r.who === "A" && r.method === "PUT").length, "held back while the minute is spent").toBe(outBefore);

      // Once the minute frees requests, what waited goes, and the chat is live again without a Reconnect.
      const took = await untilLive(a, b, 90_000);
      expect(took, "live once the budget frees requests").toBeLessThanOrEqual(60_000);
      expect(trouble, "a wait for the budget is no error").toEqual([]);
    }, 60_000);
  }

  it("a first pairing's offer held back by the budget goes out when it frees, and the pairing ends live", async () => {
    const relay = new MemoryRelay();
    const invitation = createLink();
    const [pa, pb] = [createIdentity(), createIdentity()];
    const A = side("A", relay, invitation.mine, pa, pb), B = side("B", relay, invitation.invite, pb, pa);
    // Both apps spent their minute before this chat started (a busy app: other chats, a group's hub).
    await spendBudget(A.relays);
    await spendBudget(B.relays);
    const a = open(A), b = open(B);
    const took = await untilLive(a, b, 120_000);
    expect(took, "live once the budget frees requests").toBeLessThanOrEqual(75_000);
    expect(took, "the budget did hold it back").toBeGreaterThanOrEqual(55_000);
    expect(trouble).toEqual([]);
  }, 60_000);
});
