import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * A larger browser font (Chrome's Settings → Font size: Very large is 24 px) on a window between 768 px and 48rem
 * (1152 px at 24 px): the app picks its layout in JS with px queries, and its CSS breakpoints were in rem, so the window
 * got the desktop's two panes with the phone's CSS on them (the sidebar's resize handle gone, a Back arrow beside the
 * list, the connection panel as a phone sheet over both panes). The CSS breakpoints are in px now: one layout, whole.
 */

/** The browser's default text size, as its settings set it (rem follows it). */
async function textSize(page: Page, px: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: px, fixed: Math.round(px * 13 / 16) } });
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(px);
}

test("a 1024 px window at a 24 px browser font keeps the desktop's CSS with the desktop's layout", { tag: ["@feature:app.responsive", "@feature:app.accessibility"] }, async ({ peer }) => {
  const { page } = await peer("mid-window-font", { viewport: { width: 1024, height: 768 } });
  const handle = page.getByTestId("sidebar-resize");
  // The desktop layout (JS): the resize handle is drawn, and its CSS shows it.
  await expect(handle).toBeVisible();
  for (const px of [20, 24, 32]) {
    await textSize(page, px);
    await expect(handle, `the resize handle at ${px} px`).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(max-width: 767px)").matches), `JS's phone query at ${px} px`).toBe(false);
  }
});
