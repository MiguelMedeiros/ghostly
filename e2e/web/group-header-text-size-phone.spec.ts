import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * An open group's header on a 375px phone at 150% of the browser's text size. The name is 15px at any text size, but
 * Back, the connection, Share link and ⋮ were sized in rem and grew with it, and took the row: the name had 23px left
 * ("C…"), and the members line under it, at least 66px wide, ran under the connection button, which took its taps.
 * Those stay their size now, as in a 1:1 chat's header (chat-header-text-size-phone.spec.ts).
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
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
}

/** What a line shows against what it holds: cut short with an ellipsis when `shown` < `whole`. */
const room = (line: Locator) => line.evaluate((el) => ({ text: el.textContent, shown: Math.round(el.clientWidth), whole: Math.round(el.scrollWidth) }));

test("on a 375px phone at 150% text size an open group's header shows its name, and a tap on the members line opens the members", { tag: ["@feature:app.mobile-layout", "@feature:app.accessibility", "@feature:groups.connection"] }, async ({ peer }) => {
  const { page } = await peer("group-header", { mobile: true, viewport: PHONE });
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  await page.getByTestId("new-group-name").fill("Clube do livro");
  await page.getByTestId("new-group-create").click();
  await page.getByTestId("group-share-dialog").getByTestId("group-share-done").click();
  await expect(page.getByTestId("group-chat")).toHaveAttribute("data-status", "active");
  await textSize(page, 24);
  for (const language of ["en", "fr", "ar"]) {
    await useLanguage(page, language);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("24px");
    const name = page.getByTestId("group-name");
    await expect(name).toBeVisible();
    const measured = await room(name);
    expect.soft(measured.whole, `${language} group-name: ${JSON.stringify(measured)}`).toBeLessThanOrEqual(measured.shown);
    // Every header button is whole, a 44px target, and on the screen.
    for (const id of ["chat-back", "group-connection-options", "group-share", "group-options"]) {
      const box = (await page.getByTestId(id).first().boundingBox())!;
      expect.soft(Math.min(box.width, box.height), `${language} ${id}`).toBeGreaterThanOrEqual(44);
      expect.soft(box.x, `${language} ${id}`).toBeGreaterThanOrEqual(0);
      expect.soft(box.x + box.width, `${language} ${id}`).toBeLessThanOrEqual(PHONE.width);
    }
    // The members line is what a tap on it reaches, not a button over it.
    const members = page.getByTestId("group-members");
    expect.soft(await members.evaluate((line) => {
      const box = line.getBoundingClientRect();
      return line.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    }), `${language}: the members line under a button`).toBe(true);
  }
});
