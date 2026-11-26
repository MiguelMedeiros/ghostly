import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { composerRow } from "../support/composer";

/**
 * A group's + → Payment opens the list of whom to pay: 360px wide from 768px up, at the composer's start. It was kept
 * to the window, not to its chat pane: upright on an iPad (768 by 1024) it ran 13px past the screen's edge, its start
 * cut off in Arabic, and on a phone on its side (844 by 390) 42px under the notch.
 */
const NOTCH = { left: 47, right: 47, top: 0, bottom: 21 };
const SIZES = [
  { name: "an iPad upright", width: 768, height: 1024, insets: { left: 0, right: 0, top: 0, bottom: 0 } },
  { name: "a phone on its side", width: 844, height: 390, insets: NOTCH },
];

async function useLanguage(page: Page, language: string): Promise<void> {
  await page.evaluate((language) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
  }, language);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", language);
}

test("a group's list of whom to pay stays on the screen and out of the notch, in English and Arabic", { tag: ["@feature:groups.payments.member", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const [alice, bob] = await Promise.all([peer("alice", { mobile: true, viewport: SIZES[1] }), peer("bob")]);
  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Lunch");
  // A private group (group-mesh/1): payments exist only there (WISP 902 § Payments).
  await alice.page.getByTestId("new-group-kind-mesh").click();
  await alice.page.getByTestId("new-group-create").click();
  const url = await alice.page.getByTestId("group-share-dialog").getByTestId("group-link-url").inputValue();
  await alice.page.getByTestId("group-share-done").click();
  await bob.page.goto(url);
  await expect(bob.page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 120_000 });

  const page = alice.page;
  const cdp = await page.context().newCDPSession(page);
  for (const language of ["en", "ar"]) {
    await useLanguage(page, language);
    for (const size of SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: size.insets });
      await (await composerRow(page, "payment-button")).click();
      const list = page.getByTestId("group-pay-recipients");
      await expect(list).toBeVisible();
      const box = (await list.boundingBox())!;
      const where = `${language}, ${size.name}: ${Math.round(box.x)}..${Math.round(box.x + box.width)}`;
      expect.soft(box.x, `${where} starts inside the safe area`).toBeGreaterThanOrEqual(size.insets.left);
      expect.soft(box.x + box.width, `${where} ends inside the safe area`).toBeLessThanOrEqual(size.width - size.insets.right);
      await test.info().attach(`${language}, ${size.name}`, { body: await page.screenshot({ animations: "disabled" }), contentType: "image/png" });
      await page.keyboard.press("Escape");
      await expect(list).toHaveCount(0);
    }
  }
});
