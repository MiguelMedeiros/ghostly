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

/** Ana installs Chess from the store, pairs with Bob and opens it in their chat: Bob gets its card. */
async function cardInChat(peer: (name: string) => Promise<Peer>): Promise<{ ana: Peer; bob: Peer }> {
  const store = await testStore();
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
  await expect(ana.page.getByTestId("installed-app")).toContainText(store.title);
  await ana.page.goto("/#/");
  await pair(ana, bob);
  await (await composerRow(ana.page, "composer-apps")).click();
  await ana.page.getByTestId("chat-apps").getByTestId("chat-app-open").click();
  await expect(chat(bob).getByTestId("app-card")).toContainText("Ana opened it here");
  return { ana, bob };
}

test("on a phone at a doubled text size, Add's store question and a card's install screen keep their buttons on screen", { tag: ["@feature:apps.page", "@feature:apps.chat.card", "@feature:app.accessibility"] }, async ({ peer }) => {
  const { bob } = await cardInChat(peer);
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

/** The card's words' sizes, in px: its title, who opened it, "Not checked yet", the fingerprint, its time. */
const cardSizes = (card: Locator) => card.evaluate((card) => {
  const px = (element: Element | null | undefined) => element ? Math.round(parseFloat(getComputedStyle(element).fontSize) * 10) / 10 : 0;
  return {
    title: px(card.querySelector("[data-testid=app-card-title]")),
    who: px(card.querySelector("[data-testid=app-card-who]")),
    check: px(card.querySelector("[data-testid=app-card-check]")),
    fingerprint: px(card.querySelector(".font-mono")),
    time: px(card.querySelector(".ms-auto")),
  };
});

/** What is cut or pushed out: the page wider than the screen, the card past its edge, one of its lines wider than its box. */
const cardCut = (card: Locator) => card.evaluate((card) => {
  const out: string[] = [];
  if (document.documentElement.scrollWidth > window.innerWidth) out.push(`page ${document.documentElement.scrollWidth} > ${window.innerWidth}`);
  const box = card.getBoundingClientRect();
  if (box.left < -0.5 || box.right > window.innerWidth + 0.5) out.push(`card at ${box.left}-${box.right}`);
  for (const id of ["app-card-who", "app-card-check", "app-card-install"]) {
    const element = card.querySelector<HTMLElement>(`[data-testid=${id}]`);
    if (!element) { out.push(`${id} missing`); continue; }
    if (element.scrollWidth > element.clientWidth + 1) out.push(`${id} ${element.scrollWidth} wide in ${element.clientWidth}`);
    const own = element.getBoundingClientRect();
    if (own.left < box.left - 0.5 || own.right > box.right + 0.5) out.push(`${id} at ${own.left}-${own.right} out of ${box.left}-${box.right}`);
  }
  return out;
});

async function settings(page: Page, values: { language?: string; textSize: string }): Promise<void> {
  await page.evaluate((values) => localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}"), ...values })), values);
  await page.reload();
}

test("at Text size Huge on a phone, an app's card in a chat grows with the messages, in English and Arabic, and nothing is cut", { tag: ["@feature:settings.text-size", "@feature:apps.chat.card", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const { bob } = await cardInChat(peer);
  const page = bob.page;
  await page.setViewportSize(PHONE);
  const card = chat(bob).getByTestId("app-card");
  await expect(card).toBeVisible();
  const before = await cardSizes(card);
  expect(before).toEqual({ title: 14, who: 12, check: 12, fingerprint: 11, time: 11 });

  for (const language of ["en", "ar"]) {
    await settings(page, { language, textSize: "huge" });
    await expect(page.locator("html")).toHaveAttribute("lang", language);
    await page.goto("/#/");
    await page.getByTestId("chat-row").first().click();
    await expect(card).toBeVisible();
    // Its words at half again their size, as the messages are; its time beside it as a message's keeps its own.
    expect(await cardSizes(card), language).toEqual({ title: 21, who: 18, check: 18, fingerprint: 16.5, time: 11 });
    expect(await cardCut(card), language).toEqual([]);
    await card.screenshot({ path: test.info().outputPath(`card-huge-${language}.png`) });
  }
});
