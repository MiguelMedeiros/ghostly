import type { Page } from "@playwright/test";
import { expect, openProfilePage, test } from "../support/fixtures";

// The lock screen hides the app behind a password. It holds across a reload, can be changed and turned
// off, and follows a profile: a new one starts locked like the one it came from, and another profile's
// data is only deleted with its own lock password.

const locked = (page: Page) => page.getByText("Ghostly is locked");
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

async function setLock(page: Page, password: string): Promise<void> {
  await page.goto("/#/settings");
  await page.getByRole("switch", { name: "Lock Screen" }).click();
  await field(page, "New password").fill(password);
  await field(page, "Confirm password").fill(password);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Password set successfully")).toBeVisible();
}

async function unlock(page: Page, password: string): Promise<void> {
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(locked(page)).toHaveCount(0);
}

test("lock screen: a reload stays locked, the password can be changed, and the lock turned off", { tag: ["@feature:settings.lock.now", "@feature:settings.lock.password", "@feature:settings.lock.startup"] }, async ({ peer }) => {
  const { page } = await peer("lock");
  await setLock(page, "first secret");

  // A reload does not skip the password, and nothing of the app is there behind the lock.
  await page.reload();
  await expect(locked(page)).toBeVisible();
  await expect(page.getByTitle("New Chat")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Settings" })).toHaveCount(0);
  await page.getByPlaceholder("Password").fill("not it");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Incorrect password, try again")).toBeVisible();
  await expect(locked(page)).toBeVisible();
  await expect(page.getByTitle("New Chat")).toHaveCount(0);
  await unlock(page, "first secret");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  // Changing it takes the current one first.
  await page.getByTestId("settings-password-edit").click();
  await field(page, "Current password").fill("not it");
  await field(page, "New password").fill("second secret");
  await field(page, "Confirm password").fill("second secret");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Incorrect password", { exact: true })).toBeVisible();
  await field(page, "Current password").fill("first secret");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Password changed successfully")).toBeVisible();

  // Now only the new one opens it.
  await page.getByRole("button", { name: "Lock Now" }).click();
  await expect(locked(page)).toBeVisible();
  await page.getByPlaceholder("Password").fill("first secret");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Incorrect password, try again")).toBeVisible();
  await expect(locked(page)).toBeVisible();
  await unlock(page, "second secret");
  await expect(page.getByTitle("New Chat")).toBeVisible();

  // Turned off: the switch says so, and a reload opens straight into the app.
  await page.goto("/#/settings");
  const lockSwitch = page.getByRole("switch", { name: "Lock Screen" });
  await expect(lockSwitch).toHaveAttribute("aria-checked", "true");
  await lockSwitch.click();
  await expect(lockSwitch).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("button", { name: "Lock Now" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(locked(page)).toHaveCount(0);
  await expect(lockSwitch).toHaveAttribute("aria-checked", "false");
});

test("profiles and the lock: a new profile is locked too, and deleting a locked one takes its password", { tag: ["@feature:profiles.lock", "@feature:profiles.create", "@feature:profiles.switch", "@feature:profiles.delete"] }, async ({ peer }) => {
  const { page } = await peer("lock-profiles");
  await setLock(page, "shared secret");

  // A new profile starts behind the same lock: it is not a way around it.
  await openProfilePage(page);
  await page.getByTestId("profile-new").click();
  await page.getByTestId("profile-new-name").fill("Side");
  await page.getByTestId("profile-create").click();
  await expect(locked(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("profile-page")).toHaveCount(0);
  await unlock(page, "shared secret");
  await expect(page.getByTestId("profile-name")).toHaveValue("Side");

  // Back to the first profile: its own lock, the same password.
  const rows = page.getByTestId("profile-row");
  await rows.filter({ hasText: "Personal" }).getByTestId("profile-switch").click();
  await expect(locked(page)).toBeVisible({ timeout: 30_000 });
  await unlock(page, "shared secret");
  await expect(page.getByTestId("profile-name")).toHaveValue("Personal");

  // Deleting the locked profile asks for its lock password; a wrong one deletes nothing.
  await rows.filter({ hasText: "Side" }).getByTestId("profile-delete").click();
  const dialog = page.getByTestId("delete-profile");
  await expect(dialog.getByTestId("delete-profile-summary")).toContainText("0 chats");
  const password = dialog.getByTestId("delete-profile-password");
  await expect(password).toBeVisible();
  await dialog.getByTestId("delete-profile-confirm").fill("Side");
  await expect(dialog.getByTestId("delete-profile-go"), "not without the lock password").toBeDisabled();
  await password.fill("wrong secret");
  await dialog.getByTestId("delete-profile-go").click();
  await expect(dialog.getByRole("alert")).toContainText("Wrong lock password for that profile");
  await expect(dialog).toBeVisible();
  await expect(rows).toHaveCount(2);

  await password.fill("shared secret");
  await dialog.getByTestId("delete-profile-go").click();
  await expect(dialog).toBeHidden();
  await expect(rows).toHaveCount(1);
  await expect(rows.filter({ hasText: "Side" })).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => /^ghostly_[a-z0-9]{10}_/.test(key))), "nothing of Side is left").toEqual([]);
});
