import { expect, test, type Page } from "@playwright/test";
import { axe } from "./axe";

/**
 * A draft's tables and code blocks: only the ones wider (or taller) than their box are tab stops, and a wide table
 * is a region named after its header row. One that fits the column is neither, so Tab does not stop on dozens of
 * boxes that do not move, and a screen reader does not hear "scrollable" for them.
 */

const DRAFT = "/wisps/1200-marketplace";

async function boxes(page: Page) {
  // The renderer's checks run after hydration; wait for every box to have settled on what it is.
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLElement>(".reference-table, .reader-prose pre")].every(
      (el) => el.hasAttribute("tabindex") === (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight),
    ),
  );
  return page.locator(".reference-table, .reader-prose pre").evaluateAll((els) =>
    els.map((el) => ({
      tag: el.tagName,
      scrolls: el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight,
      tabindex: el.getAttribute("tabindex"),
      role: el.getAttribute("role"),
      name: el.getAttribute("aria-label"),
      head: [...el.querySelectorAll("thead th")].map((th) => th.textContent!.trim()).join(", "),
    })),
  );
}

for (const width of [1280, 375]) {
  test(`reader scroll regions at ${width}: only a box that scrolls is a tab stop, and a table region says what it holds`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(DRAFT);
    const all = await boxes(page);
    expect(all.filter((b) => b.tag === "DIV").length).toBeGreaterThan(20);
    expect(all.some((b) => !b.scrolls)).toBe(true);

    for (const b of all) {
      expect(b.tabindex, `${b.tag} ${b.head}`).toBe(b.scrolls ? "0" : null);
      if (b.tag === "DIV") {
        expect(b.role).toBe(b.scrolls ? "region" : null);
        expect(b.name).toBe(b.scrolls ? `Table: ${b.head}` : null);
      } else {
        expect(b.role).toBeNull();
      }
    }

    // The wide ones stay reachable from the keyboard.
    expect((await axe(page, ".reader-prose")).filter((v) => v.startsWith("scrollable-region-focusable"))).toEqual([]);
  });
}

test("reader scroll regions: a table that stops fitting becomes a tab stop again", async ({ page }) => {
  await page.goto(DRAFT);
  const before = await boxes(page);
  const fits = before.findIndex((b) => b.tag === "DIV" && !b.scrolls);
  expect(fits).toBeGreaterThanOrEqual(0);

  await page.setViewportSize({ width: 320, height: 900 });
  const after = await boxes(page);
  expect(after.filter((b) => b.tabindex === "0").length).toBeGreaterThan(before.filter((b) => b.tabindex === "0").length);
});
