import { expect, test } from "../support/fixtures";

/**
 * A phone on its side (iPhone 17: 874 by 402, the Dynamic Island 62px into one end, the home indicator 20px
 * above the bottom). The page runs under both (viewport-fit=cover), so the app keeps its content clear of the
 * sides. Chromium's DevTools protocol plays the safe area.
 */
const LANDSCAPE = { width: 874, height: 402 };
const SIDE = 62;

test("a phone on its side: nothing sits under the notch", { tag: ["@feature:app.mobile-layout", "@feature:app.responsive"] }, async ({ peer }) => {
  const { page } = await peer("alice", { mobile: true, viewport: LANDSCAPE });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { left: SIDE, right: SIDE, top: 0, bottom: 20 } });
  await expect.poll(() => page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("div"));
    probe.style.paddingLeft = "env(safe-area-inset-left)";
    const inset = getComputedStyle(probe).paddingLeft;
    probe.remove();
    return inset;
  })).toBe(`${SIDE}px`);

  for (const locator of [page.getByPlaceholder("Search chats..."), page.getByTitle("New Chat").first()]) {
    const box = (await locator.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(SIDE);
    expect(box.x + box.width).toBeLessThanOrEqual(LANDSCAPE.width - SIDE);
  }
  // Nothing wider than the screen for the insets.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(LANDSCAPE.width);

  // A chat: its header and composer too.
  await page.getByTitle("New Chat").first().click();
  for (const locator of [page.getByPlaceholder("Message…"), page.getByTestId("chat-options")]) {
    const box = (await locator.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(SIDE);
    expect(box.x + box.width).toBeLessThanOrEqual(LANDSCAPE.width - SIDE);
  }
});
