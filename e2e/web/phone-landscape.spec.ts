import { createLink } from "@ghostly/core";
import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { chat, createWallet, expect, say, test, useFakeProviders } from "../support/fixtures";
import { iosKeyboard, keyboard } from "../support/keyboard";
import { pair } from "../support/paired";
import { optionsOf } from "../support/select";

/**
 * A phone on its side (iPhone 17: 874 by 402, the Dynamic Island 62px into one end, the home indicator 20px
 * above the bottom). The page runs under both (viewport-fit=cover), so the app keeps its content clear of the
 * sides. Chromium's DevTools protocol plays the safe area.
 */
const LANDSCAPE = { width: 874, height: 402 };
const SIDE = 62;
const HOME = 20;

test("a phone on its side: nothing sits under the notch or the home indicator", { tag: ["@feature:app.mobile-layout", "@feature:app.responsive"] }, async ({ peer }) => {
  const { page } = await peer("alice", { mobile: true, viewport: LANDSCAPE });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { left: SIDE, right: SIDE, top: 0, bottom: HOME } });
  await expect.poll(() => page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("div"));
    probe.style.paddingLeft = "env(safe-area-inset-left)";
    const inset = getComputedStyle(probe).paddingLeft;
    probe.remove();
    return inset;
  })).toBe(`${SIDE}px`);

  for (const locator of [page.getByPlaceholder("Search chats..."), page.getByTitle("New Chat").first()]) {
    const box = (await locator.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(SIDE);
    expect(box.x + box.width).toBeLessThanOrEqual(LANDSCAPE.width - SIDE);
  }
  // Nothing wider than the screen for the insets.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(LANDSCAPE.width);

  // A chat: its header and composer too.
  await page.getByTitle("New Chat").first().click();
  for (const locator of [page.getByPlaceholder("Message…"), page.getByTestId("chat-options")]) {
    const box = (await locator.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(SIDE);
    expect(box.x + box.width).toBeLessThanOrEqual(LANDSCAPE.width - SIDE);
  }
  // Two panes, both bottom rows above the home indicator: the message field and the account bar's places sat 7px into
  // it (an installed iPad too, 20px under both).
  const composer = (await page.locator(".composer-row").boundingBox())!;
  expect(composer.y + composer.height).toBeLessThanOrEqual(LANDSCAPE.height - HOME);
  for (const place of await page.getByTestId("account-bar").locator(".account-action").all()) {
    const box = (await place.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(LANDSCAPE.height - HOME);
  }

  // With the keyboard up the indicator is covered: the composer stands on the keyboard, no band for it in between.
  const field = page.getByPlaceholder("Message…");
  const composerPadding = () => page.locator("[data-composer]").evaluate((element) => parseFloat(getComputedStyle(element).paddingBottom));
  const resting = await composerPadding();
  await field.focus();
  await page.setViewportSize({ width: LANDSCAPE.width, height: LANDSCAPE.height - 200 });
  await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");
  await expect.poll(composerPadding).toBe(resting - HOME);
});

test("a phone on its side with the keyboard up: the account bar goes behind it and the chat list keeps the room", { tag: ["@feature:app.mobile-layout", "@feature:app.responsive"] }, async ({ peer }) => {
  // Safari's keyboard (only the visual viewport gets shorter) leaves 162px of 402: the list pane's header, the search
  // field and the account bar with its home-indicator band took all of it, and a search showed a list 0px tall.
  const { page } = await peer("side-search", { mobile: true, viewport: LANDSCAPE });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { left: SIDE, right: SIDE, top: 0, bottom: HOME } });
  await iosKeyboard(page);
  await page.getByTitle("New Chat").first().click();
  await expect(page.getByPlaceholder("Message…")).toBeVisible();
  const bar = page.getByTestId("account-bar");
  await expect(bar).toBeVisible();

  for (const field of [page.getByPlaceholder("Search chats..."), page.getByPlaceholder("Message…")]) {
    await field.focus();
    await keyboard(page, 240);
    await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");
    await expect(bar).toBeHidden();
    const list = (await page.getByTestId("chat-list").boundingBox())!;
    expect(list.height).toBeGreaterThan(40);
    expect(list.y + list.height).toBeLessThanOrEqual(LANDSCAPE.height - 240);
    await keyboard(page, 0);
    await expect(page.locator("html")).toHaveAttribute("data-keyboard", "false");
    await expect(bar).toBeVisible();
  }
});

for (const screen of [{ name: "a small phone", width: 667, height: 375, keyboard: 200 }, { name: "two panes", ...LANDSCAPE, keyboard: 240 }]) {
  test(`a phone on its side with the keyboard up (${screen.name}): a chat's search shows the message it found`, { tag: ["@feature:app.mobile-layout", "@feature:chat.search"] }, async ({ peer }) => {
    // The chat's header, the search bar and the composer took all of what the keyboard leaves: the list was 0px tall,
    // and "1 of 8" showed no message. While the search has the focus the composer goes behind the keyboard.
    const visible = screen.height - screen.keyboard;
    const { page } = await peer(`side-find-${screen.width}`, { mobile: true, viewport: { width: screen.width, height: screen.height } });
    await iosKeyboard(page);
    const mine = createLink().mine;
    await page.evaluate(({ mine }) => {
      const id = crypto.randomUUID().replaceAll("-", "");
      const start = Date.now() - 86_400_000;
      const messages = Array.from({ length: 120 }, (_, i) => ({
        id: `m${i}`, sender: i % 2 ? "peer" : "me", timestamp: start + i * 60_000, delivery: i % 2 ? undefined : "delivered",
        text: i % 30 === 5 ? `Needle ${i}` : `Message ${i}`,
      }));
      localStorage.setItem(`ghostly_${id}`, JSON.stringify({ id, mySeedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, messages, createdAt: start }));
      localStorage.setItem(`ghostly_join_${id}`, "true");
      window.dispatchEvent(new Event("session-updated"));
      location.hash = `/chat/${id}`;
    }, { mine });
    const composer = page.locator("[data-composer]");
    await expect(composer).toBeVisible();
    await page.getByTestId("chat-options").click();
    await page.getByTestId("chat-search-open").click();
    const field = page.getByTestId("chat-search-input");
    await expect(field).toBeFocused();
    await keyboard(page, screen.keyboard);
    await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");

    // A marked word between the search bar and the keyboard (rows drawn out of sight carry marks too).
    const shown = () => page.evaluate((visible) => {
      const top = document.querySelector("[data-testid=chat-search]")!.getBoundingClientRect().bottom;
      return [...document.querySelectorAll("[data-search-match]")].some((mark) => { const box = mark.getBoundingClientRect(); return box.top >= top && box.bottom <= visible; });
    }, visible);
    await field.fill("needle");
    await expect(page.getByTestId("chat-search-count")).toHaveText("1 of 4");
    await expect.poll(shown).toBe(true);
    await field.press("Enter");
    await expect(page.getByTestId("chat-search-count")).toHaveText("2 of 4");
    await expect.poll(shown).toBe(true);
    await expect(composer).toBeHidden();

    // Typing a message again: the composer is back, on the keyboard.
    await page.getByTestId("chat-search-close").click();
    await page.getByPlaceholder("Message…").focus();
    await expect(composer).toBeVisible();
    expect((await composer.boundingBox())!.y + (await composer.boundingBox())!.height).toBeLessThanOrEqual(visible + 1);
  });
}

test("a phone on its side: the chat beside the list uses its width, and a video keeps its shape", { tag: ["@feature:app.mobile-layout", "@feature:files.video.play"] }, async ({ peer }) => {
  // Two panes from 768px: the chat is what the list and the notch leave (about 330px here). Its rows kept a desktop's
  // 63px on each side, so a message took a third of it and a video became a tall black box around a small picture.
  const [alice, bob] = await Promise.all([peer("side-alice"), peer("side-bob", { mobile: true, viewport: LANDSCAPE })]);
  const cdp = await bob.page.context().newCDPSession(bob.page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { left: SIDE, right: SIDE, top: 0, bottom: 20 } });
  await pair(alice, bob);
  const text = "A message long enough to fill a whole line of the chat and then wrap onto a second one";
  await say(alice, text);
  await expect(chat(bob).getByText(text)).toBeVisible({ timeout: 30_000 });
  await alice.page.getByTestId("media-input").setInputFiles(fileURLToPath(new URL("../support/video-fixtures/ghosts.mp4", import.meta.url)));
  const frame = chat(bob).getByTestId("video-frame").last();
  await expect(frame).toBeVisible({ timeout: 30_000 });

  const listWidth = await chat(bob).evaluate((list) => list.clientWidth);
  expect(listWidth).toBeLessThan(400);
  const bubble = chat(bob).locator("[data-message-bubble]", { hasText: text });
  expect((await bubble.boundingBox())!.width).toBeGreaterThan(listWidth * 0.6);
  // 320 by 180: as wide as the chat lets it, as tall as that makes it.
  const box = (await frame.boundingBox())!;
  expect(box.width / box.height).toBeCloseTo(16 / 9, 1);
});

test("a phone on its side: a list pulled down at its top does not pull the page", { tag: ["@feature:app.mobile-layout", "@feature:app.responsive"] }, async ({ peer }) => {
  // Two panes on a touch screen: the page must not take a list's overscroll. Chrome's pull-to-refresh reloaded the app
  // when it did (an Android phone on its side, a tablet), dropping its chats and calls.
  const [phone, desktop] = await Promise.all([peer("pull-phone", { mobile: true, viewport: LANDSCAPE }), peer("pull-desktop")]);
  const overscroll = (page: Page) => page.evaluate(() => [document.documentElement, document.body].map((element) => getComputedStyle(element).overscrollBehaviorY));
  await expect(phone.page.locator(".two-pane")).toBeVisible();
  expect(await overscroll(phone.page)).toEqual(["none", "none"]);
  // With a mouse, the browser keeps its own (a trackpad's bounce and swipe back).
  await expect(desktop.page.locator(".two-pane")).toBeVisible();
  expect(await overscroll(desktop.page)).toEqual(["auto", "auto"]);
});

test("a phone on its side: an open select's list stays clear of the notch", { tag: ["@feature:app.mobile-layout", "@feature:app.responsive"] }, async ({ peer }) => {
  // Settings → Language sits at the right end, by the notch: its list kept only the 8px edge and ran 30px into it, the
  // chosen option's ✓ under the Dynamic Island.
  const { page } = await peer("select-side", { mobile: true, viewport: LANDSCAPE });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { left: SIDE, right: SIDE, top: 0, bottom: HOME } });
  await page.goto("/#/settings/appearance");
  const select = page.getByTestId("settings-language");
  // Scrolled to it by hand, as a person does: the page stops bringing Appearance back to the top as it loads.
  await expect(select).toBeVisible();
  const pane = (await page.locator("[data-page-body]").boundingBox())!;
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  // Scrolled until it is whole on screen, a wheel step at a time: Appearance grew (Text size and its samples, #6128),
  // and a fixed 150 px no longer reaches it.
  await expect(async () => {
    await page.mouse.wheel(0, 150);
    await expect(select).toBeInViewport({ ratio: 1, timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  const options = await optionsOf(select);
  const list = page.locator(`[id="${await select.getAttribute("aria-controls")}"]`);
  await expect(list).toHaveAttribute("data-placement", /.+/);
  await expect(list).toBeVisible();
  const box = (await list.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(SIDE);
  expect(box.x + box.width).toBeLessThanOrEqual(LANDSCAPE.width - SIDE);
  expect(box.y + box.height).toBeLessThanOrEqual(LANDSCAPE.height - HOME);
  await expect(options.first()).toBeVisible();
});

/**
 * What a panel from the end edge shows clear of the safe area: nothing past the end inset, under the top one (an
 * installed iPad's status bar) or in the home indicator's band. The insets differ on each side, so the end the page's
 * direction puts it at is the one checked.
 */
async function clearOfInsets(page: Page, panel: string, targets: string[], insets: { left: number; right: number; top: number; bottom: number }) {
  const rtl = await page.locator("html").getAttribute("dir") === "rtl";
  const end = rtl ? insets.left : insets.right;
  const box = (await page.getByTestId(panel).boundingBox())!;
  // At its end edge, as wide as before plus the inset: the content keeps its 400px.
  expect(rtl ? box.x : box.x + box.width).toBe(rtl ? 0 : LANDSCAPE.width);
  expect(box.width).toBe(400 + end);
  for (const id of targets) {
    const target = (await page.getByTestId(panel).getByTestId(id).boundingBox())!;
    if (rtl) expect(target.x).toBeGreaterThanOrEqual(end);
    else expect(target.x + target.width).toBeLessThanOrEqual(LANDSCAPE.width - end);
    expect(target.y).toBeGreaterThanOrEqual(insets.top);
    expect(target.y + target.height).toBeLessThanOrEqual(LANDSCAPE.height - insets.bottom);
  }
}

/** Uneven on purpose: a panel that pads the wrong side's inset is caught. And a status bar's 24px on top. */
const PANEL_INSETS = { left: 47, right: SIDE, top: 24, bottom: HOME };

for (const language of ["en", "ar"] as const) {
  test(`a phone on its side (${language}): a message's details keep the close button and Copy JSON clear of the notch and the home indicator`, { tag: ["@feature:app.mobile-layout", "@feature:chat.paired.message-details"] }, async ({ peer }) => {
    // The panel is a portal on the body, outside #root's side insets: its ✕ sat 16px from the screen's edge, under
    // the Dynamic Island's band, and Copy JSON in the home indicator's.
    const { page } = await peer(`side-details-${language}`, { mobile: true, viewport: LANDSCAPE });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: PANEL_INSETS });
    const mine = createLink().mine;
    await page.evaluate(({ mine, language }) => {
      const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
      localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
      const id = crypto.randomUUID().replaceAll("-", "");
      const messages = [{ id: "m0", sender: "peer", timestamp: Date.now() - 60_000, text: "Where did this come from?" }];
      localStorage.setItem(`ghostly_${id}`, JSON.stringify({ id, mySeedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, messages, createdAt: Date.now() - 120_000 }));
      localStorage.setItem(`ghostly_join_${id}`, "true");
      location.hash = `/chat/${id}`;
    }, { mine, language });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
    const row = page.locator(".chat-wallpaper [data-message-row]").filter({ hasText: "Where did this come from?" });
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByTestId("message-options").click({ force: true });
    await page.getByTestId("message-details").click();
    const panel = page.getByTestId("message-details");
    await expect(panel).toHaveAttribute("data-side", "end");
    await expect(panel).toHaveAttribute("data-loaded", "yes");
    // Its slide in over (it stays in getAnimations(), filled).
    await panel.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    await clearOfInsets(page, "message-details", ["message-details-close", "message-details-copy-all"], PANEL_INSETS);
  });
}

test("a phone on its side: a wallet total's breakdown keeps its close button clear of the notch", { tag: ["@feature:app.mobile-layout", "@feature:wallet.balance.total"] }, async ({ peer }) => {
  // The same panel from the end edge as a message's details, with the same escape from #root's insets.
  const alice = await peer("side-wallet-total");
  const page = alice.page;
  await useFakeProviders(alice);
  await createWallet(alice, "lightning", "testnet", { provider: "fake-lightning", fill: async (form) => {
    await form.getByLabel("Name").fill("Node A");
    await form.getByLabel("Access token").fill("token-a");
    await form.getByTestId("provider-save").click();
  } });
  await expect(page.getByTestId("wallet-total-bitcoin-amount")).toHaveText(/^100,000\s*test sats$/, { timeout: 30_000 });
  await page.setViewportSize(LANDSCAPE);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: PANEL_INSETS });
  await page.getByTestId("wallet-total-bitcoin").click();
  await expect(page.getByTestId("wallet-total-breakdown")).toHaveAttribute("data-side", "end");
  await clearOfInsets(page, "wallet-total-breakdown", ["wallet-total-close", "wallet-total-rows"], PANEL_INSETS);
});

for (const screen of [{ name: "a small phone", width: 667, height: 375, keyboard: 200 }, { name: "two panes", ...LANDSCAPE, keyboard: 240 }]) {
  test(`a phone on its side with the keyboard up (${screen.name}): a pinned message and a reply leave the message field above the keyboard`, { tag: ["@feature:app.mobile-layout", "@feature:chat.pins", "@feature:chat.replies", "@feature:chat.edit"] }, async ({ peer }) => {
    // The pinned bar and the reply or edit bar stood between the header and the field on top of each other: the list
    // was 0px tall, and the field went under the keyboard (109-227 of 175 visible at 667×375), what was typed out of sight.
    const visible = screen.height - screen.keyboard;
    const [alice, bob] = await Promise.all([peer(`side-bars-a-${screen.width}`), peer(`side-bars-b-${screen.width}`, { mobile: true, viewport: { width: screen.width, height: screen.height } })]);
    await pair(alice, bob);
    for (let i = 0; i < 3; i++) { await say(alice, `From alice ${i}`); await say(bob, `From bob ${i}`); }
    const page = bob.page;
    const row = (text: string) => page.locator(".chat-wallpaper [data-message-row]").filter({ hasText: text }).last();
    await expect(row("From alice 2")).toBeVisible();
    await iosKeyboard(page);
    await expect(row("From alice 2")).toBeVisible();
    const menu = async (text: string, item: string) => {
      await row(text).hover();
      await row(text).getByTestId("message-options").click({ force: true });
      await page.getByTestId(item).click();
    };
    const input = page.getByPlaceholder("Message…");
    const composer = page.locator("[data-composer]");
    const pinned = page.getByTestId("pinned-bar");
    // The whole composer (+, the field, Send) stands on the keyboard.
    const fits = async () => { const box = (await composer.boundingBox())!; return box.y + box.height <= visible + 1; };

    await menu("From alice 1", "message-pin");
    await expect(pinned).toBeVisible();
    await input.focus();
    await keyboard(page, screen.keyboard);
    await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");
    await expect.poll(fits).toBe(true);
    // The pinned bar waits behind the keyboard, as the tab bar does: the chat keeps that room.
    await expect(pinned).toBeHidden();

    await keyboard(page, 0);
    await input.blur();
    await expect(pinned).toBeVisible();
    await menu("From alice 2", "message-reply");
    await input.focus();
    await keyboard(page, screen.keyboard);
    await expect.poll(fits).toBe(true);
    await input.fill("one\ntwo\nthree\nfour");
    await expect.poll(fits).toBe(true);
    await expect(page.getByTestId("reply-quote-snippet")).toBeVisible();

    await input.fill("");
    await keyboard(page, 0);
    await page.keyboard.press("Escape");
    await input.blur();
    await menu("From bob 2", "message-edit");
    await keyboard(page, screen.keyboard);
    await expect.poll(fits).toBe(true);
    // Keyboard down: the pinned message is back.
    await keyboard(page, 0);
    await input.blur();
    await expect(pinned).toBeVisible();
  });
}
