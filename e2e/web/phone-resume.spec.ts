import type { Page } from "@playwright/test";
import { seed } from "../support/chatPerf";
import { expect, test } from "../support/fixtures";
import { iosKeyboard, keyboard } from "../support/keyboard";

/**
 * The app installed on an iPhone, left with the keyboard up and opened again from the app switcher. iOS takes the
 * keyboard down while the page is in the background, where the page hears no resize, or gives the page a shorter
 * height for a moment as it shows again and then the whole one with no event. The app took the keyboard for still
 * up: the chat list ended halfway down the screen, its last row cut, and the tab bar was gone.
 *
 * The keyboard is iOS's (support/keyboard.ts: the visual viewport gets shorter, the page keeps its height), and the
 * background is the page's visibility as iOS reports it.
 */
const PHONE = { width: 393, height: 852 };
const KEYBOARD = 336;

/** Opened from the home screen, as iOS says it (`navigator.standalone`; Chromium cannot emulate the display mode). */
async function standalone(page: Page): Promise<void> {
  await page.context().addInitScript(() => Object.defineProperty(navigator, "standalone", { configurable: true, value: true }));
}

/** Pinned chats, a folded folder and an open one with more chats than the screen holds, as Miguel's list. */
async function longList(page: Page): Promise<void> {
  const labels = [...["Ana", "Bruno", "Carla"], ...["Lab 1", "Lab 2", "Lab 3"], ...Array.from({ length: 14 }, (_, i) => `Wave ${i + 1}`)];
  const ids = await seed(page, labels.map(label => ({ label, count: 1, lean: true })));
  await page.evaluate(ids => {
    ids.slice(0, 3).forEach(id => localStorage.setItem(`ghostly_pin_${id}`, "1"));
    const chats: Record<string, string> = {};
    ids.slice(3, 6).forEach(id => { chats[id] = "lab"; });
    ids.slice(6).forEach(id => { chats[id] = "wave"; });
    localStorage.setItem("ghostly_chat_folders", JSON.stringify({ folders: [{ id: "lab", name: "Caspers lab", folded: true }, { id: "wave", name: "Wave" }], chats }));
  }, ids);
}

/**
 * The page put in the background (`hidden`) or shown again, as iOS tells an installed app switched away from and back:
 * its visibility and the window's focus. (Not a `pageshow`: that is a page out of the back/forward cache, which the
 * app starts again, lib/restoredPage.ts.)
 */
async function visibility(page: Page, state: "hidden" | "visible"): Promise<void> {
  await page.evaluate(state => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => state === "hidden" });
    if (state === "hidden") window.dispatchEvent(new FocusEvent("blur"));
    document.dispatchEvent(new Event("visibilitychange"));
    if (state === "visible") window.dispatchEvent(new FocusEvent("focus"));
  }, state);
}

/** Where the list ends and the tab bar is (all 0 when it is not drawn). */
const layout = (page: Page) => page.evaluate(() => {
  const list = document.querySelector('[data-testid="chat-list"]')!.getBoundingClientRect();
  const tabs = document.querySelector('[data-testid="mobile-tabs"]')!.getBoundingClientRect();
  return { listBottom: Math.round(list.bottom), tabsTop: Math.round(tabs.top), tabsBottom: Math.round(tabs.bottom) };
});

/** The whole screen: the list down to the tab bar, the tab bar at the bottom, and its last row in full once scrolled to. */
async function fillsTheScreen(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-keyboard", "false");
  await expect.poll(() => layout(page)).toEqual({ listBottom: expect.any(Number), tabsTop: expect.any(Number), tabsBottom: PHONE.height });
  const { listBottom, tabsTop } = await layout(page);
  expect(listBottom).toBe(tabsTop);
  const last = page.getByTestId("chat-list").getByTestId("chat-row").last();
  await last.scrollIntoViewIfNeeded();
  const row = (await last.boundingBox())!;
  expect(row.y + row.height).toBeLessThanOrEqual(tabsTop);
}

/** The installed app with the long list, typing in its search: the keyboard up, the tab bar behind it. */
async function typing(page: Page): Promise<void> {
  await longList(page);
  await standalone(page);
  await iosKeyboard(page);
  await expect(page.getByTestId("chat-list").getByTestId("chat-row")).toHaveCount(17);
  await fillsTheScreen(page);
  await search(page).focus();
  await keyboard(page, KEYBOARD);
  await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");
}

const search = (page: Page) => page.getByTestId("sidebar").locator('input[type="search"]');

test.describe("installed on a phone, back from the background with the keyboard gone", () => {
  test("the keyboard taken down in the background, unheard: the list fills the screen again", { tag: ["@feature:app.mobile-layout", "@feature:app.pwa.install"] }, async ({ peer }, testInfo) => {
    const { page } = await peer("alice", { mobile: true, viewport: PHONE });
    await typing(page);
    // Off to another app: the field loses the focus while the keyboard still covers the page, then the keyboard
    // goes with no resize the page hears.
    await visibility(page, "hidden");
    await search(page).blur();
    await keyboard(page, 0, { quietly: true });
    await visibility(page, "visible");
    await fillsTheScreen(page);
    await page.screenshot({ path: testInfo.outputPath("resumed.png") });
    // Nothing of a wide window's at the screen's end beside the search and the rows: the list's fold button and its
    // resize handle are a side list's only.
    await expect(page.getByTestId("chat-list-toggle")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-resize")).toBeHidden();
    const atEdge = await page.evaluate(x => [80, 120, 160, 200, 240].map(y => {
      const hit = document.elementFromPoint(x, y)!;
      return !!hit.closest('[data-testid="chat-list"], .sidebar-header, input[type="search"]') || hit.querySelector('input[type="search"]') !== null;
    }), PHONE.width - 4);
    expect(atEdge).toEqual([true, true, true, true, true]);
  });

  test("a shorter height for a moment as it shows again, then the whole one unheard: the list fills the screen", { tag: ["@feature:app.mobile-layout", "@feature:app.pwa.install"] }, async ({ peer }, testInfo) => {
    const { page } = await peer("alice", { mobile: true, viewport: PHONE });
    await typing(page);
    await visibility(page, "hidden");
    await search(page).blur();
    await visibility(page, "visible");
    // As it shows: still the keyboard's height, heard; the whole height comes back a moment later, unheard.
    await keyboard(page, KEYBOARD);
    await page.waitForTimeout(50);
    await keyboard(page, 0, { quietly: true });
    await fillsTheScreen(page);
    await page.screenshot({ path: testInfo.outputPath("resumed-late.png") });
  });
});
