import { expect, test } from "../support/fixtures";

/**
 * Hold messages… on a short screen: a phone on its side, a window at 200% zoom. The dialog was taller than the window
 * with nothing to scroll, so its title and its Save were cut with no way to reach them.
 */
for (const { language, width, height } of [{ language: "en", width: 568, height: 320 }, { language: "pt", width: 667, height: 375 }, { language: "fr", width: 320, height: 568 }]) {
  test(`Hold messages stays in a ${width}x${height} window in ${language}, and scrolls to its title and its Save`, { tag: ["@feature:delivery.hold.enable", "@feature:app.mobile-layout"] }, async ({ peer }) => {
    const alice = await peer(`hold-short-${language}`, { viewport: { width, height } });
    const page = alice.page;
    await page.evaluate((chosen) => localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}"), language: chosen })), language);
    await page.reload();
    await page.getByTestId("sidebar-new-chat").click();
    await page.getByTestId("chat-options").click();
    await page.getByTestId("chat-more-open").click();
    await page.getByTestId("chat-hold-open").click();

    const dialog = page.getByTestId("chat-hold");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.y, "the dialog's top is on the screen").toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height, "the dialog's bottom is on the screen").toBeLessThanOrEqual(height);

    const inWindow = (id: string) => page.getByTestId(id).evaluate((element, windowHeight) => {
      const { top, bottom } = element.getBoundingClientRect();
      return top >= 0 && bottom <= windowHeight;
    }, height);
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, 2_000);
    await expect.poll(() => inWindow("chat-hold-save")).toBe(true);
    await page.mouse.wheel(0, -2_000);
    await expect.poll(() => page.locator("#chat-hold-title").evaluate((title) => title.getBoundingClientRect().top >= 0)).toBe(true);
  });
}
