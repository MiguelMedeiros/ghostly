import type { Page } from "@playwright/test";
import { engineHistory, seed } from "../support/chatPerf";
import { expect, test } from "../support/fixtures";

// covers: chat.tasks-board

/**
 * The Tasks board on a 375x667 phone at 200% of the browser's text size. The rows above the board (the summary, Group
 * by, the filter, the tags, the column tabs) grew with the text and left the board 31px or none; the page scrolled only on a
 * screen under 500px high, so nothing scrolled, and Group by's last choice ran past the screen's right edge. A screen
 * short for its text size is now short as a phone on its side is: the rows scroll away with the board, which is the
 * page's whole height; Group by wraps.
 */
const PHONE = { width: 375, height: 667 };

/** The browser's default text size, as its settings set it (rem follows it). */
async function textSize(page: Page, px: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: px, fixed: Math.round(px * 13 / 16) } });
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(px);
}

test("on a 375x667 phone at 200% text size the Tasks board takes the screen, and Group by stays on it", { tag: ["@feature:chat.tasks-board", "@feature:app.mobile-layout", "@feature:app.accessibility"] }, async ({ peer }) => {
  test.setTimeout(3 * 60_000);
  const { page } = await peer("tasks-text-size", { mobile: true, viewport: PHONE });
  // A chat whose history holds a bot's task cards and a routine's reports, in the engine's store.
  await seed(page, [{ label: "Coordinator", count: 1 }]);
  await page.reload();
  await expect(page.getByTestId("chat-row-name").filter({ hasText: "Coordinator" })).toBeVisible();
  await engineHistory(page, "Coordinator", 120);
  await page.reload();
  await page.goto("/#/tasks");
  await expect(page.getByTestId("tasks-board")).toHaveAttribute("data-layout", "tabs");

  // At the default 16px the rows above the board stay put: a wheel over the board does not move them.
  const board = page.getByTestId("tasks-board");
  await board.hover();
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  await expect(page.getByTestId("tasks-summary")).toBeInViewport({ ratio: 1 });

  // A wheel in the middle of the screen, over the rows: the board may have no height to hover. Until the page is at its
  // end, however tall the rows above the tabs have grown.
  await textSize(page, 32);
  await page.mouse.move(PHONE.width / 2, PHONE.height / 2);
  const scroller = page.getByTestId("tasks-scroller");
  await expect(async () => {
    await page.mouse.wheel(0, 400);
    expect(await scroller.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1)).toBe(true);
  }).toPass({ timeout: 10_000 });
  // The rows went with the page, the column tabs stay, and the board below them is most of the screen. At the page's
  // end the tabs may lose a fraction of a pixel to rounding at the scroller's top.
  await expect(page.getByTestId("tasks-summary")).not.toBeInViewport();
  await expect(page.getByTestId("tasks-tabs")).toBeInViewport({ ratio: 0.95 });
  const shown = await board.evaluate((el) => { const box = el.getBoundingClientRect(); return Math.min(box.bottom, innerHeight) - Math.max(box.top, 0); });
  expect(shown).toBeGreaterThan(PHONE.height / 2);
  await page.screenshot({ path: test.info().outputPath("tasks-phone-32px-scrolled.png") });

  // A pull back brings the rows back, and each Group by choice is on the screen.
  await expect(async () => {
    await page.mouse.wheel(0, -400);
    await expect(page.getByTestId("tasks-summary")).toBeInViewport({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await page.screenshot({ path: test.info().outputPath("tasks-phone-32px.png") });
  for (const id of ["tasks-group-status", "tasks-group-chat"]) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect.soft(box.x, id).toBeGreaterThanOrEqual(0);
    expect.soft(box.x + box.width, id).toBeLessThanOrEqual(PHONE.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
