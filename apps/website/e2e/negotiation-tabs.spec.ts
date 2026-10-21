import { expect, test, type Page } from "@playwright/test";

/**
 * The negotiation loop on /developers (components/dev/Negotiation.tsx): the scenario tab that plays carries the loop's
 * progress as a growing line (.ng-tab-bar, width = --p). A copy of the reduced-motion rules at the top level of
 * negotiation.css hid that line for everyone; only a reader who asked for less motion, who sees a still, goes without.
 */

/** The bar of the tab that plays, once the loop is a third into its scenario. */
async function activeBar(page: Page) {
  await page.goto("/developers", { waitUntil: "networkidle" });
  await page.locator(".ng-tabs").evaluate((el) => {
    document.documentElement.style.scrollBehavior = "auto";
    el.scrollIntoView({ block: "center" });
  });
  return page.locator('.ng-tab[aria-pressed="true"] .ng-tab-bar');
}

test("the scenario that plays shows its progress", async ({ page }) => {
  test.setTimeout(90_000);
  await activeBar(page);
  // The server's page shows the second scenario as a finished still (--p 1); the loop starts from the first once the
  // script runs, and its bar grows from there.
  await expect(page.locator(".ng-tab").first()).toHaveAttribute("aria-pressed", "true", { timeout: 45_000 });
  // The bar's share of its tab, read with the tab's --p in one go: past a third of the scenario it is drawn.
  await expect
    .poll(
      () =>
        page.locator(".ng-tab").first().evaluate((tab) => {
          const bar = tab.querySelector(".ng-tab-bar")!;
          const p = parseFloat((tab as HTMLElement).style.getPropertyValue("--p")) || 0;
          const drawn = getComputedStyle(bar).display === "none" ? 0 : bar.getBoundingClientRect().width / tab.getBoundingClientRect().width;
          return p > 0.3 ? drawn : -1;
        }),
      { timeout: 45_000 },
    )
    .toBeGreaterThan(0.2);
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the still has no progress line", async ({ page }) => {
    const bar = await activeBar(page);
    await expect(bar).toBeHidden();
  });
});
