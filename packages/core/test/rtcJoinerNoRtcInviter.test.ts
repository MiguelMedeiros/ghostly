import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PairedTransport, TransportDescriptors } from "../src/pairedTransports";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, invitationWhere, open, run, useFakeWorld, type Opened } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";

// covers: chat.paired.pair-timing, transport.hyperdht

/**
 * A first pairing over the DHT where the joiner has WebRTC (a macOS or Windows Desktop) and the inviter has none (a
 * Linux Desktop). The joiner's early offer (`dialEarly`) goes before it reads the inviter's record; once the record
 * says the inviter runs no WebRTC, that offer can never be answered. It was kept standing, and the joiner's own
 * HyperDHT dial was due `RACE_DIRECT_MS` (8 s) after it: every pairing waited for the inviter's dial, and a stalled
 * one had nothing racing it (0.5 to 4.6 s to live in the DHT-direct lab, none under 0.3 s). In-memory Pkarr, HyperDHT
 * stood in for by NativeWorld, fake time. The record read is the engine's (`learnPeerTransports`), stood in for here;
 * the inviter never reads the joiner's, so it never dials: only the joiner's own dial can make the chat live.
 */

const RECORD: PairedTransport[] = ["hyperdht/1"];
const live = (side: Opened) => side.link.isDataLinkOpen && side.link.pairingProgress?.stage === "live";
const transportOf = (side: Opened) => (side.link as unknown as { activeBinding?: { transport: string } }).activeBinding?.transport ?? "webrtc/1";

async function until(check: () => boolean, limit: number): Promise<number> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > limit) return Infinity;
    await run(50);
  }
  return Date.now() - start;
}

beforeEach(useFakeWorld);
afterEach(closeWorld);

describe("a WebRTC joiner pairing with an inviter that has no WebRTC", () => {
  it.each(["while-gathering", "after-offer"] as const)("drops its early offer and dials HyperDHT itself once it reads the inviter's record (record read %s)", async record => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK), native = new NativeWorld(), made = invitationWhere("joiner");
    const inviter = open(made.inviter, pkarr, { dht: true, link: { rtcAvailable: false } });
    const inviterDht = native.endpoint("hyperdht/1", "ana");
    inviter.link.registerEndpoint(inviterDht);
    await run(2_000);
    let offeredAt = 0;
    const joiner = open(made.joiner, pkarr, { dht: true, onDataLinkState: state => { if (state === "offering" && !offeredAt) offeredAt = Date.now(); } });
    joiner.link.registerEndpoint(native.endpoint("hyperdht/1", "bia"));
    const learn = () => joiner.link.learnPeerTransports(RECORD, { "hyperdht/1": inviterDht.descriptor } as TransportDescriptors, true);
    if (record === "while-gathering") learn();
    expect(await until(() => offeredAt > 0, 10_000), "the joiner's early offer goes").toBeLessThan(Infinity);
    if (record === "after-offer") learn();
    const readAt = Date.now();
    // Before: the joiner's dial was due 8 s after its offer, and nothing else dialled.
    const dialled = await until(() => (native.dialsBy.get("bia") ?? 0) > 0, 10_000);
    expect(dialled, "the joiner dials HyperDHT within a read of the record").toBeLessThan(500);
    const waited = await until(() => live(joiner) && live(inviter), 10_000);
    expect(transportOf(joiner)).toBe("hyperdht/1");
    expect(Date.now() - readAt, `live ${waited} ms after the read`).toBeLessThan(1_000);
    expect((joiner.link as unknown as { dataLink: { state: string } }).dataLink.state, "the unanswerable offer is withdrawn").toBe("idle");
  }, 60_000);
});
