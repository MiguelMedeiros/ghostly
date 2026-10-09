import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { RELAY_POLL_INTERVALS, TRANSPORTS_GONE_MS } from "../src/link";
import { createIdentity, type Identity } from "../src/identity";
import { edgeParams } from "../src/groupCrypto";
import { randomBytes, toBase64Url } from "../src/bytes";
import { encodePacketTransports, parsePacketTransports } from "../src/capsRecord";
import { buildLinkRecords, LABEL, parseLinkRecords } from "../src/records";
import { fromBase64Url } from "../src/bytes";
import type { PairingState } from "../src/pairedSession";
import type { NativeTransport, PairedTransport, TransportDescriptors } from "../src/pairedTransports";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, rtc, useFakeWorld, yieldToLoop } from "./support/pairingWorld";
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

/**
 * What the engine keeps of an edge from one run of the app to the next (node.ts `StoredLink`): what the member's packet
 * said (`onPacketTransports`), and that this side ran a native endpoint there (its seed, `transportSeeds`).
 */
interface Kept { peerTransports?: PairedTransport[]; peerDescriptors?: TransportDescriptors; peerFallback?: boolean; seeds?: boolean }

interface Member {
  name: string; link: GhostLink; states: PairingState[]; frames: unknown[];
  /** What the member's packet said, each time it said something new. */
  heard: PairedTransport[][];
  /** How many times what the member's packet had said was forgotten (`onPacketTransportsGone`). */
  gone: number;
  kept: Kept;
  /** The WebRTC connections this app made (an offer out, or an answer). */
  rtcMade: number;
  /** The app quits (a goodbye, its endpoints closed), if it has not, and starts again with what it kept; `change`: what differs in that run. */
  restart(change?: Partial<MemberOptions>): Promise<void>;
  quit(): Promise<void>;
}

let pkarr: MemoryPkarr, native: NativeWorld;

interface MemberOptions {
  rtc: boolean; transports?: NativeTransport[]; entry?: "host" | "guest"; endpointAfterMs?: number; offAfterFailure?: boolean;
  /** No native slot is free for this edge (node.ts `GROUP_NATIVE_SLOTS`): it starts no endpoint, whatever it heard. */
  noSlot?: boolean;
  /** An app from before `packetTransportsSaid` (1.1.6): with no endpoint up, it publishes no `_tr`, whatever it said before. */
  neverRetracts?: boolean;
}

function member(name: string, group: string, me: Identity, peer: Identity, options: MemberOptions): Member {
  const states: PairingState[] = [], frames: unknown[] = [], heard: PairedTransport[][] = [];
  const transports = options.transports ?? ["iroh/1"];
  const kept: Kept = {};
  let started = false, rtcOn = options.rtc, runs = 0, quitted = false;
  const startEndpoints = () => {
    if (started || quitted || options.noSlot) return;
    started = true;
    kept.seeds = true;
    for (const transport of transports) result.link.registerEndpoint(native.endpoint(transport, name));
  };
  /** As node.ts `keepsGroupNative`: no WebRTC here, or none on the member's app as its packet said. */
  const keepsNative = () => !rtcOn || (!!kept.peerTransports && !kept.peerTransports.includes("webrtc/1"));
  const startNative = () => {
    const mine = runs;
    if (options.endpointAfterMs) setTimeout(() => { if (mine === runs) startEndpoints(); }, options.endpointAfterMs); else startEndpoints();
  };
  const make = () => new GhostLink({
    params: edgeParams(group, me.seed, me.pubKeyZ32, peer.pubKeyZ32),
    rtcAvailable: rtcOn,
    pairing: { credentials: { seedB64: me.seedB64, peerKey: peer.pubKeyZ32, requireSignedSignals: true, verifiedPeerKey: peer.pubKeyZ32 },
      pinPeer: async key => { if (key !== peer.pubKeyZ32) throw new Error("Not the member this edge belongs to"); }, trustOnFirstUse: false },
    native: { peerDescriptors: kept.peerDescriptors, peerTransports: kept.peerTransports, peerFallback: kept.peerFallback, automatic: true },
    // An entry session opens so (node.ts `startEdge`): one exchange, the member's side publishing after its first look.
    ...(options.entry ? { oneShot: true, firstPublish: options.entry === "host" ? "after-first-poll" as const : "at-start" as const } : {}),
    packetTransports: true,
    packetTransportsSaid: !!kept.seeds && !options.neverRetracts,
    transport: pkarr.transport(),
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    groupsSupport: true,
    createPeerConnection: () => {
      if (!rtcOn) throw new ReferenceError("RTCPeerConnection is not defined");
      result.rtcMade++;
      return fakePeerConnection(name);
    },
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
    events: {
      onPairingState: state => { states.push(state); },
      onGroupFrame: frame => { frames.push(frame); },
      onPacketTransports: (said, descriptors) => {
        heard.push(said);
        Object.assign(kept, { peerTransports: said, peerDescriptors: descriptors, peerFallback: true });
        if (!said.includes("webrtc/1")) setTimeout(startEndpoints, options.endpointAfterMs ?? 0);
      },
      onPacketTransportsGone: () => {
        result.gone++;
        Object.assign(kept, { peerTransports: undefined, peerDescriptors: undefined, peerFallback: undefined });
      },
      // `offAfterFailure`: as the engine does (node.ts `edgeWithoutRtc`), an edge whose WebRTC attempt connected nothing
      // starts again as on an app with no WebRTC, its native endpoints up, for this run of the app.
      onDirectEvidence: evidence => {
        if (!options.offAfterFailure || !rtcOn || evidence === "open" || evidence === "closed") return;
        rtcOn = false;
        const old = result.link;
        void old.stop(false).then(() => {
          result.link = make();
          result.link.start();
          started = false;
          startEndpoints();
        });
      },
    },
  });
  const quit = async () => {
    runs++; quitted = true;
    // Its goodbye is a packet out: time passes while it goes.
    let over = false;
    void result.link.stop().then(() => { over = true; });
    while (!over) await run(250);
  };
  const result: Member = { name, link: make(), states, frames, heard, gone: 0, kept, rtcMade: 0, quit,
    restart: async (change = {}) => {
      if (!quitted) await quit();
      Object.assign(options, change);
      // What an edge whose WebRTC failed did for that run only (`edgeWithoutRtc`) is over: the app has WebRTC again.
      rtcOn = options.rtc;
      started = quitted = false;
      states.length = 0;
      result.link = make();
      result.link.start();
      if (keepsNative()) startNative();
    } };
  result.link.start();
  if (options.entry === "guest") result.link.expectPeer();
  if (keepsNative()) startNative();
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

/** The labels of the packet a member has out now. */
function labels(pkarr: MemoryPkarr, m: Member): string[] {
  const encKey = fromBase64Url((m.link as unknown as { options: { params: { encKeyB64: string } } }).options.params.encKeyB64);
  const packet = (pkarr as unknown as { packets: Map<string, { packet: Parameters<typeof parseLinkRecords>[0] }> }).packets.get(m.link.myPubKeyZ32)?.packet;
  return packet ? parseLinkRecords(packet, encKey).rawRecordNames : [];
}

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

  // Either key order: the side whose attempt failed may be the one that dials, or the one that answered.
  for (const failing of ["the side that dials", "the side that answered"] as const) it(`an edge whose WebRTC failed on ${failing} goes live over Iroh in seconds, not after the other side's attempt runs out`, async () => {
    // Offer and answer meet, and one side's connection fails at once (ICE gave up: a VPN, a firewall). That side starts
    // the edge again with no WebRTC (node.ts `edgeWithoutRtc`), and says so in its packet. The other side still held
    // its attempt, connecting, and took nothing else until it timed out (30 s): a member let in over slow relays reached
    // another 32 to 73 s after its welcome (meshSignals.test.ts on CI, 2026-10-06).
    rtc.blocked = true;
    if (failing === "the side that dials") rtc.blockedFailsAfterMs = 0; else rtc.answerFailsAfterMs = 0;
    const group = toBase64Url(randomBytes(16));
    let [one, two] = [createIdentity(), createIdentity()];
    const edgeKey = (me: Identity, peer: Identity) => edgeParams(group, me.seed, me.pubKeyZ32, peer.pubKeyZ32).peerPubKeyZ32;
    // `one` dials: its link key is the lower.
    if (edgeKey(two, one) > edgeKey(one, two)) [one, two] = [two, one];
    const dials = member("dials", group, one, two, { rtc: true, offAfterFailure: true });
    const answers = member("answers", group, two, one, { rtc: true, offAfterFailure: true });
    const took = await untilLive(dials, answers, 3 * 60_000);
    console.log(`GROUP_EDGE_NATIVE WebRTC failed on ${failing}: live in ${took / 1000} s`);
    expect(took).toBeLessThan(15_000);
    expect(liveOn(dials)).toBe("iroh/1");
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

/**
 * A member whose edge went native once (its WebRTC connected nothing, `edgeWithoutRtc`) said `_tr = ["iroh/1"]`, and the
 * other member's app kept that. In its next run that member has WebRTC again and runs no native endpoint: it published
 * no `_tr` at all, and the other app, which acts only on a `_tr` that is there, went on ranking its transports against
 * the kept `["iroh/1"]`: an Iroh endpoint nobody listens on, or nothing in common at all ("No transport both apps allow
 * is available yet"). Neither side's restart changed it (a private group of six, "0 of 5 reachable", 2026-10-09).
 */
describe("a member whose edge went native once, back with WebRTC", () => {
  /** The edge as it was left: live over Iroh for that run, `reader` keeping `["iroh/1"]`; both apps quit, WebRTC connects again. */
  async function wentNativeOnce(dials: "the member back" | "the reader", options: { back?: Partial<MemberOptions>; reader?: Partial<MemberOptions> } = {}) {
    // The attempt that fails is the member's own: its offer's, or its answer's.
    rtc.blocked = true;
    if (dials === "the member back") rtc.blockedFailsAfterMs = 0; else rtc.answerFailsAfterMs = 0;
    const group = toBase64Url(randomBytes(16));
    let [one, two] = [createIdentity(), createIdentity()];
    const edgeKey = (me: Identity, peer: Identity) => edgeParams(group, me.seed, me.pubKeyZ32, peer.pubKeyZ32).peerPubKeyZ32;
    // `one` dials: its link key is the lower.
    if (edgeKey(two, one) > edgeKey(one, two)) [one, two] = [two, one];
    const [b, r] = dials === "the member back" ? [one, two] : [two, one];
    const back = member("back", group, b, r, { rtc: true, offAfterFailure: true, ...options.back });
    const reader = member("reader", group, r, b, { rtc: true, ...options.reader });
    expect(await untilLive(back, reader, 60_000)).toBeLessThan(60_000);
    expect(liveOn(reader)).toBe("iroh/1");
    expect(reader.kept.peerTransports).toEqual(["iroh/1"]);
    await back.quit(); await reader.quit();
    rtc.blocked = false; rtc.blockedFailsAfterMs = undefined; rtc.answerFailsAfterMs = undefined;
    return { back, reader };
  }
  const said = (m: Member, peer: Member) => published(pkarr, m, peer).map(value => parsePacketTransports(value));

  // Either key order, and a reader with its Iroh endpoint up (it dials one nobody listens on) or with none (no slot
  // free: it has nothing in common with the kept list). The reader is told nothing new: it overwrites what it kept on a
  // `_tr` that is there, as the released apps do (1.1.5, 1.1.6), and never needs the rule below.
  for (const dials of ["the member back", "the reader"] as const) for (const slot of ["an Iroh endpoint", "no native slot"] as const)
    it(`it says \`["webrtc/1"]\`, and a reader with ${slot} that only overwrites on a \`_tr\` goes live over WebRTC (${dials} dials)`, async () => {
      const { back, reader } = await wentNativeOnce(dials);
      // The reader's app starts first, with what it kept; then the member's, with WebRTC and no endpoint.
      await reader.restart({ noSlot: slot === "no native slot" });
      await run(5_000);
      await back.restart();
      const took = await untilLive(back, reader, TRANSPORTS_GONE_MS - 30_000);
      console.log(`GROUP_EDGE_NATIVE back with WebRTC, ${dials} dials, reader with ${slot}: live in ${took / 1000} s`);
      expect(took).toBeLessThan(TRANSPORTS_GONE_MS - 30_000);
      expect(liveOn(back)).toBe("webrtc/1");
      expect(liveOn(reader)).toBe("webrtc/1");
      // What it runs now, and no way to dial anything: it runs no endpoint.
      expect(said(back, reader)).toEqual([{ transports: ["webrtc/1"], descriptors: {} }]);
      expect(reader.heard.at(-1)).toEqual(["webrtc/1"]);
      expect(reader.kept.peerTransports).toEqual(["webrtc/1"]);
      expect(reader.gone).toBe(0);
    }, 120_000);

  // The member's app is from before it said so (1.1.6): it publishes no `_tr`. The reader stays as the bug left it for
  // `TRANSPORTS_GONE_MS`, then forgets the kept list on the member's packet that advertises with no `_tr`.
  for (const slot of ["an Iroh endpoint", "no native slot"] as const)
    it(`a reader with ${slot} forgets the kept list once the member's packet has said no \`_tr\` for two minutes, and offers WebRTC`, async () => {
      const { back, reader } = await wentNativeOnce("the reader", { back: { neverRetracts: true } });
      await reader.restart({ noSlot: slot === "no native slot" });
      await run(5_000);
      await back.restart();
      expect(said(back, reader)).toEqual([]);
      // As it was: the reader's turn to dial, and nothing it can dial.
      expect(await untilLive(back, reader, TRANSPORTS_GONE_MS - 10_000)).toBe(Infinity);
      expect(reader.gone).toBe(0);
      expect(reader.kept.peerTransports).toEqual(["iroh/1"]);
      const took = await untilLive(back, reader, 3 * 60_000);
      console.log(`GROUP_EDGE_NATIVE member back publishes no \`_tr\`, reader with ${slot}: live ${took / 1000} s after two minutes`);
      expect(took).toBeLessThan(3 * 60_000);
      expect(reader.gone).toBe(1);
      expect(reader.kept.peerTransports).toBeUndefined();
      expect(reader.kept.peerDescriptors).toBeUndefined();
      expect(liveOn(reader)).toBe("webrtc/1");
      // Started again, it is an edge between two apps with WebRTC, as it was before that network.
      await reader.restart();
      expect(await untilLive(back, reader, 3 * 60_000)).toBeLessThan(3 * 60_000);
      expect(liveOn(reader)).toBe("webrtc/1");
    }, 120_000);

  it("an app with no WebRTC that starts again keeps what its member kept of it: nothing is forgotten before its endpoint is up, nor while it waits for a slot less than two minutes", async () => {
    const group = toBase64Url(randomBytes(16));
    const [one, two] = [createIdentity(), createIdentity()];
    // Its endpoints take ten seconds to come up, each run (a HyperDHT with its DHT out of reach, a browser's Iroh relay).
    const linux = member("linux", group, one, two, { rtc: false, endpointAfterMs: 10_000 });
    const web = member("web", group, two, one, { rtc: true });
    expect(await untilLive(linux, web, 3 * 60_000)).toBeLessThan(90_000);
    expect(web.kept.peerTransports).toEqual(["iroh/1"]);
    const offered = web.rtcMade;
    for (const endpointAfterMs of [10_000, TRANSPORTS_GONE_MS - 30_000]) {
      await linux.restart({ endpointAfterMs });
      // Its first packets of this run advertise and carry no `_tr`: nothing is up yet.
      await run(Math.min(endpointAfterMs - 2_000, 8_000));
      expect(said(linux, web)).toEqual([]);
      const took = await untilLive(linux, web, 4 * 60_000);
      console.log(`GROUP_EDGE_NATIVE app with no WebRTC back, endpoint after ${endpointAfterMs / 1000} s: live in ${took / 1000} s`);
      expect(took).toBeLessThan(4 * 60_000);
      expect(liveOn(web)).toBe("iroh/1");
      expect(web.gone).toBe(0);
      expect(web.kept.peerTransports).toEqual(["iroh/1"]);
      // It was offered no WebRTC meanwhile.
      expect(web.rtcMade).toBe(offered);
    }
  }, 120_000);

  it("an edge between two apps with WebRTC that never left it publishes no `_tr`, across restarts too: its packet is byte for byte what it was", async () => {
    const group = toBase64Url(randomBytes(16));
    const [one, two] = [createIdentity(), createIdentity()];
    const a = member("a", group, one, two, { rtc: true }), b = member("b", group, two, one, { rtc: true });
    expect(await untilLive(a, b, 3 * 60_000)).toBeLessThan(60_000);
    await a.restart(); await b.restart();
    expect(await untilLive(a, b, 3 * 60_000)).toBeLessThan(60_000);
    // Long enough for a reader to decide a `_tr` is gone: there was none to forget.
    await run(TRANSPORTS_GONE_MS + 60_000);
    expect(liveOn(a)).toBe("webrtc/1");
    for (const [m, peer] of [[a, b], [b, a]] as const) {
      expect(m.heard).toEqual([]);
      expect(m.gone).toBe(0);
      expect(m.kept).toEqual({});
      expect(published(pkarr, m, peer)).toEqual([]);
      expect(labels(pkarr, m)).not.toContain(LABEL.tr);
    }
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
