import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { pasteInvite } from "../support/clipboard";

/**
 * The device dialogs on a 320 px phone at 200 % text (WISP 06 § User experience): a device name of one long word (16
 * bytes, the most a device's slot keeps) wraps inside the dialog, as the standby screen's does, where it ran past the
 * dialog's edge, cut, with the dialog scrolling sideways. Add a device's last step says it, and Lost or stolen's
 * "Remove <device>" button holds it.
 */

const PHONE = { mobile: true, viewport: { width: 320, height: 568 } };
const NAME = "WWWWWWWWWWWWWWWW";

/** The browser's default text size, as its settings set it (rem follows it). */
async function textSize(page: Page, px: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: px, fixed: Math.round(px * 13 / 16) } });
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(px);
}

/** Nothing in the dialog is wider than it: no sideways scroll, and `inner` whole and inside it. */
async function expectInside(dialog: Locator, inner: Locator): Promise<void> {
  expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth), "the dialog's sideways scroll").toBe(0);
  expect(await inner.evaluate((el) => el.scrollWidth - el.clientWidth), "the line's cut-off width").toBe(0);
  const [box, line] = [(await dialog.boundingBox())!, (await inner.boundingBox())!];
  expect(line.x).toBeGreaterThanOrEqual(box.x);
  expect(line.x + line.width).toBeLessThanOrEqual(box.x + box.width);
}

test("on a 320 px phone at 200 % text, a one-word device name wraps inside Add a device's last step and Lost or stolen's Remove button", { tag: ["@feature:devices.enroll", "@feature:devices.remove"] }, async ({ peer }) => {
  const [active, phone] = await Promise.all([peer("active", PHONE), peer("phone", PHONE)]);
  await active.page.goto("/#/profile");
  await textSize(active.page, 32);

  await active.page.getByTestId("device-add-open").click();
  const add = active.page.getByTestId("device-add");
  await add.getByTestId("device-add-password").fill("a long lock password");
  await add.getByTestId("device-add-password-again").fill("a long lock password");
  await add.getByTestId("device-add-next").click();
  const code = (await add.getByTestId("device-add-code").getAttribute("data-code"))!;

  // On a phone the chat list offers I already use Ghostly (the home pane has it on a wider screen).
  await phone.page.getByTestId("sidebar-already").click();
  await phone.page.getByTestId("device-join-add").click();
  await pasteInvite(phone.page, code);
  await phone.page.getByTestId("device-join-name").fill(NAME);
  await phone.page.getByTestId("device-join-next").click();
  await expect(add.getByTestId("device-add-digits")).toBeVisible();
  await add.getByTestId("device-add-match").click();

  // "<device> added. It is on standby."
  const done = add.getByTestId("device-add-done");
  await expect(done).toHaveText(`${NAME} added. It is on standby.`);
  await expectInside(add, done);
  await add.getByRole("button", { name: "Done" }).click();
  await phone.page.getByTestId("device-join-continue").click();

  // Remove, then Lost or stolen?: "Remove <device>".
  await active.page.getByTestId("device-row").filter({ hasText: NAME }).getByTestId("device-menu").click();
  await active.page.getByTestId("device-remove-open").click();
  await active.page.getByTestId("device-remove-lost").click();
  const lost = active.page.getByTestId("device-lost");
  const remove = lost.getByTestId("device-lost-remove");
  await expect(remove).toHaveText(`Remove ${NAME}`);
  await expectInside(lost, remove);
  await expectInside(lost, remove.locator("span"));
});
