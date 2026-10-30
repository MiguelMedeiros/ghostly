import { expect, test } from "@playwright/test";

/**
 * On a phone the negotiation loop's four scenario tabs on /developers are 40 px numbered dots (negotiation.css, the
 * phone block): a plain number in the middle of each. A copy of the wide-screen number styles for the tabs that do not
 * play outranked the phone block, so three dots drew a second ring inside, their number 4 px off centre.
 */

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`every scenario dot is a plain centred number (${reducedMotion})`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ reducedMotion });
    await page.goto("/developers", { waitUntil: "networkidle" });
    const tabs = page.locator(".ng-tab");
    await expect(tabs).toHaveCount(4);
    await expect(page.locator('.ng-tab[aria-pressed="true"]')).toHaveCount(1, { timeout: 45_000 });
    const dots = await tabs.evaluateAll((all) =>
      all.map((tab) => {
        const n = tab.querySelector(".ng-tab-n")!;
        const style = getComputedStyle(n);
        const t = tab.getBoundingClientRect();
        const r = n.getBoundingClientRect();
        return {
          border: style.borderTopWidth,
          margin: style.marginRight,
          offset: Math.abs(Math.round(r.left + r.width / 2 - (t.left + t.width / 2))),
        };
      }),
    );
    expect(dots).toEqual(Array(4).fill({ border: "0px", margin: "0px", offset: 0 }));
  });
}
