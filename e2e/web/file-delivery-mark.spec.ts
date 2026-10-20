import { chat, connect, delivered, expect, link, test } from "../support/fixtures";

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

// A large file is copied into this device before it goes. With no room for the copy it never leaves: the red Not sent
// mark, with nothing to send again, before a reload and after it (it used to read Sent once the page was reloaded).
test("a large file with no room on this device for its copy keeps the Not sent mark after a reload", { tag: ["@feature:files.storage", "@feature:files.persistence"] }, async ({ peer, browserName }) => {
  test.skip(browserName !== "chromium", "The room is taken away through Chromium's DevTools protocol");
  const MIB = 1024 * 1024;
  const [alice, bob] = await Promise.all([peer("fm-full-alice"), peer("fm-full-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const devtools = await alice.context.newCDPSession(alice.page);
  const origin = new URL(alice.page.url()).origin;
  const usage = await alice.page.evaluate(async () => (await navigator.storage.estimate()).usage ?? 0);
  await devtools.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: usage + 4 * MIB });
  await alice.page.getByTestId("file-input").setInputFiles({ name: "too big.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(20 * MIB, 7) });
  const row = chat(alice).locator("[data-message-row]").filter({ hasText: "too big.bin" }).last();
  for (const when of ["before a reload", "after a reload"]) {
    await expect(row.getByTestId("file-status"), when).toHaveText("Not enough space on this device", { timeout: 60_000 });
    await expect(delivered(row, "failed"), when).toBeVisible();
    await expect(row.getByRole("button", { name: /send again/i }), when).toHaveCount(0);
    if (when === "before a reload") await alice.page.reload();
  }
  await devtools.send("Storage.overrideQuotaForOrigin", { origin });
});
