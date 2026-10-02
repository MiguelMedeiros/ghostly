import { chat, connect, expect, link, say, test } from "../support/fixtures";
import { skewClock } from "../support/clock";

/**
 * Two people whose devices' clocks differ, as real ones do. Reported 2026-10-01: a first pairing between clocks two
 * minutes apart never completed. On the web a chat goes live over WebRTC alone here (no Iroh relay in this suite), and
 * every offer and answer of the other side read as "older than 120 s" or "from the future" and was dropped; the
 * capability record and the DHT envelopes of the side that was ahead were refused too, with nothing on screen.
 */
const AHEAD = 2 * 60_000;

test("a first pairing with a contact whose clock is two minutes ahead goes live, and both ways deliver", { tag: ["@feature:chat.paired.clock-skew"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob", { beforeOpen: (context) => skewClock(context, AHEAD) })]);
  expect(await bob.page.evaluate(() => Date.now()) - await alice.page.evaluate(() => Date.now())).toBeGreaterThan(AHEAD - 5_000);
  await link(alice, bob);
  // Texts both ways and the WebRTC data link up: what `connect` checks for any two peers.
  await connect(alice, bob);
  await say(bob, "from the future");
  await expect(chat(alice).getByText("from the future", { exact: true })).toBeVisible();
});
