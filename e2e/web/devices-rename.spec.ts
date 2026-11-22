import { expect, test } from "../support/fixtures";
import { enrollDevice } from "../support/devices";

/**
 * Rename (WISP 06 § User experience, the row menu). Two browser contexts are the person's two devices: the desktop is
 * active, the phone on standby with a live link. The desktop renames the phone and then itself; the phone's standby
 * screen names the desktop by its new name, read from the set's next record on the desktop's hint. Every password here
 * is a test value.
 */

test("the active device renames the other device and itself, and the standby shows the new name", { tag: ["@feature:devices.screens"] }, async ({ peer }) => {
  test.setTimeout(8 * 60_000);
  const [desktop, phone] = await Promise.all([peer("desktop"), peer("phone")]);
  await enrollDevice(desktop, phone, { name: "Phone" });
  await desktop.page.goto("/#/profile");
  const rows = desktop.page.getByTestId("device-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "Phone" }).getByTestId("device-link-status")).toHaveAttribute("data-status", "live", { timeout: 120_000 });

  // The phone's row: Rename, the name prefilled, Enter saves.
  const phoneMenu = rows.filter({ hasText: "Phone" }).getByTestId("device-menu");
  await phoneMenu.click();
  await desktop.page.getByTestId("device-rename-open").click();
  const field = desktop.page.getByTestId("device-rename-name");
  await expect(field).toHaveValue("Phone");
  await field.fill("Pixel");
  await field.press("Enter");
  await expect(desktop.page.getByTestId("device-rename")).toHaveCount(0, { timeout: 60_000 });
  await expect(rows.filter({ hasText: "Pixel" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Pixel" }).getByTestId("device-menu")).toBeFocused();

  // This device's own row has Rename too; Escape first cancels it.
  await rows.first().getByTestId("device-menu-self").click();
  await desktop.page.getByTestId("device-rename-open").click();
  await desktop.page.keyboard.press("Escape");
  await expect(desktop.page.getByTestId("device-rename")).toHaveCount(0);
  await rows.first().getByTestId("device-menu-self").click();
  await desktop.page.getByTestId("device-rename-open").click();
  await desktop.page.getByTestId("device-rename-name").fill("Office PC");
  await desktop.page.getByTestId("device-rename-save").click();
  await expect(rows.first()).toContainText("Office PC", { timeout: 60_000 });

  // The phone reads the record on the desktop's hint: its standby screen names the desktop by its new name.
  await expect(phone.page.getByTestId("device-standby-title")).toHaveText("Active on Office PC", { timeout: 120_000 });
});
