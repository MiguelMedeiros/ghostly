import type { Page } from "@playwright/test";
import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

/**
 * Bob's reply bar, and the messages he chose to forward, follow Alice's message as his chat has it now (WISP 400 §
 * Replies, § Delete for everyone): her edit shows in the bar and in the quote that goes, and her message deleted for
 * everyone leaves the bar and the choice, its words with them. His draft stays, and Enter sends it as a plain message.
 */

/** The row whose own text is exactly `text`. */
const row = (page: Page, text: string) => page.locator(".chat-wallpaper [data-message-row]")
  .filter({ has: page.getByTestId("message-text").filter({ hasText: new RegExp(`^${text}$`) }) }).last();
const bar = (page: Page) => page.getByTestId("composer-reply");
const field = (p: Peer) => p.page.getByPlaceholder("Message…");

async function menu(p: Peer, text: string, item: string): Promise<void> {
  const target = row(p.page, text);
  await target.hover();
  await target.getByTestId("message-options").click();
  await p.page.getByTestId(item).click();
}

async function edit(p: Peer, from: string, to: string): Promise<void> {
  await menu(p, from, "message-edit");
  await field(p).fill(to);
  await field(p).press("Enter");
  await expect(p.page.getByTestId("composer-edit")).toHaveCount(0);
}

async function deleteForEveryone(p: Peer, text: string): Promise<void> {
  await menu(p, text, "message-delete-everyone");
  await p.page.getByTestId("message-delete-confirm").click();
  await expect(row(p.page, text)).toHaveCount(0);
}

test("a reply bar and a choice to forward follow the contact's edit and delete for everyone", { tag: ["@feature:chat.replies", "@feature:chat.paired.delete-message", "@feature:chat.forward"] }, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const [alice, bob] = await Promise.all([peer("held-reply-alice"), peer("held-reply-bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  // Deleted for everyone while Bob answers it: the bar goes with the words, the draft stays and goes plain.
  await say(alice, "zebra secret 4471");
  await edit(alice, "zebra secret 4471", "zebra secret 4472");
  await expect(row(bob.page, "zebra secret 4472")).toBeVisible();
  await menu(bob, "zebra secret 4472", "message-reply");
  await expect(bar(bob.page).getByTestId("reply-quote-snippet")).toHaveText("zebra secret 4472");
  await field(bob).fill("my draft answer");
  await deleteForEveryone(alice, "zebra secret 4472");
  await expect(row(bob.page, "zebra secret 4472")).toHaveCount(0);
  await expect(bar(bob.page)).toHaveCount(0);
  await expect(bob.page.locator("body")).not.toContainText("zebra secret");
  await expect(field(bob)).toHaveValue("my draft answer");
  await field(bob).press("Enter");
  await expect(row(alice.page, "my draft answer")).toBeVisible();
  await expect(row(alice.page, "my draft answer").getByTestId("message-quote")).toHaveCount(0);
  await expect(bob.page.getByRole("alert")).toHaveCount(0);

  // Edited while Bob answers it: the bar shows the new text, and the reply both sides see quotes it.
  await say(alice, "lynx v0 3301");
  await menu(bob, "lynx v0 3301", "message-reply");
  await edit(alice, "lynx v0 3301", "lynx v1 3302");
  await expect(bar(bob.page).getByTestId("reply-quote-snippet")).toHaveText("lynx v1 3302");
  await say(bob, "ok lynx");
  for (const p of [alice, bob]) await expect(row(p.page, "ok lynx").getByTestId("reply-quote-snippet")).toHaveText("lynx v1 3302");

  // Chosen to forward, then deleted for everyone: no longer chosen, and the choice ends with it.
  await say(alice, "otter 5501");
  await expect(chat(bob).getByText("otter 5501")).toBeVisible();
  await menu(bob, "otter 5501", "message-select-start");
  await expect(bob.page.getByTestId("select-count")).toHaveText("1 selected");
  await deleteForEveryone(alice, "otter 5501");
  await expect(bob.page.getByTestId("select-bar")).toHaveCount(0);
});
