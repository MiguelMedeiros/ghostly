import { expect, test } from "@playwright/test";

// /terms and /privacy: they render with their titles, the footer and the sitemap list them, and the site sets no
// cookie and loads nothing from an analytics or font service (the privacy policy says so).

for (const [path, title] of [
  ["/terms", "Terms of Service"],
  ["/privacy", "Privacy Policy"],
] as const) {
  test(`${path} renders with its title`, async ({ page }) => {
    await page.goto(path);
    await expect(page).toHaveTitle(`${title} | Ghostly`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `https://ghostly.tools${path}`);
    await expect(page.locator("main")).not.toContainText(/\[(contact|city|state)[^\]]*\]/i);
  });
}

test("the footer links both pages", async ({ page }) => {
  await page.goto("/privacy");
  const footer = page.locator("footer");
  await expect(footer.getByRole("link", { name: "Privacy", exact: true })).toHaveAttribute("href", "/privacy");
  await expect(footer.getByRole("link", { name: "Terms", exact: true })).toHaveAttribute("href", "/terms");
});

test("the sitemap lists both pages", async ({ request }) => {
  const xml = await (await request.get("/sitemap.xml")).text();
  expect(xml).toContain("<loc>https://ghostly.tools/terms</loc>");
  expect(xml).toContain("<loc>https://ghostly.tools/privacy</loc>");
});

test("the site sets no cookie and asks no analytics or font service", async ({ page, context }) => {
  const hosts = new Set<string>();
  page.on("request", (req) => hosts.add(new URL(req.url()).host));
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.goto("/terms");
  await page.waitForLoadState("networkidle");
  expect(await context.cookies()).toEqual([]);
  expect(await page.evaluate(() => document.cookie)).toBe("");
  const base = new URL(page.url()).host;
  expect([...hosts].filter((h) => h !== base)).toEqual([]);
});

// The footer's loops (its rising ghosts and its ghost's SMIL hem) rest while the reader is far above it, as on every
// page with Shell (components/site/IdleLoops.tsx), and run again once it is in view.
for (const path of ["/terms", "/privacy"]) {
  test(`${path} rests the footer's loops while the footer is off screen`, async ({ page }) => {
    await page.goto(path);
    const footer = page.locator("footer");
    const loops = footer.locator(".particles, svg.ghost:not(svg svg)");
    expect(await loops.count()).toBeGreaterThan(0);
    const resting = () =>
      footer.evaluate((el) =>
        [...el.querySelectorAll(".particles, svg.ghost:not(svg svg)")].every(
          (loop) => loop.hasAttribute("data-offscreen") && (!(loop instanceof SVGSVGElement) || loop.animationsPaused()),
        ),
      );
    await expect.poll(resting).toBe(true);
    await footer.scrollIntoViewIfNeeded();
    await expect(loops.first()).not.toHaveAttribute("data-offscreen");
    await expect.poll(resting).toBe(false);
  });
}
