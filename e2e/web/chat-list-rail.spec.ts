import type { Locator } from "@playwright/test";
import { expect, say, test } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * The chat list folded to a rail on a wide window: the list header's button folds it, the open chat gets the room, a
 * message that arrives shows its count on the contact's picture, a click on the picture opens the chat and the rail
 * stays; the choice survives a reload, and the rail's own button (or Alt+Shift+L) unfolds the list.
 */

const box = async (locator: Locator) => (await locator.boundingBox())!;

test("folds the list to a rail of pictures, opens a chat from it with its unread count, and keeps the choice across a reload", { tag: ["@feature:chats.list.rail"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob", { viewport: { width: 1100, height: 800 } })]);
  await pair(alice, bob);
  const { page } = bob;
  const sidebar = page.getByTestId("sidebar");
  const toggle = page.getByTestId("chat-list-toggle");
  const main = page.locator("main");
  const wide = (await box(main)).width;

  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  const rail = page.getByTestId("chat-rail");
  await expect(rail).toBeVisible();
  await expect(page.getByTestId("chat-list")).toHaveCount(0);
  expect((await box(sidebar)).width).toBeLessThanOrEqual(73);
  expect((await box(main)).width).toBeGreaterThan(wide + 200);
  // The focus is on the button that unfolds it, which says so.
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAccessibleName("Expand chat list");

  // Bob is elsewhere when it arrives: the picture counts it.
  await page.goto("/#/settings");
  await say(alice, "Are you there?");
  const contact = rail.getByTestId("chat-rail-chat").first();
  await expect(contact.getByTestId("chat-rail-unread")).toHaveText("1", { timeout: 15_000 });
  await expect(contact).toHaveAttribute("title", /\S/);
  const inside = await box(contact.getByTestId("chat-rail-unread"));
  const edge = await box(sidebar);
  expect(inside.x + inside.width).toBeLessThanOrEqual(edge.x + edge.width);

  await contact.click();
  await expect(page.getByPlaceholder("Message…")).toBeVisible();
  await expect(page.getByText("Are you there?")).toBeVisible();
  await expect(rail).toBeVisible();
  await expect(contact).toHaveAttribute("aria-current", "page");
  await expect(contact.getByTestId("chat-rail-unread")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("chat-rail")).toBeVisible();
  await expect(page.getByTestId("chat-list")).toHaveCount(0);

  await page.getByTestId("chat-list-toggle").click();
  await expect(page.getByTestId("chat-list")).toBeVisible();
  await expect(page.getByTestId("chat-rail")).toHaveCount(0);
  await expect(page.getByTestId("chat-list-toggle")).toBeFocused();
  await page.reload();
  await expect(page.getByTestId("chat-list")).toBeVisible();

  // The shortcut, from the message field: the list folds and the field keeps the focus.
  const field = page.getByPlaceholder("Message…");
  await field.click();
  await page.keyboard.press("Alt+Shift+L");
  await expect(page.getByTestId("chat-rail")).toBeVisible();
  await expect(field).toBeFocused();
  await page.keyboard.press("Alt+Shift+L");
  await expect(page.getByTestId("chat-list")).toBeVisible();
});

test("on the rail the list's notices still show, over the open page, and go back to the list when it unfolds", { tag: ["@feature:chats.list.rail"] }, async ({ peer }) => {
  const { page, context } = await peer("ana", { viewport: { width: 1100, height: 800 } });
  await page.getByTestId("chat-list-toggle").click();
  await expect(page.getByTestId("chat-rail")).toBeVisible();

  await context.setOffline(true);
  try {
    const banner = page.getByTestId("offline-banner");
    await expect(banner).toBeVisible();
    // Over the page, as wide as it: not squeezed into the rail's 72 px.
    await expect(page.locator("main").getByTestId("offline-banner")).toBeVisible();
    expect((await box(banner)).width).toBeGreaterThan(400);

    await page.getByTestId("chat-list-toggle").click();
    await expect(page.getByTestId("sidebar").getByTestId("offline-banner")).toBeVisible();
    await expect(page.getByTestId("offline-banner")).toHaveCount(1);
  } finally {
    await context.setOffline(false);
  }
  await expect(page.getByTestId("offline-banner")).toHaveCount(0);
});

test("a phone's list has no rail",{ tag: ["@feature:chats.list.rail"] }, async ({ peer }) => {
  const { page } = await peer("phone", { viewport: { width: 390, height: 800 } });
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTestId("chat-list-toggle")).toHaveCount(0);
  await page.keyboard.press("Alt+Shift+L");
  await expect(page.getByTestId("chat-rail")).toHaveCount(0);
});
