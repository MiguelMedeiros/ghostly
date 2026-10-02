import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * Keeping the browser from clearing the app's data (apps/ui/src/lib/storagePersistence.ts). Chromium answers
 * `navigator.storage.persist()` by itself: yes to a site allowed to notify, installed or used a lot, no to a site
 * it has only just met. A test's fresh context is the second kind, so the suite sees the real "no": the app asks
 * once the profile holds a chat, never before, never twice, and Settings says Not protected.
 *
 * The real "yes" cannot be earned here (Playwright's `grantPermissions("notifications")` does not reach the rule
 * a test browser decides by), so the permission behind it is granted over the DevTools protocol: the browser then
 * reports the storage as kept, and Settings says Protected. That the app's own call turns a no into a yes after
 * an install or allowed notifications is in the unit tests (apps/ui/src/test/pwa/storagePersistence.test.tsx).
 */

const persisted = (page: Page) => page.evaluate(() => navigator.storage.persisted());
/** The app's own record of the one time it asked, per profile; null while it never did. */
const asked = (page: Page) => page.evaluate(() => localStorage.getItem("ghostly-storage-persist"));
const granted = (record: string | null) => Object.values(JSON.parse(record!) as Record<string, { granted: boolean }>)[0].granted;

/**
 * This page's browser keeps the origin's storage from now on. The session stays open: the grant lasts as long as
 * it does (it ends with the context). It replaces the context's other permissions, which this spec does not use.
 */
async function browserKeepsStorage(page: Page) {
  const session = await page.context().newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.send("Browser.grantPermissions", { browserContextId: targetInfo.browserContextId, permissions: ["durableStorage"] });
}

async function storageRow(page: Page) {
  await page.goto("/#/settings");
  const row = page.getByTestId("settings-storage-protection");
  await row.scrollIntoViewIfNeeded();
  return row;
}

async function firstChat(page: Page) {
  await page.goto("/#/");
  await page.getByTitle("New Chat").click();
  await expect(page.getByTestId("invite-card")).toBeVisible();
}

test("an empty profile asks for nothing; the first chat asks once; Settings says Not protected, with what to do behind the ⓘ", { tag: ["@feature:app.storage.persist"] }, async ({ peer }, testInfo) => {
  const { page } = await peer("storage-refused");
  await expect(page.getByTestId("sidebar")).toBeVisible();

  // Nothing to keep yet: the browser is not asked, and Settings tells the truth.
  let row = await storageRow(page);
  await expect(row.getByTestId("settings-storage-state")).toHaveText("Not protected");
  expect(await asked(page)).toBeNull();

  // The first chat: now there is something to lose. Asked, and refused: this browser met the site a moment ago.
  await firstChat(page);
  await expect.poll(() => asked(page), { timeout: 15_000 }).not.toBeNull();
  const first = await asked(page);
  expect(granted(first)).toBe(false);
  expect(await persisted(page)).toBe(false);

  row = await storageRow(page);
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

test("where the browser keeps the storage, Settings says Protected, with what is used", { tag: ["@feature:app.storage.persist"] }, async ({ peer }, testInfo) => {
  const { page } = await peer("storage-kept");
  await firstChat(page);
  await expect.poll(() => asked(page), { timeout: 15_000 }).not.toBeNull();
  let row = await storageRow(page);
  await expect(row.getByTestId("settings-storage-state")).toHaveText("Not protected");

  await browserKeepsStorage(page);
  expect(await persisted(page)).toBe(true);
  // Read again when the app is opened again (and whenever its window comes back).
  await page.reload();
  row = await storageRow(page);
  await expect(row.getByTestId("settings-storage-state")).toHaveText("Protected");
  await expect(row).toContainText("This browser keeps Ghostly's data until you remove it.");
  // What is used of what is available, from the browser's own estimate.
  await expect(page.getByTestId("settings-storage-used")).toContainText(/\d [KMG]?B of [\d.]+ [KMG]?B/);
  await row.screenshot({ path: testInfo.outputPath("storage-protected.png") });
});
