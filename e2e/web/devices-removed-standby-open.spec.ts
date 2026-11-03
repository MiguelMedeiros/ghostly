import { expect, test } from "../support/fixtures";
import { enrollDevice } from "../support/devices";

/**
 * A device removed while its standby screen stays open (WISP 06 § When a device checks). The active device puts the
 * tombstone and closes the removed device's link; the standby, left in front with no reload, no focus and no visibility
 * change, reads the turn on that close and says it was removed, instead of offering Use here until its 10-minute read. The keyboard focus that was on
 * Use here goes to Add this device.
 */

test("a device removed while its standby screen stays open says so, without a reload", { tag: ["@feature:devices.remove"] }, async ({ peer }) => {
  test.setTimeout(8 * 60_000);
  const [desktop, tablet] = await Promise.all([peer("desktop"), peer("tablet")]);
  await enrollDevice(desktop, tablet, { name: "Tablet" });
  const standby = tablet.page.getByTestId("device-standby");
  await expect(standby).toHaveAttribute("data-state", "standby", { timeout: 120_000 });
  await expect(tablet.page.getByTestId("device-standby-link")).toHaveAttribute("data-status", "live", { timeout: 120_000 });
  await expect(tablet.page.getByTestId("handoff-use-here")).toBeVisible();
  // The keyboard focus is on Use here, which the removal takes away.
  await tablet.page.getByTestId("handoff-use-here").focus();
  await expect(tablet.page.getByTestId("handoff-use-here")).toBeFocused();

  // Profile, Devices, Remove on the tablet's row.
  await desktop.page.goto("/#/profile");
  await desktop.page.getByTestId("device-row").filter({ hasText: "Tablet" }).getByTestId("device-menu").click();
  await desktop.page.getByTestId("device-remove-open").click();
  await desktop.page.getByTestId("device-remove").getByTestId("device-remove-go").click();
  await expect(desktop.page.getByTestId("device-removed")).toContainText("Removed", { timeout: 60_000 });

  // The tablet's page is not touched: it says it was removed well before its 10-minute read, and Use here is gone.
  await expect(standby).toHaveAttribute("data-state", "removed", { timeout: 60_000 });
  await expect(tablet.page.getByTestId("device-standby-title")).toHaveText("This device was removed");
  await expect(tablet.page.getByTestId("handoff-use-here")).toHaveCount(0);
  await expect(tablet.page.getByTestId("device-standby-reenroll")).toBeVisible();
  // The focus went to what replaced it, not to the page.
  await expect(tablet.page.getByTestId("device-standby-reenroll")).toBeFocused();
});
