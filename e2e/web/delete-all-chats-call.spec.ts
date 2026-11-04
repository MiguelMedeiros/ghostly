import { chat, expect, test } from "../support/fixtures";
import { pair } from "../support/paired";

const clock = /^\d{1,2}:\d{2}$/;

/**
 * Settings' Delete all chats does not delete a chat a call is on in. It did: the call talked on in a chat gone from
 * the list, and the hang-up, sent on a link the delete had removed, never crossed: the contact's call ended only when
 * its media gave up, about half a minute later.
 */
test("Delete all chats in Settings waits for the call to end; after the call it deletes", { tag: ["@feature:chats.list.delete-all", "@feature:calls.mini-window"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("delete-all-call-alice"), peer("delete-all-call-bob")]);
  await pair(alice, bob);
  await expect(bob.page.getByTestId("call-audio")).toBeEnabled();
  await bob.page.getByTestId("call-audio").click();
  await expect(alice.page.getByText("Incoming audio call...")).toBeVisible();
  await alice.page.getByTitle("Accept audio call").click();
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();
  await bob.page.getByTestId("call-minimize").click();

  await bob.page.getByTitle("Settings", { exact: true }).click();
  await expect(bob.page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(bob.page.getByTestId("call-window")).toBeVisible();
  await bob.page.getByTestId("delete-all-chats").click();
  await expect(bob.page.getByText("A call is on in a chat. End it first, then delete all chats.")).toBeVisible();
  await expect(bob.page.getByTestId("delete-all-chats-confirm")).toBeDisabled();
  await bob.page.getByTestId("delete-all-chats-confirm").click({ force: true });
  await expect(bob.page.getByTestId("chat-row")).toHaveCount(1);
  await expect(bob.page.getByTestId("call-window")).toBeVisible();
  await expect(alice.page.getByTestId("call-status")).toHaveAttribute("data-state", "connected");

  // The chat is still there for the hang-up to cross: the contact's call ends with it, not half a minute later.
  await bob.page.getByTitle("End call").click();
  await expect(alice.page.getByTitle("End call")).toHaveCount(0, { timeout: 10_000 });
  await expect(chat(alice).getByText("Audio call ended")).toBeVisible();

  // Once it is over, the confirm is on again and every chat goes, as before.
  await expect(bob.page.getByText("Delete your only chat?")).toBeVisible();
  await bob.page.getByTestId("delete-all-chats-confirm").click();
  await expect(bob.page.getByTestId("chat-row")).toHaveCount(0);
});
