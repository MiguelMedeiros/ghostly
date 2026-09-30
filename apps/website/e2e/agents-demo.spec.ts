import { expect, test, type Page } from "@playwright/test";

/**
 * /developers/agents: the chat that plays (components/agents/AgentDemo.tsx) goes through its frames by itself, holds
 * still on Pause, and never changes the page's layout while it plays; with reduced motion it is its finished frame.
 * The app's screens load, and "Connect your agent" has its three steps, each command with a Copy button.
 */

const demo = (page: Page) => page.getByTestId("agent-demo");
const frame = async (page: Page) => Number(await demo(page).getAttribute("data-frame"));

test("the chat plays its frames, and nothing around it moves", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/developers/agents", { waitUntil: "networkidle" });
  const box = () => page.evaluate(() => {
    const r = document.querySelector("[data-testid=agent-demo]")!.getBoundingClientRect();
    return { h: Math.round(r.height), w: Math.round(r.width), page: document.documentElement.scrollHeight, next: Math.round(document.getElementById("show")!.getBoundingClientRect().top) };
  });
  const before = await box();
  const seen = new Set<number>();
  for (let i = 0; i < 16; i++) {
    seen.add(await frame(page));
    expect(await box(), "the chat or the page changed size while it plays").toEqual(before);
    await page.waitForTimeout(500);
  }
  expect(seen.size, `frames seen: ${[...seen]}`).toBeGreaterThanOrEqual(4);
});

test("Pause holds the chat on its frame; Play goes on", async ({ page }) => {
  await page.goto("/developers/agents", { waitUntil: "networkidle" });
  await expect.poll(() => frame(page), { timeout: 10_000 }).toBeGreaterThan(0);
  const toggle = page.getByTestId("agent-demo-toggle");
  await toggle.click();
  await page.mouse.move(2, 2); // off the chat: a hover pauses it too
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const held = await frame(page);
  await page.waitForTimeout(3500);
  expect(await frame(page)).toBe(held);
  await toggle.click();
  await page.mouse.move(2, 2);
  await expect.poll(() => frame(page), { timeout: 10_000 }).not.toBe(held);
});

test.describe(() => {
  test.use({ reducedMotion: "reduce" });
  test("reduced motion: the finished frame, still, with no Pause", async ({ page }) => {
    await page.goto("/developers/agents", { waitUntil: "networkidle" });
    await expect(demo(page)).toHaveAttribute("data-frame", "7");
    await expect(demo(page).locator(".agd-card")).toHaveAttribute("data-status", "done");
    await expect(demo(page).locator(".agd-routine")).toHaveAttribute("data-on", "true");
    await expect(page.getByTestId("agent-demo-toggle")).toHaveCount(0);
    await page.waitForTimeout(2500);
    await expect(demo(page)).toHaveAttribute("data-frame", "7");
    await expect(page.getByTestId("agent-demo-caption")).toHaveText("An agent at work");
  });
});

test("the app's screens load, and Connect your agent has three steps with Copy on each command", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/developers/agents", { waitUntil: "networkidle" });
  for (const img of await page.locator(".ag-shots img").all()) {
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  }
  const steps = page.getByTestId("agent-connect").locator(".ag-step");
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toContainText("npm install -g @ghostlytools/cli");
  await expect(steps.nth(2)).toContainText("ghostly task send owner");
  expect(await page.getByTestId("agent-connect").locator(".cl-copy").count()).toBe(6);
  await expect(page.locator('a[href="/wisps/4xx-status-cards"]').first()).toBeAttached();
});
