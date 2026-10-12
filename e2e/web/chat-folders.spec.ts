import type { Page } from "@playwright/test";
import { expect, say, test } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * Folders in the chat list (apps/ui/src/lib/chatFolders.ts): a person's own sections, made and filled from a chat's ⋮,
 * that fold to a header with their chats' unread added up. A folded folder still says what comes in, and a reload
 * keeps the folders, their chats and what is folded.
 */

const folder = (page: Page, name: string) => page.getByTestId("sidebar").getByTestId("chat-folder-section").filter({ has: page.getByTestId("chat-folder-name").getByText(name, { exact: true }) });

test("a chat is moved to a new folder from its ⋮, the folder folds, and a message raises its count while folded", { tag: ["@feature:chats.folders"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob", { viewport: { width: 1100, height: 800 } })]);
  await pair(alice, bob);
  const { page } = bob;
  await expect(page.getByTestId("chat-folder")).toHaveCount(0);

  // From the open chat's ⋮: Move to folder… → New folder… names one and puts the chat in it.
  await page.getByTestId("chat-options").click();
  await page.getByTestId("chat-options-menu").getByTestId("chat-folder-open").click();
  await page.getByTestId("chat-folder-menu").getByTestId("chat-folder-new").click();
  await page.getByTestId("folder-name").fill("Friends");
  await page.getByTestId("folder-name-save").click();
  const friends = folder(page, "Friends");
  await expect(friends.getByTestId("chat-row")).toHaveCount(1);
  await expect(page.getByTestId("sidebar").getByTestId("chat-row")).toHaveCount(1);
  // The header is a row 44 px tall, a button that says whether the folder is open.
  expect((await friends.getByTestId("chat-folder").boundingBox())!.height).toBe(44);
  const toggle = friends.getByTestId("chat-folder-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(friends.getByTestId("chat-folder-unread")).toHaveCount(0);

  // Folded, only the header is left of it.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("sidebar").getByTestId("chat-row")).toHaveCount(0);

  // Bob is elsewhere when a message comes: the folded folder counts it.
  await page.goto("/#/settings");
  await say(alice, "are you there?");
  await expect(friends.getByTestId("chat-folder-unread")).toHaveText("1", { timeout: 30_000 });
  await expect(friends.getByTestId("chat-folder-unread")).toHaveAccessibleName("1 unread in Friends");
  await say(alice, "hello?");
  await expect(friends.getByTestId("chat-folder-unread")).toHaveText("2", { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("folded.png") });

  // A reload keeps the folder, its chat and that it is folded.
  await page.reload();
  await expect(folder(page, "Friends").getByTestId("chat-folder-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(folder(page, "Friends").getByTestId("chat-folder-unread")).toHaveText("2");
  await expect(page.getByTestId("sidebar").getByTestId("chat-row")).toHaveCount(0);

  // Unfolded with the keyboard, the chat is there with its own count; opening it clears both.
  await folder(page, "Friends").getByTestId("chat-folder-toggle").press("Enter");
  const row = folder(page, "Friends").getByTestId("chat-row");
  await expect(row.getByTestId("chat-row-unread")).toHaveText("2");
  await row.click();
  await expect(folder(page, "Friends").getByTestId("chat-folder-unread")).toHaveCount(0);

  // Deleting the folder puts the chat back in the list, in no folder.
  await folder(page, "Friends").getByTestId("chat-folder-options").click();
  await page.getByTestId("chat-folder-delete").click();
  await page.getByTestId("folder-delete-confirm").click();
  await expect(page.getByTestId("chat-folder")).toHaveCount(0);
  await expect(page.getByTestId("sidebar").getByTestId("chat-row")).toHaveCount(1);
});
