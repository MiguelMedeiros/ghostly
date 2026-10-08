import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INVITER_DIAL_GRACE_MS, type GhostLink } from "../src/ghostlink";
import type { NativeEndpoint, PairedTransport, TransportDescriptors } from "../src/pairedTransports";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, invitationWhere, open, run, useFakeWorld, type Opened } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";

// covers: chat.one-chat, chat.paired.pair-timing, core.dht-direct

/**
 * Two Linux Desktops pair from a fresh invite: WebKitGTK has no WebRTC, so the joiner's first packet carries no offer,
 * and the chat goes live on a native transport once a side reads the other's capability record (its descriptors).
 * The inviter used to wait `INVITER_DIAL_GRACE_MS` for an offer that could not come before dialling, and the joiner,
 * still reading, often did not dial meanwhile: 2.5 s of the ~11 s two Desktops took on the DHT alone (dht-direct on
 * CI, 2026-10-07). In-memory Pkarr and native transports on fake time; the record read is the engine's
 * (`peerCapsChanged` → `learnPeerTransports`), stood in for here.
 */

interface Desk { side: Opened; endpoint: NativeEndpoint; dials: number[] }

function desktop(native: NativeWorld, name: string, side: Opened): Desk {
  const endpoint = native.endpoint("hyperdht/1", name);
  const desk: Desk = { side, endpoint, dials: [] };
  const connect = endpoint.connect.bind(endpoint);
  endpoint.connect = async descriptor => { desk.dials.push(Date.now()); return connect(descriptor); };
  side.link.registerEndpoint(endpoint);
  return desk;
}

/** What the contact's capability record says: the transports its app runs (no WebRTC), and how to dial them. */
const record = (desk: Desk): [PairedTransport[], TransportDescriptors] =>
  [["hyperdht/1"], { "hyperdht/1": desk.endpoint.descriptor } as TransportDescriptors];

const channelOf = (link: GhostLink) => (link as unknown as { channel: unknown }).channel;
const live = (desk: Desk) => desk.side.link.isDataLinkOpen && desk.side.link.pairingProgress?.stage === "live";

async function until(check: () => boolean, limit: number): Promise<number> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > limit) return Infinity;
    await run(50);
  }
  return Date.now() - start;
}

/** A fresh invite between two Desktops with no WebRTC, each with its HyperDHT endpoint up; the inviter's key dials. */
async function pair(dialer: "inviter" | "joiner"): Promise<{ native: NativeWorld; inviter: Desk; joiner: Desk }> {
  const pkarr = new MemoryPkarr(DESKTOP_NETWORK), native = new NativeWorld(), made = invitationWhere(dialer);
  const inviter = desktop(native, "ana", open(made.inviter, pkarr, { dht: true, link: { rtcAvailable: false } }));
  await run(2_000);
  const joiner = desktop(native, "bia", open(made.joiner, pkarr, { dht: true, link: { rtcAvailable: false } }));
  // The inviter sees the joiner and has pinned it, as when it reads the joiner's record (only a pinned contact's is read).
  const seen = await until(() => inviter.side.progress.some(p => p.peerSeen) && !!inviter.side.credentials.peerKey, 60_000);
  expect(seen, "the inviter sees the joiner").toBeLessThan(Infinity);
  return { native, inviter, joiner };
}

beforeEach(useFakeWorld);
afterEach(closeWorld);

describe("a first pairing with no WebRTC on either side", () => {
  it.each(["inviter", "joiner"] as const)("the inviter dials the joiner's native transport as soon as its record says how, not after the grace an offer gets (the %s's key is lower)", async dialer => {
    const { inviter, joiner } = await pair(dialer);
    expect(inviter.dials, "nothing to dial before the record").toEqual([]);
    const learnt = Date.now();
    inviter.side.link.learnPeerTransports(...record(joiner), true);
    const took = await until(() => inviter.dials.length > 0, 10_000);
    expect(took, "the inviter dials").toBeLessThan(Infinity);
    expect(inviter.dials[0] - learnt, "at once, not after the inviter's grace").toBeLessThan(INVITER_DIAL_GRACE_MS / 5);
    expect(await until(() => live(inviter) && live(joiner), 10_000), "live on both sides").toBeLessThan(Infinity);
    expect(inviter.side.link.isDataLinkOpen && joiner.side.link.isDataLinkOpen).toBe(true);
  }, 60_000);

  it.each(["inviter", "joiner"] as const)("both reading each other's record at once dial each other, and one session carries the chat on both sides (the %s's key is lower)", async dialer => {
    const { native, inviter, joiner } = await pair(dialer);
    joiner.side.link.learnPeerTransports(...record(inviter), true);
    inviter.side.link.learnPeerTransports(...record(joiner), true);
    expect(await until(() => live(inviter) && live(joiner), 10_000), "live on both sides").toBeLessThan(Infinity);
    expect(inviter.dials.length + joiner.dials.length, "each dialled once").toBe(2);
    // The two ends of one connection: the crossing settled on the same one at both sides, and it stays.
    await run(15_000);
    for (const desk of [inviter, joiner]) expect(live(desk), `${desk.side.link.pairingProgress?.role} still live`).toBe(true);
    const a = channelOf(inviter.side.link) as { peer?: unknown }, b = channelOf(joiner.side.link);
    expect(a?.peer, "one session, the same connection at both ends").toBe(b);
    expect(native.dials, "no dial after the crossing").toBe(2);
  }, 60_000);
});
