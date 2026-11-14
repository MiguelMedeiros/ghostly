import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * A new group's link dialog on a 375px phone at 150% of the browser's text size. Share and Copy sat side by side and
 * neither could shrink or wrap: in French "Copier" went past the dialog's edge and the dialog scrolled sideways
 * (340/325px). They go one under the other when they don't fit, and stay inside the dialog.
 */
const PHONE = { width: 375, height: 667 };

/** The browser's default text size, as its settings set it (rem follows it). */
async function textSize(page: Page, px: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: px, fixed: Math.round(px * 13 / 16) } });
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(px);
}

async function useLanguage(page: Page, language: string): Promise<void> {
  await page.evaluate((language) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
  }, language);
  // The chat list, where New group is: on a phone the last group's chat covers it.
  await page.goto("/#/");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
}

test("on a 375px phone at 150% text size the new group's Share and Copy stay inside its link dialog", { tag: ["@feature:groups.link.share", "@feature:app.mobile-layout", "@feature:app.accessibility"] }, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const alice = await peer("alice", { mobile: true, viewport: PHONE });
  const page = alice.page;
  await textSize(page, 24);
  for (const language of ["en", "fr", "es", "it", "pt", "ar", "ja"]) {
    await useLanguage(page, language);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("24px");
    await page.getByTestId("sidebar-new-more").click();
    await page.getByTestId("new-group").click();
    await page.getByTestId("new-group-name").fill("Clube do livro de domingo");
    await page.getByTestId("new-group-create").click();
    const dialog = page.getByTestId("group-share-dialog");
    await expect(dialog.getByTestId("group-link-copy")).toBeVisible();
    // The dialog does not scroll sideways: nothing in it is wider than its content box.
    const widths = await dialog.evaluate((d) => ({ shown: d.clientWidth, whole: d.scrollWidth }));
    expect.soft(widths.whole, `${language} dialog ${JSON.stringify(widths)}`).toBeLessThanOrEqual(widths.shown);
    // Share and Copy are whole, inside the dialog, and a 44px target, side by side or one under the other.
    const box = (await dialog.boundingBox())!;
    for (const id of ["group-link-share", "group-link-copy"]) {
      const button = (await dialog.getByTestId(id).boundingBox())!;
      expect.soft(button.x, `${language} ${id}`).toBeGreaterThanOrEqual(box.x);
      expect.soft(button.x + button.width, `${language} ${id}`).toBeLessThanOrEqual(box.x + box.width);
      expect.soft(button.height, `${language} ${id}`).toBeGreaterThanOrEqual(44);
      const label = await dialog.getByTestId(id).evaluate((el) => ({ shown: el.clientWidth, whole: el.scrollWidth }));
      expect.soft(label.whole, `${language} ${id} label ${JSON.stringify(label)}`).toBeLessThanOrEqual(label.shown);
    }
    await dialog.getByTestId("group-share-done").click();
    await expect(dialog).toBeHidden();
  }
});
