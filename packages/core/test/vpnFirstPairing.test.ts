import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RACE_ANSWERED_MS } from "../src/ghostlink";
import type { PairedTransport, TransportDescriptors } from "../src/pairedTransports";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, invitationWhere, open, rtc, run, useFakeWorld, type Opened } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";

// covers: chat.paired.pair-timing, transport.iroh

/**
 * A first pairing where the joiner is behind a VPN that blocks UDP: the joiner's early offer (`dialEarly`) is answered,
 * and ICE never connects (host candidates only, no TURN). Both apps run an Iroh reached through its relay, which works
 * from the first second. The early offer goes before the inviter's capability record is read, so it was made with no
 * fallback, and nothing raced it: the chat went live over the relayed Iroh only after the attempt timed out and the
 * next one raced, 32 to 66 s in (zero's VPN lab, 2026-10-13). In-memory Pkarr, WebRTC that never connects
 * (`rtc.blocked`), Iroh stood in for by NativeWorld, fake time. The record read is the engine's (`peerCapsChanged` →
 * `learnPeerTransports`), stood in for here.
 */

const RECORD: PairedTransport[] = ["webrtc/1", "iroh/1"];
const live = (side: Opened) => side.link.isDataLinkOpen && side.link.pairingProgress?.stage === "live";
const channelOf = (side: Opened) => (side.link as unknown as { channel: unknown }).channel;
const transportOf = (side: Opened) => (side.link as unknown as { activeBinding?: { transport: string } }).activeBinding?.transport ?? "webrtc/1";

async function until(check: () => boolean, limit: number): Promise<number> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > limit) return Infinity;
    await run(50);
  }
  return Date.now() - start;
}

/**
 * The joiner opens the invite; its early offer goes once the first look finds the inviter, and the inviter answers.
 * `record`: when the joiner reads the inviter's record (it says Iroh, and how to dial it): while its dial waits to send
 * the offer, after the offer went, or after the answer.
 */
async function pairBehindVpn(record: "while-gathering" | "before-answer" | "after-answer", vpn = true): Promise<{ answered: number; liveMs: number; transport: string; irohDials: number }> {
  rtc.blocked = vpn;
  const pkarr = new MemoryPkarr(DESKTOP_NETWORK), native = new NativeWorld(), made = invitationWhere("joiner");
  const inviter = open(made.inviter, pkarr, { dht: true });
  const inviterIroh = native.endpoint("iroh/1", "ana");
  inviter.link.registerEndpoint(inviterIroh);
  await run(2_000);
  const joined = Date.now();
  let answeredAt = 0, offeredAt = 0;
  const joiner = open(made.joiner, pkarr, { dht: true, onDataLinkState: state => {
    if (state === "offering" && !offeredAt) offeredAt = Date.now();
    if (state === "connecting" && !answeredAt) answeredAt = Date.now();
  } });
  // Iroh is up before the offer is (its endpoint starts as the link does): the race has nothing to join later.
  joiner.link.registerEndpoint(native.endpoint("iroh/1", "bia"));
  const learn = () => joiner.link.learnPeerTransports(RECORD, { "iroh/1": inviterIroh.descriptor } as TransportDescriptors, true);
  // The early dial waits for its first look at the inviter before its offer goes: the record read meanwhile.
  if (record === "while-gathering") learn();
  const offerOut = await until(() => offeredAt > 0, 10_000);
  expect(offerOut, "the joiner's early offer goes").toBeLessThan(Infinity);
  if (record === "before-answer") learn();
  expect(await until(() => answeredAt > 0, 20_000), "the inviter answers the offer").toBeLessThan(Infinity);
  if (record === "after-answer") { await run(500); learn(); }
  const waited = await until(() => live(joiner) && live(inviter), 90_000);
  const liveAt = Date.now();
  // The dead WebRTC attempt times out, and the inviter's answer is given up on, while the chat is live: it stays where it is.
  await run(60_000);
  for (const side of [joiner, inviter]) expect(live(side), `${side.link.pairingProgress?.role} still live a minute later`).toBe(true);
  const a = channelOf(joiner) as { peer?: unknown } | undefined;
  if (waited !== Infinity && transportOf(joiner) !== "webrtc/1") expect(a?.peer, "one session, the same connection at both ends").toBe(channelOf(inviter));
  return { answered: answeredAt - joined, liveMs: waited === Infinity ? Infinity : liveAt - joined, transport: transportOf(joiner), irohDials: native.dials + native.dialFailures };
}

beforeEach(useFakeWorld);
afterEach(closeWorld);

describe("a first pairing whose WebRTC is answered and never connects (a VPN that blocks UDP)", () => {
  it.each(["while-gathering", "before-answer", "after-answer"] as const)("goes live over the relayed Iroh about RACE_ANSWERED_MS after the answer, not after the attempt times out (record read %s)", async record => {
    const { answered, liveMs, transport } = await pairBehindVpn(record);
    // Before: 24.2 s here (60 s in zero's lab), the attempt timed out and the next one raced. After: 8.4 s.
    expect(transport, "over the Iroh both run").toBe("iroh/1");
    expect(liveMs, `live ${liveMs} ms after the join (answered at ${answered} ms)`).toBeLessThan(answered + RACE_ANSWERED_MS + 3_000);
  }, 120_000);

  it("with no VPN, the answered offer connects and nothing is raced: live over WebRTC", async () => {
    const { liveMs, transport, irohDials } = await pairBehindVpn("before-answer", false);
    expect(transport).toBe("webrtc/1");
    expect(irohDials, "the relayed Iroh is not dialled").toBe(0);
    expect(liveMs).toBeLessThan(RACE_ANSWERED_MS);
  }, 120_000);
});
