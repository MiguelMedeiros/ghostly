import { expect, test } from "@playwright/test";

/**
 * In forced colors (Windows high contrast) a card's face loses its gradient, the only thing that painted it: each face
 * must still hide the card behind it, or the stack reads as the names of every card written over one another.
 */

for (const deck of [".wallet-deck", ".identity-deck"]) {
  test(`in forced colors every face of ${deck} is opaque`, async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto("/");
    const el = page.locator(deck);
    await el.scrollIntoViewIfNeeded();
    await expect(el).toHaveAttribute("data-mode", "stack");
    const backgrounds = await el.locator("[data-deck=face]").evaluateAll((faces) => faces.map((f) => getComputedStyle(f).backgroundColor));
    expect(backgrounds.length).toBeGreaterThan(1);
    for (const background of backgrounds) expect(background, "a face's background").toMatch(/^rgb\(/);
  });
}
