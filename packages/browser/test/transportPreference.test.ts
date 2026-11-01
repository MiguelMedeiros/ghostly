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
