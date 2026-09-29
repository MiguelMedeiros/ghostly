import { chat, connect, expect, link, say, test } from "../support/fixtures";

/**
 * A chat deleted on the web stops answering at once. Its link used to run on for up to 15 s after it was made (the
 * grace session sync gives a link whose chat is not mirrored yet), so a chat deleted in its first seconds still took
 * the contact's messages and sent them receipts: two ticks for a chat that was gone.
 */
test("a chat deleted in its first seconds sends no receipt for what comes after", { tag: ["@feature:chat.paired.receipts"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("stop-alice"), peer("stop-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  // Bob deletes the chat he just joined.
  await bob.page.getByTestId("chat-options").click();
  await bob.page.getByTestId("chat-options").locator("..").getByRole("button", { name: "Delete chat", exact: true }).click();
  await bob.page.getByRole("dialog").getByRole("button", { name: "Delete chat", exact: true }).click();
  await expect(bob.page.getByTestId("chat-row")).toHaveCount(0);

  await say(alice, "are you still there?");
  const mark = chat(alice).locator("[data-message-row]").filter({ hasText: "are you still there?" }).getByTestId("message-delivery");
  await expect(mark).toBeVisible();
  // Long enough for a receipt over the live link (they take well under a second here) and past the old 15 s grace.
  await alice.page.waitForTimeout(16_000);
  await expect(mark).not.toHaveAttribute("data-delivery", "delivered");
});
