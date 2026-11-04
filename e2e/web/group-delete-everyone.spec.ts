import type { Page } from "@playwright/test";
import { expect, say, test, type Peer } from "../support/fixtures";

/**
 * Delete for everyone in a group (WISP 400 § Delete for everyone), a community and a private group. Alice creates the
 * group and Bob joins by its link; each deletes one of their own messages from its ⋮ and the other member's copy goes
 * too, also after a reload. In a community the removal used to stay on its author's device: the message went there,
 * and every other member kept it.
 */

/** The row whose own text is exactly `text`. */
const row = (page: Page, text: string) => page.locator(".chat-wallpaper [data-message-row]")
  .filter({ has: page.getByTestId("message-text").filter({ hasText: new RegExp(`^${text}$`) }) });

async function deleteForEveryone(peer: Peer, text: string): Promise<void> {
  const message = row(peer.page, text);
  await message.hover();
  await message.getByTestId("message-options").click();
  await peer.page.getByTestId("message-delete-everyone").click();
  await peer.page.getByTestId("message-delete-confirm").click();
  await expect(message).toHaveCount(0);
}

for (const kind of ["community", "mesh"] as const) {
  test(`${kind === "community" ? "a community" : "a private group"}: a message deleted for everyone goes from the other member's chat too`, { tag: ["@feature:groups.edit", "@feature:groups.protocol.edits"] }, async ({ peer }) => {
    test.setTimeout(6 * 60_000);
    const [alice, bob] = await Promise.all(["alice", "bob"].map(name => peer(`delete-everyone-${kind}-${name}`)));
    await alice.page.getByTestId("sidebar-new-more").click();
    await alice.page.getByTestId("new-group").click();
    await alice.page.getByTestId("new-group-name").fill("Release crew");
    await alice.page.getByTestId(`new-group-kind-${kind}`).click();
    await alice.page.getByTestId("new-group-create").click();
    const share = alice.page.getByTestId("group-share-dialog");
    const url = await share.getByTestId("group-link-url").inputValue();
    await share.getByTestId("group-share-done").click();
    await bob.page.goto(url);
    await expect(bob.page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 180_000 });

    await say(bob, "from Bob, a mistake");
    await say(bob, "from Bob, kept");
    await expect(row(alice.page, "from Bob, kept")).toBeVisible({ timeout: 120_000 });
    await say(alice, "from Alice, a mistake");
    await say(alice, "from Alice, kept");
    await expect(row(bob.page, "from Alice, kept")).toBeVisible({ timeout: 120_000 });

    await deleteForEveryone(bob, "from Bob, a mistake");
    await deleteForEveryone(alice, "from Alice, a mistake");
    await expect(row(alice.page, "from Bob, a mistake")).toHaveCount(0, { timeout: 60_000 });
    await expect(row(bob.page, "from Alice, a mistake")).toHaveCount(0, { timeout: 60_000 });
    // Gone for good, not only from the page: the rest of the chat stays.
    await alice.page.reload();
    await expect(row(alice.page, "from Bob, kept")).toBeVisible();
    await expect(row(alice.page, "from Bob, a mistake")).toHaveCount(0);
  });
}
