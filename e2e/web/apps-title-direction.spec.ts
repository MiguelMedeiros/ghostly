import type { Locator, Page } from "@playwright/test";
import { chat, expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { STORE_URL, serveStore, testStore } from "../support/appStore";

/*
 * An app's Latin title and tagline read in their own direction (an English title is cut at its end) but sit beside the
 * app's icon, or the contact's picture, in the Arabic app as in the English one. With `dir="auto"` alone a block aligned
 * its text to its own start: in Arabic "Chess" sat at the far left of its line, away from the icon on the right, while
 * the Arabic line under it ("الإصدار 1.2.0", "مع Bob") sat beside it.
 */
const PHONE = { width: 375, height: 812 };
/** 39 letters of the 40 a manifest allows, in capitals: wider than any of its lines on a phone. */
const LONG = "CHESS OPENINGS TRAINER FOR CLUB PLAYERS";

async function setNickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

async function useLanguage(page: Page, language: string): Promise<void> {
  await page.evaluate((language) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
  }, language);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
}

/** Where a line's text is drawn: its letters, not its box (a block is as wide as its column). */
const inked = (line: Locator) => line.evaluate((element) => {
  const range = document.createRange();
  range.selectNodeContents(element);
  const { left, right } = range.getBoundingClientRect();
  return { left, right };
});

/** The line's text starts beside the icon: in Arabic at its left, in English at its right, 16 px apart at most. */
async function expectBeside(icon: Locator, line: Locator, rtl: boolean, what: string): Promise<void> {
  await line.scrollIntoViewIfNeeded();
  const box = (await icon.boundingBox())!, text = await inked(line);
  const gap = Math.round(rtl ? box.x - text.right : text.left - (box.x + box.width));
  expect.soft(gap, `${what}: ${gap} px from the icon`).toBeGreaterThanOrEqual(0);
  expect.soft(gap, `${what}: ${gap} px from the icon`).toBeLessThanOrEqual(16);
}

/** A title too long for its line is cut at its end: its first letter shows, an ellipsis takes its last ones' place. */
async function expectCutAtEnd(line: Locator, what: string): Promise<void> {
  await line.scrollIntoViewIfNeeded();
  const seen = await line.evaluate((element) => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    const range = document.createRange();
    range.setStart(element.firstChild!, 0);
    range.setEnd(element.firstChild!, 1);
    const first = range.getBoundingClientRect();
    return { direction: style.direction, overflow: style.textOverflow, cut: element.scrollWidth > element.clientWidth, firstIn: first.left >= box.left - 1 && first.right <= box.right + 1 };
  });
  expect.soft(seen, what).toEqual({ direction: "ltr", overflow: "ellipsis", cut: true, firstIn: true });
}

for (const [language, title] of [["ar", "Chess"], ["en", "Chess"], ["ar", LONG]] as const) {
  const long = title === LONG;
  test(`${language}${long ? ", a long title" : ""}: an app's title and tagline sit beside its icon on every screen`, { tag: ["@feature:apps.page", "@feature:apps.chat.card", "@feature:apps.view", "@feature:app.i18n"] }, async ({ peer }) => {
    const rtl = language === "ar";
    const store = await testStore({ title });
    const tagline = "Play chess with a contact";
    const [ana, bob] = await Promise.all([peer("ana"), peer("bob")]);
    await serveStore(ana.context, store);
    await serveStore(bob.context, store);
    await setNickname(ana, "Ana");
    await setNickname(bob, "Bob");
    await ana.page.getByTestId("account-apps").click();
    await ana.page.getByTestId("apps-add").click();
    await ana.page.getByTestId("apps-add-url").fill(STORE_URL);
    await ana.page.getByTestId("apps-add-check").click();
    await ana.page.getByTestId("apps-add-store-confirm").click();
    await ana.page.getByTestId("app-store").filter({ hasText: store.storeName }).getByTestId("app-listing-install").click();
    await ana.page.getByTestId("app-install").getByTestId("app-install-confirm").click();
    await expect(ana.page.getByTestId("installed-app")).toContainText(title);
    await ana.page.goto("/#/");
    await pair(ana, bob);

    const page = ana.page;
    await page.setViewportSize(PHONE);
    await useLanguage(page, language);

    // The Apps page: the store's listing and the installed app's row.
    await page.goto("/#/apps");
    const listing = page.getByTestId("app-store").filter({ hasText: store.storeName }).getByTestId("app-listing");
    await expect(listing).toBeVisible();
    const installed = page.getByTestId("installed-app");
    if (long) {
      await expectCutAtEnd(listing.getByText(title, { exact: true }), "listing");
      await expectCutAtEnd(installed.getByText(title, { exact: true }), "installed row");
    } else {
      await expectBeside(listing.getByTestId("app-icon"), listing.getByText(title, { exact: true }), rtl, "listing's title");
      await expectBeside(listing.getByTestId("app-icon"), listing.getByText(tagline, { exact: true }), rtl, "listing's tagline");
      await expectBeside(installed.getByTestId("app-icon"), installed.getByText(title, { exact: true }), rtl, "installed row's title");
      await expectBeside(installed.getByTestId("app-icon"), installed.getByText(tagline, { exact: true }), rtl, "installed row's tagline");
    }

    // Its details screen.
    await installed.getByRole("button").first().click();
    const details = page.getByTestId("app-details");
    await expect(details).toBeVisible();
    await expectBeside(details.getByTestId("app-icon"), details.getByRole("heading", { name: title, exact: true }), rtl, "details screen's title");
    await expectBeside(details.getByTestId("app-icon"), details.getByText(tagline, { exact: true }), rtl, "details screen's tagline");
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);

    // A chat's + → Apps, then the app open in the chat: its header beside the contact's picture.
    await page.goto("/#/");
    await page.getByTestId("chat-row").first().click();
    await (await composerRow(page, "composer-apps")).click();
    const row = page.getByTestId("chat-apps").getByTestId("chat-app");
    await expect(row).toBeVisible();
    if (long) await expectCutAtEnd(row.getByText(title, { exact: true }), "chat's apps");
    else {
      await expectBeside(row.getByTestId("app-icon"), row.getByText(title, { exact: true }), rtl, "chat's apps: title");
      await expectBeside(row.getByTestId("app-icon"), row.getByText(tagline, { exact: true }), rtl, "chat's apps: tagline");
    }
    await row.getByTestId("chat-app-open").click();
    const app = page.getByTestId("mini-app");
    await expect(app.getByTestId("mini-app-title")).toHaveText(title);
    if (long) await expectCutAtEnd(app.getByTestId("mini-app-title"), "mini-app header");
    else await expectBeside(app.getByTestId("mini-app-avatar"), app.getByTestId("mini-app-title"), rtl, "mini-app header");

    // Bob's card for it, and the install screen its Join opens.
    const other = bob.page;
    await other.setViewportSize(PHONE);
    await useLanguage(other, language);
    await other.goto("/#/");
    await other.getByTestId("chat-row").first().click();
    const card = chat(bob).getByTestId("app-card");
    await expect(card.getByTestId("app-card-install")).toBeVisible();
    const cardTitle = card.getByTestId("app-card-title").getByText(title, { exact: true });
    if (long) await expectCutAtEnd(cardTitle, "card");
    else await expectBeside(card.getByTestId("app-icon"), cardTitle, rtl, "card's title");
    await card.getByTestId("app-card-install").click();
    const install = other.getByTestId("app-install");
    await expect(install.getByTestId("app-install-confirm")).toBeVisible();
    await expectBeside(install.getByTestId("app-icon"), install.getByRole("heading", { name: title, exact: true }), rtl, "install screen's title");
    await expectBeside(install.getByTestId("app-icon"), install.getByText(tagline, { exact: true }), rtl, "install screen's tagline");
  });
}
