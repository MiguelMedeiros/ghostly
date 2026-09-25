import { chat, connect, expect, linkLegacy, say, test } from "../support/fixtures";
import { pasteInvite } from "../support/clipboard";

/**
 * A chat made with a v0.4 code (WISP 402) is a compatibility chat: it keeps working both ways, says what it
 * is, and moves on by a new chat whose invite goes inside it. 0.5 never creates one; the fixture makes it
 * the way a v0.4 code pasted into a current app does.
 */
test("a 0.4 compatibility chat keeps working, says so, and continues in a new chat", { tag: ["@feature:chat.compat"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await linkLegacy(alice, bob);
  await connect(alice, bob);
  for (const p of [alice, bob]) await expect(p.page.getByTestId("compat-chat")).toHaveText("Compatibility chat · older Ghostly");

  const old = alice.page.url();
  await alice.page.getByTestId("chat-options").click();
  await alice.page.getByTestId("chat-continue-new").click();
  // Alice is in the new chat, with its invite; Bob got that invite as a message in the old one.
  await expect(alice.page.getByTestId("invite-card")).toBeVisible();
  const invite = chat(bob).getByText("Let's continue in a new chat", { exact: false });
  await expect(invite).toBeVisible({ timeout: 60_000 });
  // Bob opens it with Join, the way a link or a pasted code arrives.
  const code = /(ghostly1[0-9a-z]+|pair1\/\S+)/i.exec(await invite.innerText())![1];
  await bob.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(bob.page, code);
  await expect(bob.page.getByPlaceholder("Message…")).toBeVisible();
  await expect(bob.page.getByTestId("compat-chat")).toHaveCount(0);
  await say(bob, "hello in the new chat");
  await expect(chat(alice).getByText("hello in the new chat")).toBeVisible({ timeout: 60_000 });
  await expect(alice.page.getByTestId("compat-chat")).toHaveCount(0);

  // The old chat stays readable and points at the new one.
  await alice.page.goto(old);
  await expect(alice.page.getByTestId("compat-continued")).toBeVisible();
  await expect(chat(alice).getByText(`hello from ${bob.name}`)).toBeVisible();
});
