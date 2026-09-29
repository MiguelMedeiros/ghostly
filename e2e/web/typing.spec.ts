import { chat, expect, test } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * The typing indicator (WISP 401 § Typing): what one side writes shows as "typing…" in the other's chat header and
 * chat list row, over the live session only, and goes when the message arrives, when the text is cleared, and after a
 * few seconds of silence. With "Send typing indicator" off, a profile says nothing and still sees its contact's.
 */

test("the contact sees typing… while one writes, until the message, a cleared text or silence", { tag: ["@feature:chat.typing", "@feature:settings.send-typing"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await pair(alice, bob);
  const box = alice.page.getByPlaceholder("Message…");
  const typing = bob.page.getByTestId("chat-typing");
  const rowTyping = bob.page.getByTestId("sidebar").getByTestId("chat-row-typing");

  // Alice writes: Bob's header and his chat list row say so.
  await box.pressSequentially("hel");
  await expect(typing).toHaveText("typing…", { timeout: 15_000 });
  await expect(rowTyping).toHaveText("typing…");
  // Alice sends: it goes with the message.
  await box.pressSequentially("lo");
  await box.press("Enter");
  await expect(chat(bob).getByText("hello")).toBeVisible();
  await expect(typing).toHaveCount(0);
  await expect(rowTyping).toHaveCount(0);
  await expect(bob.page.getByTestId("chat-subtitle")).not.toHaveText(/typing/);

  // She writes again and clears it: it goes.
  await box.pressSequentially("again");
  await expect(typing).toBeVisible({ timeout: 15_000 });
  await box.fill("");
  await expect(typing).toHaveCount(0, { timeout: 8_000 });

  // She stops with text left: it goes by itself after a few seconds.
  await box.pressSequentially("draft");
  await expect(typing).toBeVisible({ timeout: 15_000 });
  await expect(typing).toHaveCount(0, { timeout: 12_000 });
  await box.fill("");

  // Send typing indicator off: Alice's writing is not shown, Bob's still is, to her.
  await alice.page.goto("/#/settings");
  const toggle = alice.page.getByTestId("settings-send-typing");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await alice.page.getByTestId("sidebar").getByTestId("chat-row").first().click();
  await alice.page.getByPlaceholder("Message…").pressSequentially("secret draft");
  await bob.page.getByPlaceholder("Message…").pressSequentially("and me");
  await expect(alice.page.getByTestId("chat-typing")).toBeVisible({ timeout: 15_000 });
  await bob.page.waitForTimeout(3_000);
  await expect(typing).toHaveCount(0);
});
