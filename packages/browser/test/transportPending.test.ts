import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, createIdentity, createLink, emptyDhtDeliveryState, identityFromSeedB64,
  type GhostRecord, type NativeEndpoint, type PairingState, type PairedTransport, type PkarrTransport, type SignedPacket } from "@ghostly/core";
import { FakeNativeNet } from "./helpers/fakeNative";
// covers: transport.wait, transport.switch, transport.chat-switch, transport.preference

/**
 * A chosen transport the chat is not on yet waits for it (WISP 100, "A chosen transport not reached yet"), on two
 * real links over stand-ins for Iroh and HyperDHT (FakeNativeNet) and an in-memory DHT. The order that got stuck
 * on a pair of Linux Desktops (#244): HyperDHT chosen with Fallback off before the contact's capability record
 * named it. The switch failed, and the chat stayed on "Connection issue" with nothing retrying it.
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

interface Side {
  link: GhostLink; state: PairingState; received: { text: string; via: string }[];
  iroh: NativeEndpoint; hyper: NativeEndpoint; switchFailed: PairedTransport[];
}
const links: GhostLink[] = [];
afterEach(async () => { vi.useRealTimers(); for (const link of links.splice(0)) await link.stop(false); });

/**
 * Two sides live on Iroh. `chooserCoordinates`: the side that will choose (A) holds the lower rendezvous key, so it
 * plans the switch; otherwise the contact does. The contact (B) has not started HyperDHT yet: its policy and the
 * record A knows name Iroh only, and it registers `b.hyper` when the test says.
 */
async function pair(net: FakeNativeNet, chooserCoordinates: boolean): Promise<[Side, Side]> {
  let invitation = createLink();
  while ((invitation.invite.peerPubKeyZ32 < invitation.mine.peerPubKeyZ32) !== chooserCoordinates) invitation = createLink();
  const params = [invitation.mine, invitation.invite];
  const seeds = [createIdentity().seedB64, createIdentity().seedB64];
  const pkarr = memoryPkarr();
  const endpoints = ["a", "b"].map(name => ({ iroh: net.endpoint("iroh/1", name), hyper: net.endpoint("hyperdht/1", name) }));
  const sides: Side[] = [];
  for (let i = 0; i < 2; i++) {
    const side = { state: { status: "connecting" }, received: [], switchFailed: [], ...endpoints[i] } as unknown as Side;
    const peer = endpoints[1 - i];
    let dhtState = emptyDhtDeliveryState();
    side.link = new GhostLink({
      params: { ...params[i], profile: "paired-chat/1" }, rtcAvailable: false,
      pairing: { credentials: { seedB64: seeds[i], peerKey: identityFromSeedB64(seeds[1 - i]).pubKeyZ32 }, pinPeer: async () => {} },
      dht: { state: dhtState, save: async state => { dhtState = state; }, pollMs: 100 },
      // A knows the contact's Iroh only (from a session before its HyperDHT started), and has read no record of it yet.
      native: i === 0
        ? { preferred: "iroh/1", fallback: true, automatic: true, peerTransports: ["iroh/1"], peerFallback: true, peerDescriptors: { "iroh/1": peer.iroh.descriptor } }
        : { preferred: "iroh/1", fallback: true, automatic: true, peerTransports: ["iroh/1", "hyperdht/1"], peerFallback: true,
          peerDescriptors: { "iroh/1": peer.iroh.descriptor, "hyperdht/1": peer.hyper.descriptor } },
      transport: pkarr,
      createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
      events: {
        onPairingState: state => { side.state = state; },
        onMessage: message => { side.received.push({ text: message.text, via: message.via }); },
        onTransportSwitchFailed: target => { side.switchFailed.push(target); },
      },
    });
    links.push(side.link);
    side.link.registerEndpoint(side.iroh);
    if (i === 0) side.link.registerEndpoint(side.hyper);
    side.link.start();
    sides.push(side);
  }
  const [a, b] = sides;
  await a.link.connect(5_000);
  await vi.waitFor(() => expect([a, b].map(s => [s.state.status, s.state.transport])).toEqual([["ready", "iroh/1"], ["ready", "iroh/1"]]));
  // Each has read the other's envelope on the DHT: the floor is there for text when layer 1 is not.
  await vi.waitFor(() => expect([a, b].map(s => s.link.dhtDelivery?.peerMode)).toEqual(["stream", "stream"]));
  return [a, b];
}

/** Nothing reads as a connection failure: no error state, no switch error. */
const noFailure = (side: Side) => {
  expect(side.state.status).not.toBe("error");
  expect(side.state.transitionError).toBeUndefined();
};

describe.each([true, false])("chooser coordinates: %s", chooserCoordinates => {
  it("waits on the DHT for a HyperDHT chosen with Fallback off before the contact's record names it, and lands once it does", async () => {
    const net = new FakeNativeNet();
    const [a, b] = await pair(net, chooserCoordinates);
    await a.link.setTransportPreference("hyperdht/1", false);
    // Nothing the contact has said names HyperDHT: waiting, not failed, and not live on Iroh (Fallback off).
    await vi.waitFor(() => expect(a.link.transportWait).toMatchObject({ transport: "hyperdht/1", by: "you", reason: "unknown" }));
    await vi.waitFor(() => expect(b.link.transportWait).toMatchObject({ transport: "hyperdht/1", by: "contact", reason: "app-lacks" }));
    for (const side of [a, b]) { noFailure(side); expect(side.link.isDataLinkOpen).toBe(false); expect(side.link.textDelivery).toBe("dht"); }
    // The chat still carries short text, over the DHT.
    expect(await a.link.sendMessage("while waiting")).toBeNull();
    await vi.waitFor(() => expect(b.received).toContainEqual({ text: "while waiting", via: "pkarr" }), { timeout: 5_000 });

    // The contact's HyperDHT starts, but is not reachable yet (its announce is still on its way): the switch fails.
    net.unreachable.add("hyperdht/1");
    b.link.registerEndpoint(b.hyper);
    await vi.waitFor(() => expect(a.link.transportWait).toMatchObject({ transport: "hyperdht/1", reason: "unreachable" }), { timeout: 15_000 });
    for (const side of [a, b]) { noFailure(side); expect(side.link.textDelivery).toBe("dht"); }
    // Fallback off: the chat was not kept anywhere, so no side says a switch failed and it stayed.
    expect([a.switchFailed, b.switchFailed]).toEqual([[], []]);

    // It is reachable now, and the contact's record names it: the switch is tried again at once, and lands.
    net.unreachable.delete("hyperdht/1");
    a.link.learnPeerTransports(["iroh/1", "hyperdht/1"], { "iroh/1": b.iroh.descriptor, "hyperdht/1": b.hyper.descriptor });
    await vi.waitFor(() => expect([a, b].map(s => [s.state.status, s.state.transport])).toEqual([["ready", "hyperdht/1"], ["ready", "hyperdht/1"]]), { timeout: 10_000 });
    for (const side of [a, b]) { noFailure(side); expect(side.link.isDataLinkOpen).toBe(true); expect(side.link.transportWait).toBeUndefined(); }
    expect(await a.link.sendMessage("over HyperDHT")).toBeNull();
    await vi.waitFor(() => expect(b.received).toContainEqual({ text: "over HyperDHT", via: "datalink" }));
  }, 40_000);

  it("tries a switch that did not connect again on the background pace, with nothing new said", async () => {
    const net = new FakeNativeNet();
    const [a, b] = await pair(net, chooserCoordinates);
    net.unreachable.add("hyperdht/1");
    b.link.registerEndpoint(b.hyper);
    await vi.waitFor(() => expect(a.link.peerAvailableTransports).toContain("hyperdht/1"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    await a.link.setTransportPreference("hyperdht/1", false);
    await vi.waitFor(() => expect(a.link.transportWait).toMatchObject({ reason: "unreachable" }), { timeout: 15_000 });
    // The side that plans switches (the lower key) tries again; the other waits for its plan.
    const [coordinator, other] = chooserCoordinates ? [a, b] : [b, a];
    await vi.waitFor(() => expect(coordinator.link.transportWait?.retryAt).toBeGreaterThan(0));
    expect(other.link.transportWait?.retryAt).toBeUndefined();
    const retryAt = coordinator.link.transportWait!.retryAt!;
    // 20 s after a failed attempt, doubling: the first retry is due in about that.
    expect(retryAt - Date.now()).toBeGreaterThan(15_000);
    expect(retryAt - Date.now()).toBeLessThanOrEqual(20_000);
    net.unreachable.delete("hyperdht/1");
    await vi.advanceTimersByTimeAsync(21_000);
    await vi.waitFor(() => expect([a, b].map(s => [s.state.status, s.state.transport])).toEqual([["ready", "hyperdht/1"], ["ready", "hyperdht/1"]]), { timeout: 10_000 });
    expect(a.link.transportWait).toBeUndefined();
  }, 40_000);
});

it("says plainly that the contact's app lacks the chosen transport, keeps watching, and Automatic brings the chat back live", async () => {
  const net = new FakeNativeNet();
  const [a, b] = await pair(net, true);
  // The contact's record, read: its app runs Iroh and nothing else.
  a.link.learnPeerTransports(["iroh/1"], { "iroh/1": b.iroh.descriptor });
  await a.link.setTransportPreference("hyperdht/1", false);
  await vi.waitFor(() => expect(a.link.transportWait).toMatchObject({ transport: "hyperdht/1", by: "you", reason: "contact-lacks" }));
  noFailure(a); noFailure(b);
  expect(a.link.textDelivery).toBe("dht");

  // Automatic: the app's rule, fallback on. Live on Iroh again, nothing waits.
  await a.link.setTransportPreference("iroh/1", true, true);
  await vi.waitFor(() => expect([a, b].map(s => [s.state.status, s.state.transport, s.link.isDataLinkOpen])).toEqual([["ready", "iroh/1", true], ["ready", "iroh/1", true]]));
  expect(a.link.transportWait).toBeUndefined();
  expect(b.link.transportWait).toBeUndefined();
}, 30_000);

it("waits again, then lands, when a newer record of the contact's lists the transport it lacked", async () => {
  const net = new FakeNativeNet();
  const [a, b] = await pair(net, false);
  a.link.learnPeerTransports(["iroh/1"], { "iroh/1": b.iroh.descriptor });
  await a.link.setTransportPreference("hyperdht/1", false);
  await vi.waitFor(() => expect(a.link.transportWait).toMatchObject({ reason: "contact-lacks" }));
  // The contact's app gained HyperDHT: its record says so first, then its endpoint starts.
  a.link.learnPeerTransports(["iroh/1", "hyperdht/1"], { "iroh/1": b.iroh.descriptor });
  expect(a.link.transportWait).toMatchObject({ reason: "starting" });
  b.link.registerEndpoint(b.hyper);
  await vi.waitFor(() => expect([a, b].map(s => [s.state.status, s.state.transport])).toEqual([["ready", "hyperdht/1"], ["ready", "hyperdht/1"]]), { timeout: 10_000 });
  expect(a.link.transportWait).toBeUndefined();
}, 30_000);

it("with no session, waits only for a transport missing on a side: a contact that has it and is away is retrying live", async () => {
  const net = new FakeNativeNet();
  const invitation = createLink(), seeds = [createIdentity().seedB64, createIdentity().seedB64];
  const b = { iroh: net.endpoint("iroh/1", "b"), hyper: net.endpoint("hyperdht/1", "b") };
  const link = new GhostLink({
    params: { ...invitation.mine, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: seeds[0], peerKey: identityFromSeedB64(seeds[1]).pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "hyperdht/1", fallback: false },
    transport: memoryPkarr(), createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
  });
  links.push(link);
  link.registerEndpoint(net.endpoint("iroh/1", "a"));
  link.registerEndpoint(net.endpoint("hyperdht/1", "a"));
  // Nothing known of the contact yet: retrying live, as any chat.
  expect(link.transportWait).toBeUndefined();
  link.learnPeerTransports(["iroh/1"], { "iroh/1": b.iroh.descriptor });
  expect(link.transportWait).toEqual({ transport: "hyperdht/1", by: "you", reason: "contact-lacks", failures: 0 });
  link.learnPeerTransports(["iroh/1", "hyperdht/1"], { "iroh/1": b.iroh.descriptor });
  expect(link.transportWait).toMatchObject({ reason: "starting" });
  // It has it and says how to dial it: reaching it is the chat retrying live, not a wait.
  link.learnPeerTransports(["iroh/1", "hyperdht/1"], { "iroh/1": b.iroh.descriptor, "hyperdht/1": b.hyper.descriptor });
  expect(link.transportWait).toBeUndefined();
});
