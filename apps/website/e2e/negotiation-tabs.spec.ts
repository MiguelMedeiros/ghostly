import { expect, test, type Page } from "@playwright/test";

/**
 * The negotiation loop on /developers (components/dev/Negotiation.tsx): the scenario tab that plays carries the loop's
 * progress as a growing line (.ng-tab-bar, scaled to --ng-p). A copy of the reduced-motion rules at the top level of
 * negotiation.css hid that line for everyone, and while it read --p, which dev-steps.css on the same page registers as
 * not inherited, it stayed 0 px wide; only a reader who asked for less motion, who sees a still, goes without. The line
 * grew by its width once, a layout of the page on every frame the loop played (about 45% of the page's main thread).
 */

/** The demo's tabs, scrolled to the middle of the screen so the loop runs. */
async function openTabs(page: Page) {
  await page.goto("/developers", { waitUntil: "networkidle" });
  await page.locator(".ng-tabs").evaluate((el) => {
    document.documentElement.style.scrollBehavior = "auto";
    el.scrollIntoView({ block: "center" });
  });
  return page.locator(".ng-tab");
}

test("the scenario that plays shows its progress", async ({ page }) => {
  test.setTimeout(90_000);
  const tabs = await openTabs(page);
  // Pick the third scenario, not one the loop plays on its own at first (the server's still shows the second, the loop
  // then starts from the first): the pick plays it from the start and holds it. A click before hydration does nothing,
  // so click until the tab is the pressed one.
  const tab = tabs.nth(2);
  await expect(async () => {
    await tab.click();
    await expect(tab).toHaveAttribute("aria-pressed", "true", { timeout: 1_000 });
  }).toPass({ timeout: 45_000 });
  // The bar's share of its tab, read with the tab's --ng-p in one go: past a third of the scenario it is drawn.
  await expect
    .poll(
      () =>
        tab.evaluate((el) => {
          const bar = el.querySelector(".ng-tab-bar")!;
          const p = parseFloat((el as HTMLElement).style.getPropertyValue("--ng-p")) || 0;
          const drawn = getComputedStyle(bar).display === "none" ? 0 : bar.getBoundingClientRect().width / el.getBoundingClientRect().width;
          return p > 0.3 ? drawn : -1;
        }),
      { timeout: 45_000 },
    )
    .toBeGreaterThan(0.2);
});

test("the progress line grows without changing its box, so the loop lays out nothing while it plays", async ({ page }) => {
  test.setTimeout(90_000);
  const tabs = await openTabs(page);
  const tab = tabs.nth(2);
  await expect(async () => {
    await tab.click();
    await expect(tab).toHaveAttribute("aria-pressed", "true", { timeout: 1_000 });
  }).toPass({ timeout: 45_000 });
  // The line's box (offsetWidth, before transforms) at two points of the scenario, and what is drawn of it.
  const read = () =>
    tab.evaluate((el) => {
      const bar = el.querySelector<HTMLElement>(".ng-tab-bar")!;
      return { p: parseFloat(el.style.getPropertyValue("--ng-p")) || 0, box: bar.offsetWidth, drawn: bar.getBoundingClientRect().width };
    });
  await expect.poll(async () => (await read()).p, { timeout: 45_000 }).toBeGreaterThan(0.1);
  const early = await read();
  await expect.poll(async () => (await read()).p, { timeout: 45_000 }).toBeGreaterThan(early.p + 0.3);
  const late = await read();
  expect(late.drawn).toBeGreaterThan(early.drawn);
  expect(late.box).toBe(early.box);
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the still has no progress line", async ({ page }) => {
    await openTabs(page);
    await expect(page.locator('.ng-tab[aria-pressed="true"] .ng-tab-bar')).toBeHidden();
  });
});
