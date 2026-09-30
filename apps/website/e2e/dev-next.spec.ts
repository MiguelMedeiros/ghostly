import { expect, test } from "@playwright/test";

/**
 * The Developers page ends with four cards (components/dev/DevelopersPage.tsx): the WISPs, the roadmap, the CLI and
 * AI agents. Four across on a desktop, two by two on a tablet, stacked on a phone.
 */

test("the four cards and where they go", async ({ page }) => {
  await page.goto("/developers");
  const cards = page.locator(".devnext-card");
  await expect(cards.locator("h3")).toHaveText(["WISPs", "The roadmap", "The CLI", "AI agents"]);
  const hrefs = await cards.locator("a").evaluateAll((els) => els.map((el) => el.getAttribute("href")));
  expect(hrefs).toEqual(["/wisps", "/roadmap", "/cli", "/developers/agents"]);
});

for (const [width, columns] of [
  [1280, 4],
  [820, 2],
  [390, 1],
] as const) {
  test(`at ${width}px the cards sit ${columns} to a row, with no sideways scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/developers");
    const cards = page.locator(".devnext-card");
    await cards.first().scrollIntoViewIfNeeded();
    const tops = await cards.evaluateAll((els) => els.map((el) => (el as HTMLElement).offsetTop));
    expect(tops.filter((top) => top === tops[0]).length).toBe(columns);
    const doc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(doc.sw).toBeLessThanOrEqual(doc.cw);
  });
}
