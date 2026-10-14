import { expect, test, type Page } from "@playwright/test";

/**
 * Every page loads the same two font files (Inter and JetBrains Mono, latin). A character outside that subset drawn in
 * Inter pulls another file: the ₿ of one 8 px coin in /developers' step scenes cost 83 KB at every visit, so the coin
 * is a path.
 */
async function fontsOf(page: Page, path: string): Promise<Set<string>> {
  const files = new Set<string>();
  const listen = (r: { url(): string }) => { if (r.url().endsWith(".woff2")) files.add(new URL(r.url()).pathname); };
  page.on("response", listen);
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  // Down to the end and back, so everything below the fold has drawn once.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 30)); }
  });
  await page.waitForLoadState("networkidle");
  // The explainer's payment step draws the coin.
  const next = page.locator('[data-action="next"]').first();
  if (await next.count()) for (let i = 0; i < 7; i++) await next.click();
  await page.waitForTimeout(300);
  page.off("response", listen);
  return files;
}

test("/developers loads no font file beyond the ones the home page loads", async ({ page }) => {
  const home = await fontsOf(page, "/");
  expect(home.size).toBeGreaterThan(0);
  const developers = await fontsOf(page, "/developers");
  expect([...developers].filter((file) => !home.has(file))).toEqual([]);
});
