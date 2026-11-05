import type { Locator, Page } from "@playwright/test";
import { chat, expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { STORE_URL, serveStore, testStore } from "../support/appStore";

/*
 * The apps' screens at the browser's largest text size a person may need (200 %, WCAG 1.4.4) on a 375 px phone: a
 * screen's buttons go on to a second line rather than past the screen's edge. Unwrapped, the install screen a chat
 * card opens ("Install and open") pushed its Cancel off the left edge, where nothing scrolls to it.
 */
const PHONE = { width: 375, height: 812 };

/** The browser's default text size, as its settings set it (rem follows it). */
async function textSize(page: Page, px: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: px, fixed: Math.round(px * 13 / 16) } });
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(px);
}

async function setNickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

/** Each of the screen's buttons, named, whole within the screen's width. */
async function expectButtonsOnScreen(screen: Locator, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const button = screen.getByRole("button", { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    const box = (await button.boundingBox())!;
    expect.soft(Math.round(box.x), `${name}: its start on screen`).toBeGreaterThanOrEqual(0);
    expect.soft(Math.round(box.x + box.width), `${name}: its end on screen`).toBeLessThanOrEqual(PHONE.width);
  }
}

test("on a phone at a doubled text size, Add's store question and a card's install screen keep their buttons on screen", { tag: ["@feature:apps.page", "@feature:apps.chat.card", "@feature:app.accessibility"] }, async ({ peer }) => {
  const store = await testStore();
  const [ana, bob] = await Promise.all([peer("ana"), peer("bob")]);
  await serveStore(ana.context, store);
  await serveStore(bob.context, store);
  await setNickname(ana, "Ana");
  await setNickname(bob, "Bob");
  // Ana installs Chess from the store, pairs with Bob and opens it in their chat: Bob gets its card.
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
  await (await composerRow(ana.page, "composer-apps")).click();
  await ana.page.getByTestId("chat-apps").getByTestId("chat-app-open").click();
  await expect(chat(bob).getByTestId("app-card")).toContainText("Ana opened it here");

  const page = bob.page;
  await page.setViewportSize(PHONE);
  await textSize(page, 32);

  // Apps → Add with a store link: the store's question, Cancel and Add store.
  await page.goto("/#/apps");
  await page.getByTestId("apps-add").click();
  await page.getByTestId("apps-add-url").fill(STORE_URL);
  await page.getByTestId("apps-add-check").click();
  const add = page.getByTestId("apps-add-dialog");
  await expect(add.getByTestId("apps-add-store-confirm")).toBeVisible();
  await expectButtonsOnScreen(add, ["Cancel", "Add store"]);
  await add.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(add).toHaveCount(0);

  // The card's Join: the install screen, Cancel and "Install and open".
  await page.getByTestId("mobile-tab-chats").click();
  await page.getByTestId("chat-row").first().click();
  await chat(bob).getByTestId("app-card-install").click();
  const install = page.getByTestId("app-install");
  await expect(install.getByTestId("app-install-confirm")).toBeVisible();
  await expectButtonsOnScreen(install, ["Cancel", "Install and open"]);
});
