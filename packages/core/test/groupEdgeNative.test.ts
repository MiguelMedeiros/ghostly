import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { createIdentity, type Identity } from "../src/identity";
import { edgeParams } from "../src/groupCrypto";
import { randomBytes, toBase64Url } from "../src/bytes";
import { encodePacketTransports, parsePacketTransports } from "../src/capsRecord";
import { buildLinkRecords, LABEL, parseLinkRecords } from "../src/records";
import { fromBase64Url } from "../src/bytes";
import type { PairingState } from "../src/pairedSession";
import type { NativeTransport, PairedTransport } from "../src/pairedTransports";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, useFakeWorld, yieldToLoop } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";
// covers: groups.native-links, groups.send

/**
 * A group's edge where one app has no WebRTC (Ghostly Desktop on Linux: WebKitGTK has none), WISP 902 § Transports. An
 * edge has no capability record, so the app with no WebRTC says in its own packet (`_tr`) which transports it runs and
 * how to dial its native ones; the member's app, reading that it has no WebRTC, starts its own native endpoint and says
 * the same back. The edge then goes live over Iroh (or HyperDHT), and group frames cross it. Two apps that both have
 * WebRTC never publish `_tr`: their packets are what they were.
 *
 * Built as the engine's `startEdge` builds an edge (pinned to the member key, `packetTransports`), with the engine's part
 * played here: an app with no WebRTC registers its endpoints at once, an app with WebRTC once the member's packet says
 * it has none (`onPacketTransports`, `keepsGroupNative` in node.ts).
 */

interface Member {
  name: string; link: GhostLink; states: PairingState[]; frames: unknown[];
  /** What the member's packet said, each time it said something new. */
  heard: PairedTransport[][];
}

let pkarr: MemoryPkarr, native: NativeWorld;

function member(name: string, group: string, me: Identity, peer: Identity, options: { rtc: boolean; transports?: NativeTransport[]; entry?: "host" | "guest"; endpointAfterMs?: number }): Member {
  const states: PairingState[] = [], frames: unknown[] = [], heard: PairedTransport[][] = [];
  const transports = options.transports ?? ["iroh/1"];
  let started = false;
  const startEndpoints = () => {
    if (started) return;
    started = true;
    for (const transport of transports) result.link.registerEndpoint(native.endpoint(transport, name));
  };
  const link = new GhostLink({
    params: edgeParams(group, me.seed, me.pubKeyZ32, peer.pubKeyZ32),
    rtcAvailable: options.rtc,
    pairing: { credentials: { seedB64: me.seedB64, peerKey: peer.pubKeyZ32, requireSignedSignals: true, verifiedPeerKey: peer.pubKeyZ32 },
      pinPeer: async key => { if (key !== peer.pubKeyZ32) throw new Error("Not the member this edge belongs to"); }, trustOnFirstUse: false },
    native: { automatic: true },
    // An entry session opens so (node.ts `startEdge`): one exchange, the member's side publishing after its first look.
    ...(options.entry ? { oneShot: true, firstPublish: options.entry === "host" ? "after-first-poll" as const : "at-start" as const } : {}),
    packetTransports: true,
    transport: pkarr.transport(),
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    groupsSupport: true,
    createPeerConnection: () => {
      if (!options.rtc) throw new ReferenceError("RTCPeerConnection is not defined");
      return fakePeerConnection(name);
    },
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
    events: {
      onPairingState: state => { states.push(state); },
      onGroupFrame: frame => { frames.push(frame); },
      onPacketTransports: said => {
        heard.push(said);
        if (!said.includes("webrtc/1")) setTimeout(startEndpoints, options.endpointAfterMs ?? 0);
      },
    },
  });
  const result: Member = { name, link, states, frames, heard };
  link.start();
  if (options.entry === "guest") link.expectPeer();
  if (!options.rtc) { if (options.endpointAfterMs) setTimeout(startEndpoints, options.endpointAfterMs); else startEndpoints(); }
  return result;
}

async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 250) { await vi.advanceTimersByTimeAsync(250); await yieldToLoop(); }
}
async function untilLive(a: Member, b: Member, limit: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < limit) {
    if (a.link.groupsSupport && b.link.groupsSupport) return Date.now() - start;
    await run(250);
  }
  return Infinity;
}
const liveOn = (m: Member) => [...m.states].reverse().find(s => s.status === "ready")?.transport;

/** Every `_tr` a key published, decrypted with the edge's key. */
function published(pkarr: MemoryPkarr, m: Member, peer: Member): string[] {
  const encKey = fromBase64Url((m.link as unknown as { options: { params: { encKeyB64: string } } }).options.params.encKeyB64);
  void peer;
  const packet = (pkarr as unknown as { packets: Map<string, { packet: Parameters<typeof parseLinkRecords>[0] }> }).packets.get(m.link.myPubKeyZ32)?.packet;
  if (!packet) return [];
  const parsed = parseLinkRecords(packet, encKey);
  return parsed.transports ? [parsed.transports] : [];
}

beforeEach(() => {
  useFakeWorld();
  pkarr = new MemoryPkarr(DESKTOP_NETWORK);
  native = new NativeWorld();
  native.hexIds = true;
});
afterEach(async () => { await closeWorld(); });

describe("a group's edge with a member whose app has no WebRTC", () => {
  // Either key order: the side that dials is the lower key, whichever app it is.
  for (const dialer of ["the app with no WebRTC", "the app with WebRTC"] as const) it(`goes live over Iroh when ${dialer} dials, and group frames cross it`, async () => {
    const group = toBase64Url(randomBytes(16));
    let [one, two] = [createIdentity(), createIdentity()];
    const edgeKey = (me: Identity, peer: Identity) => edgeParams(group, me.seed, me.pubKeyZ32, peer.pubKeyZ32);
    // `linux` is the lower edge key (it dials) in the first case, the higher in the second.
    const lower = (a: Identity, b: Identity) => edgeKey(a, b).peerPubKeyZ32 > edgeKey(b, a).peerPubKeyZ32;
    if (lower(one, two) !== (dialer === "the app with no WebRTC")) [one, two] = [two, one];
    const linux = member("linux", group, one, two, { rtc: false, transports: ["iroh/1", "hyperdht/1"] });
    const web = member("web", group, two, one, { rtc: true });
    const took = await untilLive(linux, web, 3 * 60_000);
    console.log(`GROUP_EDGE_NATIVE ${dialer} dials: live in ${took / 1000} s`);
    expect(took).toBeLessThan(90_000);
    expect(liveOn(linux)).toBe("iroh/1");
    expect(liveOn(web)).toBe("iroh/1");
    // The web app heard it has no WebRTC. (The Linux app hears the web app's transports in its packet, or on the session
    // when the web app dialled first.)
    expect(web.heard[0]).not.toContain("webrtc/1");
    for (const said of linux.heard) expect(said).toEqual(expect.arrayContaining(["webrtc/1", "iroh/1"]));
    // Group frames cross the edge both ways.
    linux.link.sendGroupFrame({ t: "group-msg", n: 1 });
    web.link.sendGroupFrame({ t: "group-msg", n: 2 });
    await run(1_000);
    expect(web.frames).toContainEqual({ t: "group-msg", n: 1 });
    expect(linux.frames).toContainEqual({ t: "group-msg", n: 2 });
  }, 120_000);

  // A group link's entry session: the member's side (the host, the lower key by construction) dials, the joiner knocked.
  // An endpoint up within the host's first-packet window (the host publishes after its first look, and by 2 s), or after.
  for (const host of ["the app with no WebRTC", "the app with WebRTC"] as const) for (const endpointAfterMs of [1_000, 3_000]) it(`an entry session goes live over Iroh when ${host} lets the joiner in, endpoints up after ${endpointAfterMs / 1000} s`, async () => {
    const group = `entry/${toBase64Url(randomBytes(16))}`;
    let [one, two] = [createIdentity(), createIdentity()];
    const edgeKey = (me: Identity, peer: Identity) => edgeParams(group, me.seed, me.pubKeyZ32, peer.pubKeyZ32).peerPubKeyZ32;
    // `one` hosts: its link key is the lower.
    if (edgeKey(two, one) > edgeKey(one, two)) [one, two] = [two, one];
    const linuxHosts = host === "the app with no WebRTC";
    // Endpoints take a moment to come up, as Iroh's do in a browser.
    const guest = member("guest", group, two, one, { rtc: linuxHosts, entry: "guest", endpointAfterMs });
    await run(2_000);
    const hostSide = member("host", group, one, two, { rtc: !linuxHosts, entry: "host", endpointAfterMs });
    const took = await untilLive(hostSide, guest, 3 * 60_000);
    console.log(`GROUP_EDGE_NATIVE entry, ${host} hosts, endpoints after ${endpointAfterMs / 1000} s: live in ${took / 1000} s`);
    expect(took).toBeLessThan(90_000);
    expect(liveOn(hostSide)).toBe("iroh/1");
  }, 120_000);

  it("two apps with no WebRTC go live over a native transport too", async () => {
    const group = toBase64Url(randomBytes(16));
    const [one, two] = [createIdentity(), createIdentity()];
    const a = member("a", group, one, two, { rtc: false }), b = member("b", group, two, one, { rtc: false });
    expect(await untilLive(a, b, 3 * 60_000)).toBeLessThan(90_000);
    expect(liveOn(a)).toBe("iroh/1");
  }, 120_000);

  it("two apps with WebRTC go live over it, and neither publishes `_tr`", async () => {
    const group = toBase64Url(randomBytes(16));
    const [one, two] = [createIdentity(), createIdentity()];
    const a = member("a", group, one, two, { rtc: true }), b = member("b", group, two, one, { rtc: true });
    expect(await untilLive(a, b, 3 * 60_000)).toBeLessThan(60_000);
    expect(liveOn(a)).toBe("webrtc/1");
    expect(a.heard).toEqual([]);
    expect(b.heard).toEqual([]);
    expect(published(pkarr, a, b)).toEqual([]);
    expect(published(pkarr, b, a)).toEqual([]);
  }, 120_000);
});

describe("`_tr` in a link's packet", () => {
  const encKey = randomBytes(32);
  const key = createIdentity().pubKeyZ32;
  const iroh = { id: "ab".repeat(32), relay: "https://relay.test./", addresses: ["192.0.2.1:4000"] };

  it("carries the transports and how to dial them, never an address", () => {
    const value = encodePacketTransports(["iroh/1", "hyperdht/1"], { "iroh/1": iroh, "hyperdht/1": { publicKey: "cd".repeat(32) } });
    expect(value).not.toContain("192.0.2.1");
    const built = buildLinkRecords(key, { messages: [], ackTimestamp: 0, services: [{ id: "chat", type: "chat" }], transports: value }, encKey);
    const parsed = parseLinkRecords({ pubKeyZ32: key, timestampMicros: 1n, records: built.records }, encKey);
    expect(parsed.rawRecordNames).toContain(LABEL.tr);
    expect(parsePacketTransports(parsed.transports)).toEqual({ transports: ["iroh/1", "hyperdht/1"],
      descriptors: { "iroh/1": { id: expect.any(String), relay: "https://relay.test./" }, "hyperdht/1": { publicKey: expect.any(String) } } });
  });

  it("is absent from a packet that sets none, which reads as before", () => {
    const built = buildLinkRecords(key, { messages: [], ackTimestamp: 0, services: [{ id: "chat", type: "chat" }] }, encKey);
    expect(built.records.map(r => r.label)).not.toContain(LABEL.tr);
    const parsed = parseLinkRecords({ pubKeyZ32: key, timestampMicros: 1n, records: built.records }, encKey);
    expect(parsed.transports).toBeNull();
    expect(parsed.services).toEqual([{ id: "chat", type: "chat" }]);
  });

  it("refuses what is not one", () => {
    expect(parsePacketTransports(null)).toBeNull();
    expect(parsePacketTransports("not json")).toBeNull();
    expect(parsePacketTransports(JSON.stringify({ t: "iroh/1" }))).toBeNull();
    expect(parsePacketTransports(JSON.stringify({ t: ["iroh/1"], d: { "iroh/1": { id: "short" } } }))).toBeNull();
    // A transport this reader does not know is skipped, not a reason to refuse it.
    expect(parsePacketTransports(JSON.stringify({ t: ["quic/9", "webrtc/1"], d: {} }))).toEqual({ transports: ["webrtc/1"], descriptors: {} });
  });
});
