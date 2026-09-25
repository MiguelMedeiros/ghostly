import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapsExchange, GhostLink, capsDescriptors, createIdentity, createLink, dialDescriptors, emptyDhtDeliveryState, identityFromSeedB64,
  type GhostRecord, type PairingState, type PairedTransport, type PkarrTransport, type SignedPacket } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import type { LinkView } from "../src/shared/types";
import { FakeNativeNet } from "./helpers/fakeNative";
// covers: transport.iroh-web, transport.preference, transport.wait, transport.timeline

/**
 * A chat that never went live, between an app (a real node, as the Desktop runs it) and its contact's link (as a
 * browser runs it), with capability records on an in-memory DHT. Found on Miguel's web and Desktop apps: the web
 * chose Iroh, and the Desktop never heard of it; the chat stayed "On DHT · retrying live" because the Desktop's
 * record named its Iroh endpoint before the endpoint had a relay, and a browser can reach Iroh only through one.
 */

/** Pkarr in one process: a publish is readable at once. */
function memoryPkarr(): PkarrTransport {
  const packets = new Map<string, SignedPacket>();
  return {
    publish: async (identity: { pubKeyZ32: string }, records: GhostRecord[]) => {
      packets.set(identity.pubKeyZ32, { pubKeyZ32: identity.pubKeyZ32, timestampMicros: BigInt(Date.now()) * 1000n, records });
    },
    resolve: async (key: string) => packets.get(key) ?? null,
    describe: () => ({ protocol: "memory", relays: [] }),
  } as PkarrTransport;
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); vi.useRealTimers(); });

/** Fake time moves on in small steps, so the links' own timers (polls, retries, record spacing) run in between. */
async function until(check: () => void, withinMs: number): Promise<void> {
  for (let waited = 0; ; waited += 500) {
    try { check(); return; } catch (error) { if (waited >= withinMs) throw error; }
    await vi.advanceTimersByTimeAsync(500);
  }
}
const advance = (ms: number) => until(() => { throw new Error("waiting"); }, ms).catch(() => {});

type Has = { iroh?: "relay-only" | "relay-later" | "direct"; hyperdht?: boolean };

/**
 * `appDials`: the app holds the lower rendezvous key, so it dials. Both are pinned already (the first contact
 * happened on the DHT) and neither has a session to remember. No WebRTC on either side: the contact's cannot reach
 * the Desktop's WKWebView here, and the node runs where there is none.
 */
async function setup({ appDials, app, contact: has }: { appDials: boolean; app: Has; contact: Has }) {
  const net = new FakeNativeNet();
  const pkarr = memoryPkarr();
  let invitation = createLink();
  while ((invitation.invite.peerPubKeyZ32 < invitation.mine.peerPubKeyZ32) !== appDials) invitation = createLink();
  const [mine, theirs] = [createIdentity().seedB64, createIdentity().seedB64];
  const id = `not-live-${crypto.randomUUID()}`;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink({ ...invitation.mine, id, profile: "paired-chat/1", participationSeed: mine, createdAt: 1, pairedPeerKey: identityFromSeedB64(theirs).pubKeyZ32 });
  const appEndpoints = {
    ...(app.iroh ? { "iroh/1": net.endpoint("iroh/1", "app", app.iroh) } : {}),
    ...(app.hyperdht ? { "hyperdht/1": net.endpoint("hyperdht/1", "app", "direct") } : {}),
  };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: pkarr, automaticWallets: false,
    nativeTransports: Object.fromEntries(Object.entries(appEndpoints).map(([t, endpoint]) => [t, async () => endpoint])) });

  let contactState: PairingState = { status: "connecting" };
  const contactHeard: (PairedTransport | "automatic")[] = [];
  let dhtState = emptyDhtDeliveryState();
  const params = { ...invitation.invite, profile: "paired-chat/1" as const };
  const credentials = { seedB64: theirs, peerKey: identityFromSeedB64(mine).pubKeyZ32 };
  // The contact's side of the capability record, as the engine wires it (capsContent, peerCapsChanged).
  const caps: CapsExchange = new CapsExchange({
    params, credentials, transport: pkarr, save: async () => {},
    local: () => ({ versions: [1], transports: contact.availableTransports, capabilities: ["chat/1", "dht-text/1"], extensions: [],
      descriptors: capsDescriptors(contact.nativeDescriptors), name: "", ...(contact.choice ? { choice: contact.choice } : {}) }),
    changed: record => {
      contact.learnPeerTransports(record.transports as PairedTransport[], dialDescriptors(record.descriptors), true);
      contact.learnPeerChoice(record.choice, true);
    },
    published: () => contact.announceCapsRevision(),
  });
  const contact: GhostLink = new GhostLink({
    params, rtcAvailable: false,
    pairing: { credentials, pinPeer: async () => {} },
    dht: { state: dhtState, save: async state => { dhtState = state; }, pollMs: 250, capsRev: () => caps.rev, peerCapsRev: rev => caps.peerRev(rev) },
    native: { preferred: has.iroh ? "iroh/1" : "hyperdht/1", fallback: true, automatic: true },
    transport: pkarr, autoConnect: true,
    createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    events: {
      onPairingState: state => { contactState = state; },
      onPeerTransportChoice: transport => { contactHeard.push(transport); },
      onTransportsChanged: () => { void caps.update().catch(() => {}); },
    },
  });
  const contactEndpoints = {
    ...(has.iroh ? { "iroh/1": net.endpoint("iroh/1", "contact", has.iroh) } : {}),
    ...(has.hyperdht ? { "hyperdht/1": net.endpoint("hyperdht/1", "contact", "direct") } : {}),
  };
  for (const endpoint of Object.values(contactEndpoints)) contact.registerEndpoint(endpoint);
  cleanup.push(async () => { await caps.stop(); await contact.stop(false); await node.shutdown(); await db.deleteLink(id); });
  contact.start();
  caps.start();
  await node.start();
  node.setActiveLink({ linkId: id });
  const view = () => node.getState().links.find(l => l.id === id)!;
  /** The contact chooses, as its engine does: the link, then its record. */
  const contactChooses = async (transport: PairedTransport) => { await contact.setTransportPreference(transport, true, false, true); await caps.update(); };
  return { net, node, id, view, contact, contactChooses, contactState: () => contactState, contactHeard, appEndpoints };
}

const lines = (view: LinkView) => (view.transportLog ?? []).map(e => [e.kind, e.cause ?? null, e.target ?? null]);
const liveOn = (s: Awaited<ReturnType<typeof setup>>) => [s.view().pairing?.status, s.view().pairing?.transport, s.contactState().status, s.contactState().transport];

it("a browser reaches a Desktop over Iroh through the relay the Desktop's endpoint names only once it is homed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
  // The browser has the lower key and dials, as Miguel's web did.
  const s = await setup({ appDials: false, app: { iroh: "relay-later" }, contact: { iroh: "relay-only" } });
  // Its first record names the endpoint with no relay: nothing the browser can dial. The browser says so, and the
  // app knows the browser dials: it is not a silent retry loop on either side.
  await until(() => expect(s.contact.liveAttempt).toMatchObject({ side: "dialled", failed: [{ transport: "iroh/1", error: "The contact has no Iroh relay" }] }), 45_000);
  expect(s.contact.liveAttempt!.retryAt).toBeGreaterThan(Date.now());
  expect(s.contact.isDataLinkOpen).toBe(false);
  expect(s.view().liveDialer).toBe("contact");
  s.appEndpoints["iroh/1"]!.homeRelay();
  // Homed now: the record says so, the browser takes it, and the chat goes live through the relay.
  await until(() => expect(liveOn(s)).toEqual(["ready", "iroh/1", "ready", "iroh/1"]), 120_000);
  expect(s.view().transportRelayed).toEqual({ relays: ["relay.test"] });
  expect([s.view().liveAttempt, s.contact.liveAttempt]).toEqual([undefined, undefined]);
}, 60_000);

describe("a choice made while the chat is not live", () => {
  it("reaches the contact as a row of its own, and the chat lands on it once it connects", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    const s = await setup({ appDials: false, app: { iroh: "direct" }, contact: { iroh: "relay-only" } });
    s.net.unreachable.add("iroh/1");
    await advance(45_000);
    await s.contactChooses("iroh/1");
    // The app hears of it from the contact's record: one row, as for a choice made on a session.
    await until(() => expect(lines(s.view())).toContainEqual(["chose", "contact", "iroh/1"]), 90_000);
    // The choice is dialled, and why it does not connect is said where it was tried.
    await until(() => expect(s.contact.liveAttempt?.failed).toEqual([{ transport: "iroh/1", error: "iroh/1 unreachable" }]), 90_000);
    s.net.unreachable.delete("iroh/1");
    await until(() => expect(liveOn(s)).toEqual(["ready", "iroh/1", "ready", "iroh/1"]), 240_000);
    expect(s.view().transportWait).toBeUndefined();
    expect(s.contact.transportWait).toBeUndefined();
  }, 60_000);

  it.each([
    { chooser: "contact", appDials: true },
    { chooser: "app", appDials: false },
  ] as const)("made by the $chooser, decides where the other side dials first", async ({ chooser, appDials }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    // Two transports both have: the rank alone puts Iroh first.
    const s = await setup({ appDials, app: { iroh: "direct", hyperdht: true }, contact: { iroh: "direct", hyperdht: true } });
    s.net.unreachable.add("iroh/1"); s.net.unreachable.add("hyperdht/1");
    await advance(45_000);
    if (chooser === "contact") await s.contactChooses("hyperdht/1");
    else await s.node.setChatTransport({ linkId: s.id, transport: "hyperdht/1" });
    if (chooser === "contact") await until(() => expect(lines(s.view())).toContainEqual(["chose", "contact", "hyperdht/1"]), 90_000);
    else await until(() => expect(s.contactHeard).toEqual(["hyperdht/1"]), 90_000);
    s.net.unreachable.delete("iroh/1"); s.net.unreachable.delete("hyperdht/1");
    await until(() => expect(liveOn(s)).toEqual(["ready", "hyperdht/1", "ready", "hyperdht/1"]), 240_000);
    // Told once, though the session that opened carries the same choice as its switch intent.
    await advance(5_000);
    if (chooser === "contact") expect(lines(s.view()).filter(l => l[0] === "chose")).toEqual([["chose", "contact", "hyperdht/1"]]);
    else expect(s.contactHeard).toEqual(["hyperdht/1"]);
  }, 60_000);

  it("begins the session that opens elsewhere as a choice, so the chat moves there once it connects", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    const s = await setup({ appDials: true, app: { iroh: "direct", hyperdht: true }, contact: { iroh: "direct", hyperdht: true } });
    s.net.unreachable.add("iroh/1"); s.net.unreachable.add("hyperdht/1");
    await advance(45_000);
    await s.node.setChatTransport({ linkId: s.id, transport: "hyperdht/1" });
    // Only Iroh gets through: the chat opens there (Fallback on), and the choice still stands.
    s.net.unreachable.delete("iroh/1");
    await until(() => expect(liveOn(s)).toEqual(["ready", "iroh/1", "ready", "iroh/1"]), 240_000);
    await until(() => expect(s.view().transportWait).toMatchObject({ transport: "hyperdht/1", by: "you", live: "iroh/1" }), 60_000);
    expect(s.contact.transportWait).toMatchObject({ transport: "hyperdht/1", by: "contact", live: "iroh/1" });
    s.net.unreachable.delete("hyperdht/1");
    await until(() => expect(liveOn(s)).toEqual(["ready", "hyperdht/1", "ready", "hyperdht/1"]), 240_000);
    expect([s.view().transportWait, s.contact.transportWait]).toEqual([undefined, undefined]);
  }, 60_000);
});
