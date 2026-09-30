import type { Page } from "@playwright/test";
import { connect, expect, link, test, type Peer } from "../support/fixtures";

/**
 * A call's buttons stay round and off the edges on a narrow screen. With Share screen (a browser that can capture one,
 * in a narrow window) the row had five buttons of 64 px with 32 px between them: wider than 375 px, so flex squeezed
 * four of them into ovals pressed against both edges. A phone's browser has no screen capture, but its video call has
 * four: microphone, camera (once the video lane is open), devices and hang up, 360 px with those gaps, past a 320 px
 * phone. The row is measured once all of them are there.
 */
/** Buttons of the row that are squeezed out of round (flex shrinks them) or reach the screen's edges. */
const misshapen = (page: Page) => page.getByTestId("call-hang-up").evaluate((hangUp) => {
  const width = document.documentElement.clientWidth;
  return [...hangUp.parentElement!.children].map((b) => b.getBoundingClientRect())
    .filter((r) => r.width > 0 && (Math.abs(r.width - r.height) > 1 || r.left < 4 || r.right > width - 4))
    .map((r) => `${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.left)}..${Math.round(r.right)} of ${width}`);
});

for (const { width, share } of [{ width: 320, share: false }, { width: 375, share: true }]) {
  test(`the call's buttons fit a ${width} px phone${share ? ", Share screen too" : ""}`, { tag: ["@feature:calls.video"] }, async ({ peer }) => {
    const alice = await peer("alice");
    const bob: Peer = await peer("bob", { mobile: true, viewport: { width, height: 740 } });
    // A phone's browser has no screen capture, so its row has no Share screen button.
    if (!share) {
      await bob.page.addInitScript(() => { delete (MediaDevices.prototype as { getDisplayMedia?: unknown }).getDisplayMedia; });
      await bob.page.reload();
      await expect(bob.page.getByTitle("New Chat")).toBeVisible();
    }
    await link(alice, bob);
    await connect(alice, bob);
    await alice.page.getByTestId("call-video").click();
    await bob.page.getByTitle("Accept video call").click();
    await expect(bob.page.getByTestId("call-hang-up")).toBeVisible();
    await expect(bob.page.getByTestId("call-camera")).toBeVisible();
    await expect(bob.page.getByTestId("call-devices")).toBeVisible();
    await expect(bob.page.getByTestId("share-screen")).toHaveCount(share ? 1 : 0);
    await expect.poll(() => misshapen(bob.page)).toEqual([]);
    await bob.page.getByTestId("call-hang-up").click();
  });
}

/** Plays an iPhone 17's safe area (Chromium's DevTools protocol): the status bar and Dynamic Island, the home indicator. */
async function safeArea(page: Page, insets: { top: number; right: number; bottom: number; left: number }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
}

test("an installed iPhone: the call's corner button stays clear of the status bar, and of the notch on its side", { tag: ["@feature:calls.video", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const alice = await peer("alice");
  const bob = await peer("bob", { mobile: true, viewport: { width: 402, height: 874 } });
  await link(alice, bob);
  await connect(alice, bob);
  await safeArea(bob.page, { top: 62, right: 0, bottom: 34, left: 0 });
  await alice.page.getByTestId("call-video").click();
  await bob.page.getByTitle("Accept video call").click();
  const corner = bob.page.getByTestId("call-minimize");
  await expect(corner).toBeVisible();
  // Upright: below the status bar (62px on an iPhone 17; black-translucent, the page runs under it). It was at 16.
  await expect.poll(async () => (await corner.boundingBox())!.y).toBeGreaterThanOrEqual(62);

  // On its side, the Dynamic Island at the left end: past it.
  await bob.page.setViewportSize({ width: 874, height: 402 });
  await safeArea(bob.page, { top: 0, right: 62, bottom: 20, left: 62 });
  await expect.poll(async () => (await corner.boundingBox())!.x).toBeGreaterThanOrEqual(62);
  // The small window keeps its button in its own corner.
  await corner.click();
  await expect(bob.page.getByTestId("call-window")).toHaveAttribute("data-mini", "true");
  const small = (await bob.page.getByTestId("call-window").boundingBox())!, button = (await corner.boundingBox())!;
  expect(button.x - small.x).toBeLessThan(20);
  await bob.page.getByTestId("call-hang-up").click();
});
