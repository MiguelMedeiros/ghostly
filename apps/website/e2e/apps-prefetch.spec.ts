import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * /apps lists every app of the store (up to 200, lib/storeRead.ts), each a link to its page, and an app's page is
 * rendered for each visit (app/apps/[slug]/page.tsx). Each card loads its page when the reader is about to open it
 * (pointer, focus, touch), not as it scrolls into view: before, every card on screen asked the server for its page.
 * The build under test shows the test store (GHOSTLY_STORE_FIXTURE, which CI sets), whose two apps are listed.
 */
const snapshot = JSON.parse(readFileSync(join(__dirname, "..", "lib", "store-snapshot.json"), "utf8")) as { source: string };

function prefetches(page: Page): Set<string> {
  const seen = new Set<string>();
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.searchParams.has("_rsc")) seen.add(url.pathname);
  });
  return seen;
}

const appPages = (seen: Set<string>) => [...seen].filter((p) => p.startsWith("/apps/"));

test.skip(snapshot.source !== "fixture", "Build with GHOSTLY_STORE_FIXTURE=1 to check the page on the test store");

test("/apps loads no app's page until the reader points at or focuses its card", async ({ page }) => {
  const seen = prefetches(page);
  await page.goto("/apps");
  const cards = page.locator(".ap-card");
  await expect(cards).toHaveCount(2);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  expect(appPages(seen)).toEqual([]);

  const [first, second] = await cards.evaluateAll((links) => links.map((a) => a.getAttribute("href")!));
  await cards.nth(0).hover();
  await expect.poll(() => seen.has(first)).toBe(true);
  expect(appPages(seen)).toEqual([first]);
  await cards.nth(1).focus();
  await expect.poll(() => seen.has(second)).toBe(true);

  await cards.nth(0).click();
  await expect(page).toHaveURL(new RegExp(`${first.replace(/\./g, "\\.")}$`));
});
