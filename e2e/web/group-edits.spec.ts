import type { Page } from "@playwright/test";
import { chat, expect, openProfilePage, say, test, type Peer } from "../support/fixtures";

/**
 * Editing a sent message in a group (WISP 9xx § Edits). Alice, in a community with Bob, edits her text from its ⋮ and
 * then with ↑ in an empty composer; Bob sees the new text in place, marked edited, never as a second message, with
 * the earlier versions in its details. Alice cannot edit Bob's message.
 */

/** The row whose own text is exactly `text`. */
const row = (page: Page, text: string) => page.locator(".chat-wallpaper [data-message-row]")
  .filter({ has: page.getByTestId("message-text").filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) }).last();
const field = (p: Peer) => p.page.getByPlaceholder("Message…");
const groupChat = (p: Peer) => p.page.getByTestId("group-chat");

async function setName(peer: Peer, name: string): Promise<void> {
  await openProfilePage(peer.page);
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

test("an edit in a group shows on the other member's side in place, marked edited, with the history in its details", { tag: ["@feature:groups.edit", "@feature:groups.protocol.edits"] }, async ({ peer }) => {
  test.setTimeout(8 * 60_000);
  const [alice, bob] = await Promise.all(["alice", "bob"].map(name => peer(`edit-group-${name}`)));
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob")]);

  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Release crew");
  await alice.page.getByTestId("new-group-create").click();
  const share = alice.page.getByTestId("group-share-dialog");
  const url = await share.getByTestId("group-link-url").inputValue();
  await share.getByTestId("group-share-done").click();
  await bob.page.goto(url);
  await expect(groupChat(bob)).toHaveAttribute("data-status", "active", { timeout: 180_000 });
  await say(bob, "hi from Bob");
  await expect(chat(alice).getByText("hi from Bob")).toBeVisible({ timeout: 120_000 });
  await say(alice, "Working: 0 of 2");
  await expect(row(bob.page, "Working: 0 of 2")).toBeVisible({ timeout: 120_000 });

  // Bob's message has no Edit on Alice's side.
  const his = row(alice.page, "hi from Bob");
  await his.hover();
  await his.getByTestId("message-options").click();
  await expect(alice.page.getByTestId("message-reply")).toBeVisible();
  await expect(alice.page.getByTestId("message-edit")).toHaveCount(0);
  await alice.page.keyboard.press("Escape");

  // Alice edits hers from its ⋮.
  const mine = row(alice.page, "Working: 0 of 2");
  await mine.hover();
  await mine.getByTestId("message-options").click();
  await alice.page.getByTestId("message-edit").click();
  await expect(alice.page.getByTestId("composer-edit")).toBeVisible();
  await expect(field(alice)).toHaveValue("Working: 0 of 2");
  await field(alice).fill("Working: 1 of 2");
  await field(alice).press("Enter");
  await expect(alice.page.getByTestId("composer-edit")).toHaveCount(0);
  await expect(row(alice.page, "Working: 1 of 2").getByTestId("message-edited")).toBeVisible();

  // Bob: the same message with the new text, marked; no second message.
  await expect(row(bob.page, "Working: 1 of 2").getByTestId("message-edited")).toHaveText("edited", { timeout: 60_000 });
  await expect(groupChat(bob).getByText("Working: 0 of 2", { exact: true })).toHaveCount(0);

  // ↑ in Alice's empty composer edits her last message.
  await field(alice).click();
  await field(alice).press("ArrowUp");
  await expect(alice.page.getByTestId("composer-edit")).toBeVisible();
  await expect(field(alice)).toHaveValue("Working: 1 of 2");
  await field(alice).fill("Done: 2 of 2");
  await field(alice).press("Enter");
  await expect(row(bob.page, "Done: 2 of 2").getByTestId("message-edited")).toBeVisible({ timeout: 60_000 });
  // Said to the group: Alice's mark no longer waits.
  await expect(row(alice.page, "Done: 2 of 2").getByTestId("message-edited")).not.toHaveAttribute("data-pending", { timeout: 30_000 });

  // Its details keep the earlier versions, the original first.
  await row(bob.page, "Done: 2 of 2").getByTestId("message-text").dblclick();
  const versions = bob.page.getByTestId("message-details").locator('[data-section="edits"] [data-testid="message-details-row"]');
  await expect(versions.nth(0)).toHaveAttribute("data-value", /^2, the last at /);
  await expect(versions.nth(1)).toHaveAttribute("data-label", /^Original, /);
  await expect(versions.nth(1)).toHaveAttribute("data-value", "Working: 0 of 2");
  await bob.page.keyboard.press("Escape");

  // A reload keeps it.
  await bob.page.reload();
  await expect(row(bob.page, "Done: 2 of 2").getByTestId("message-edited")).toBeVisible({ timeout: 60_000 });
});
