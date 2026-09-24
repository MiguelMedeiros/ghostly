import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { GhostLink, createIdentity, type NativeEndpoint, type NativeTransport } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
// covers: transport.native-pool

it("bounds native listeners, restores saved identities and never evicts a busy endpoint", async () => {
  await db.putSettings({ online:true, nick:"", relays:[], iceServers:[], mints:[], mintsInitialized:true });
  const ids = Array.from({length:11}, (_, i) => `pool-${i}`);
  for (const [i, id] of ids.entries()) await db.putLink({id, profile:"paired-chat/1", createdAt:i,
    seedB64:createIdentity().seedB64, encKeyB64:createIdentity().seedB64, participationSeed:createIdentity().seedB64,
    peerPubKeyZ32:createIdentity().pubKeyZ32, pairedPeerKey: i < 9 ? createIdentity().pubKeyZ32 : undefined});
  vi.stubGlobal("RTCPeerConnection", vi.fn(() => {throw new Error("No dial expected");}));
  const counts = {"iroh/1":0,"hyperdht/1":0}, peaks = {...counts};
  const created: {transport:NativeTransport; seed:string; close:ReturnType<typeof vi.fn>}[] = [];
  const factory = (transport:NativeTransport) => async (seed:string):Promise<NativeEndpoint> => {
    if (++counts[transport] > 8) throw new Error("native capacity exceeded");
    peaks[transport] = Math.max(peaks[transport],counts[transport]);
    const close = vi.fn(async () => {counts[transport]--;}); created.push({transport,seed,close});
    return {transport,descriptor:{seed},close,connect:vi.fn(),onConnection:null,onDescriptor:null};
  };
  const node = new GhostlyNode({onState:vi.fn(),onMessages:vi.fn(),onCallSignal:vi.fn()}, {
    transport:{publish:async()=>{},resolve:async()=>null,describe:()=>({protocol:"fixture",relays:[]})},
    automaticWallets:false,
    nativeTransports:{"iroh/1":factory("iroh/1"),"hyperdht/1":factory("hyperdht/1")},
  });
  const row = (id:string) => node.getState().links.find(l=>l.id===id)!;
  try {
    await node.start();
    await vi.waitFor(()=>expect(row(ids[8]).transportErrors?.["iroh/1"]).toContain("eight"));
    expect(counts).toEqual({"iroh/1":8,"hyperdht/1":8});
    expect(row(ids[9]).availableTransports).toEqual(["webrtc/1"]);
    expect(row(ids[10]).availableTransports).toEqual(["webrtc/1"]);
    const original = (await db.getLinks()).find(l => l.id === ids[0]);
    node.setActiveLink({linkId:ids[8]});
    await vi.waitFor(()=>expect(row(ids[8]).availableTransports).toHaveLength(3));
    expect(row(ids[0]).availableTransports).toEqual(["webrtc/1"]);
    node.setActiveLink({linkId:ids[0]});
    await vi.waitFor(()=>expect(row(ids[0]).availableTransports).toHaveLength(3));
    expect(((await db.getLinks()).find(l => l.id === ids[0]))?.transportSeeds).toEqual(original?.transportSeeds);
    expect(created.filter(e => e.seed === original?.transportSeeds?.["iroh/1"])).toHaveLength(2);
    const busy = vi.spyOn(GhostLink.prototype,"canReleaseEndpoint").mockReturnValue(false);
    const closes = created.reduce((n,e)=>n+e.close.mock.calls.length,0);
    node.setActiveLink({linkId:ids[9]});
    await vi.waitFor(()=>expect(row(ids[9]).transportErrors?.["hyperdht/1"]).toContain("Disconnect"));
    expect(created.reduce((n,e)=>n+e.close.mock.calls.length,0)).toBe(closes);
    busy.mockRestore();
    node.setActiveLink({linkId:ids[9]});
    await vi.waitFor(()=>expect(row(ids[9]).availableTransports).toHaveLength(3));
    expect(row(ids[9]).transportErrors).toEqual({});
    expect(peaks).toEqual({"iroh/1":8,"hyperdht/1":8});
    expect((await db.getLinks()).filter(l => ids.includes(l.id))).toHaveLength(11);
  } finally {
    vi.restoreAllMocks(); await node.shutdown();
    expect(counts).toEqual({"iroh/1":0,"hyperdht/1":0});
    for (const id of ids) await db.deleteLink(id);
    vi.unstubAllGlobals();
  }
});
