import { expect, test } from "../support/fixtures";
import { pasteInvite } from "../support/clipboard";

/**
 * A standby on a 375 px phone (WISP 06 § The standby screen): Your devices names the active device in full. In Italian
 * Check connection is wide enough to cut the default name "Chrome, Windows" to "Chrome, Win…" when both share a line;
 * the button goes to its own line instead.
 */

const PHONE = { mobile: true, viewport: { width: 375, height: 667 } };

test("on a 375 px phone in Italian, the standby's row names the active device in full, with Check connection on its own line", { tag: ["@feature:devices.standby-screen"] }, async ({ peer }) => {
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
  expect(await name.evaluate((el) => el.scrollWidth - el.clientWidth), "the name's cut-off width").toBe(0);
  // The button sits below the name, inside the row.
  const [nameBox, checkBox, rowBox] = [(await name.boundingBox())!, (await check.boundingBox())!, (await row.boundingBox())!];
  expect(checkBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height);
  expect(checkBox.x + checkBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
});
