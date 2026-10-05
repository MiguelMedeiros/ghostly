import { chat, connect, expect, link, say, test } from "../support/fixtures";
import { skewClock } from "../support/clock";

/**
 * Two people whose devices' clocks differ, as real ones do. Reported 2026-10-01: a first pairing between clocks two
 * minutes apart never completed. On the web a chat goes live over WebRTC alone here (no Iroh relay in this suite), and
 * every offer and answer of the other side read as "older than 120 s" or "from the future" and was dropped; the
 * capability record and the DHT envelopes of the side that was ahead were refused too, with nothing on screen.
 */
const AHEAD = 2 * 60_000;

test("a device whose clock is three minutes ahead says so, in the chat's connection panel and in Settings, Network; one whose clock is right says nothing", { tag: ["@feature:app.clock-off"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob", { beforeOpen: (context) => skewClock(context, 3 * 60_000) })]);
  await link(alice, bob);
  await connect(alice, bob);
  // Bob's app read the relays' own time on their answers (two of the three relay names is enough), and it is not his.
  await bob.page.getByTestId("connection-options").click();
  const note = bob.page.getByTestId("connection-clock-off");
  await expect(note).toContainText("This device's clock seems to be off by about 3 minutes. Chats may be slow to connect.");
  await note.getByTestId("connection-clock-off-info").click();
  await expect(note.getByTestId("connection-clock-off-text")).toContainText("about 3 minutes ahead of what the relays and your contacts' devices say");
  // Alice's clock is right: her contact's being off is one contact's word, and says nothing about hers.
  await alice.page.getByTestId("connection-options").click();
  await expect(alice.page.getByRole("dialog", { name: "Connection options" })).toBeVisible();
  await expect(alice.page.getByTestId("connection-clock-off")).toHaveCount(0);
  await bob.page.goto("/#/settings/network");
  await expect(bob.page.getByTestId("network-clock-off")).toContainText("off by about 3 minutes");
  // He sets his clock: the next answers agree with it, and the note goes.
  await bob.page.evaluate(() => { (globalThis as { clockOffset?: number }).clockOffset = 0; });
  await expect(bob.page.getByTestId("network-clock-off")).toHaveCount(0);
});

test("a first pairing with a contact whose clock is two minutes ahead goes live, and both ways deliver", { tag: ["@feature:chat.paired.clock-skew"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob", { beforeOpen: (context) => skewClock(context, AHEAD) })]);
  expect(await bob.page.evaluate(() => Date.now()) - await alice.page.evaluate(() => Date.now())).toBeGreaterThan(AHEAD - 5_000);
  await link(alice, bob);
  // Texts both ways and the WebRTC data link up: what `connect` checks for any two peers.
  await connect(alice, bob);
  await say(bob, "from the future");
  await expect(chat(alice).getByText("from the future", { exact: true })).toBeVisible();
});

test("a first pairing with a contact whose clock is two minutes behind goes live: its first packet is not hidden by the inviter's warm one", { tag: ["@feature:chat.paired.clock-behind"] }, async ({ peer }) => {
  // The inviter warms the key it gives its contact with an empty packet. Dated by the inviter's clock, it was later
  // than everything the joiner published until the joiner's clock caught up, and the relay kept it in their place.
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob", { beforeOpen: (context) => skewClock(context, -AHEAD) })]);
  expect(await alice.page.evaluate(() => Date.now()) - await bob.page.evaluate(() => Date.now())).toBeGreaterThan(AHEAD - 5_000);
  await link(alice, bob);
  await connect(alice, bob);
  await say(bob, "from the past");
  await expect(chat(alice).getByText("from the past", { exact: true })).toBeVisible();
});
