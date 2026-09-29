import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * The web app on a phone, installed (display-mode: standalone) and with the on-screen keyboard up. Playwright
 * has no keyboard to open: it is the viewport losing a keyboard's height (336px, an iPhone's) while a field has
 * the focus, which is what Android (resizes-content) and an installed iPhone web app do to the page.
 *
 * What only the iOS Simulator shows, and these cannot: iOS 26 giving an installed app the screen less the status
 * bar, with nothing drawn in the band left at the bottom. A document 100vh tall (src/index.css) is what fixes
 * it there; here, that the document is as tall as the screen.
 */
const PHONE = { width: 390, height: 844 };
const KEYBOARD = 336;

/**
 * Opened from the home screen, as iOS says it (`navigator.standalone`): Chromium has no way to emulate
 * `display-mode: standalone`, and the app asks either.
 */
async function standalone(page: Page): Promise<void> {
  await page.context().addInitScript(() => Object.defineProperty(navigator, "standalone", { configurable: true, value: true }));
  await page.reload();
  await expect(page.getByTitle("New Chat")).toBeVisible();
}

/** The element's box, against the part of the page that is visible. */
async function box(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, visible: window.visualViewport?.height ?? window.innerHeight };
  });
}

test("installed on a phone: the app fills the screen, and the composer rides the keyboard", { tag: ["@feature:app.mobile-layout", "@feature:app.pwa.install"] }, async ({ peer }) => {
  const { page } = await peer("alice", { mobile: true, viewport: PHONE });
  await standalone(page);

  // As tall as the screen, not the body's nothing (every phone screen is fixed to the viewport).
  expect(await page.evaluate(() => document.documentElement.getBoundingClientRect().height)).toBe(PHONE.height);
  const tabs = await box(page, '[data-testid="mobile-tabs"]');
  expect(tabs.bottom).toBe(PHONE.height);

  await page.getByTitle("New Chat").click();
  const input = page.getByPlaceholder("Message…");
  await input.focus();
  await page.setViewportSize({ width: PHONE.width, height: PHONE.height - KEYBOARD });

  // Up: the page knows (the home indicator's inset no longer pads the composer), the field and its buttons sit
  // above the keyboard, and the header is still on screen.
  await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");
  await expect(input).toBeFocused();
  const row = await box(page, ".composer-row");
  expect(row.bottom).toBeLessThanOrEqual(row.visible);
  expect(row.top).toBeGreaterThan(0);
  const back = await box(page, '[data-testid="chat-back"]');
  expect(back.top).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // Down: the whole screen again.
  await input.blur();
  await page.setViewportSize(PHONE);
  await expect(page.locator("html")).toHaveAttribute("data-keyboard", "false");
  await expect.poll(async () => (await box(page, ".app-shell")).bottom).toBe(PHONE.height);
  expect((await box(page, ".composer-row")).bottom).toBeLessThanOrEqual(PHONE.height);
});
