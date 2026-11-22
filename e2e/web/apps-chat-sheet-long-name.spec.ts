import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";

/*
 * A chat's + → Apps says "Apps with <name>": a contact's name of one long word (20 letters, as long as a nickname may
 * be) breaks onto the next line. Unbroken, the sheet scrolled 42 px sideways on a 320 px phone, and in Arabic the
 * name's end was drawn off the screen's left side.
 */
const PHONE = { width: 320, height: 640 };
const NAME = "W".repeat(20);

async function useLanguage(page: Page, language: string): Promise<void> {
  await page.evaluate((language) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
  }, language);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
}

for (const language of ["en", "ar"]) {
  test(`${language}: a contact's long one-word name stays inside the chat's Apps sheet on a phone`, { tag: ["@feature:apps.chat.card","@feature:app.mobile-layout"] }, async ({ peer }) => {
    const [ana, bob] = await Promise.all([peer("ana"), peer("bob")]);
    await bob.page.goto("/#/settings");
    await bob.page.getByPlaceholder("Enter your nickname...").fill(NAME);
    await bob.page.goto("/#/");
    await pair(ana, bob);

    const page = ana.page;
    await page.setViewportSize(PHONE);
    await useLanguage(page, language);
    await page.goto("/#/");
    await page.getByTestId("chat-row").first().click();
    await expect(page.getByTestId("chat-name")).toContainText(NAME);
    await (await composerRow(page, "composer-apps")).click();
    const sheet = page.getByTestId("chat-apps");
    const title = sheet.getByRole("heading");
    await expect(title).toContainText(NAME);

    const sideways = await sheet.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect.soft(sideways, "the sheet scrolls sideways").toBeLessThanOrEqual(0);
    const ink = await title.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const { left, right } = range.getBoundingClientRect();
      return { left: Math.round(left), right: Math.round(right) };
    });
    const box = (await sheet.boundingBox())!;
    expect.soft(ink.left, `title drawn from x=${ink.left}`).toBeGreaterThanOrEqual(Math.floor(box.x));
    expect.soft(ink.right, `title drawn to x=${ink.right}`).toBeLessThanOrEqual(Math.ceil(box.x + box.width));
  });
}
