import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * Keeping the browser from clearing the app's data (apps/ui/src/lib/storagePersistence.ts). Chromium answers
 * `navigator.storage.persist()` by itself: yes to a site allowed to notify (or installed, or used a lot), no to a
 * site it has only just met. So a context with the notifications permission stands in for "the browser says yes",
 * and one without for "the browser says no". The app asks once the profile holds a chat, never before, and
 * Settings says what the browser answered.
 */

const persisted = (page: Page) => page.evaluate(() => navigator.storage.persisted());
const asked = (page: Page) => page.evaluate(() => localStorage.getItem("ghostly-storage-persist"));
const allowNotifications = (context: BrowserContext) => context.grantPermissions(["camera", "microphone", "clipboard-read", "clipboard-write", "notifications"]);

async function storageRow(page: Page) {
  await page.goto("/#/settings");
  const row = page.getByTestId("settings-storage-protection");
  await row.scrollIntoViewIfNeeded();
  return row;
}

test("an empty profile asks for nothing; the first chat asks, and Settings says Protected", { tag: ["@feature:app.storage.persist"] }, async ({ peer }, testInfo) => {
  const { page } = await peer("storage-kept", { beforeOpen: allowNotifications });
  await expect(page.getByTestId("sidebar")).toBeVisible();

  // Nothing to keep yet: the browser is not asked, and Settings tells the truth.
  let row = await storageRow(page);
  await expect(row.getByTestId("settings-storage-state")).toHaveText("Not protected");
  expect(await persisted(page)).toBe(false);
  expect(await asked(page)).toBeNull();

  // The first chat: now there is something to lose.
  await page.goto("/#/");
  await page.getByTitle("New Chat").click();
  await expect(page.getByTestId("invite-card")).toBeVisible();
  await expect.poll(() => persisted(page), { timeout: 15_000 }).toBe(true);

  row = await storageRow(page);
  await expect(row.getByTestId("settings-storage-state")).toHaveText("Protected");
  await expect(row).toContainText("This browser keeps Ghostly's data until you remove it.");
  // What is used of what is available, from the browser's own estimate.
  await expect(page.getByTestId("settings-storage-used")).toContainText(/\d [KMG]?B of [\d.]+ [KMG]?B/);
  await row.screenshot({ path: testInfo.outputPath("storage-protected.png") });
});

test("a browser that says no is asked once; Settings says Not protected, with what to do behind the ⓘ", { tag: ["@feature:app.storage.persist"] }, async ({ peer }, testInfo) => {
  const { page } = await peer("storage-refused");
  await page.getByTitle("New Chat").click();
  await expect(page.getByTestId("invite-card")).toBeVisible();
  // Asked, and refused: this browser has no reason to say yes to a site it met a moment ago.
  await expect.poll(() => asked(page), { timeout: 15_000 }).not.toBeNull();
  const first = await asked(page);
  expect(Object.values(JSON.parse(first!) as Record<string, { granted: boolean }>)[0].granted).toBe(false);
  expect(await persisted(page)).toBe(false);

  let row = await storageRow(page);
  await expect(row.getByTestId("settings-storage-state")).toHaveText("Not protected");
  await expect(row).toContainText("This browser may clear Ghostly's data when the device runs low on space.");
  await expect(row.getByTestId("row-info-text")).toHaveCount(0);
  await row.getByTestId("row-info").click();
  await expect(row.getByTestId("row-info-text")).toContainText("allow notifications, and keep a backup of your profile");
  // Chromium answers by itself: no button that would do nothing.
  await expect(page.getByTestId("settings-storage-protect")).toHaveCount(0);
  await row.screenshot({ path: testInfo.outputPath("storage-not-protected.png") });

  // The next start does not ask again: the record of the one ask is the same.
  await page.reload();
  row = await storageRow(page);
  await expect(row.getByTestId("settings-storage-state")).toHaveText("Not protected");
  expect(await asked(page)).toBe(first);
});
