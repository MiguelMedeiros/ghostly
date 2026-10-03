import { expect, test } from "../support/fixtures";
import { enrollDevice, untilShown } from "../support/devices";

/**
 * Removing a device (WISP 06 § Removing a device, part 7). Three browser contexts are the person's three devices: the
 * desktop is active, the phone and the tablet are on standby. The phone's page is closed; the desktop removes the
 * tablet. The phone, opened again, gets the new device-set secret over its old link, shows the new list once and goes
 * on as a standby with a live link to the desktop. The tablet, opened again, reads its removal from the tombstone and
 * holds no link to anyone. Every password here is a test value.
 */

test("the active device removes the third device while the second is closed; the second takes the new set when it opens again, and the removed one is out", { tag: ["@feature:devices.remove"] }, async ({ peer }) => {
  test.setTimeout(12 * 60_000);
  const [desktop, phone, tablet] = await Promise.all([peer("desktop"), peer("phone"), peer("tablet")]);
  await enrollDevice(desktop, phone, { name: "Phone" });
  await enrollDevice(desktop, tablet, { name: "Tablet" });
  await expect(desktop.page.getByTestId("device-row")).toHaveCount(3);

  // The phone is closed: it holds the old secret and hears nothing of what follows.
  const phoneUrl = phone.page.url();
  await phone.page.close();

  // Profile, Devices, Remove on the tablet's row.
  await desktop.page.goto("/#/profile");
  await desktop.page.getByTestId("device-row").filter({ hasText: "Tablet" }).getByTestId("device-remove-open").click();
  const dialog = desktop.page.getByTestId("device-remove");
  await expect(dialog).toContainText("Remove Tablet?");
  await dialog.getByTestId("device-remove-go").click();
  await expect(desktop.page.getByTestId("device-removed")).toContainText("Tablet was removed.", { timeout: 60_000 });
  await expect(desktop.page.getByTestId("device-row")).toHaveCount(2);
  await expect(desktop.page.getByTestId("device-row").filter({ hasText: "Tablet" })).toHaveCount(0);
  // The phone has not taken the new secret yet.
  await expect(desktop.page.getByTestId("device-waiting")).toContainText("Waiting for Phone to open Ghostly");

  // The phone opens again: the new set comes over its old link, and it shows the list once.
  phone.page = await phone.context.newPage();
  await phone.page.goto(phoneUrl);
  const notice = phone.page.getByTestId("device-set-notice");
  await untilShown(phone.page, notice, { timeout: 240_000 });
  await expect(phone.page.getByTestId("device-set-notice-title")).toContainText("Phone");
  await expect(phone.page.getByTestId("device-set-notice-title")).not.toContainText("Tablet");
  await phone.page.getByTestId("device-set-notice-ok").click();
  await expect(notice).toHaveCount(0);
  // It goes on as a standby of the new set, with a live link to the desktop that answers.
  const standby = phone.page.getByTestId("device-standby");
  await expect(standby).toHaveAttribute("data-state", "standby");
  await expect(standby).not.toHaveAttribute("data-unfinished", "true");
  await expect(phone.page.getByTestId("device-standby-title")).toHaveText(/^Active on .+/);
  const link = phone.page.getByTestId("device-standby-link");
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("data-status", "live", { timeout: 120_000 });
  await link.getByTestId("device-standby-check").click();
  await expect(link.getByTestId("device-standby-check-result")).toHaveText(/^Answered in \d+ ms$/);
  // The desktop no longer waits for it.
  await expect(desktop.page.getByTestId("device-waiting")).toHaveCount(0, { timeout: 60_000 });
  await expect(desktop.page.getByTestId("device-row").filter({ hasText: "Phone" }).getByTestId("device-link-status")).toHaveAttribute("data-status", "live", { timeout: 120_000 });

  // The tablet, opened again, reads the tombstone at the old address: removed, and it holds no link to anyone.
  await tablet.page.reload();
  const tabletStandby = tablet.page.getByTestId("device-standby").and(tablet.page.locator("[data-state=removed]"));
  await untilShown(tablet.page, tabletStandby, { timeout: 180_000 });
  await expect(tablet.page.getByTestId("device-standby-title")).toHaveText("This device was removed");
  await expect(tablet.page.getByTestId("device-standby-reenroll")).toBeVisible();
  await expect(tablet.page.getByTestId("device-standby-link")).toHaveCount(0);
  // The two that stay still list only each other, and their link still answers.
  await expect(desktop.page.getByTestId("device-row")).toHaveCount(2);
  await link.getByTestId("device-standby-check").click();
  await expect(link.getByTestId("device-standby-check-result")).toHaveText(/^Answered in \d+ ms$/);
});
