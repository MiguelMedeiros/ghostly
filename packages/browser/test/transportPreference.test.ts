import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { createIdentity, type NativeEndpoint, type NativeTransport, type PairedTransport } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import type { StoredLink } from "../src/shared/types";
// covers: transport.preference

it.each([[false, "missing"], [false, "failed"], [false, "pending"], [true, "missing"], [true, "failed"]] as const)("saves preferences without a remote handshake (paired: %s, discovery: %s)", async (paired, discovery) => {
  const row: StoredLink = { id: `preference-${paired}`, profile: "paired-chat/1", createdAt: 1,
    seedB64: createIdentity().seedB64, encKeyB64: createIdentity().seedB64,
    participationSeed: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32,
    pairedPeerKey: paired ? createIdentity().pubKeyZ32 : undefined };
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink(row);
  const rtc = vi.fn(function () { throw new Error("No handshake should start"); });
  vi.stubGlobal("RTCPeerConnection", rtc);
  const dial = vi.fn(async () => { throw new Error("No native dial should start"); });
  const endpoint = (transport: NativeTransport): NativeEndpoint => ({ transport, descriptor: {}, connect: dial,
    close: async () => {}, onConnection: null, onDescriptor: null });
  let release!: () => void;
  const publication = new Promise<void>(resolve => { release = resolve; });
  const transport = { publish: vi.fn(async () => {
    if (discovery === "failed") throw new Error("discovery publication unavailable");
    if (discovery === "pending") await publication;
  }),
    resolve: vi.fn(async () => null), describe: () => ({ protocol: "local fixture", relays: [] }) };
  const options = { transport, automaticWallets: false, nativeTransports: { "iroh/1": async () => endpoint("iroh/1"), "hyperdht/1": async () => endpoint("hyperdht/1") } };
  const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() };
  let node = new GhostlyNode(events, options);
  const current = () => node.getState().links.find(l => l.id === row.id)!;
  try {
    await node.start();
    node.setActiveLink({ linkId: row.id });
    await vi.waitFor(() => expect(current().availableTransports).toHaveLength(3));
    if (discovery === "failed") await vi.waitFor(() => expect(current().discoveryError).toContain("discovery publication unavailable"));
    // A chosen transport first: on an Automatic chat, Iroh with Fallback off is what the Fallback switch sends (it stays
    // Automatic, ghostly#6125), and this test is about saving choices without a handshake.
    await node.setChatTransport({ linkId: row.id, transport: "hyperdht/1" });
    for (const preferred of ["iroh/1", "hyperdht/1", "webrtc/1"] as PairedTransport[]) {
      for (const fallback of [false, true]) {
        await node.setTransportPreference({ linkId: row.id, preferred, fallback });
        expect(current().preferredTransport).toBe(preferred);
        expect(current().transportFallback).toBe(fallback);
        if (discovery === "failed") expect(current().discoveryError).toContain("Could not publish discovery");
        else expect(current().discoveryError).toBeUndefined();
        expect(current().pairing?.status).not.toBe("error");
      }
    }
    await Promise.all([
      node.setTransportPreference({ linkId: row.id, preferred: "iroh/1", fallback: false }),
      node.setTransportPreference({ linkId: row.id, preferred: "hyperdht/1", fallback: true }),
    ]);
    expect(current().preferredTransport).toBe("hyperdht/1");
    expect(rtc).not.toHaveBeenCalled(); expect(dial).not.toHaveBeenCalled();
    release();
    await node.shutdown();
    node = new GhostlyNode(events, options);
    await node.start();
    node.setActiveLink({ linkId: row.id });
    await vi.waitFor(() => expect(current().availableTransports).toHaveLength(3));
    expect(current().preferredTransport).toBe("hyperdht/1");
    expect(current().transportFallback).toBe(true);
    expect(current().peerParticipationKey).toBe(row.pairedPeerKey);
    expect(current().peerVerified).toBe(paired);
    expect(rtc).not.toHaveBeenCalled(); expect(dial).not.toHaveBeenCalled();
  } finally { release(); await node.shutdown(); await db.deleteLink(row.id); vi.unstubAllGlobals(); }
}, 3000);

it("on an app with no WebRTC, DHT only releases the native transports, still names them, and Automatic brings them back", async () => {
  const row: StoredLink = { id: "dht-only-way-back", profile: "paired-chat/1", createdAt: 1,
    seedB64: createIdentity().seedB64, encKeyB64: createIdentity().seedB64,
    participationSeed: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, pairedPeerKey: createIdentity().pubKeyZ32 };
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink(row);
  // The Linux Desktop: WebKitGTK has no WebRTC, only the host's native transports.
  vi.stubGlobal("RTCPeerConnection", undefined);
  const endpoint = (transport: NativeTransport): NativeEndpoint => ({ transport, descriptor: {}, connect: async () => { throw new Error("offline"); },
    close: async () => {}, onConnection: null, onDescriptor: null });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "local fixture", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() },
    { transport, automaticWallets: false, nativeTransports: { "iroh/1": async () => endpoint("iroh/1"), "hyperdht/1": async () => endpoint("hyperdht/1") } });
  const current = () => node.getState().links.find(l => l.id === row.id)!;
  try {
    await node.start();
    node.setActiveLink({ linkId: row.id });
    await vi.waitFor(() => expect(current().availableTransports).toEqual(["iroh/1", "hyperdht/1"]));
    await node.setChatTransport({ linkId: row.id, transport: "dht" });
    expect(current().deliveryMode).toBe("dht");
    await vi.waitFor(() => expect(current().availableTransports).toEqual([]));
    // What the chat's menu offers to leave DHT only by.
    expect(current().runnableTransports).toEqual(["iroh/1", "hyperdht/1"]);
    await node.setChatTransport({ linkId: row.id, transport: "auto" });
    expect(current().deliveryMode).toBe("stream");
    await vi.waitFor(() => expect(current().availableTransports).toEqual(["iroh/1", "hyperdht/1"]));
  } finally { await node.shutdown(); await db.deleteLink(row.id); vi.unstubAllGlobals(); }
}, 5000);

it("leaving DHT only answers before the native listeners are up; a choice out of it still waits for them", async () => {
  const row: StoredLink = { id: "dht-only-answers-first", profile: "paired-chat/1", createdAt: 1,
    seedB64: createIdentity().seedB64, encKeyB64: createIdentity().seedB64,
    participationSeed: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, pairedPeerKey: createIdentity().pubKeyZ32 };
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink(row);
  vi.stubGlobal("RTCPeerConnection", undefined);
  const endpoint = (transport: NativeTransport): NativeEndpoint => ({ transport, descriptor: {}, connect: async () => { throw new Error("offline"); },
    close: async () => {}, onConnection: null, onDescriptor: null });
  // The first listener starts at once; after DHT only, each waits until `up` (Iroh's relay or the HyperDHT out of reach).
  let starts = 0, up!: () => void;
  const reachable = new Promise<void>(resolve => { up = resolve; });
  const slow = (transport: NativeTransport) => async () => { if (starts++ >= 2) await reachable; return endpoint(transport); };
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "local fixture", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() },
    { transport, automaticWallets: false, nativeTransports: { "iroh/1": slow("iroh/1"), "hyperdht/1": slow("hyperdht/1") } });
  const current = () => node.getState().links.find(l => l.id === row.id)!;
  const settled = async (step: Promise<void>) => { let done = false; void step.then(() => { done = true; }); await new Promise(r => setTimeout(r, 50)); return done; };
  try {
    await node.start();
    node.setActiveLink({ linkId: row.id });
    await vi.waitFor(() => expect(current().availableTransports).toEqual(["iroh/1", "hyperdht/1"]));
    await node.setDeliveryMode({ linkId: row.id, mode: "dht" });
    await vi.waitFor(() => expect(current().availableTransports).toEqual([]));
    // `chat disconnect --hold 0`: back on a live link at once, the listeners still starting.
    expect(await settled(node.setDeliveryMode({ linkId: row.id, mode: "stream" }))).toBe(true);
    expect(current().deliveryMode).toBe("stream");
    expect(current().availableTransports).toEqual([]);
    await node.setDeliveryMode({ linkId: row.id, mode: "dht" });
    // A transport chosen out of DHT only needs its listener: that one waits, as before.
    const chosen = node.setChatTransport({ linkId: row.id, transport: "iroh/1" });
    expect(await settled(chosen)).toBe(false);
    up();
    await chosen;
    expect(current().preferredTransport).toBe("iroh/1");
    await vi.waitFor(() => expect(current().availableTransports).toEqual(["iroh/1", "hyperdht/1"]));
  } finally { up(); await node.shutdown(); await db.deleteLink(row.id); vi.unstubAllGlobals(); }
}, 5000);

it.each(["webrtc/1", "auto"] as const)("on an app with WebRTC, %s chosen out of DHT only answers before the native listeners are up", async choice => {
  const row: StoredLink = { id: `dht-only-left-for-${choice}`, profile: "paired-chat/1", createdAt: 1,
    seedB64: createIdentity().seedB64, encKeyB64: createIdentity().seedB64,
    participationSeed: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, pairedPeerKey: createIdentity().pubKeyZ32 };
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink(row);
  vi.stubGlobal("RTCPeerConnection", vi.fn(function () { throw new Error("No handshake in this test"); }));
  const endpoint = (transport: NativeTransport): NativeEndpoint => ({ transport, descriptor: {}, connect: async () => { throw new Error("offline"); },
    close: async () => {}, onConnection: null, onDescriptor: null });
  // After DHT only, each listener waits until `up`: Iroh's relay out of reach kept the web's Connection panel greyed out
  // 24 to 44 s after WebRTC was chosen, the chat live again in a second (bug hunt, 2026-11-08).
  let starts = 0, up!: () => void;
  const reachable = new Promise<void>(resolve => { up = resolve; });
  const slow = (transport: NativeTransport) => async () => { if (starts++ >= 2) await reachable; return endpoint(transport); };
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "local fixture", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() },
    { transport, automaticWallets: false, nativeTransports: { "iroh/1": slow("iroh/1"), "hyperdht/1": slow("hyperdht/1") } });
  const current = () => node.getState().links.find(l => l.id === row.id)!;
  const settled = async (step: Promise<void>) => { let done = false; void step.then(() => { done = true; }); await new Promise(r => setTimeout(r, 50)); return done; };
  try {
    await node.start();
    node.setActiveLink({ linkId: row.id });
    await vi.waitFor(() => expect(current().availableTransports).toEqual(["webrtc/1", "iroh/1", "hyperdht/1"]));
    await node.setChatTransport({ linkId: row.id, transport: "dht" });
    await vi.waitFor(() => expect(current().availableTransports).toEqual(["webrtc/1"]));
    expect(await settled(node.setChatTransport({ linkId: row.id, transport: choice }))).toBe(true);
    expect(current().deliveryMode).toBe("stream");
    // Automatic shows as the transport it picks, WebRTC here.
    expect(current().preferredTransport).toBe("webrtc/1");
    up();
    await vi.waitFor(() => expect(current().availableTransports).toEqual(["webrtc/1", "iroh/1", "hyperdht/1"]));
  } finally { up(); await node.shutdown(); await db.deleteLink(row.id); vi.unstubAllGlobals(); }
}, 5000);

/**
 * An app with WebRTC on DHT only, Iroh's relay out of reach: after DHT only, Iroh's listener starts only at `irohUp`
 * (never, unless the test says so), HyperDHT's at `hyperUp` when `heldHyperdht`. What `chat show` reads and what the
 * store keeps for the next start.
 */
async function leftDhtOnly(id: string, heldHyperdht: boolean) {
  const row: StoredLink = { id, profile: "paired-chat/1", createdAt: 1,
    seedB64: createIdentity().seedB64, encKeyB64: createIdentity().seedB64,
    participationSeed: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, pairedPeerKey: createIdentity().pubKeyZ32 };
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink(row);
  vi.stubGlobal("RTCPeerConnection", vi.fn(function () { throw new Error("No handshake in this test"); }));
  const endpoint = (transport: NativeTransport): NativeEndpoint => ({ transport, descriptor: {}, connect: async () => { throw new Error("offline"); },
    close: async () => {}, onConnection: null, onDescriptor: null });
  let irohUp!: () => void, hyperUp!: () => void, dhtOnly = false;
  const irohReachable = new Promise<void>(resolve => { irohUp = resolve; });
  const hyperReachable = new Promise<void>(resolve => { hyperUp = resolve; });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "local fixture", relays: [] }) };
  const options = { transport, automaticWallets: false, nativeTransports: {
    "iroh/1": async () => { if (dhtOnly) await irohReachable; return endpoint("iroh/1"); },
    "hyperdht/1": async () => { if (dhtOnly && heldHyperdht) await hyperReachable; return endpoint("hyperdht/1"); },
  } };
  const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() };
  const s = { row, node: new GhostlyNode(events, options), irohUp, hyperUp,
    current: () => s.node.getState().links.find(l => l.id === row.id)!,
    stored: async () => (await db.getLinks()).find(l => l.id === row.id)!,
    /** Whether `step` has answered within 50 ms. */
    settled: async (step: Promise<void>) => { let done = false; void step.then(() => { done = true; }, () => {}); await new Promise(r => setTimeout(r, 50)); return done; },
    restart: async () => { await s.node.shutdown(); s.node = new GhostlyNode(events, options); await s.node.start(); s.node.setActiveLink({ linkId: row.id }); },
    end: async () => { irohUp(); hyperUp(); await s.node.shutdown(); await db.deleteLink(row.id); vi.unstubAllGlobals(); } };
  await s.node.start();
  s.node.setActiveLink({ linkId: row.id });
  await vi.waitFor(() => expect(s.current().availableTransports).toEqual(["webrtc/1", "iroh/1", "hyperdht/1"]));
  await s.node.setChatTransport({ linkId: row.id, transport: "dht" });
  await vi.waitFor(() => expect(s.current().availableTransports).toEqual(["webrtc/1"]));
  dhtOnly = true;
  return s;
}

it("HyperDHT chosen out of DHT only answers once its own listener is up, not after Iroh's", async () => {
  const s = await leftDhtOnly("dht-only-left-for-hyperdht", false);
  try {
    // Iroh's listener never comes up here: the choice answered only once it gave up, 10 s with its relay out of reach
    // (bug hunt, 2026-11-17), the chat live on the HyperDHT at 2 s.
    expect(await s.settled(s.node.setChatTransport({ linkId: s.row.id, transport: "hyperdht/1" }))).toBe(true);
    expect(s.current().deliveryMode).toBe("stream");
    expect(s.current().preferredTransport).toBe("hyperdht/1");
    expect(s.current().transportAutomatic).toBe(false);
    expect(s.current().availableTransports).toEqual(["webrtc/1", "hyperdht/1"]);
  } finally { await s.end(); }
}, 5000);

it.each(["auto", "webrtc/1"] as const)("%s chosen while HyperDHT's listener is still starting out of DHT only is the choice kept", async later => {
  const s = await leftDhtOnly(`dht-only-hyperdht-then-${later}`, true);
  try {
    const first = s.node.setChatTransport({ linkId: s.row.id, transport: "hyperdht/1" });
    expect(await s.settled(first)).toBe(false);
    await s.node.setChatTransport({ linkId: s.row.id, transport: later });
    const kept = () => {
      expect(s.current().deliveryMode).toBe("stream");
      expect(s.current().transportAutomatic).toBe(later === "auto");
      // Automatic shows as the transport it picks: WebRTC, then Iroh once its listener is up; never the HyperDHT here.
      if (later === "auto") expect(s.current().preferredTransport).not.toBe("hyperdht/1");
      else expect(s.current().preferredTransport).toBe("webrtc/1");
    };
    kept();
    // The listeners come up: the earlier choice answers, and leaves the chat as the later one did.
    s.hyperUp(); s.irohUp();
    await first;
    kept();
    await vi.waitFor(() => expect([...s.current().availableTransports].sort()).toEqual(["hyperdht/1", "iroh/1", "webrtc/1"]));
    kept();
    expect((await s.stored()).preferredTransport).toBe(later === "auto" ? undefined : "webrtc/1");
    await s.restart();
    await vi.waitFor(() => expect(s.current().availableTransports).toEqual(["webrtc/1", "iroh/1", "hyperdht/1"]));
    kept();
  } finally { await s.end(); }
}, 5000);

it("DHT only chosen while HyperDHT's listener is still starting stays, and the earlier choice says it did not apply", async () => {
  const s = await leftDhtOnly("dht-only-hyperdht-then-dht", true);
  try {
    const first = s.node.setChatTransport({ linkId: s.row.id, transport: "hyperdht/1" });
    expect(await s.settled(first)).toBe(false);
    await s.node.setChatTransport({ linkId: s.row.id, transport: "dht" });
    s.hyperUp(); s.irohUp();
    // As before: the CLI then keeps a hold made meanwhile (`chat disconnect --hold`), which only a choice that applied ends.
    await expect(first).rejects.toThrow("Transport unavailable");
    expect(s.current().deliveryMode).toBe("dht");
    await new Promise(r => setTimeout(r, 50));
    expect(s.current().availableTransports).toEqual(["webrtc/1"]);
    expect((await s.stored()).deliveryMode).toBe("dht");
  } finally { await s.end(); }
}, 5000);
