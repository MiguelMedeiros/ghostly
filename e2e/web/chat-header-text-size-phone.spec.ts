import type { Locator, Page } from "@playwright/test";
import { connect, expect, link, test } from "../support/fixtures";

/**
 * A chat's header on a 375px phone at 150% of the browser's text size. The name is 15px at any text size, but Back,
 * the avatar, the connection, the call and ⋮ were sized in rem and grew with it, and took the row: the name had 33px
 * left ("C…" in French, "連…" in Japanese), the key under it too. Those stay their size now, and the name has its room.
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

test("on a 375px phone at 150% text size the chat header's name and key show whole", { tag: ["@feature:app.mobile-layout", "@feature:app.accessibility"] }, async ({ peer }) => {
  const alice = await peer("alice");
  const bob = await peer("bob", { mobile: true, viewport: PHONE });
  await link(alice, bob);
  await connect(alice, bob);
  const page = bob.page;
  await textSize(page, 24);
  for (const language of ["en", "fr", "ar", "ja"]) {
    await useLanguage(page, language);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("24px");
    for (const id of ["chat-name", "chat-subtitle"]) {
      const line = page.getByTestId(id);
      await expect(line).toBeVisible();
      const measured = await room(line);
      expect.soft(measured.whole, `${language} ${id}: ${JSON.stringify(measured)}`).toBeLessThanOrEqual(measured.shown);
    }
    // Every header button is whole, a 44px target, and on the screen.
    for (const id of ["chat-back", "connection-options", "call-audio", "chat-options"]) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect.soft(Math.min(box.width, box.height), `${language} ${id}`).toBeGreaterThanOrEqual(44);
      expect.soft(box.x, `${language} ${id}`).toBeGreaterThanOrEqual(0);
      expect.soft(box.x + box.width, `${language} ${id}`).toBeLessThanOrEqual(PHONE.width);
    }
  }
});
