import { expect, test, type Page } from "@playwright/test";
import { axe } from "./axe";

/** Ends the entrance fades at once: some wait off screen, paused, and axe measures a text only once it is drawn. */
const settle = (page: Page) =>
  page.evaluate(() => {
    for (const a of document.getAnimations()) if (a.effect?.getComputedTiming().iterations !== Infinity) a.finish();
  });

/**
 * The two demos on /developers keep their text readable (WCAG AA, 4.5:1) in the states they teach: a peer's transport
 * and capability that are off in the negotiation (components/dev/Negotiation.tsx) read at 2.5:1 under a 0.55 opacity,
 * and the agents chat's message field (components/agents/AgentDemo.tsx) at 4.09:1. With reduced motion each demo is
 * its finished frame, which shows both.
 */

for (const width of [1280, 375]) {
  test(`/developers: the negotiation's off entries pass axe at ${width}px`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/developers", { waitUntil: "networkidle" });
    const off = page.locator('.ng-chip[data-state="off"], .ng-order li[data-state="off"]');
    expect(await off.count(), "the finished frame shows entries that are off").toBeGreaterThan(0);
    await off.first().scrollIntoViewIfNeeded();
    await settle(page);
    expect(await axe(page, ".ng-chip, .ng-order"), `at ${width}px`).toEqual([]);
  });

  test(`/developers/agents: the chat's message field passes axe at ${width}px`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/developers/agents", { waitUntil: "networkidle" });
    const field = page.locator(".agd-composer span");
    await expect(field).toBeVisible();
    await field.scrollIntoViewIfNeeded();
    await settle(page);
    expect(await axe(page, "[data-testid=agent-demo]"), `at ${width}px`).toEqual([]);
  });
}
