import type { Locator, Page } from "@playwright/test";
import { connect, expect, link, test } from "../support/fixtures";

/**
 * The app's menus (chat ⋮, group ⋮, New) are as wide as their longest row: no row ever wraps onto a second
 * line and none is cut, in English, Portuguese and Arabic (right to left), on a wide screen and on a phone,
 * and the menu stays inside the window.
 */
const WIDE = { width: 1280, height: 800 }, PHONE = { width: 390, height: 844 };

async function useLanguage(page: Page, language: string): Promise<void> {
  await page.evaluate((language) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
  }, language);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", new RegExp(`^${language}`));
}

/** What each row's text measures: how many lines it takes and whether it had to be cut. */
const measure = (menu: Locator) => menu.evaluate((el) => {
  const box = el.getBoundingClientRect();
  const width = document.documentElement.clientWidth, height = window.innerHeight;
  return {
    inside: box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= height + 0.5,
    rows: el.querySelectorAll("[data-menu-item]").length,
    texts: [...el.querySelectorAll<HTMLElement>("[data-menu-text]")].map((text) => ({
      text: text.textContent,
      lines: Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight)),
      cut: text.scrollWidth > text.clientWidth,
    })),
  };
});

async function oneLineEach(menu: Locator, rows: number, where: string): Promise<void> {
  await expect(menu).toBeVisible();
  // Past the fade-in's small slide, so the box is where it stays.
  await expect.poll(async () => (await measure(menu)).inside, { message: `${where}: inside the window` }).toBe(true);
  const { rows: count, texts } = await measure(menu);
  expect(count, where).toBe(rows);
  expect(texts.filter((t) => t.lines !== 1 || t.cut), `${where}: rows that wrap or are cut`).toEqual([]);
}

async function close(page: Page, menu: Locator): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
}

test("every row of the chat, group and New menus is one line and whole, in every tested language, wide and on a phone", { tag: ["@feature:app.menus", "@feature:app.i18n"] }, async ({ peer }, testInfo) => {
  test.setTimeout(5 * 60_000);
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const { page } = alice;
  const chatHash = new URL(page.url()).hash;

  // A group of her own, for its menu: as its admin she has every row of it.
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  await page.getByTestId("new-group-name").fill("Menus");
  await page.getByTestId("new-group-kind-mesh").click();
  await page.getByTestId("new-group-create").click();
  await expect(page.getByTestId("group-share-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("group-share-dialog")).toHaveCount(0);
  const groupHash = new URL(page.url()).hash;
  const go = async (hash: string) => { await page.evaluate((hash) => { location.hash = hash; }, hash); };

  for (const language of ["en", "pt", "ar"]) {
    await useLanguage(page, language);
    for (const viewport of [WIDE, PHONE]) {
      await page.setViewportSize(viewport);
      const at = `${language} at ${viewport.width}px`;
      const sheet = viewport === PHONE ? "sheet" : "popover";

      // The chat's ⋮: Pin, Mute notifications, Hold messages, Services, Refresh, Tech Info, Delete.
      // Not in it: the connection (the header's connection control has it), Payments (the composer's + → Payment) and
      // Identities (the contact's marks in the header, e2e/web/contact-identities.spec.ts).
      await go(chatHash);
      await page.getByTestId("chat-options").click();
      const chatMenu = page.getByTestId("chat-options-menu");
      await expect(chatMenu).toHaveAttribute("data-menu", sheet);
      await expect(chatMenu.getByTestId("chat-hold-open")).toBeVisible();
      await expect(chatMenu.getByTestId("chat-connection-open")).toHaveCount(0);
      await expect(chatMenu.getByTestId("chat-payments-open")).toHaveCount(0);
      await expect(chatMenu.getByTestId("chat-identities-open")).toHaveCount(0);
      await oneLineEach(chatMenu, 7, `chat menu, ${at}`);
      if (language !== "ar") await page.screenshot({ path: testInfo.outputPath(`chat-menu-${language}-${viewport.width}.png`) });
      await close(page, chatMenu);

      // The group's ⋮: Members, Mute notifications, Rotate keys, Leave group, Delete from this device.
      await go(groupHash);
      await page.getByTestId("group-options").click();
      const groupMenu = page.getByTestId("group-options-menu");
      await expect(groupMenu).toHaveAttribute("data-menu", sheet);
      await oneLineEach(groupMenu, 5, `group menu, ${at}`);
      await close(page, groupMenu);

      // New ▾: Chat and Group, each with a line saying what it is.
      await go("#/");
      await page.getByTestId("sidebar-new-more").click();
      const newMenu = page.getByTestId("sidebar-new-menu");
      await expect(newMenu).toHaveAttribute("data-menu", sheet);
      await oneLineEach(newMenu, 2, `New menu, ${at}`);
      await close(page, newMenu);
    }
  }
});
