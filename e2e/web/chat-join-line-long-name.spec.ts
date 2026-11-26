import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { pair } from "../support/paired";

/*
 * A 1:1 chat's "<name> joined the chat" line, for a contact whose name is one long word (20 letters, as long as a
 * nickname may be): the name breaks inside the line. Unbroken, the centred line ran off both sides of a 320 px phone
 * and the chat cut it: the icon at the left edge and its ⋮ off the screen, and at the browser's larger text size
 * (24 px) "joined" read "d the chat" with the time gone.
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
  test(`${language}: a contact's long one-word name stays inside the chat's joined line on a phone`, { tag: ["@feature:chat.paired.join-notice","@feature:app.mobile-layout"] }, async ({ peer }) => {
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
    const row = page.locator("[data-message-row]").filter({ has: page.getByTestId("join-line").filter({ hasText: NAME }) });
    await expect(row).toBeVisible();

    const cdp = await page.context().newCDPSession(page);
    for (const px of [16, 24]) {
      await cdp.send("Page.setFontSizes", { fontSizes: { standard: px, fixed: px } });
      await row.screenshot({ path: test.info().outputPath(`joined-line-${px}px.png`) });
      // Each part of the line: its icon, its words (the name and "joined the chat"), its time and its ⋮.
      const parts = await row.evaluate((el) => {
        const ink = (node: Element) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const { left, right } = range.getBoundingClientRect();
          return [Math.round(left), Math.round(right)];
        };
        const line = el.querySelector("[data-testid=join-line]")!;
        const [icon, words, time] = Array.from(line.children);
        const menu = el.querySelector("[data-testid=message-options]")!.getBoundingClientRect();
        return { icon: ink(icon), words: ink(words), time: ink(time), menu: [Math.round(menu.left), Math.round(menu.right)], width: innerWidth };
      });
      for (const [part, [left, right]] of Object.entries(parts).filter(([part]) => part !== "width") as [string, number[]][]) {
        expect.soft(left, `${px} px: the ${part} starts at x=${left}`).toBeGreaterThanOrEqual(0);
        expect.soft(right, `${px} px: the ${part} ends at x=${right}`).toBeLessThanOrEqual(parts.width);
      }
    }
  });
}
