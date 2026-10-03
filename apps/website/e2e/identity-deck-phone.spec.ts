import { expect, test } from "@playwright/test";
import { swipe } from "./swipe";

/** On a touch screen the home's identity deck is the app's snapping track, like the wallet's: a swipe brings the next card to the centre. */

test("a phone gets the swipe track, and a swipe chooses the next identity", async ({ page, context }) => {
  await page.goto("/");
  const deck = page.locator(".identity-deck");
  await deck.scrollIntoViewIfNeeded();
  await expect(deck).toHaveAttribute("data-mode", "track");
  const track = page.locator(".identity-deck-track");
  expect(await track.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // The page never scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // The first touch stops the dealing for good.
  await page.locator(".identity-deck-card[data-active=true]").tap();
  await page.waitForTimeout(600);
  const from = (await page.locator(".identity-deck-card[data-active=true]").getAttribute("data-testid"))!;
  const ids = await page.locator(".identity-deck-card").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!));
  // Toward the end if there is room, else back.
  const forward = ids.indexOf(from) < ids.length - 1;
  await swipe(context, track, forward ? -0.6 : 0.6);
  const next = ids[ids.indexOf(from) + (forward ? 1 : -1)];
  await expect(page.getByTestId(next)).toHaveAttribute("data-active", "true");
  await expect(page.locator("#identity-panel")).toHaveAttribute("aria-labelledby", next.replace("identity-card-", "identity-tab-"));

  await page.waitForTimeout(4500);
  await expect(page.getByTestId(next)).toHaveAttribute("data-active", "true");
});
