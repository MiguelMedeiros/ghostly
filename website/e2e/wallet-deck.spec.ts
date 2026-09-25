import { expect, test, type Page } from "@playwright/test";

/**
 * The home's wallet deck is the app's: with a mouse, a stack whose cards come up as the pointer passes over them
 * (no click), the arrow keys, Home and End move along it, and it deals the next card by itself until the reader
 * touches it. The phone's track is wallet-deck-phone.spec.ts.
 */

const RAILS = ["cashu", "lightning", "arkade", "bark", "spark", "bitcoin", "fedimint", "usdt"];
const card = (page: Page, rail: string) => page.getByTestId(`wallet-card-${rail}`);
const active = (page: Page) => page.locator(".wallet-deck-card[data-active=true]");

async function openDeck(page: Page) {
  await page.goto("/");
  const deck = page.locator(".wallet-deck");
  await deck.scrollIntoViewIfNeeded();
  await expect(deck).toBeVisible();
  return deck;
}

test("every wallet of the app, in its order, as the app's stack", async ({ page }) => {
  const deck = await openDeck(page);
  await expect(deck).toHaveAttribute("data-mode", "stack");
  const ids = await page.locator(".wallet-deck-card").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.replace("wallet-card-", "")));
  expect(ids).toEqual(RAILS);
  await expect(page.getByRole("tablist", { name: "One wallet, many ways to pay." })).toBeVisible();
  // The arrows under the deck are the app's; the site's "Choose a card" caption is gone.
  await expect(page.getByTestId("wallet-deck-next")).toBeVisible();
  await expect(page.getByText("Choose a card", { exact: true })).toHaveCount(0);
});

test("a card comes up as the pointer passes over it, with no click", async ({ page }) => {
  await openDeck(page);
  let clicks = 0;
  await page.exposeFunction("countClick", () => clicks++);
  await page.evaluate(() => document.addEventListener("click", () => (window as unknown as { countClick: () => void }).countClick(), true));

  for (const rail of ["fedimint", "bark", "spark"]) {
    // A card's button is the strip of it that shows: its middle is on that card.
    const box = (await card(page, rail).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await expect(card(page, rail)).toHaveAttribute("data-active", "true");
    await expect(card(page, rail)).toHaveAttribute("aria-selected", "true");
  }
  // The chosen card's details are in the panel under the deck.
  await expect(page.locator("#wallet-panel")).toContainText("Bitcoin on Spark");
  await expect(page.locator("#wallet-panel")).toHaveAttribute("aria-labelledby", "wallet-tab-spark");
  // It lifted: its face stands higher than the cards beside it.
  const lift = async (rail: string) => (await card(page, rail).locator("[data-deck=face]").boundingBox())!.y;
  await expect.poll(async () => (await lift("bark")) - (await lift("spark"))).toBeGreaterThan(5);
  expect(clicks).toBe(0);

  // Pointing at it stopped the dealing for good, even after the pointer leaves.
  await page.mouse.move(5, 5);
  await page.waitForTimeout(4500);
  await expect(card(page, "spark")).toHaveAttribute("data-active", "true");
});

test("the keyboard moves through the cards", async ({ page }) => {
  await openDeck(page);
  await active(page).focus();
  await page.keyboard.press("Home");
  await expect(card(page, "cashu")).toBeFocused();
  await expect(card(page, "cashu")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(card(page, "lightning")).toBeFocused();
  await expect(card(page, "lightning")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(card(page, "usdt")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(card(page, "cashu")).toBeFocused();
  await expect(page.locator("#wallet-panel")).toContainText("Private ecash tokens");
  // The focused card wears a visible ring.
  const outline = await card(page, "cashu").locator("[data-deck=face]").evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe("solid");
});

test("the deck deals by itself while nobody touches it", async ({ page }) => {
  await openDeck(page);
  // Keep the pointer off the deck.
  await page.mouse.move(5, 5);
  const first = await active(page).getAttribute("data-testid");
  await expect(active(page)).not.toHaveAttribute("data-testid", first!, { timeout: 6000 });
});

test("with reduced motion the deck stays where the reader leaves it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openDeck(page);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(4500);
  await expect(card(page, "cashu")).toHaveAttribute("data-active", "true");
});
