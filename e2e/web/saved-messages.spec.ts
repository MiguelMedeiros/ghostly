import type { Page } from "@playwright/test";
import { chat, connect, expect, link, say, test } from "../support/fixtures";

/**
 * Saved messages: a message saved from its ⋮ shows in the Saved view, reached from above the chat list, and is still
 * there after a reload; a row opens its chat on the message, and unsaves from its bookmark. Kept on this device only:
 * the contact sees nothing of it.
 */

const row = (page: Page, text: string) => page.locator(".chat-wallpaper [data-message-row]").filter({ hasText: text }).last();

async function menuItem(page: Page, text: string) {
  const message = row(page, text);
  await message.hover();
  await message.getByTestId("message-options").click();
  return page.getByTestId("message-save");
}

test("a message saved from its ⋮ is in the Saved view, after a reload too, and opens its chat on it", { tag: ["@feature:chat.saved"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("saved-alice"), peer("saved-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  await say(bob, "the gate code is 4711");
  await say(alice, "noted, thanks");
  await expect(chat(alice).getByText("the gate code is 4711")).toBeVisible();
  const { page } = alice;

  // Nothing saved yet: no way to the view.
  await expect(page.getByTestId("sidebar-saved")).toHaveCount(0);
  const save = await menuItem(page, "the gate code is 4711");
  await expect(save).toHaveText("Save");
  await save.click();
  await expect(page.getByTestId("sidebar-saved")).toHaveAccessibleName("Saved messages, 1");
  await (await menuItem(page, "noted, thanks")).click();
  await expect(page.getByTestId("sidebar-saved")).toHaveAccessibleName("Saved messages, 2");
  // Saved: the menu says Unsave.
  await expect(await menuItem(page, "the gate code is 4711")).toHaveText("Unsave");
  await page.keyboard.press("Escape");

  await page.reload();
  await page.getByTestId("sidebar-saved").click();
  await expect(page.getByTestId("saved-page")).toBeVisible();
  await expect(page.getByTestId("saved-text")).toHaveText(["noted, thanks", "the gate code is 4711"]);
  const theirs = page.getByTestId("saved-row").filter({ hasText: "the gate code is 4711" });
  await expect(theirs.getByTestId("saved-author")).toHaveCount(0);
  await expect(page.getByTestId("saved-row").filter({ hasText: "noted, thanks" }).getByTestId("saved-author")).toHaveText("You");

  await theirs.getByTestId("saved-open").click();
  await expect(row(page, "the gate code is 4711")).toHaveAttribute("data-reply-flash", "");

  // Unsaved from the view: it goes, and the other stays.
  await page.getByTestId("sidebar-saved").click();
  await page.getByTestId("saved-row").filter({ hasText: "noted, thanks" }).getByTestId("saved-unsave").click();
  await expect(page.getByTestId("saved-text")).toHaveText(["the gate code is 4711"]);
  await expect(page.getByTestId("sidebar-saved")).toHaveAccessibleName("Saved messages, 1");

  // Bob's app hears nothing of it.
  await expect(bob.page.getByTestId("sidebar-saved")).toHaveCount(0);
});
