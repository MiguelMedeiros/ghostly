import type { Locator } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * The account switcher on a phone on its side (844 by 390, the notch's sides and the home indicator as an iPhone has
 * them). At 768px and up it is a popover over the account bar, as tall as its rows: with a second profile it was 336px
 * in the 306px above the bar, and with four it began 128px above the top of the screen. The profile in use, Set a
 * status and the first profiles were off the screen, with nothing to scroll.
 */
const SIDE = { width: 844, height: 390 };
const INSETS = { left: 47, right: 47, top: 0, bottom: 21 };

/** Whether the element is on the screen and a tap at its centre lands on it. */
const reach = (locator: Locator) => locator.evaluate((element, height) => {
  const box = element.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return box.top >= -1 && box.bottom <= height + 1 && !!hit && element.contains(hit) ? "in view" : `${Math.round(box.top)}..${Math.round(box.bottom)} of 0..${height}`;
}, SIDE.height);

test("a phone on its side: the account switcher with four profiles stays on the screen and scrolls to every row", { tag: ["@feature:app.mobile-layout", "@feature:profiles.switcher"] }, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const { page } = await peer("switcher-side", { mobile: true, viewport: SIDE });
  await (await page.context().newCDPSession(page)).send("Emulation.setSafeAreaInsetsOverride", { insets: INSETS });
  for (const name of ["Work", "Family", "Travel"]) {
    await page.goto("/#/profile");
    await page.getByTestId("profile-new").click();
    await page.getByTestId("profile-new-name").fill(name);
    await page.getByTestId("profile-create").click();
    await expect(page.getByTestId("profile-name")).toHaveValue(name, { timeout: 60_000 });
    await expect(page.getByTestId("profile-switch-splash")).toHaveCount(0, { timeout: 30_000 });
  }
  await page.goto("/#/");

  await page.getByTestId("account-profile").click();
  const menu = page.getByTestId("profile-switcher");
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId("profile-switcher-item")).toHaveCount(3);
  // The whole popover between the top of the screen and the account bar.
  await expect.poll(async () => Math.round((await menu.boundingBox())!.y)).toBeGreaterThanOrEqual(0);
  const bar = (await page.getByTestId("account-profile").boundingBox())!;
  const box = (await menu.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
  await test.info().attach("four profiles on its side", { body: await page.screenshot({ animations: "disabled" }), contentType: "image/png" });

  // Every row can be brought into view and tapped, the first and the last included.
  const rows = menu.locator("[role^='menuitem']");
  for (const row of await rows.all()) {
    await row.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
    expect.soft(await reach(row), await row.getAttribute("data-testid") ?? "row").toBe("in view");
  }
  // Opened with the keyboard's focus on the first other profile: that row is in view at once.
  await page.keyboard.press("Escape");
  await page.getByTestId("account-profile").click();
  await expect(menu.getByTestId("profile-switcher-item").first()).toBeFocused();
  expect(await reach(menu.getByTestId("profile-switcher-item").first())).toBe("in view");

  // Set a status, the row that was off the screen, opens its dialog.
  await menu.getByTestId("profile-switcher-status").click();
  await expect(page.getByTestId("status-picker")).toBeVisible();
});
