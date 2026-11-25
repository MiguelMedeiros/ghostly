import { chat, connect, expect, link, say, test } from "../support/fixtures";

/**
 * Block contact, as a person does it: ⋮ → Block contact, confirmed. What the contact sends afterwards never shows, and
 * nothing tells its app (it goes out as any message does); the chat keeps what it had. Unblocked from Settings →
 * Privacy & security → Blocked contacts, the contact is heard again.
 */
test("a blocked contact's messages never show; unblocked in Settings, they come again", { tag: ["@feature:chat.paired.block"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("block-alice"), peer("block-bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  await bob.page.getByTestId("chat-options").click();
  await bob.page.getByTestId("chat-block").click();
  const asked = bob.page.getByRole("dialog", { name: /^Block .*\?$/ });
  await expect(asked).toHaveAccessibleDescription(/can no longer call you or send you anything/);
  await asked.getByRole("button", { name: "Block", exact: true }).click();
  await expect(asked).toBeHidden();
  // The menu says it is blocked now: Unblock contact takes Block's place.
  await bob.page.getByTestId("chat-options").click();
  await expect(bob.page.getByTestId("chat-unblock")).toBeVisible();
  await bob.page.keyboard.press("Escape");

  await say(alice, "can you hear me?");
  const line = chat(alice).locator("[data-message-row]").filter({ hasText: "can you hear me?" });
  await expect(line.getByTestId("message-delivery")).toBeVisible();
  // Well past a live receipt (under a second here): nothing shows on Bob's side.
  await bob.page.waitForTimeout(5_000);
  await expect(chat(bob).getByText("can you hear me?")).toHaveCount(0);
  await expect(chat(bob).getByText(`hello from ${alice.name}`)).toBeVisible();

  // A wide window shows every section of Settings on one page.
  await bob.page.goto("/#/settings");
  const row = bob.page.getByTestId("settings-blocked-contact");
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: /^Unblock / }).click();
  await expect(bob.page.getByTestId("settings-blocked-none")).toBeVisible();

  await bob.page.getByTestId("chat-row").first().click();
  await say(alice, "and now?");
  await expect(chat(bob).getByText("and now?")).toBeVisible();
});
