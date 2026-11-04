import { expect, test } from "../support/fixtures";
import { DEVICE_SET_PASSWORD } from "../support/devices";

/**
 * The device dialogs open with the focus where their first answer is typed. A closed <dialog> is hidden, so a field's
 * autoFocus did nothing and showModal() gave the focus to Close: the lock password typed straight away went nowhere,
 * and its first space pressed Close. Every password here is a test value.
 */
test("Add a device from the keyboard: the password field has the focus, and the password typed with its spaces shows the code", { tag: ["@feature:devices.enroll"] }, async ({ peer }) => {
  const { page } = await peer("desktop");
  await page.goto("/#/profile");
  // Add stays off until the device set is read. press() does not wait for that (click() does), and Enter on a button
  // still off went nowhere, so the dialog never opened.
  const open = page.getByTestId("device-add-open");
  await expect(open).toBeEnabled();
  await open.press("Enter");
  const add = page.getByTestId("device-add");
  await expect(add).toBeVisible();
  await expect(add.getByTestId("device-add-password")).toBeFocused();
  await page.keyboard.type(DEVICE_SET_PASSWORD);
  await page.keyboard.press("Tab");
  await expect(add.getByTestId("device-add-password-again")).toBeFocused();
  await page.keyboard.type(DEVICE_SET_PASSWORD);
  await page.keyboard.press("Enter");
  await expect(add.getByTestId("device-add-code")).toBeVisible();
  // Closed, the focus goes back to what opened it.
  await page.keyboard.press("Escape");
  await expect(add).toBeHidden();
  await expect(open).toBeFocused();
});
