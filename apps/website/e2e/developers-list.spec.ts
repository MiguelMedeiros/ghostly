import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * The Developers page's path (components/dev/DevelopersPage.tsx) is an ordered list, so each of its steps is one of
 * the list's items: a screen reader then says how many steps there are and which one it is on.
 */

for (const width of [1280, 375]) {
  test(`at ${width}px axe finds nothing serious on /developers`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/developers");
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === 1).map((a) => a.finished.catch(() => {})));
    });
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const found = violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`));
    expect(found).toEqual([]);
  });
}

test("every step of the path is an item of its list", async ({ page }) => {
  await page.goto("/developers");
  const path = page.locator("ol.dvx-path");
  const steps = await path.locator(".dvx-step").count();
  expect(steps).toBeGreaterThan(0);
  expect(await path.locator("> *").evaluateAll((els) => els.map((el) => el.tagName))).toEqual(Array(steps).fill("LI"));
  await expect(path.getByRole("listitem").filter({ has: page.locator(".dvx-step-title") })).toHaveCount(steps);
});
