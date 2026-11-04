import { expect, test, type Page } from "@playwright/test";

/**
 * The motion library is about 122 KB of script (41 KB on the wire), for the home's story and /developers' scenes. A
 * ghost's pupils were a `motion.g` so that the story's could follow motion values, and the footer's sleeping ghost is on
 * every page: before, every page loaded the whole library for pupils that never move (/privacy: 635 KB of script, 513 KB
 * without it, and about 30 ms of a 4x slower phone's main thread). A page that animates nothing with it loads none of it.
 */
function motionScripts(page: Page): () => Promise<string[]> {
  const found: string[] = [];
  const reads: Promise<void>[] = [];
  page.on("response", (r) => {
    if (r.request().resourceType() !== "script") return;
    reads.push(
      r
        .text()
        .then((text) => {
          // One of motion's transform keys: a string its renderer holds, whatever the minifier does to the rest.
          if (text.includes("transformPerspective")) found.push(new URL(r.url()).pathname);
        })
        .catch(() => {}),
    );
  });
  // Read to the end, so the footer and everything it loads are in.
  return async () => {
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForLoadState("networkidle");
    await Promise.all(reads);
    return found;
  };
}

for (const path of ["/privacy", "/terms", "/cli", "/wisps", "/wisps/01-ghost-core", "/agents/faq", "/roadmap", "/brand"]) {
  test(`${path} loads no part of the motion library`, async ({ page }) => {
    const loaded = motionScripts(page);
    await page.goto(path);
    expect(await loaded()).toEqual([]);
  });
}

test("the home, whose story moves with it, loads the motion library", async ({ page }) => {
  const loaded = motionScripts(page);
  await page.goto("/");
  expect((await loaded()).length).toBeGreaterThan(0);
});
