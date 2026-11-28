import type { Locator, Page } from "@playwright/test";
import { expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { STORE_URL, serveStore, testStore } from "../support/appStore";

/**
 * An app open in a chat on a 375px phone at 150% and 200% of the browser's text size. Its title and "With <name>" are
 * 15px and 12px at any text size, but Back, the contact's picture and Close were sized in rem and grew with it: at 200%
 * they took the row and "Chess" showed as "C…". They stay their size now, as the chat header's do (#7336).
 */
const PHONE = { width: 375, height: 812 };

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

async function setNickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

/** What a line shows against what it holds: cut short with an ellipsis when `shown` < `whole`. */
const room = (line: Locator) => line.evaluate((el) => ({ text: el.textContent, shown: Math.round(el.clientWidth), whole: Math.round(el.scrollWidth) }));

test("on a 375px phone at 150% and 200% text size, an app's header in a chat shows its title and the contact's name whole", { tag: ["@feature:apps.view", "@feature:app.mobile-layout", "@feature:app.accessibility"] }, async ({ peer }) => {
  const store = await testStore();
  const [ana, bob] = await Promise.all([peer("ana"), peer("bob")]);
  await serveStore(ana.context, store);
  await setNickname(ana, "Ana");
  await setNickname(bob, "Bob");
  await ana.page.getByTestId("account-apps").click();
  await ana.page.getByTestId("apps-add").click();
  await ana.page.getByTestId("apps-add-url").fill(STORE_URL);
  await ana.page.getByTestId("apps-add-check").click();
  await ana.page.getByTestId("apps-add-store-confirm").click();
  await ana.page.getByTestId("app-store").filter({ hasText: store.storeName }).getByTestId("app-listing-install").click();
  await ana.page.getByTestId("app-install").getByTestId("app-install-confirm").click();
  await expect(ana.page.getByTestId("installed-app")).toContainText(store.title);
  await ana.page.goto("/#/");
  await pair(ana, bob);

  const page = ana.page;
  await page.setViewportSize(PHONE);
  for (const language of ["en", "ar"]) {
    await useLanguage(page, language);
    for (const px of [24, 32]) {
      await textSize(page, px);
      await page.goto("/#/");
      await page.getByTestId("chat-row").first().click();
      await (await composerRow(page, "composer-apps")).click();
      await page.getByTestId("chat-apps").getByTestId("chat-app-open").click();
      const app = page.getByTestId("mini-app");
      await expect(app).toHaveAttribute("data-place", "phone");
      await expect(app.getByTestId("mini-app-title")).toHaveText(store.title);
      for (const id of ["mini-app-title", "mini-app-with"]) {
        const measured = await room(app.getByTestId(id));
        expect.soft(measured.whole, `${language} ${px}px ${id}: ${JSON.stringify(measured)}`).toBeLessThanOrEqual(measured.shown);
      }
      // Every header button is whole, a 44px target, and on the screen.
      for (const id of ["mini-app-back", "app-connection-options", "mini-app-close"]) {
        const box = (await app.getByTestId(id).boundingBox())!;
        expect.soft(Math.min(box.width, box.height), `${language} ${px}px ${id}`).toBeGreaterThanOrEqual(44);
        expect.soft(box.x, `${language} ${px}px ${id}`).toBeGreaterThanOrEqual(0);
        expect.soft(box.x + box.width, `${language} ${px}px ${id}`).toBeLessThanOrEqual(PHONE.width);
      }
      await app.getByTestId("mini-app-close").click();
      await expect(app.getByTestId("mini-app-title")).toHaveCount(0);
    }
  }
});
