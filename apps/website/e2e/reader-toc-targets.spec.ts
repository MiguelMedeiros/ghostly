import { expect, test } from "@playwright/test";

/**
 * The "On this page" entries of a WISP are links of one 13-14 px line: 15-19 px high by font, under the 24 px target size
 * (WCAG 2.5.8), on a desktop and on a phone, where a finger has to hit one of rows packed 4 px apart.
 */
for (const width of [1280, 375]) {
  test(`/wisps/public-profiles: every 'On this page' link is at least 24 px high at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/wisps/public-profiles");
    const links = await page.locator(".reader-toc a").evaluateAll((els) =>
      els.map((a) => ({ text: (a.textContent ?? "").trim(), height: Math.round(a.getBoundingClientRect().height * 10) / 10 })),
    );
    expect(links.length).toBeGreaterThan(2);
    expect(links.filter((l) => l.height < 24)).toEqual([]);
  });
}
