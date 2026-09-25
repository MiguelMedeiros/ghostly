import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { GhostLink, createIdentity, createLink, identityFromSeedB64, type PairingState } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import type { LinkView } from "../src/shared/types";
import { FakeNativeNet } from "./helpers/fakeNative";
// covers: transport.timeline, transport.chat-switch, transport.preference

/**
 * The engine's side of the chat's connection story: a real node (the app) and its contact's link over stand-ins for
 * Iroh and HyperDHT. Each change the node lives through becomes a line in the chat's transport log, with who and
 * why; none of them is a message.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function setup() {
  const net = new FakeNativeNet();
  const invitation = createLink();
  const [mine, theirs] = [createIdentity().seedB64, createIdentity().seedB64];
  const id = `timeline-${crypto.randomUUID()}`;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink({ ...invitation.mine, id, profile: "paired-chat/1", participationSeed: mine, createdAt: 1,
    pairedPeerKey: identityFromSeedB64(theirs).pubKeyZ32,
    peerTransports: ["iroh/1", "hyperdht/1"], peerFallback: true, preferredTransport: "iroh/1", transportFallback: true,
    peerDescriptors: { "iroh/1": { id: "contact:iroh/1" }, "hyperdht/1": { id: "contact:hyperdht/1" } } });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false,
    nativeTransports: { "iroh/1": async () => net.endpoint("iroh/1", "app"), "hyperdht/1": async () => net.endpoint("hyperdht/1", "app") } });
  let contactState: PairingState = { status: "connecting" };
  const contact = new GhostLink({
    params: { ...invitation.invite, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: theirs, peerKey: identityFromSeedB64(mine).pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true, peerTransports: ["iroh/1", "hyperdht/1"], peerFallback: true,
      peerDescriptors: { "iroh/1": { id: "app:iroh/1" }, "hyperdht/1": { id: "app:hyperdht/1" } } },
    transport, createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    events: { onPairingState: state => { contactState = state; } },
  });
  contact.registerEndpoint(net.endpoint("iroh/1", "contact"));
  contact.registerEndpoint(net.endpoint("hyperdht/1", "contact"));
  cleanup.push(async () => { await contact.stop(false); await node.shutdown(); await db.deleteLink(id); });
  await node.start();
  node.setActiveLink({ linkId: id });
  const view = () => node.getState().links.find(l => l.id === id)!;
  await vi.waitFor(() => expect(view().availableTransports).toHaveLength(2));
  void contact.connect(5_000).catch(() => {});
  await vi.waitFor(() => expect([view().pairing?.status, view().pairing?.transport, contactState.transport]).toEqual(["ready", "iroh/1", "iroh/1"]));
  return { net, node, contact, id, view, contactState: () => contactState };
}

const lines = (view: LinkView) => (view.transportLog ?? []).map(e => [e.kind, e.cause ?? null, e.transport ?? null]);

it("tells the chat's connection story: first connection, the contact's switch, yours, a failed one, a drop and back", async () => {
  const { net, node, contact, id, view, contactState } = await setup();
  await vi.waitFor(() => expect(lines(view())).toEqual([["connected", null, "iroh/1"]]));
  expect(view().peerTransports).toEqual(expect.arrayContaining(["iroh/1", "hyperdht/1"]));
  expect(view().transportAutomatic).toBe(false);
  // The round trip is on the line of the transport in use, and in the view.
  await vi.waitFor(() => expect(view().transportRttMs).toBeGreaterThanOrEqual(0));
  await vi.waitFor(() => expect(view().transportLog![0].rttMs).toBeGreaterThanOrEqual(0));

  await contact.setTransportPreference("hyperdht/1", true);
  await vi.waitFor(() => expect(lines(view()).at(-1)).toEqual(["switched", "contact", "hyperdht/1"]));
  expect(view().transportLog!.at(-1)!.from).toBe("iroh/1");

  await node.setChatTransport({ linkId: id, transport: "iroh/1" });
  await vi.waitFor(() => expect(lines(view()).at(-1)).toEqual(["switched", "you", "iroh/1"]));
  expect(view().preferredTransport).toBe("iroh/1");

  net.unreachable.add("hyperdht/1");
  await node.setChatTransport({ linkId: id, transport: "hyperdht/1" });
  await vi.waitFor(() => expect(view().transportLog!.at(-1)).toMatchObject({ kind: "failed", target: "hyperdht/1", transport: "iroh/1" }), { timeout: 15_000 });
  expect(view().pairing?.transport).toBe("iroh/1");
  net.unreachable.delete("hyperdht/1");

  // Automatic: nothing moves by itself, and the chat's choice is forgotten.
  await node.setChatTransport({ linkId: id, transport: "auto" });
  expect(view().transportAutomatic).toBe(true);
  expect((await db.getLinks()).find(l => l.id === id)?.preferredTransport).toBeUndefined();

  contact.disconnect();
  await vi.waitFor(() => expect(lines(view()).at(-1)).toEqual(["lost", null, null]));
  // The contact still prefers HyperDHT: it dials that, so the chat comes back on another transport than dropped.
  void contact.connect(5_000).catch(() => {});
  await vi.waitFor(() => expect(lines(view()).at(-1)).toEqual(["switched", "dropped", "hyperdht/1"]));
  expect(view().transportLog!.at(-1)!.from).toBe("iroh/1");
  expect(contactState().status).toBe("ready");
  // Dropped again within the minute: the drops and returns become one line that keeps counting.
  contact.disconnect();
  await vi.waitFor(() => expect(view().pairing?.status).not.toBe("ready"));
  void contact.connect(5_000).catch(() => {});
  await vi.waitFor(() => expect(view().transportLog!.at(-1)).toMatchObject({ kind: "flapping", count: 2, live: true }));

  // Kept with the chat, and never a message: nothing to count as unread, nothing to preview.
  expect((await db.getLinks()).find(l => l.id === id)?.transportLog?.map(e => e.kind))
    .toEqual(["connected", "switched", "switched", "failed", "flapping"]);
  expect(await db.getMessages(id)).toEqual([]);
  // Only the chat on screen carries it in the state.
  node.setActiveLink({ linkId: null });
  expect(view().transportLog).toBeUndefined();
}, 40_000);
