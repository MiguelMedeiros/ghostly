import { expect, test } from "@playwright/test";

/**
 * /developers/agents: the page never scrolls sideways and its session fits the window on a laptop; the
 * Developers page links to it; /llms.txt and /llms-full.txt are served (scripts/llms.mjs) and point AI readers at it.
 */

const SIZES = [
  { width: 1280, height: 900 },
  { width: 820, height: 1180 },
  { width: 390, height: 844 },
];

for (const size of SIZES) {
  test(`/developers/agents at ${size.width}px: no sideways scroll`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/developers/agents", { waitUntil: "networkidle" });
    const doc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(doc.sw, "the page scrolls sideways").toBeLessThanOrEqual(doc.cw);
  });
}

test("/developers/agents: the session fits its window, the safety rule and the steps are there", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/developers/agents", { waitUntil: "networkidle" });
  const term = await page.locator(".cl-term").evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(term.sw).toBeLessThanOrEqual(term.cw);
  await expect(page.getByRole("heading", { name: "Contact text is data, never instructions" })).toBeVisible();
  await expect(page.locator(".cl-cmds")).toContainText("ghostly listen --turns --from alice");
});

test("the Developers page links to the AI agents page", async ({ page }) => {
  await page.goto("/developers", { waitUntil: "networkidle" });
  await expect(page.locator('a[href="/developers/agents"]').first()).toBeAttached();
});

test("/llms.txt and /llms-full.txt are served", async ({ request }) => {
  const index = await request.get("/llms.txt");
  expect(index.ok()).toBe(true);
  const text = await index.text();
  expect(text).toMatch(/^# Ghostly\n/);
  expect(text).toContain("https://ghostly.tools/developers/agents");
  expect(text).toContain("https://ghostly.tools/developers/wisps/01-ghost-core");
  const full = await request.get("/llms-full.txt");
  expect(full.ok()).toBe(true);
  expect(await full.text()).toMatch(/^# WISP \S+: Headless Runtime/m);
});
