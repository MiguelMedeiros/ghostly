import { chat, expect, test } from "../support/fixtures";
import { pair } from "../support/paired";

const clock = /^\d{1,2}:\d{2}$/;

/**
 * A chat is not deleted while a call is on in it. It was: the call talked on in a chat gone from the list, the dialog
 * stayed open over the home screen in front of End call, and the hang-up, sent on a link the delete had removed,
 * never crossed: the contact's call ended only when its media gave up, about half a minute later.
 */
test("a chat with a call on is not deleted from its menu or the list; after the call it is", { tag: ["@feature:chats.list.delete", "@feature:calls.paired"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("delete-call-alice"), peer("delete-call-bob")]);
  await pair(alice, bob);
  await expect(bob.page.getByTestId("call-audio")).toBeEnabled();
  await bob.page.getByTestId("call-audio").click();
  await expect(alice.page.getByText("Incoming audio call...")).toBeVisible();
  await alice.page.getByTitle("Accept audio call").click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();
  await bob.page.getByTestId("call-minimize").click();

  const dialog = bob.page.getByRole("dialog", { name: "Delete chat?", exact: true });
  const confirm = dialog.getByRole("button", { name: "Delete chat", exact: true });
  const said = "A call is on in this chat. End it first, then delete the chat.";
  // From the chat's own menu.
  await bob.page.getByTestId("chat-options").click();
  await bob.page.getByTestId("chat-options").locator("..").getByRole("button", { name: "Delete chat", exact: true }).click();
  await expect(dialog).toHaveAccessibleDescription(said);
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  // From the chat list's row.
  await bob.page.getByTestId("chat-row").getByRole("button", { name: "Delete chat", exact: true }).click();
  await expect(dialog).toHaveAccessibleDescription(said);
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(bob.page.getByTestId("chat-row")).toHaveCount(1);
  for (const p of [alice, bob]) await expect(p.page.getByTestId("call-status")).toHaveAttribute("data-state", "connected");

  // The chat is still there for the hang-up to cross: the contact's call ends with it, not half a minute later.
  await bob.page.getByTitle("End call").click();
  await expect(alice.page.getByTitle("End call")).toHaveCount(0, { timeout: 10_000 });
  await expect(chat(alice).getByText("Audio call ended")).toBeVisible();

  // Once it is over, the chat is deleted as before.
  await bob.page.getByTestId("chat-row").getByRole("button", { name: "Delete chat", exact: true }).click();
  await expect(dialog).toHaveAccessibleDescription(/^This deletes the chat and its history from this device/);
  await confirm.click();
  await expect(bob.page.getByTestId("chat-row")).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
});
