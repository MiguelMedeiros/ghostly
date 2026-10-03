import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "../src/identity";
import { createLink } from "../src/invite";
import { LinkSession, RELAY_POLL_INTERVALS } from "../src/link";
import type { GhostRecord, SignedPacket } from "../src/pkarr";
import type { DiscoveryChange, PkarrTransport } from "../src/transport";

// covers: core.relay-breaker

/**
 * What a relay that answers again costs a profile whose contacts are away. Every link hears it (`subscribe`), and each
 * one read its contact at once, whatever its pace: one relay flipping between throttled and answering (a 429's rest
 * ending, as the Desktop reports it) made 42 reads a flip on a profile of 42 mostly offline chats.
 */

const NOW = 1_800_000_000_000;
const I = RELAY_POLL_INTERVALS;
const N = 40;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => void vi.useRealTimers());

/** An in-memory Pkarr every link shares, with a relay-health feed the test drives and every read counted. */
function network() {
  const packets = new Map<string, SignedPacket>();
  const listeners = new Set<(change?: DiscoveryChange) => void>();
  const answered = new Map<string, number>();
  const t = {
    reads: 0,
    failResolve: false,
    /** The read is held back: the transport hands back the copy it kept, the network answered nothing. */
    kept: false,
    publish: vi.fn(async (identity: Identity, records: GhostRecord[]) => {
      packets.set(identity.pubKeyZ32, { pubKeyZ32: identity.pubKeyZ32, timestampMicros: BigInt(Date.now()) * 1000n, records });
    }),
    resolve: vi.fn(async (key: string) => {
      t.reads++;
      if (t.failResolve) throw new Error("relays unreachable");
      if (!t.kept) answered.set(key, Date.now());
      return packets.get(key) ?? null;
    }),
    readAnsweredAt: (key: string) => answered.get(key),
    describe: () => ({ protocol: "memory", relays: [] }),
    subscribe(listener: (change?: DiscoveryChange) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    flip() { for (const listener of listeners) listener("recovered"); },
  };
  return t satisfies PkarrTransport;
}

/** `count` chats whose contacts were online once and went away 20 minutes ago, each link reading at its own pace. */
async function awayChats(net: ReturnType<typeof network>, count: number): Promise<LinkSession[]> {
  const links: LinkSession[] = [];
  for (let i = 0; i < count; i++) {
    const { mine, invite } = createLink();
    const contact = new LinkSession({ params: invite, transport: net, pollIntervals: I, getServices: () => [] });
    contact.start();
    await vi.advanceTimersByTimeAsync(0);
    await contact.stop(true);
    links.push(new LinkSession({ params: mine, transport: net, pollIntervals: I }));
  }
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  for (const link of links) link.start();
  // Past the first reads and into the background pace.
  await vi.advanceTimersByTimeAsync(2 * I.background + 1_000);
  return links;
}

describe("a relay that answers again", () => {
  it("costs reads per minute bounded by the links' own pace, not one more read per chat each time it flips", async () => {
    const net = network();
    const links = await awayChats(net, N);
    const before = net.reads;
    // One relay throttled and answering again every 15 s, for a minute.
    for (let i = 0; i < 4; i++) {
      net.flip();
      await vi.advanceTimersByTimeAsync(15_000);
    }
    const perMinute = net.reads - before;
    // Each link reads at its background pace (twice a minute); the flips add nothing for links whose reads are answered.
    expect(perMinute).toBeLessThanOrEqual(N * (60_000 / I.background) + N / 4);
    await Promise.all(links.map(link => link.stop(false)));
  });

  it("reads at once on the links whose last read failed or was answered from a kept copy, and on one looking for its contact", async () => {
    const net = network();
    const [failed, kept, watched, quiet] = await awayChats(net, 4);
    net.failResolve = true;
    failed.pollNow();
    await vi.advanceTimersByTimeAsync(0);
    net.failResolve = false;
    net.kept = true;
    kept.pollNow();
    await vi.advanceTimersByTimeAsync(0);
    net.kept = false;
    watched.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    const reads = new Map([failed, kept, watched, quiet].map(link => [link, 0]));
    net.resolve.mockClear();
    const keyOf = new Map([failed, kept, watched, quiet].map(link => [(link as unknown as { peerPubKeyZ32: string }).peerPubKeyZ32, link]));
    net.flip();
    await vi.advanceTimersByTimeAsync(0);
    for (const [key] of net.resolve.mock.calls) { const link = keyOf.get(key)!; reads.set(link, reads.get(link)! + 1); }
    expect(reads.get(failed), "the link whose read failed").toBe(1);
    expect(reads.get(kept), "the link whose read was a kept copy").toBe(1);
    expect(reads.get(watched), "the link on screen").toBe(1);
    expect(reads.get(quiet), "a link whose read was answered, at the background pace").toBe(0);
    await Promise.all([failed, kept, watched, quiet].map(link => link.stop(false)));
  });
});
