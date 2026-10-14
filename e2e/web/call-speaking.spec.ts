import { expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * Who is speaking in a call: each side's avatar wears a ring that follows its voice. Chromium's fake
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

test("a voice call shows your own side too, ringed by your microphone and quiet while you are muted", { tag: ["@feature:calls.speaking", "@feature:calls.audio", "@feature:calls.mini-window"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("speaking-self-alice"), peer("speaking-self-bob")]);
  await pair(alice, bob);
  await alice.page.getByTestId("call-audio").click();
  await bob.page.getByTitle("Accept audio call").click();
  for (const p of [alice, bob]) await expect(p.page.getByTestId("call-status")).toHaveAttribute("data-state", "connected");

  // Beside the contact, smaller: Alice, with her own microphone's ring.
  const you = alice.page.getByTestId("call-self-avatar");
  await expect(you).toHaveAttribute("data-speaking", "true");
  const sizes = () => alice.page.evaluate(() => ["call-peer-avatar", "call-self-avatar"].map((id) => Math.round(document.querySelector(`[data-testid=${id}]`)!.getBoundingClientRect().width)));
  expect(await sizes()).toEqual([96, 64]);
  await alice.page.screenshot({ path: testInfo.outputPath("both.png") });

  // Muted, her ring is gone for good, and Bob's side of her is quiet too; his own goes on.
  await alice.page.getByTestId("call-mute").click();
  await expect(you).toHaveAttribute("data-muted", "true");
  await expect(you).not.toHaveAttribute("data-speaking");
  await expect(bob.page.getByTestId("call-self-avatar")).toHaveAttribute("data-speaking", "true");
  await alice.page.getByTestId("call-mute").click();
  await expect(you).toHaveAttribute("data-speaking", "true");

  // The small window holds both, inside its box.
  await alice.page.getByTestId("call-minimize").click();
  await expect(alice.page.getByTestId("call-window")).toHaveAttribute("data-mini", "true");
  expect(await sizes()).toEqual([44, 32]);
  await expect(you).toHaveAttribute("data-speaking", "true");
  const inside = await alice.page.evaluate(() => {
    const box = document.querySelector("[data-testid=call-window]")!.getBoundingClientRect();
    return [...document.querySelectorAll(".call-peer")].every((side) => {
      const at = side.getBoundingClientRect();
      return at.left >= box.left && at.right <= box.right && at.top >= box.top && at.bottom <= box.bottom;
    });
  });
  expect(inside).toBe(true);
  await alice.page.screenshot({ path: testInfo.outputPath("both-small.png") });

  // With a camera on, your picture stands for you: no avatar of yours.
  await alice.page.getByTestId("call-minimize").click();
  await alice.page.getByTestId("call-camera").click();
  await expect(alice.page.getByTestId("call-self-view")).toBeVisible();
  await expect(you).toHaveCount(0);

  await alice.page.getByTestId("call-hang-up").click();
  await expect(bob.page.getByTitle("End call")).toHaveCount(0);
});

/**
 * What of the small call window's middle reaches the state line above it or the buttons below it: each avatar with
 * the widest ring it can wear there (3 + 4 px, index.css), and each name that shows.
 */
const crowded = (p: Peer) => p.page.evaluate(() => {
  const win = document.querySelector("[data-testid=call-window]")!;
  const box = (el: Element, pad = 0) => { const r = el.getBoundingClientRect(); return { l: r.left - pad, t: r.top - pad, r: r.right + pad, b: r.bottom + pad }; };
  const meet = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  const shown = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const line = [...win.querySelectorAll("[data-testid=call-status] span")].filter(shown).map((el) => box(el));
  const buttons = [...win.querySelectorAll(".call-controls button")].map((el) => box(el));
  const out: string[] = [];
  for (const avatar of win.querySelectorAll<HTMLElement>(".call-avatar")) {
    if (line.some((at) => meet(box(avatar, 7), at))) out.push(`${avatar.dataset.testid} reaches the state line`);
    if (buttons.some((at) => meet(box(avatar, 7), at))) out.push(`${avatar.dataset.testid} reaches the buttons`);
  }
  for (const name of [...win.querySelectorAll(".call-name")].filter(shown)) {
    if (line.some((at) => meet(box(name), at))) out.push(`"${name.textContent}" runs into the state line`);
    if (buttons.some((at) => meet(box(name), at))) out.push(`"${name.textContent}" runs into the buttons`);
  }
  return out;
});

test("on a phone the small window keeps the state line, the avatars with their ring, the names and the buttons apart", { tag: ["@feature:calls.speaking", "@feature:calls.mini-window", "@feature:app.i18n"] }, async ({ peer }, testInfo) => {
  // A phone opens the small window at its smallest width, 190 x 136 px. In Arabic: right to left.
  const [alice, bob] = await Promise.all([peer("speaking-phone-alice", { mobile: true, viewport: { width: 320, height: 568 } }), peer("speaking-phone-bob")]);
  await pair(alice, bob);
  await alice.page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language: "ar" }));
  });
  await alice.page.reload();
  for (const p of [alice, bob]) await expect(p.page.getByTestId("call-audio")).toBeEnabled({ timeout: 90_000 });
  const callWindow = alice.page.getByTestId("call-window");
  const small = async () => {
    await alice.page.getByTestId("call-audio").click();
    await bob.page.getByTitle("Accept audio call").click();
    await expect(alice.page.getByTestId("call-status")).toHaveAttribute("data-state", "connected");
    // The next call opens as the last one was left: small.
    if ((await callWindow.getAttribute("data-mini")) !== "true") await alice.page.getByTestId("call-minimize").click();
    await expect(callWindow).toHaveAttribute("data-mini", "true");
    await expect(alice.page.getByTestId("call-self-avatar")).toHaveAttribute("data-speaking", "true");
  };
  const hangUp = async () => {
    await alice.page.getByTestId("call-hang-up").click();
    await expect(bob.page.getByTitle("End call")).toHaveCount(0);
  };

  await small();
  expect(await callWindow.evaluate((el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height])).toEqual([190, 136]);
  expect(await crowded(alice)).toEqual([]);
  await alice.page.screenshot({ path: testInfo.outputPath("phone-small.png") });
  // The contact's name shows; yours is there for a screen reader, beside the avatar that is yours.
  await expect(callWindow.locator(".call-name").first()).toBeVisible();
  await expect(callWindow.locator(".call-self .call-name")).toHaveText("أنت");
  await hangUp();

  // As low as a pulled corner takes it, 128 px.
  await alice.page.evaluate(() => localStorage.setItem("ghostly_call_window_box", JSON.stringify({ x: 114, y: 336, w: 190, h: 128 })));
  await small();
  expect(await callWindow.evaluate((el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height])).toEqual([190, 128]);
  expect(await crowded(alice)).toEqual([]);
  await alice.page.screenshot({ path: testInfo.outputPath("phone-small-lowest.png") });
  await hangUp();
});
