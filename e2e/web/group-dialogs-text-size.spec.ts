import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/*
 * A group's questions on a 375 px phone with the browser's text size at 200 % (WCAG 1.4.4): New group, Leave, New link
 * and Turn off. Their two buttons shared one line that never wrapped, so at that size the action took the line and
 * pushed Cancel out of the dialog and past the screen's edge, where nothing scrolls to it. The line wraps now, as the
 * app's other dialogs' do.
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

/** The buttons of the dialog on top that stand past its padding box, or past the screen: none when it holds them all. */
const buttonsOut = (page: Page) => page.evaluate(() => {
  const dialog = [...document.querySelectorAll<HTMLElement>("dialog[open]")].at(-1);
  if (!dialog) return ["no dialog is open"];
  const box = dialog.getBoundingClientRect(), style = getComputedStyle(dialog);
  const start = box.left + parseFloat(style.paddingLeft) - 0.5, end = box.right - parseFloat(style.paddingRight) + 0.5;
  const out: string[] = [];
  for (const button of dialog.querySelectorAll<HTMLElement>("button")) {
    const own = button.getBoundingClientRect();
    if (!own.width) continue;
    if (own.left < start || own.right > end || own.left < 0 || own.right > innerWidth)
      out.push(`"${button.textContent?.trim()}" at ${Math.round(own.left)}-${Math.round(own.right)}, the dialog holds ${Math.round(start)}-${Math.round(end)}`);
  }
  return out;
});

test("on a phone at a doubled text size, New group, Leave, New link and Turn off keep Cancel and their action inside the dialog", { tag: ["@feature:app.accessibility", "@feature:app.mobile-layout", "@feature:groups.create", "@feature:groups.leave", "@feature:groups.link.replace"] }, async ({ peer }) => {
  const { page } = await peer("group-dialogs", { mobile: true, viewport: PHONE });
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  await page.getByTestId("new-group-name").fill("Clube do livro");
  await page.getByTestId("new-group-create").click();
  await page.getByTestId("group-share-dialog").getByTestId("group-share-done").click();
  await expect(page.getByTestId("group-chat")).toHaveAttribute("data-status", "active");
  const group = page.url();
  await textSize(page, 32);

  for (const language of ["en", "pt", "fr", "ar"]) {
    await useLanguage(page, language);

    await page.getByTestId("group-options").click();
    await page.getByTestId("group-leave").click();
    await expect(page.getByTestId("group-leave-dialog")).toBeVisible();
    expect.soft(await buttonsOut(page), `${language}: Leave`).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("group-leave-dialog")).toHaveCount(0);

    await page.getByTestId("group-members").click();
    for (const id of ["group-link-reset", "group-link-disable"]) {
      await page.getByTestId(id).click();
      await expect(page.getByTestId("group-link-ask-dialog")).toBeVisible();
      expect.soft(await buttonsOut(page), `${language}: ${id}`).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("group-link-ask-dialog")).toHaveCount(0);
    }

    await page.goto(group.replace(/#.*$/, "#/"));
    await page.getByTestId("sidebar-new-more").click();
    await page.getByTestId("new-group").click();
    await page.getByTestId("new-group-name").fill("Clube");
    expect.soft(await buttonsOut(page), `${language}: New group`).toEqual([]);
    await page.keyboard.press("Escape");
    await page.goto(group);
    await expect(page.getByTestId("group-chat")).toHaveAttribute("data-status", "active");
  }
});
