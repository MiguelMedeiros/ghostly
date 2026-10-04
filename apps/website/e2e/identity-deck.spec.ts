import { expect, test, type Page } from "@playwright/test";

/**
 * The home's identity deck is the wallet deck's twin (wallet-deck.spec.ts): the app's deck with the wallet card's face,
 * one card per identity proof the app offers, in its picker's order. With a mouse, a card comes up as the pointer
 * passes over it; the arrow keys, Home and End move along it; it deals by itself until the reader touches it. The
 * phone's track is identity-deck-phone.spec.ts.
 */

const PROOFS = ["nostr", "pubky", "domain", "openpgp", "bitcoin", "ssh", "ssh-github", "ssh-gitlab", "did", "atproto"];
const card = (page: Page, id: string) => page.getByTestId(`identity-card-${id}`);
const active = (page: Page) => page.locator(".identity-deck-card[data-active=true]");

async function openDeck(page: Page) {
  await page.goto("/");
  const deck = page.locator(".identity-deck");
  await deck.scrollIntoViewIfNeeded();
  await expect(deck).toBeVisible();
  return deck;
}

test("every identity proof the app offers, in its order, as the app's stack", async ({ page }) => {
  const deck = await openDeck(page);
  await expect(deck).toHaveAttribute("data-mode", "stack");
  const ids = await page.locator(".identity-deck-card").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.replace("identity-card-", "")));
  expect(ids).toEqual(PROOFS);
  await expect(page.getByRole("tablist", { name: "One you, many ways to prove it." })).toBeVisible();
  await expect(page.getByTestId("identity-deck-next")).toBeVisible();
  // Its status comes from its WISP's header: experimental where the notes say so.
  await expect(card(page, "nostr").locator(".wallet-deck-card-status")).toHaveText("Available");
  await expect(card(page, "domain").locator(".wallet-deck-card-status")).toHaveText("Available · experimental");
  // Not offered by the app: no card.
  await expect(page.locator("[data-testid=identity-card-oidc], [data-testid=identity-card-keet]")).toHaveCount(0);
  // The wallet deck beside it is still the only wallet deck.
  await expect(page.locator(".wallet-deck")).toHaveCount(1);
});

test("a card comes up as the pointer passes over it, with no click", async ({ page }) => {
  await openDeck(page);
  let clicks = 0;
  await page.exposeFunction("countClick", () => clicks++);
  await page.evaluate(() => document.addEventListener("click", () => (window as unknown as { countClick: () => void }).countClick(), true));

  for (const id of ["did", "ssh-github", "bitcoin"]) {
    const box = (await card(page, id).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await expect(card(page, id)).toHaveAttribute("data-active", "true");
    await expect(card(page, id)).toHaveAttribute("aria-selected", "true");
  }
  await expect(page.locator("#identity-panel")).toContainText("key behind a Bitcoin address");
  await expect(page.locator("#identity-panel")).toHaveAttribute("aria-labelledby", "identity-tab-bitcoin");
  expect(clicks).toBe(0);

  // Pointing at it stopped the dealing for good, even after the pointer leaves.
  await page.mouse.move(5, 5);
  await page.waitForTimeout(4500);
  await expect(card(page, "bitcoin")).toHaveAttribute("data-active", "true");
});

test("the keyboard moves through the cards", async ({ page }) => {
  await openDeck(page);
  await active(page).focus();
  await page.keyboard.press("Home");
  await expect(card(page, "nostr")).toBeFocused();
  await expect(card(page, "nostr")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(card(page, "pubky")).toBeFocused();
  await expect(page.locator("#identity-panel")).toContainText("Pubky Ring");
  await page.keyboard.press("End");
  await expect(card(page, "atproto")).toBeFocused();
  await expect(page.locator("#identity-panel")).toContainText("Bluesky");
  await page.keyboard.press("ArrowRight");
  await expect(card(page, "nostr")).toBeFocused();
  const outline = await card(page, "nostr").locator("[data-deck=face]").evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe("solid");
  // The arrows under the deck are labelled buttons.
  await page.locator(".identity-deck").getByRole("button", { name: "Next card" }).click();
  await expect(card(page, "pubky")).toHaveAttribute("data-active", "true");
});

test("the deck deals by itself while nobody touches it", async ({ page }) => {
  await openDeck(page);
  await page.mouse.move(5, 5);
  const first = await active(page).getAttribute("data-testid");
  await expect(active(page)).not.toHaveAttribute("data-testid", first!, { timeout: 6000 });
});

test("with reduced motion the deck stays where the reader leaves it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openDeck(page);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(4500);
  await expect(card(page, "nostr")).toHaveAttribute("data-active", "true");
});
