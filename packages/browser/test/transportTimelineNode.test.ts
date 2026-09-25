import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, createIdentity, createLink, identityFromSeedB64, type PairingState } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import type { LinkView } from "../src/shared/types";
import { FakeNativeNet } from "./helpers/fakeNative";
// covers: transport.timeline, transport.chat-switch, transport.preference

/**
 * The engine's side of the chat's connection story: a real node (the app) and its contact's link over stand-ins for
 * Iroh and HyperDHT. What matters (the first connection, a change of transport, a choice) becomes a row in the
 * chat's transport log, with who and why; a drop it comes back from on the same transport is only in the
 * connection history. None of them is a message.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

/** `appCoordinates`: the app holds the lower rendezvous key, so it plans the switches (random when left out). */
async function setup({ appCoordinates }: { appCoordinates?: boolean } = {}) {
  const net = new FakeNativeNet();
  let invitation = createLink();
  while (appCoordinates !== undefined && (invitation.invite.peerPubKeyZ32 < invitation.mine.peerPubKeyZ32) !== appCoordinates) invitation = createLink();
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
  const contactGot: string[] = [];
  const contact = new GhostLink({
    params: { ...invitation.invite, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: theirs, peerKey: identityFromSeedB64(mine).pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true, peerTransports: ["iroh/1", "hyperdht/1"], peerFallback: true,
      peerDescriptors: { "iroh/1": { id: "app:iroh/1" }, "hyperdht/1": { id: "app:hyperdht/1" } } },
    transport, createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    events: { onPairingState: state => { contactState = state; }, onMessage: message => { contactGot.push(message.text); } },
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
  // A disconnected link says nothing more, so what it said before the drop would pass for the redial's state.
  const dropContact = () => { contact.disconnect(); contactState = { status: "connecting" }; };
  return { net, node, contact, id, view, contactState: () => contactState, contactGot, dropContact };
}

const lines = (view: LinkView) => (view.transportLog ?? []).map(e => [e.kind, e.cause ?? null, e.transport ?? null]);
const history = (view: LinkView) => (view.transportHistory ?? []).map(e => e.kind);

it("tells the chat's connection story: first connection, the contact's switch, yours, a failed one, automatic, and a drop only in the history", async () => {
  const { net, node, contact, id, view, contactState, dropContact } = await setup();
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

  // Automatic: this side stops choosing, so the contact's standing choice (HyperDHT) wins, and the chat's own is forgotten.
  await node.setChatTransport({ linkId: id, transport: "auto" });
  expect(view().transportAutomatic).toBe(true);
  expect((await db.getLinks()).find(l => l.id === id)?.preferredTransport).toBeUndefined();
  // One row for the choice, which says where the apps took the chat.
  await vi.waitFor(() => expect(lines(view()).at(-1)).toEqual(["chose", "you", "hyperdht/1"]));
  expect(view().transportLog!.at(-1)).toMatchObject({ from: "iroh/1" });
  expect(view().transportLog!.at(-1)!.target).toBeUndefined();

  // The contact's app goes away and comes back at once: the history has it, the timeline does not.
  const rows = lines(view());
  dropContact();
  await vi.waitFor(() => expect(history(view()).at(-1)).toBe("down"));
  void contact.connect(5_000).catch(() => {});
  await vi.waitFor(() => expect([view().pairing?.status, view().pairing?.transport, contactState().status, contactState().transport])
    .toEqual(["ready", "hyperdht/1", "ready", "hyperdht/1"]));
  await vi.waitFor(() => expect(view().transportHistory!.at(-1)).toMatchObject({ kind: "live", transport: "hyperdht/1" }));
  expect(view().transportHistory!.at(-1)!.downMs).toBeGreaterThanOrEqual(0);
  expect(lines(view())).toEqual(rows);

  // Kept with the chat, and never a message: nothing to count as unread, nothing to preview.
  const stored = (await db.getLinks()).find(l => l.id === id);
  expect(stored?.transportLog?.map(e => e.kind)).toEqual(["connected", "switched", "switched", "chose", "failed", "chose"]);
  expect(stored?.transportHistory?.map(e => e.kind)).toEqual(expect.arrayContaining(["live", "switched", "chose", "failed", "down"]));
  expect(await db.getMessages(id)).toEqual([]);
  // Only the chat on screen carries it in the state.
  node.setActiveLink({ linkId: null });
  expect(view().transportLog).toBeUndefined();
  expect(view().transportHistory).toBeUndefined();
}, 40_000);

it("DHT only from the chat's menu: a row for the choice, one for leaving it, then live again", async () => {
  const { node, contact, id, view } = await setup();
  await vi.waitFor(() => expect(lines(view())).toEqual([["connected", null, "iroh/1"]]));
  await node.setChatTransport({ linkId: id, transport: "dht" });
  expect(view().deliveryMode).toBe("dht");
  await vi.waitFor(() => expect(lines(view()).at(-1)).toEqual(["dht-only", "you", null]));
  // No "lost" line beside it: the choice is the reason.
  expect(view().transportLog!.map(e => e.kind)).toEqual(["connected", "dht-only"]);
  expect(view().transportLive).toBeUndefined();

  await node.setChatTransport({ linkId: id, transport: "auto" });
  expect(view().deliveryMode).toBe("stream");
  expect(view().transportAutomatic).toBe(true);
  await vi.waitFor(() => expect(lines(view()).at(-1)).toEqual(["dht-left", null, null]));
  void contact.connect(5_000).catch(() => {});
  await vi.waitFor(() => expect(lines(view()).at(-1)).toEqual(["back", null, "iroh/1"]));
  expect(await db.getMessages(id)).toEqual([]);
}, 40_000);

/**
 * A drop in automatic mode while a move to the contact's choice is still in flight. However the keys fall (which
 * side plans the switch) and whichever side redials, both end on the transport the agreement names, once, and stay
 * there; nothing sent meanwhile is lost (WISP 100: a live chat changes transport when it drops or someone switches).
 */
describe.each([
  { appCoordinates: true, dialer: "app", who: "the app redials" },
  { appCoordinates: true, dialer: "contact", who: "the contact redials" },
  { appCoordinates: false, dialer: "app", who: "the app redials" },
  { appCoordinates: false, dialer: "contact", who: "the contact redials" },
  { appCoordinates: true, dialer: "both", who: "both redial at once" },
  { appCoordinates: false, dialer: "both", who: "both redial at once" },
] as const)("a drop mid-switch (the app plans switches: $appCoordinates), $who", ({ appCoordinates, dialer }) => {
  it("ends on the contact's choice on both sides, with one row for coming back", async () => {
    const { net, node, contact, id, view, contactState, contactGot, dropContact } = await setup({ appCoordinates });
    await vi.waitFor(() => expect(lines(view())).toEqual([["connected", null, "iroh/1"]]));
    await node.setChatTransport({ linkId: id, transport: "auto" });

    // The contact chooses HyperDHT; the switch is agreed, and its dial is still on its way when the link drops.
    const release = net.hold("hyperdht/1");
    await contact.setTransportPreference("hyperdht/1", true);
    await vi.waitFor(() => expect([view().pairing?.transitionTarget, contactState().transitionTarget]).toEqual(["hyperdht/1", "hyperdht/1"]));
    // A message still on the wire when the link drops is lost with it, and must go again once the chat is back.
    // A slow wire for that one frame keeps it on the way whatever the send path costs.
    net.latencyMs = 5_000;
    expect((await node.sendMessage({ linkId: id, text: "in flight at the drop" })).error).toBeNull();
    net.latencyMs = 2;
    dropContact();
    await vi.waitFor(() => expect(history(view()).at(-1)).toBe("down"));
    release();
    expect(contactGot).toEqual([]);

    if (dialer !== "contact") void node.connect({ linkId: id }).catch(() => {});
    if (dialer !== "app") void contact.connect(5_000).catch(() => {});
    await vi.waitFor(() => expect([view().pairing?.status, view().pairing?.transport, contactState().status, contactState().transport])
      .toEqual(["ready", "hyperdht/1", "ready", "hyperdht/1"]));
    await vi.waitFor(() => expect(contactGot).toEqual(["in flight at the drop"]));
    // Settled, not flapping: no switch pending on either side, and no more lines a while later.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect([view().pairing?.transport, view().pairing?.transitionTarget, contactState().transport, contactState().transitionTarget])
      .toEqual(["hyperdht/1", undefined, "hyperdht/1", undefined]);
    // The contact's choice is a row of its own; after it, the app reconnecting, not the contact switching, though
    // it lands on the contact's choice.
    const log = view().transportLog!, choice = log.findIndex(e => e.kind === "chose" && e.cause === "contact");
    expect(log[choice]).toMatchObject({ target: "hyperdht/1" });
    const after = log.slice(choice + 1);
    expect(after.map(e => [e.kind, e.cause, e.from, e.transport])).toEqual([["switched", "dropped", "iroh/1", "hyperdht/1"]]);
    expect(contactGot).toEqual(["in flight at the drop"]);
  }, 20_000);
});
