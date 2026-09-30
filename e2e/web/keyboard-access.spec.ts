import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * Ghostly with the keys alone: the first Tab offers to skip the chat list, every chat and group in the list is a stop
 * that Enter or Space opens, and a ringing call is a dialog that takes the focus (not the answer) and keeps the keys.
 */

/** Presses Tab until the focus is on `testId`, as someone on the keys would: at most `max` presses. */
async function tabTo(page: Page, testId: string, max = 150): Promise<void> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate((id) => document.activeElement?.getAttribute("data-testid") === id, testId)) return;
  }
  throw new Error(`Tab never reached ${testId}`);
}

const focused = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  return { tag: el?.tagName.toLowerCase(), testId: el?.getAttribute("data-testid"), role: el?.getAttribute("role") };
});

test("with the keys alone: skip the list, open a chat and a group from it, answer a call", { tag: ["@feature:app.keyboard", "@feature:chats.list.rows", "@feature:calls.paired"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("keys-alice"), peer("keys-bob")]);
  await pair(alice, bob);
  const page = alice.page;
  // A group of one, beside the chat.
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  await page.getByTestId("new-group-name").fill("Keys");
  await page.getByTestId("new-group-create").click();
  await page.getByTestId("group-share-done").click();
  await expect(page.getByTestId("group-name")).toHaveText("Keys");
  await page.goto("/#/settings");
  await expect(page.getByTestId("settings-reduce-motion")).toBeVisible();

  // The first stop skips the chat list: shown while focused, it takes the keys to the page.
  await page.reload();
  await expect(page.getByTestId("settings-reduce-motion")).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByTestId("skip-to-content");
  await expect(skip).toBeFocused();
  await expect(skip).toHaveText("Skip to content");
  expect((await skip.boundingBox())!.width).toBeGreaterThan(40);
  await page.keyboard.press("Enter");
  expect(await focused(page)).toMatchObject({ tag: "main" });
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("main"))).toBe(true);
  await expect(page.getByRole("main")).toHaveCount(1);

  // The chat's row: a stop named for the contact, Enter opens it.
  await tabTo(page, "chat-row-open");
  const chatRow = page.getByTestId("chat-row-open");
  await expect(chatRow).toHaveAccessibleName(/^Contact · /);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/chat\//);
  await expect(page.getByPlaceholder("Message…")).toBeVisible();
  await expect(chatRow).toHaveAttribute("aria-current", "page");

  // The group's row: Space opens it.
  await tabTo(page, "group-row-open");
  await expect(page.getByTestId("group-row-open")).toHaveAccessibleName("Keys");
  await page.keyboard.press(" ");
  await expect(page).toHaveURL(/#\/group\//);
  await expect(page.getByTestId("group-name")).toHaveText("Keys");

  // A call rings as a dialog named for the caller, with the focus in it; Enter there does not answer.
  await expect(bob.page.getByTestId("call-audio")).toBeEnabled();
  await bob.page.getByTestId("call-audio").click();
  await expect(bob.page.getByRole("status").filter({ hasText: "Calling..." })).toHaveAttribute("data-testid", "call-status");
  await page.goto("/#/");
  const ring = page.getByRole("alertdialog");
  await expect(ring).toBeVisible();
  await expect(ring).toHaveAccessibleDescription("Incoming audio call...");
  await expect(ring).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(ring).toBeVisible();
  // Tab goes round its buttons and never behind it; Decline, then Accept.
  await page.keyboard.press("Tab");
  await expect(ring.getByRole("button", { name: "Decline" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(ring.getByRole("button", { name: "Accept audio call" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(ring.getByRole("button", { name: "Decline" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(ring).toHaveCount(0);
  // Said in words as it changes, never the running clock.
  for (const p of [alice.page, bob.page]) await expect(p.getByTestId("call-state-spoken")).toHaveText("Connected");
  await bob.page.getByTestId("call-hang-up").click();
  await expect(page.getByTestId("call-window")).toHaveCount(0);
});
