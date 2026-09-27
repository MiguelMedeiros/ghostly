import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync } from "node:fs";
import { GhostLink } from "../src/ghostlink";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { createIdentity, type Identity } from "../src/identity";
import { edgeParams } from "../src/groupCrypto";
import { toBase64Url, randomBytes } from "../src/bytes";
import { RelayTransport } from "../src/relay";
// covers: core.relay-client, groups.send

/**
 * Measured before the fix (fake time, six runs, from the relays answering again to live): a new edge 104-125 s after a
 * 2-minute outage and 181-206 s after a 10-minute one, a live edge that dropped during a 10-minute outage 210 s. Every
 * relay's breaker was open, its wait doubled toward 5 minutes, and nothing was asked until it ran out. Now one relay is
 * asked every 15 s while all are out, and a link looks and publishes as soon as one answers: 16-43 s, 34-35 s, 4-50 s.
 *
 * A group's edge (a paired link pinned to a member key, as `startEdge` builds it) while the Pkarr relays answer HTTP 500,
 * then recover. Seen in the "Ghostly dev" group on 2026-09-27: a joiner's edges stayed down for more than ten minutes,
 * and one daemon restart brought them up in about two. Two relays in memory (both failing, or one), WebRTC stood in for
 * by peer connections that open once offer and answer met, fake time. Timings go to `EDGE_RECOVERY_OUT` when set.
 */

const realSetTimeout = globalThis.setTimeout;
const yieldToLoop = () => new Promise<void>(resolve => realSetTimeout(resolve, 0));
const RELAYS = ["https://relay-one.test", "https://relay-two.test"];

/** Two relays kept in memory; each can answer 500 to everything for a while. */
class FlakyRelays {
  packets = new Map<string, Uint8Array>();
  failing = new Set<string>();
  requests: { at: number; who: string; method: string; relay: string; status: number }[] = [];
  fetchFor(who: string): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)), relay = url.origin, key = url.pathname.slice(1), method = init?.method ?? "GET";
      if (this.failing.has(relay)) { this.requests.push({ at: Date.now(), who, method, relay, status: 500 }); return new Response("internal error", { status: 500 }); }
      this.requests.push({ at: Date.now(), who, method, relay, status: 200 });
      if (method === "PUT") { this.packets.set(key, new Uint8Array(init!.body as ArrayBuffer)); return new Response(null, { status: 204 }); }
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

const links: GhostLink[] = [];

/** One member's side of the edge toward another, built as the engine's `startEdge` builds it. */
function edge(name: string, relays: FlakyRelays, group: string, me: Identity, peer: Identity, transport = new RelayTransport({ relays: RELAYS, fetch: relays.fetchFor(name), log: () => {} })): GhostLink {
  const params = edgeParams(group, me.seed, me.pubKeyZ32, peer.pubKeyZ32);
  const link = new GhostLink({
    params,
    pairing: { credentials: { seedB64: me.seedB64, peerKey: peer.pubKeyZ32, requireSignedSignals: true, verifiedPeerKey: peer.pubKeyZ32 },
      pinPeer: async key => { if (key !== peer.pubKeyZ32) throw new Error("Not the member this edge belongs to"); }, trustOnFirstUse: false },
    transport,
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    groupsSupport: true,
    createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
  });
  links.push(link);
  link.start();
  return link;
}

async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 250) { await vi.advanceTimersByTimeAsync(250); await yieldToLoop(); }
}
async function untilLive(a: GhostLink, b: GhostLink, limit: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < limit) {
    if (a.isDataLinkOpen && b.isDataLinkOpen) return Date.now() - start;
    await run(250);
  }
  return Infinity;
}
const report = (row: Record<string, unknown>) => { if (process.env.EDGE_RECOVERY_OUT) appendFileSync(process.env.EDGE_RECOVERY_OUT, JSON.stringify(row) + "\n"); };

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); });
afterEach(async () => {
  await Promise.all(links.splice(0).map(link => link.stop(false)));
  byFingerprint.clear();
  vi.useRealTimers();
});

describe("a group's edge while the Pkarr relays answer 500", () => {
  for (const outageMin of [2, 10]) it(`a joiner's new edge, both relays failing for ${outageMin} min: live soon after they answer again, without a restart`, async () => {
    const relays = new FlakyRelays();
    const group = toBase64Url(randomBytes(16));
    const [member, joiner] = [createIdentity(), createIdentity()];
    // The member has been in the group a while: its side of the edge is up and published.
    const a = edge("member", relays, group, member, joiner);
    await run(5_000);
    for (const relay of RELAYS) relays.failing.add(relay);
    const b = edge("joiner", relays, group, joiner, member);
    await run(outageMin * 60_000);
    expect(a.isDataLinkOpen || b.isDataLinkOpen).toBe(false);
    for (const relay of RELAYS) relays.failing.delete(relay);
    const recovered = Date.now();
    const took = await untilLive(a, b, 20 * 60_000);
    // Nothing goes to a relay for minutes after the outage (the breaker's wait), then the edge goes live at the link's pace.
    expect(relays.requests.some(r => r.at >= recovered && r.at - recovered <= 20_000), "a request within 20 s of the relays answering again").toBe(true);
    report({ scenario: "new edge", outageMin, recoverMs: took });
    console.log(`EDGE_RECOVERY new edge, outage ${outageMin} min: live ${took / 1000} s after the relays recovered`);
    expect(took).toBeLessThanOrEqual(60_000);
  }, 120_000);

  it("a live edge that drops while both relays fail comes back soon after they answer again", async () => {
    const relays = new FlakyRelays();
    const group = toBase64Url(randomBytes(16));
    const [one, two] = [createIdentity(), createIdentity()];
    const a = edge("one", relays, group, one, two), b = edge("two", relays, group, two, one);
    expect(await untilLive(a, b, 60_000)).toBeLessThan(60_000);
    for (const relay of RELAYS) relays.failing.add(relay);
    a.disconnect();
    await run(10 * 60_000);
    for (const relay of RELAYS) relays.failing.delete(relay);
    const took = await untilLive(a, b, 20 * 60_000);
    report({ scenario: "dropped edge", outageMin: 10, recoverMs: took });
    console.log(`EDGE_RECOVERY dropped edge, outage 10 min: live ${took / 1000} s after the relays recovered`);
    expect(took).toBeLessThanOrEqual(60_000);
  }, 120_000);

  it("with one relay failing, the other carries the edge up at once", async () => {
    const relays = new FlakyRelays();
    const group = toBase64Url(randomBytes(16));
    const [member, joiner] = [createIdentity(), createIdentity()];
    relays.failing.add(RELAYS[0]);
    const a = edge("member", relays, group, member, joiner), b = edge("joiner", relays, group, joiner, member);
    const took = await untilLive(a, b, 10 * 60_000);
    report({ scenario: "one relay failing", recoverMs: took });
    console.log(`EDGE_RECOVERY one relay failing: live in ${took / 1000} s`);
    expect(took).toBeLessThanOrEqual(30_000);
  }, 120_000);
});
