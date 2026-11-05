import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { iosKeyboard, keyboard } from "../support/keyboard";

/**
 * The composer on a phone with the iPhone's keyboard up (e2e/support/keyboard.ts: only the visual viewport gets
 * shorter). On its side (844 by 390, two panes) the keyboard leaves 150px: a message of five lines grew the field to
 * its fixed 120px, the composer took 144px under a 56px header, and Send, + and the emoji button went under the
 * keyboard (about 40px), its refusal card off the top of the screen. Held upright the field still grows to 120px.
 */
const SCREENS = [
  { name: "on its side", width: 844, height: 390, keyboard: 240, insets: { left: 47, right: 47, top: 0, bottom: 21 } },
  { name: "upright", width: 390, height: 844, keyboard: 336, insets: { left: 0, right: 0, top: 47, bottom: 34 } },
];
const FIVE_LINES = "one\ntwo\nthree\nfour\nfive";

/** Where the element is against what the keyboard leaves, and whether a tap at its centre lands on it. */
const place = (locator: Locator) => locator.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return {
    top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height),
    visible: Math.round(window.visualViewport?.height ?? window.innerHeight), tappable: !!hit && element.contains(hit),
  };
});

/** Two frames: what the keyboard and the field's new height moved is laid out. */
const settled = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

async function inView(locator: Locator, what: string) {
  const at = await place(locator);
  expect.soft(at.top >= 0 && at.bottom <= at.visible && at.tappable, `${what} on screen and tappable: ${JSON.stringify(at)}`).toBe(true);
}

for (const language of ["en", "ar"]) {
  for (const screen of SCREENS) {
    test(`a phone ${screen.name} with the keyboard up (${language}): five lines keep Send, + and the emoji button above the keyboard`, { tag: ["@feature:app.mobile-layout", "@feature:app.responsive"] }, async ({ peer }) => {
      const { page } = await peer(`five-${language}-${screen.width}`, { mobile: true, viewport: { width: screen.width, height: screen.height } });
      if (language !== "en") {
        await page.evaluate((code) => {
          const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
          localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language: code }));
        }, language);
      }
      await iosKeyboard(page);
      // The notch and the home indicator, as an iPhone has them (Chromium's DevTools protocol plays the safe area).
      await (await page.context().newCDPSession(page)).send("Emulation.setSafeAreaInsetsOverride", { insets: screen.insets });
      if (language === "ar") await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await page.getByTestId("sidebar-new-chat").first().click();

      const field = page.locator(".composer-textarea");
      await field.focus();
      await keyboard(page, screen.keyboard);
      await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");
      await field.fill(FIVE_LINES);

      await settled(page);
      const visible = screen.height - screen.keyboard;
      const height = (await place(field)).height;
      // On its side a third of what the keyboard leaves at most: the field scrolls, the chat's header stays. Upright, 120px.
      if (screen.width > screen.height) expect.soft(height, "the field's height").toBeLessThanOrEqual(Math.floor(visible / 3));
      else expect.soft(height, "the field's height").toBe(120);
      await inView(page.locator(".composer-send"), "Send");
      await inView(page.getByTestId("composer-more"), "+");
      await inView(page.getByTestId("composer-expressions"), "emoji");
      await page.screenshot({ path: test.info().outputPath(`five-lines-${language}-${screen.width}.png`) });

      // A refusal (a paste far over what a message holds): its card above the composer, on screen, its × in reach.
      await field.fill(`${FIVE_LINES}\n${"x".repeat(20_000)}`);
      const card = page.locator("[data-composer] [role=alert]");
      await expect(card).toBeVisible();
      await settled(page);
      await inView(card, "refusal card");
      await inView(card.getByRole("button").last(), "the card's ×");
      await expect(field).toHaveValue(FIVE_LINES);
      await page.screenshot({ path: test.info().outputPath(`refusal-${language}-${screen.width}.png`) });

      if (screen.width > screen.height) {
        // A taller keyboard (its suggestions bar up): 120px left, and the card no longer fits above the composer. It is
        // cut at the top of the screen and scrolls, its × still in reach, the composer's buttons too.
        await keyboard(page, screen.height - 120);
        await field.fill(`${FIVE_LINES}\n${"y".repeat(20_001)}`);
        await expect(card).toBeVisible();
        await settled(page);
        await inView(card, "refusal card, 120px left");
        await inView(card.getByRole("button").last(), "the card's ×, 120px left");
        await inView(page.locator(".composer-send"), "Send, 120px left");
        await page.screenshot({ path: test.info().outputPath(`refusal-120-${language}-${screen.width}.png`) });
      }

      // Keyboard down: the field takes its 120px again.
      await field.blur();
      await keyboard(page, 0);
      await expect.poll(async () => (await place(field)).height).toBe(120);
    });
  }
}
