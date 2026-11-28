import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { pair } from "../support/paired";

/*
 * A chat's event lines with a name of one long word in them break the name inside the line. Unbroken, the centred line
 * ran off both sides of a 320 px phone and the chat cut it:
 * - a 1:1 chat's "<name> joined the chat", for a contact named by 20 letters (as long as a nickname may be): its icon
 *   at the left edge and its ⋮ off the screen, and at the browser's larger text size (24 px) "joined" read
 *   "d the chat" with the time gone;
 * - a group's "You renamed the group to “<name>”", for a name of 64 letters (the most a group's name may have): the
 *   name ran from x=-202 to 522.
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

  test(`${language}: a group's name of one long word stays inside its renamed line on a phone`, { tag: ["@feature:groups.rename","@feature:app.mobile-layout"] }, async ({ peer }) => {
    const { page } = await peer("ana");
    const group = "W".repeat(64);
    await page.goto("/#/");
    await page.getByTestId("sidebar-new-more").click();
    await page.getByTestId("new-group").click();
    await page.getByTestId("new-group-name").fill("Lunch");
    await page.getByTestId("new-group-create").click();
    await page.getByTestId("group-share-done").click();
    await page.getByTestId("group-members").click();
    await page.getByTestId("group-rename").click();
    await page.getByTestId("group-rename-input").fill(group);
    await page.getByTestId("group-rename-input").press("Enter");
    await page.getByTestId("group-members-dialog").getByRole("button", { name: "Close" }).click();

    await page.setViewportSize(PHONE);
    await useLanguage(page, language);
    const line = page.getByTestId("group-event").filter({ hasText: group }).locator("span").first();
    await expect(line).toBeVisible();
    await line.screenshot({ path: test.info().outputPath("renamed-line.png") });
    const [left, right] = await line.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const { left, right } = range.getBoundingClientRect();
      return [Math.round(left), Math.round(right)];
    });
    expect.soft(left, `the line's words start at x=${left}`).toBeGreaterThanOrEqual(0);
    expect.soft(right, `the line's words end at x=${right}`).toBeLessThanOrEqual(PHONE.width);
  });
}
