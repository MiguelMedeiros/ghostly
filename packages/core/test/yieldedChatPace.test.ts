import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NativeEndpoint, PairedTransport, TransportDescriptors } from "../src/pairedTransports";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, invitationWhere, open, run, useFakeWorld, type Opened } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";

// covers: transport.native-pool, core.dht-direct

/**
 * Two Desktops with no WebRTC, live over HyperDHT, and the lower key's chat gives its listener up to another chat in use
 * (node.ts `startNativeEndpoint` → `yieldEndpoint`): neither side has anything to dial now, the one with no endpoint and
 * the one whose contact's record lists HyperDHT undescribed. Each used to dial every 20 s for good, a look at the
 * contact's record each time, and the contact looked fast (`expectPeer`) at every one of its packets for an offer that
 * could not come: 25 and 60-100 reads per 5 min on the Desktop against 16 at its background pace (bug hunt, 2026-10-12).
 */

interface Desk { side: Opened; endpoint: NativeEndpoint }

function desktop(native: NativeWorld, name: string, side: Opened): Desk {
  const endpoint = native.endpoint("hyperdht/1", name);
  side.link.registerEndpoint(endpoint);
  return { side, endpoint };
}

const record = (desk: Desk): [PairedTransport[], TransportDescriptors] =>
  [["hyperdht/1"], { "hyperdht/1": desk.endpoint.descriptor } as TransportDescriptors];
const keyOf = (desk: Desk) => desk.side.link.session.identity.pubKeyZ32;

beforeEach(useFakeWorld);
afterEach(closeWorld);

describe("a chat with no WebRTC that gave its native listener up", () => {
  it("reads at the background pace on both sides, and dials again once it has something to dial", async () => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK), native = new NativeWorld(), made = invitationWhere("inviter");
    const yielder = desktop(native, "ana", open(made.inviter, pkarr, { dht: true, link: { rtcAvailable: false } }));
    await run(2_000);
    const contact = desktop(native, "bia", open(made.joiner, pkarr, { dht: true, link: { rtcAvailable: false } }));
    await run(10_000);
    yielder.side.link.learnPeerTransports(...record(contact), true);
    contact.side.link.learnPeerTransports(...record(yielder), true);
    await run(10_000);
    expect(yielder.side.link.isDataLinkOpen && contact.side.link.isDataLinkOpen, "live").toBe(true);
    // A chat nobody has open: it looks at the background pace (20 s on the Desktop's DHT), 15 reads in 5 min.
    for (const desk of [yielder, contact]) desk.side.link.session.setActive(false);
    await run(60_000);

    const readsOf = (desk: Desk) => pkarr.readsByKey.get(keyOf(desk)) ?? 0;
    const atYield = readsOf(yielder), dialsAtYield = native.dials;
    const yielding = yielder.side.link.yieldEndpoint("hyperdht/1", 0);
    await run(2_000);
    expect(await yielding, "the listener is given up").toBe(true);
    // The yielder's record now lists HyperDHT undescribed, and the contact reads it at its next look.
    await run(18_000);
    contact.side.link.learnPeerTransports(["hyperdht/1"], {}, true);
    await run(2 * 60_000 - 20_000);
    // The yield is no app quitting: the contact used to watch for it to come back, fast for 30 s and at the active pace
    // up to 2 min (89 reads). At the background pace: 6 reads, and a few for the record that changed.
    expect(readsOf(yielder) - atYield, "the contact at the background pace from the yield on").toBeLessThanOrEqual(12);
    expect(native.dials, "nothing dialled after the yield").toBe(dialsAtYield);

    const before = { yielder: readsOf(yielder), contact: readsOf(contact) };
    const dialsBefore = native.dials;
    await run(5 * 60_000);
    // The yielder reads its contact's key, and the contact the yielder's.
    const byYielder = readsOf(contact) - before.contact, byContact = readsOf(yielder) - before.yielder;
    expect(native.dials, "nothing dialled").toBe(dialsBefore);
    expect(byYielder, "the yielder at the background pace, no look every 20 s").toBeLessThanOrEqual(17);
    expect(byContact, "the contact at the background pace, no fast look for an offer that cannot come").toBeLessThanOrEqual(17);

    // In use again, the yielder takes a listener back: the contact is dialled at once.
    const again = native.endpoint("hyperdht/1", "ana");
    yielder.side.link.registerEndpoint(again);
    await run(5_000);
    expect(native.dials, "dialled on the new listener").toBeGreaterThan(dialsBefore);
    expect(yielder.side.link.isDataLinkOpen, "live again").toBe(true);
  }, 120_000);
});
