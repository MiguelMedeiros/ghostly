import { expect, test } from "../support/fixtures";
import { pasteInvite } from "../support/clipboard";

/**
 * Adding a device to a profile (WISP 06 § Adding a device, part 4): the active device makes a code, the new device
 * reads it, both show the same digits, the person confirms on the active one, and the new device ends on the standby
 * screen holding a live device link to the active one. A profile elsewhere that never enrolled anything is unchanged.
 * Two browser contexts are the two devices; a third is a person with a profile of one device.
 */

const devicesDatabase = (page: import("@playwright/test").Page) =>
  page.evaluate(async () => (await indexedDB.databases()).some((db) => db.name === "ghostly-devices"));

test("a profile adds a second device: the same digits on both, a standby with a live link to the active one, and a single profile elsewhere unchanged", { tag: ["@feature:devices.enroll"] }, async ({ peer }) => {
  const [desktop, phone, other] = await Promise.all([peer("desktop"), peer("phone"), peer("other")]);

  // The active device: Profile, Devices, Add a device. No lock yet: it asks for one of 8 characters first.
  await desktop.page.goto("/#/profile");
  await desktop.page.getByTestId("device-add-open").click();
  const add = desktop.page.getByTestId("device-add");
  await expect(add).toContainText("Set a password first");
  await add.getByTestId("device-add-password").fill("short");
  await add.getByTestId("device-add-password-again").fill("short");
  await add.getByTestId("device-add-next").click();
  await expect(add.getByTestId("device-add-password-error")).toHaveText("Use 8 characters or more.");
  await expect(add.getByTestId("device-add-notice")).toBeVisible();
  await add.getByTestId("device-add-password").fill("a long lock password");
  await add.getByTestId("device-add-password-again").fill("a long lock password");
  await add.getByTestId("device-add-next").click();
  const shown = add.getByTestId("device-add-code");
  await expect(shown).toBeVisible();
  // Under the QR code, where it stands, and the time left on the code.
  await expect(add.getByTestId("device-add-status")).toHaveText("Waiting for your other device…");
  await expect(add.getByTestId("device-add-left")).toHaveText(/^(10:00|9:\d\d) left$/);
  const code = (await shown.getAttribute("data-code"))!;
  expect(code).toMatch(/^ghostly1z/);

  // The new device: I already use Ghostly, Add this device to my profile, the code, then one screen with its name.
  await phone.page.getByTestId("home-already").click();
  await phone.page.getByTestId("device-join-add").click();
  await pasteInvite(phone.page, code);
  await expect(phone.page.getByTestId("device-join-confirm")).toHaveAttribute("data-place", "here");
  await phone.page.getByTestId("device-join-name").fill("Phone");
  await phone.page.getByTestId("device-join-next").click();

  // Both show the same six digits; the new one only once the active one proved itself.
  const desktopDigits = desktop.page.getByTestId("device-add-digits");
  const phoneDigits = phone.page.getByTestId("device-join-digits");
  await expect(desktopDigits).toBeVisible();
  await expect(phoneDigits).toBeVisible();
  const digits = await desktopDigits.getAttribute("data-digits");
  expect(digits).toMatch(/^\d{6}$/);
  expect(await phoneDigits.getAttribute("data-digits")).toBe(digits);
  await expect(add.getByTestId("device-add-status")).toHaveText("Found Phone. Check that it shows the same digits.");
  await expect(phone.page.getByTestId("device-join")).toContainText("Check that your other device shows the same digits.");
  await expect(phone.page.getByTestId("device-join")).toContainText("Confirm on your other device.");

  await add.getByTestId("device-add-match").click();
  await expect(add.getByTestId("device-add-done")).toHaveText("Phone added. It is on standby.");
  const done = phone.page.getByTestId("device-join-done");
  await expect(done).toHaveAttribute("data-step", "done");
  // A headless browser grants no persistent storage: the person is warned, and the enrollment goes on.
  await expect(phone.page.getByTestId("device-join-persist")).toContainText("This browser may clear Ghostly's data. Keep a copy on");

  // The new device starts again into the gate: the standby screen, and a live link to the active device.
  await phone.page.getByTestId("device-join-continue").click();
  const standby = phone.page.getByTestId("device-standby");
  await expect(standby).toBeVisible();
  await expect(standby).toHaveAttribute("data-state", "standby");
  await expect(standby).not.toHaveAttribute("data-unfinished", "true");
  await expect(phone.page.getByTestId("device-standby-title")).toHaveText(/^Active on .+/);
  await expect(phone.page.getByTestId("sidebar")).toHaveCount(0);
  const link = phone.page.getByTestId("device-standby-link");
  await expect(link).toHaveAttribute("data-status", "live", { timeout: 90_000 });
  await link.getByTestId("device-standby-check").click();
  await expect(link.getByTestId("device-standby-check-result")).toHaveText(/^Answered in \d+ ms$/);

  // The active device lists it, and its own link to it answers too.
  await add.getByRole("button", { name: "Done" }).click();
  const row = desktop.page.getByTestId("device-row").filter({ hasText: "Phone" });
  await expect(row).toContainText("Standby");
  await expect(row.getByTestId("device-link-status")).toHaveAttribute("data-status", "live", { timeout: 90_000 });
  // Check connection is in the row's menu (on a phone the menu is a sheet over the page).
  await row.getByTestId("device-menu").click();
  await desktop.page.getByTestId("device-check").click();
  await expect(row.getByTestId("device-check-result")).toHaveText(/^Answered in \d+ ms$/);
  // The active device runs the whole app as before.
  await desktop.page.goto("/#/");
  await expect(desktop.page.getByTitle("New Chat")).toBeVisible();

  // A profile elsewhere that never added a device: as before, and no device state was ever written for it.
  await other.page.reload();
  await expect(other.page.getByTitle("New Chat")).toBeVisible();
  expect(await devicesDatabase(other.page)).toBe(false);
});
