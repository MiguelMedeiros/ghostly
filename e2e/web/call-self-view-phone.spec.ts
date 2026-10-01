import type { Page } from "@playwright/test";
import { connect, expect, link, test } from "../support/fixtures";

/**
 * Your own picture in a video call on a phone (the self view, a box you can drag): turned on its side and back, the
 * phone keeps it in its corner, clear of the notch. It kept its distance from the left edge instead, so on its side it
 * ended up in the middle of the screen, over the contact's face.
 */
const UPRIGHT = { width: 402, height: 874 }, SIDEWAYS = { width: 874, height: 402 };

/** Plays an iPhone 17's safe area (Chromium's DevTools protocol): the status bar and Dynamic Island, the home indicator. */
async function safeArea(page: Page, insets: { top: number; right: number; bottom: number; left: number }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
}

test("a phone turned on its side keeps the call's self view in its corner, clear of the notch", { tag: ["@feature:calls.video", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const alice = await peer("alice");
  const bob = await peer("bob", { mobile: true, viewport: UPRIGHT });
  await link(alice, bob);
  await connect(alice, bob);
  await safeArea(bob.page, { top: 62, right: 0, bottom: 34, left: 0 });
  await alice.page.getByTestId("call-video").click();
  await bob.page.getByTitle("Accept video call").click();
  const self = bob.page.getByTestId("call-self-view");
  await expect(self).toBeVisible();
  const right = async () => { const box = (await self.boundingBox())!; return Math.round(box.x + box.width); };
  // Upright: in the top right corner.
  await expect.poll(right).toBe(UPRIGHT.width - 16);

  // On its side (the Dynamic Island at either end): still at the right, past the island.
  await safeArea(bob.page, { top: 0, right: 62, bottom: 20, left: 62 });
  await bob.page.setViewportSize(SIDEWAYS);
  await expect.poll(right).toBe(SIDEWAYS.width - 62 - 8);
  const box = (await self.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(8);
  expect(box.y + box.height).toBeLessThanOrEqual(SIDEWAYS.height - 20);

  // Upright again: back at the right, below the status bar.
  await safeArea(bob.page, { top: 62, right: 0, bottom: 34, left: 0 });
  await bob.page.setViewportSize(UPRIGHT);
  await expect.poll(right).toBeGreaterThan(UPRIGHT.width - 40);
  expect(await right()).toBeLessThanOrEqual(UPRIGHT.width - 8);
  expect((await self.boundingBox())!.y).toBeGreaterThanOrEqual(62);
  await bob.page.getByTestId("call-hang-up").click();
});
