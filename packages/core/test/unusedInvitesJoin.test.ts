import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RELAY_POLL_INTERVALS, UNUSED_INVITE_WAIT_MAX_MS } from "../src/link";
import { closeWorld, DESKTOP_NETWORK, invitation, MemoryPkarr, open, untilLive, useFakeWorld } from "./support/pairingWorld";

// covers: invite.create, core.relay-client

/**
 * A daemon with 15 invites nobody used (bug hunt 1013-1642): their keys and mailboxes were read at the background pace
 * for as long as it ran, 60 reads a minute where the relays give the background 20, and a join after 12 minutes was
 * noticed 86-90 s later. Once no longer awaited, an unused invite is read less often the older it is.
 */
beforeEach(() => useFakeWorld());
afterEach(() => closeWorld());

it("15 unused invites read a few times a minute between them, and a join on one still goes live", async () => {
  const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
  const made = Array.from({ length: 15 }, () => invitation());
  // Nothing on screen: each reads at its own pace.
  const inviters = made.map((m) => open(m.inviter, pkarr, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS }));
  for (const inviter of inviters) inviter.link.setChatActive(false);
  await vi.advanceTimersByTimeAsync(11 * 60_000);
  const before = pkarr.reads;
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  // At the background pace: every key and mailbox twice a minute, 60 reads a minute.
  expect((pkarr.reads - before) / 6).toBeLessThan(15);
  // A join on the seventh: noticed within the longest wait, and live.
  const joiner = open(made[6].joiner, pkarr, { dht: true, pollIntervals: RELAY_POLL_INTERVALS });
  expect(await untilLive(inviters[6], joiner, UNUSED_INVITE_WAIT_MAX_MS + 30_000)).toBeLessThan(UNUSED_INVITE_WAIT_MAX_MS + 30_000);
});
