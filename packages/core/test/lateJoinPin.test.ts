import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, invitation, open, run, useFakeWorld } from "./support/pairingWorld";

// covers: chat.paired.pair-timing, core.dht-direct

/**
 * An inviter whose app restarted a minute after the invite, joined 16 minutes later (bug hunt 1014-0600): it noticed the
 * join late, its packet already over 30 s old, and only a fresh packet read the mailbox at once. The pin (and, in the
 * engine, the native listener it starts) waited for the mailbox's slowed read of an unused invite: 18 s after the joiner
 * was seen, up to ~3 min more. The first sight of the contact reads the mailbox at once, however old its packet.
 */
beforeEach(useFakeWorld);
afterEach(closeWorld);

async function until(check: () => boolean, limit: number): Promise<number> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > limit) return Infinity;
    await run(50);
  }
  return Date.now() - start;
}

it("a restarted inviter seeing a late joiner pins it within a second, not at the mailbox's slowed read", async () => {
  const pkarr = new MemoryPkarr(DESKTOP_NETWORK), made = invitation();
  const options = { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS, link: { rtcAvailable: false } };
  const first = open(made.inviter, pkarr, options);
  first.link.setChatActive(false);
  await run(60_000);
  const stopping = first.link.stop();
  await run(2_000);
  await stopping;
  const inviter = open(made.inviter, pkarr, { ...options, credentials: first.credentials, dhtState: first.dhtState });
  inviter.link.setChatActive(false);
  await vi.advanceTimersByTimeAsync(16 * 60_000 - (Date.now() - made.inviter.createdAt));
  open({ ...made.joiner, createdAt: Date.now() }, pkarr, { dht: true, link: { rtcAvailable: false } });
  expect(await until(() => inviter.progress.some(p => p.peerSeen), 5 * 60_000), "the inviter sees the joiner").toBeLessThan(Infinity);
  expect(await until(() => inviter.pinned.length > 0, 5 * 60_000), "pinned soon after").toBeLessThan(1_000);
}, 120_000);
