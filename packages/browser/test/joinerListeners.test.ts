import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { createIdentity, type NativeEndpoint, type NativeTransport } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
// covers: transport.native-pool

/**
 * A chat this side joined from a `ghostly1` invite keeps native listeners while it is still pairing, whether or not it
 * is on screen: the joiner dials, and an app with no WebRTC (the Linux Desktop) had nothing else to offer, so a person
 * who went back to the chat list right after joining waited out the connect (90 s) before the chat went live. An invite
 * of this side's that nobody used yet still keeps none.
 */
it("a joined chat still pairing has native listeners off screen; an unused invite has none", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  const base = () => ({ profile: "paired-chat/1" as const, createdAt: 1, seedB64: createIdentity().seedB64, encKeyB64: createIdentity().seedB64,
    participationSeed: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32 });
  await db.putLink({ id: "joined", ...base(), peerParticipationKeyZ32: createIdentity().pubKeyZ32 });
  await db.putLink({ id: "invite", ...base(), inviteCode: "ghostly1-unused" });
  vi.stubGlobal("RTCPeerConnection", vi.fn(() => { throw new Error("No dial expected"); }));
  const factory = (transport: NativeTransport) => async (seed: string): Promise<NativeEndpoint> =>
    ({ transport, descriptor: { seed }, close: vi.fn(async () => {}), connect: vi.fn(), onConnection: null, onDescriptor: null });
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, {
    transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) },
    automaticWallets: false,
    nativeTransports: { "iroh/1": factory("iroh/1"), "hyperdht/1": factory("hyperdht/1") },
  });
  const row = (id: string) => node.getState().links.find((l) => l.id === id)!;
  try {
    await node.start();
    await vi.waitFor(() => expect(row("joined").availableTransports).toEqual(expect.arrayContaining(["iroh/1", "hyperdht/1"])));
    expect(row("invite").availableTransports).toEqual(["webrtc/1"]);
  } finally {
    await node.shutdown();
    for (const id of ["joined", "invite"]) await db.deleteLink(id);
    vi.unstubAllGlobals();
  }
});

/**
 * An invite of this side's from before the app started has no listener; once someone joins it, the chat is a contact's
 * and takes them at once, as at start. Neither app with WebRTC (two Linux Desktops): the joiner's dials found nothing
 * to land on, and the chat stayed on the DHT until someone wrote in it or opened it.
 */
it("an invite made before the app started takes native listeners when its joiner is pinned", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink({ id: "restarted-invite", profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64, encKeyB64: createIdentity().seedB64,
    participationSeed: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, inviteCode: "ghostly1-unused" });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const factory = (transport: NativeTransport) => async (seed: string): Promise<NativeEndpoint> =>
    ({ transport, descriptor: { seed }, close: vi.fn(async () => {}), connect: vi.fn(), onConnection: null, onDescriptor: null });
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, {
    transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) },
    automaticWallets: false,
    nativeTransports: { "iroh/1": factory("iroh/1"), "hyperdht/1": factory("hyperdht/1") },
  });
  const row = () => node.getState().links.find((l) => l.id === "restarted-invite")!;
  try {
    await node.start();
    expect(row().availableTransports).toEqual([]);
    const pairing = (node as unknown as { links: Map<string, { link: { options: { pairing: { pinPeer(key: string, signed: boolean): Promise<void> } } } }> })
      .links.get("restarted-invite")!.link.options.pairing;
    await pairing.pinPeer(createIdentity().pubKeyZ32, true);
    await vi.waitFor(() => expect(row().availableTransports).toEqual(expect.arrayContaining(["iroh/1", "hyperdht/1"])));
  } finally {
    await node.shutdown();
    await db.deleteLink("restarted-invite");
    vi.unstubAllGlobals();
  }
});
