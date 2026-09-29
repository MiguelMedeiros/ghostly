import { expect, test, type BrowserContext, type Locator } from "@playwright/test";

/** On a touch screen the home's wallet deck is the app's snapping track: a swipe brings the next card to the centre. */

/**
 * A finger dragged sideways by `share` of the target's width, held still, then lifted (the app's e2e/support/swipe.ts):
 * touch events, as a phone sends them, so the snap alone decides where the track rests.
 */
async function swipe(context: BrowserContext, target: Locator, share: number) {
  const page = target.page();
  const box = (await target.boundingBox())!;
  const cdp = await context.newCDPSession(page);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2,
    dx = box.width * share;
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", at?: number) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: at === undefined ? [] : [{ x: at, y }] });
  await touch("touchStart", x);
  for (let step = 1; step <= 12; step++) await touch("touchMove", x + (dx * step) / 12);
  for (let still = 0; still < 4; still++) {
    await page.waitForTimeout(50);
    await touch("touchMove", x + dx);
  }
  await touch("touchEnd");
  await cdp.detach();
}

test("a phone gets the swipe track, and a swipe chooses the next card", async ({ page, context }) => {
  await page.goto("/");
  const deck = page.locator(".wallet-deck");
  await deck.scrollIntoViewIfNeeded();
  await expect(deck).toHaveAttribute("data-mode", "track");
  // One card whole in the centre, the next peeking: the track is wider than the screen and scrolls.
  const track = page.locator(".wallet-deck-track");
  expect(await track.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // The page never scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // The first touch stops the dealing for good: a tap on the chosen card, then the card the swipe lands on is the one
  // after the card it started from.
  await page.locator(".wallet-deck-card[data-active=true]").tap();
  await page.waitForTimeout(600);
  const from = await page.locator(".wallet-deck-card[data-active=true]").getAttribute("data-testid");
  const rails = await page.locator(".wallet-deck-card").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
  await swipe(context, track, -0.6);
  const next = rails[rails.indexOf(from) + 1]!;
  await expect(page.getByTestId(next)).toHaveAttribute("data-active", "true");
  await expect(page.locator("#wallet-panel")).toHaveAttribute("aria-labelledby", next.replace("wallet-card-", "wallet-tab-"));

  // And it stays there.
  await page.waitForTimeout(4500);
  await expect(page.getByTestId(next)).toHaveAttribute("data-active", "true");
});
