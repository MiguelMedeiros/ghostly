import { expect, test, type Page } from "@playwright/test";

/**
 * The 404 page's scene is a 26 KB script. The root not-found page is in every page's tree (Next keeps it ready for a
 * `notFound()`), so with the scene imported straight from it every page of the site loaded that script. It loads only
 * where a page is not found: a missing address, or a link inside the site to one.
 */
function sceneScripts(page: Page): () => Promise<string[]> {
  const found: string[] = [];
  const reads: Promise<void>[] = [];
  page.on("response", (r) => {
    if (r.request().resourceType() !== "script") return;
    reads.push(
      r
        .text()
        .then((text) => {
          // The scene's own class for the ghost's wander, which only its script holds.
          if (text.includes("nf-wander-x")) found.push(new URL(r.url()).pathname);
        })
        .catch(() => {}),
    );
  });
  return async () => {
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForLoadState("networkidle");
    await Promise.all(reads);
    return found;
  };
}

for (const path of ["/", "/privacy", "/cli", "/wisps", "/wisps/01-ghost-core", "/developers", "/roadmap"]) {
  test(`${path} loads none of the 404 page's scene`, async ({ page }) => {
    const loaded = sceneScripts(page);
    await page.goto(path);
    expect(await loaded()).toEqual([]);
  });
}

test("a missing page loads its scene, and the scene comes alive", async ({ page }) => {
  const loaded = sceneScripts(page);
  await page.goto("/no-such-page");
  expect((await loaded()).length).toBeGreaterThan(0);
  // The floaters are drawn by the scene's script once it runs.
  await expect(page.locator(".nf-floater").first()).toBeAttached();
});

test("a link inside the site to a missing WISP shows the scene", async ({ page }) => {
  await page.goto("/privacy");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => (window as unknown as { next: { router: { push(href: string): void } } }).next.router.push("/wisps/99-nope"));
  await expect(page.locator(".nf-wander-x")).toBeVisible();
  await expect(page.locator(".nf-floater").first()).toBeAttached();
});
