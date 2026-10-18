import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RELAY_POLL_INTERVALS, UNUSED_INVITE_WAIT_MAX_MS } from "../src/link";
import { closeWorld, DESKTOP_NETWORK, invitation, MemoryPkarr, open, rtc, untilLive, useFakeWorld } from "./support/pairingWorld";

// covers: invite.create, invite.code, core.relay-client

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
  // One app, nothing on screen: each reads at its own pace.
  const app = pkarr.transport();
  const inviters = made.map((m) => open(m.inviter, pkarr, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS, transport: app }));
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

/**
 * The other side (bug hunt 1014-0136): 15 chats joined on invites whose inviter never came back (it deleted the chat,
 * its app is gone, the code was dead) were read at the background pace for as long as the app ran, 30 reads a minute,
 * twice what 15 unused invites cost their inviter. A joined chat whose inviter was never seen backs off the same way,
 * counted from the join.
 */
it.each([
  ["ran a minute and stopped", true],
  ["never ran", false],
])("15 joined chats whose inviter %s read a few times a minute between them, and one whose inviter comes back still goes live", async (_, ran) => {
  const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
  const made = Array.from({ length: 15 }, () => invitation());
  if (ran) {
    const gone = made.map((m) => open(m.inviter, pkarr, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS }));
    await vi.advanceTimersByTimeAsync(60_000);
    // Its goodbye goes out as it stops.
    const stopping = Promise.all(gone.map((inviter) => inviter.link.stop()));
    await vi.advanceTimersByTimeAsync(10_000);
    await stopping;
  }
  // One app holds the 15 joined chats.
  const app = pkarr.transport();
  const joiners = made.map((m) => open({ ...m.joiner, createdAt: Date.now() }, pkarr, { dht: true, pollIntervals: RELAY_POLL_INTERVALS, transport: app }));
  // Off screen once joined.
  for (const joiner of joiners) { joiner.link.setChatActive(false); joiner.link.session.setActive(false); }
  await vi.advanceTimersByTimeAsync(11 * 60_000);
  const before = pkarr.reads;
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  // At the background pace: every key and mailbox twice a minute, 60 reads a minute.
  expect((pkarr.reads - before) / 6).toBeLessThan(15);
  // The seventh's inviter comes back: the chat goes live within the longest wait.
  const back = open(made[6].inviter, pkarr, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS });
  expect(await untilLive(back, joiners[6], UNUSED_INVITE_WAIT_MAX_MS + 30_000)).toBeLessThan(UNUSED_INVITE_WAIT_MAX_MS + 30_000);
});

/**
 * Send an invite, close the app, the friend joins, open the app later (bug hunt 1014-0612): the joined chat's mailbox
 * was still read at its unused-invite wait (3 minutes for a join 15 minutes old) after its link saw the inviter online,
 * and the inviter's first text came 127 s after it was back.
 */
it("a joined chat whose inviter comes back 15 minutes later reads its mailbox once its link sees the inviter online", async () => {
  rtc.blocked = true;
  const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
  const made = invitation();
  const gone = open(made.inviter, pkarr, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS });
  await vi.advanceTimersByTimeAsync(5_000);
  const stopping = gone.link.stop();
  await vi.advanceTimersByTimeAsync(10_000);
  await stopping;
  const joiner = open({ ...made.joiner, createdAt: Date.now() }, pkarr, { dht: true, pollIntervals: RELAY_POLL_INTERVALS });
  joiner.link.setChatActive(false); joiner.link.session.setActive(false);
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  const back = open(made.inviter, pkarr, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS, credentials: gone.credentials, dhtState: gone.dhtState });
  back.link.setChatActive(false);
  let seen = Infinity, sent = false;
  for (const start = Date.now(); Date.now() - start < UNUSED_INVITE_WAIT_MAX_MS * 2 && !joiner.received.some((m) => m.text === "hello-from-alice"); await vi.advanceTimersByTimeAsync(250)) {
    if (!sent && back.pinned.length) { sent = true; void back.link.sendMessage("hello-from-alice", Date.now(), "firsttextfromalice0001"); }
    if (seen === Infinity && joiner.link.session.peerPresence.online) seen = Date.now();
  }
  expect(seen).toBeLessThan(Infinity);
  // Read at the first-contact pace once the link sees the inviter, not at the end of the unused-invite wait.
  expect(Date.now() - seen).toBeLessThan(15_000);
}, 60_000);

it("15 joined chats whose inviter never answered still read a few times a minute once the app starts again", async () => {
  const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
  const made = Array.from({ length: 15 }, () => invitation());
  const gone = made.map((m) => open(m.inviter, pkarr, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS }));
  await vi.advanceTimersByTimeAsync(60_000);
  const stopping = Promise.all(gone.map((inviter) => inviter.link.stop()));
  await vi.advanceTimersByTimeAsync(10_000);
  await stopping;
  // One app holds the 15 joined chats, before and after its restart.
  const app = pkarr.transport();
  const joined = made.map((m) => open({ ...m.joiner, createdAt: Date.now() }, pkarr, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS, transport: app }));
  await vi.advanceTimersByTimeAsync(60_000);
  // The inviter's first envelope pinned it: the chat is saved as paired, and opened so again (no pairing progress).
  expect(joined.every((j) => j.pinned.length === 1 && j.dhtState.unanswered === j.dhtState.peerSequence)).toBe(true);
  const closing = Promise.all(joined.map((j) => j.link.stop()));
  await vi.advanceTimersByTimeAsync(10_000);
  await closing;
  for (const [i, m] of made.entries()) open({ ...m.joiner, old: true }, pkarr, { dht: true, active: false, pollIntervals: RELAY_POLL_INTERVALS, credentials: joined[i].credentials, dhtState: joined[i].dhtState, transport: app });
  await vi.advanceTimersByTimeAsync(11 * 60_000);
  const before = pkarr.reads;
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  expect((pkarr.reads - before) / 6).toBeLessThan(15);
});
