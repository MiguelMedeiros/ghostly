import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * WISP content is written in docs/wisps only: what the catalog, the reader and the roadmap say is
 * read here from the documents themselves, then looked for on the pages.
 */
const docs = resolve(__dirname, "../../docs/wisps");
const row = (file: string, name: string) => readFileSync(resolve(docs, file), "utf8").match(new RegExp(`^\\| ${name} \\| (.+) \\|$`, "m"))?.[1];

test("each WISP's page shows its own summary and notes", async ({ page }) => {
  for (const file of ["202-arkade.md", "3xx-domain.md", "303-keet.md", "11xx-headless.md"]) {
    const summary = row(file, "Summary");
    expect(summary, file).toBeTruthy();
    await page.goto(`/wisps/${file.replace(/\.md$/, "")}`);
    await expect(page.getByText(summary!, { exact: true }).first()).toBeAttached();
  }
  await page.goto("/wisps/202-arkade");
  await expect(page.getByText(row("202-arkade.md", "Notes")!, { exact: true }).first()).toBeAttached();
});

test("the reader shows the WISP with its summary", async ({ page }) => {
  await page.goto("/wisps/202-arkade");
  await expect(page.getByRole("heading", { level: 1 }).first()).toContainText("Ark");
  await expect(page.getByText(row("202-arkade.md", "Summary")!, { exact: true }).first()).toBeAttached();
});

test("the roadmap's tracks and timeline are the document's", async ({ page }) => {
  const roadmap = readFileSync(resolve(docs, "ADAPTER-ROADMAP.md"), "utf8");
  const tracks = [...roadmap.matchAll(/^#### (\d{2}) (.+)$/gm)];
  const items = [...roadmap.matchAll(/^- \*\*(?:Available|Planned|Research)\*\*: (.+)$/gm)].map((m) => m[1]);
  expect(tracks.length).toBeGreaterThanOrEqual(9);
  await page.goto("/roadmap");
  for (const [, , title] of tracks) await expect(page.locator(".rm-track h2", { hasText: title })).toBeAttached();
  for (const item of items) {
    // Once in the timeline (wide and narrow layouts) and once in its track.
    await expect(page.locator(".tl-wide .tl-chip", { hasText: item })).toHaveCount(1);
    await expect(page.locator(".rm-track li", { hasText: item })).toHaveCount(1);
  }
  await expect(page.locator(".tl-wide .tl-chip")).toHaveCount(items.length);
});
