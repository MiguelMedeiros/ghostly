import { expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * Who is speaking in a call: the contact's avatar wears a ring that follows their voice. Chromium's fake
 * microphone beeps about once a second, so each side "speaks" in bursts and the ring comes and goes with them.
 */

const avatar = (peer: Peer) => peer.page.getByTestId("call-peer-avatar");

/** How wide the ring on the contact's avatar is right now, in px: 0 with no ring. */
const ring = (peer: Peer) =>
  avatar(peer).evaluate((el) => {
    const spread = /(-?[\d.]+)px$/.exec(getComputedStyle(el).boxShadow.replace(/rgba?\([^)]*\)|color\([^)]*\)/g, "").trim());
    return el.dataset.speaking === "true" && spread ? Number(spread[1]) : 0;
  });

/** The widest and the narrowest ring seen while the contact spoke, over `ms`. */
async function rings(peer: Peer, ms: number) {
  const seen: number[] = [];
  for (const until = Date.now() + ms; Date.now() < until; await peer.page.waitForTimeout(50)) seen.push(await ring(peer));
  const on = seen.filter((width) => width > 0);
  return { widest: Math.max(0, ...on), narrowest: Math.min(...on, Infinity), marked: on.length };
}

test("a voice call rings the contact's avatar while they speak, and not while they are muted", { tag: ["@feature:calls.speaking", "@feature:calls.audio", "@feature:calls.mini-window"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("speaking-alice"), peer("speaking-bob")]);
  await pair(alice, bob);
  await alice.page.getByTestId("call-audio").click();
  await bob.page.getByTitle("Accept audio call").click();
  for (const p of [alice, bob]) await expect(p.page.getByTestId("call-status")).toHaveAttribute("data-state", "connected");

  // Alice's microphone beeps: Bob sees her avatar ringed, wider than the resting 3 px at the loudest of it.
  await expect(avatar(bob)).toHaveAttribute("data-speaking", "true");
  await expect.poll(() => ring(bob)).toBeGreaterThan(3);
  await bob.page.screenshot({ path: testInfo.outputPath("speaking.png") });

  // In the small window too.
  await bob.page.getByTestId("call-minimize").click();
  await expect(bob.page.getByTestId("call-window")).toHaveAttribute("data-mini", "true");
  await expect.poll(() => ring(bob)).toBeGreaterThan(2);
  await bob.page.screenshot({ path: testInfo.outputPath("speaking-small.png") });
  await bob.page.getByTestId("call-minimize").click();

  // Muted, she sends silence: the ring goes and stays away, through what would have been two beeps.
  await alice.page.getByTestId("call-mute").click();
  await expect(avatar(bob)).toHaveAttribute("data-speaking", "false");
  expect((await rings(bob, 2500)).marked).toBe(0);

  // And it is back with her voice.
  await alice.page.getByTestId("call-mute").click();
  await expect(avatar(bob)).toHaveAttribute("data-speaking", "true");

  await alice.page.getByTestId("call-hang-up").click();
  await expect(bob.page.getByTitle("End call")).toHaveCount(0);
});

test("with motion reduced the ring is steady: there while the contact speaks, never moving", { tag: ["@feature:calls.speaking", "@feature:app.reduce-motion"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("speaking-still-alice"), peer("speaking-still-bob")]);
  await pair(alice, bob);
  await bob.page.emulateMedia({ reducedMotion: "reduce" });
  await alice.page.getByTestId("call-audio").click();
  await bob.page.getByTitle("Accept audio call").click();
  await expect(bob.page.getByTestId("call-status")).toHaveAttribute("data-state", "connected");

  await expect(avatar(bob)).toHaveAttribute("data-speaking", "true");
  const still = await rings(bob, 2500);
  expect(still.marked).toBeGreaterThan(0);
  expect([still.narrowest, still.widest]).toEqual([3, 3]);

  // The app's own switch does the same as the system's.
  await bob.page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(async () => (await rings(bob, 1500)).widest).toBeGreaterThan(3);
  await bob.page.evaluate(() => { document.documentElement.dataset.reduceMotion = "true"; });
  const switched = await rings(bob, 2500);
  expect(switched.marked).toBeGreaterThan(0);
  expect([switched.narrowest, switched.widest]).toEqual([3, 3]);

  await alice.page.getByTestId("call-hang-up").click();
  await expect(bob.page.getByTitle("End call")).toHaveCount(0);
});
