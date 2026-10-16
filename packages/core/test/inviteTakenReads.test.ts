import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, invitation, open, useFakeWorld, yieldToLoop } from "./support/pairingWorld";

// covers: chat.one-chat, core.peer-keys

/**
 * A joiner told the invite was taken (someone else used it first) can never pair with its inviter: while that inviter
 * is online, heartbeating, the chat does not read it at the pace of a first contact under way. 20 minutes of a lab
 * (three CLI daemons on one relay) read 16 requests a minute for it, 30 a minute for the 2 minutes after each of the
 * inviter's heartbeats (bug hunt 1014-1317).
 */

async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 250) { await vi.advanceTimersByTimeAsync(250); await yieldToLoop(); }
}
async function until(check: () => boolean, limit: number): Promise<number> {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > limit) return Infinity; await run(250); }
  return Date.now() - start;
}

beforeEach(useFakeWorld);
afterEach(closeWorld);

describe("a joiner whose invite someone else used first", () => {
  it("reads its online inviter at a slow pace, not a first contact's", async () => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK), made = invitation();
    const inviter = open(made.inviter, pkarr, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS });
    await run(2_000);
    const first = open({ ...made.joiner, seedB64: createIdentity().seedB64 }, pkarr, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS });
    expect(await until(() => inviter.link.isDataLinkOpen && first.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    await run(60_000);

    // The second joiner reads through a transport of its own: its requests, apart from the pair's.
    let reads = 0;
    const counted = Object.assign(Object.create(pkarr) as MemoryPkarr, { transport: () => {
      const transport = pkarr.transport();
      return { ...transport, resolve: (...args: Parameters<typeof transport.resolve>) => { reads++; return transport.resolve(...args); } };
    } });
    const second = open(made.joiner, counted, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS, credentials: { seedB64: made.joiner.seedB64, expectedPeerKey: identityFromSeedB64(made.inviter.seedB64).pubKeyZ32 } });
    expect(await until(() => !!second.dhtView?.inviteTaken, 60_000)).toBeLessThan(Infinity);
    expect(second.link.pairingProgress).toMatchObject({ stage: "failed", reason: "taken" });

    // Reads per minute for 20 minutes, the inviter heartbeating every 4. The first minute ends the join's own offer
    // (its answer looked for every 2 s), once.
    const perMinute: number[] = [];
    for (let m = 0; m < 20; m++) { const before = reads; await run(60_000); perMinute.push(reads - before); }
    expect(second.link.pairingProgress?.reason, "still taken").toBe("taken");
    expect(inviter.link.isDataLinkOpen, "the inviter stays online with the first joiner").toBe(true);
    const after = perMinute.slice(1), total = after.reduce((a, b) => a + b, 0);
    expect(Math.max(...after), `no burst at the inviter's heartbeats: ${perMinute.join(" ")}`).toBeLessThanOrEqual(5);
    expect(total / after.length, `${total} reads in ${after.length} min: ${perMinute.join(" ")}`).toBeLessThanOrEqual(3);
  }, 240_000);
});
