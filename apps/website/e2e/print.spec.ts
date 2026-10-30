import { expect, test } from "@playwright/test";

// Printed or saved as PDF, a page is its text. Fixed chrome (the nav, the skip link) repeats on every sheet, over
// the first and last lines, so print hides it; and a gradient title clips a background that print drops, so the
// legal pages and the agents FAQ printed with no title at all (site.css, the Print block).

const PAGES = ["/", "/privacy", "/terms", "/agents/faq", "/wisps", "/wisps/01-ghost-core"];

for (const path of PAGES) {
  test(`${path} prints with no fixed chrome over its text`, async ({ page }) => {
    await page.goto(path);
    await page.emulateMedia({ media: "print" });
    const fixed = await page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter((el) => {
          const style = getComputedStyle(el);
          return style.position === "fixed" && style.display !== "none" && el.getClientRects().length > 0;
        })
        .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`),
    );
    expect(fixed).toEqual([]);
  });
}

for (const [path, title] of [
  ["/privacy", "Privacy Policy"],
  ["/terms", "Terms of Service"],
  ["/agents/faq", "Agents FAQ"],
] as const) {
  test(`${path} prints its title in a solid colour`, async ({ page }) => {
    await page.goto(path);
    await page.emulateMedia({ media: "print" });
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveText(title);
    const fill = await h1.evaluate((el) => {
      const style = getComputedStyle(el);
      return { fill: style.webkitTextFillColor, color: style.color };
    });
    expect(fill.fill).toBe(fill.color);
    expect(fill.color).not.toMatch(/rgba\(.*,\s*0\)|transparent/);
  });
}
