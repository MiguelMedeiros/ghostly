import { chat, connect, expect, link, test } from "../support/fixtures";

/**
 * A file's receipt (files/3 once the contact's app checked what it stored) gives it two ticks, as a text gets from its
 * own: in the bubble and in the chat list. Files that went over the live session used to keep one tick for good.
 */

test("a sent file gets two ticks once the contact's app has it", { tag: ["@feature:chat.paired.receipts"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("fm-alice"), peer("fm-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  // Each side says "joined the chat" once the chat is live, so those lines can land just after connect() returns. The
  // chat list shows the chat's last line, and a join line carries no ticks: the file goes once both lines are in.
  await expect(chat(alice).getByText(/joined the chat/)).toHaveCount(2);
  await alice.page.getByTestId("file-input").setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello\n".repeat(100)) });
  await expect(chat(bob).getByText("note.txt")).toBeVisible({ timeout: 60_000 });
  const row = chat(alice).locator("[data-message-row]").filter({ hasText: "note.txt" }).last();
  await expect(row.getByTestId("message-delivery")).toHaveAttribute("data-delivery", "delivered", { timeout: 30_000 });
  await alice.page.goto("/#/");
  await expect(alice.page.getByTestId("chat-row-delivery").first()).toHaveAttribute("data-delivery", "delivered");
});
