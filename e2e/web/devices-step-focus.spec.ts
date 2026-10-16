import { expect, test } from "../support/fixtures";
import { pasteInvite } from "../support/clipboard";
import { DEVICE_SET_PASSWORD, finishJoin } from "../support/devices";

/**
 * Adding a device, the button pressed goes away with its step: Next (the password), Add (the new device's name) and
 * They match. The focus stays in the dialog each time, so Tab and a screen reader go on from there, not from the top
 * of the page. Every password here is a test value.
 */
test("Add a device: after Next, Add and They match the focus stays in the dialog", { tag: ["@feature:devices.enroll"] }, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const [desktop, phone] = await Promise.all([peer("desktop"), peer("phone")]);
  const page = desktop.page;
  const focusIn = (dialog: import("@playwright/test").Locator) => dialog.locator(":focus");
  await page.goto("/#/profile");
  await page.getByTestId("device-add-open").click();
  const add = page.getByTestId("device-add");
  await add.getByTestId("device-add-password").fill(DEVICE_SET_PASSWORD);
  await add.getByTestId("device-add-password-again").fill(DEVICE_SET_PASSWORD);
  await add.getByTestId("device-add-next").click();
  await expect(add.getByTestId("device-add-code")).toBeVisible();
  await expect(focusIn(add)).toHaveCount(1);
  const code = (await add.getByTestId("device-add-code").getAttribute("data-code"))!;

  await phone.page.getByTestId("home-already").click();
  await phone.page.getByTestId("device-join-add").click();
  await pasteInvite(phone.page, code);
  const join = phone.page.getByTestId("device-join");
  await join.getByTestId("device-join-name").fill("Phone");
  await join.getByTestId("device-join-next").click();
  await expect(join.getByTestId("device-join-name")).toHaveCount(0);
  await expect(focusIn(join)).toHaveCount(1);

  await expect(add.getByTestId("device-add-digits")).toBeVisible({ timeout: 90_000 });
  await add.getByTestId("device-add-match").click();
  await expect(add.getByTestId("device-add-done")).toBeVisible({ timeout: 90_000 });
  await expect(focusIn(add)).toHaveCount(1);
  await finishJoin(phone.page);
});
