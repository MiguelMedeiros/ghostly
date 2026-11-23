import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { pasteInvite } from "../support/clipboard";

/**
 * A standby on a 375 px phone (WISP 06 § The standby screen): Your devices names the active device in full. In Italian
 * Check connection is wide enough to cut the default name "Chrome, Windows" to "Chrome, Win…" when both share a line;
 * the button goes to its own line instead. At 200 % text on a 320 px phone the name alone is wider than the row: it
 * wraps, still whole.
 */

const PHONE = { mobile: true, viewport: { width: 375, height: 667 } };

/** The browser's default text size, as its settings set it (rem follows it). */
async function textSize(page: Page, px: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: px, fixed: Math.round(px * 13 / 16) } });
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(px);
}

/** The name is shown whole, inside its row, with Check connection on a line below it. */
async function expectWholeAbove(row: Locator, name: Locator, check: Locator): Promise<void> {
  expect(await name.evaluate((el) => el.scrollWidth - el.clientWidth), "the name's cut-off width").toBe(0);
  const [nameBox, checkBox, rowBox] = [(await name.boundingBox())!, (await check.boundingBox())!, (await row.boundingBox())!];
  expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
  expect(checkBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height);
  expect(checkBox.x + checkBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
}

test("on a 375 px phone in Italian, the standby's row names the active device in full, with Check connection on its own line; at 200 % text on a 320 px phone the name wraps, whole", { tag: ["@feature:devices.standby-screen"] }, async ({ peer }) => {
  const [active, phone] = await Promise.all([peer("active", PHONE), peer("phone", PHONE)]);

  await active.page.goto("/#/profile");
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
  await phone.page.getByTestId("device-join-name").fill("Phone");
  await phone.page.getByTestId("device-join-next").click();
  await expect(add.getByTestId("device-add-digits")).toBeVisible();
  await add.getByTestId("device-add-match").click();
  await phone.page.getByTestId("device-join-continue").click();
  await expect(phone.page.getByTestId("device-standby")).toBeVisible();

  // The standby in Italian.
  await phone.page.evaluate(() => {
    for (const key of ["ghostly_app_settings", ...Object.keys(localStorage).filter((key) => key.endsWith("_app_settings"))]) {
      localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), language: "it" }));
    }
  });
  await phone.page.reload();
  await expect(phone.page.locator("html")).toHaveAttribute("lang", /^it/);
  const row = phone.page.getByTestId("device-standby-link");
  await expect(row).toHaveAttribute("data-status", "live", { timeout: 90_000 });
  const check = row.getByTestId("device-standby-check");
  await expect(check).toHaveText("Verifica la connessione");

  const name = row.getByText("Chrome, Windows", { exact: true });
  await expect(name).toBeVisible();
  // The button sits below the name, inside the row; the name keeps one line.
  await expectWholeAbove(row, name, check);
  expect((await name.boundingBox())!.height).toBeLessThan(30);

  // 200 % text on a 320 px phone: the name is wider than the whole row and wraps, where it showed "Chrome, Win…".
  await phone.page.setViewportSize({ width: 320, height: 568 });
  await textSize(phone.page, 32);
  await expectWholeAbove(row, name, check);
});
