import { expect, test } from "@playwright/test";
import { swipe } from "./swipe";

/** On a touch screen the home's wallet deck is the app's snapping track: a swipe brings the next card to the centre. */

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
