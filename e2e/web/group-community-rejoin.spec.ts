import { expect, test, type Peer } from "../support/fixtures";

/**
 * Leaving a community and joining it again by its link, without a reload: the old history went with the group when
 * it was left, and it stays gone. The page keeps each history it was sent and hears only what changes in it, so the
 * old messages showed again under the new ones until a reload (bug hunt r5b, 2026-09-29). The late joiner's rule
 * (WISP 903) holds for someone who was in before, too: they read what comes after they are back. What they wrote before
 * they left keeps their name for the others (bug hunt r9c: it read "~Member xxxx" once they were out of the roster).
 */
const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const wallpaper = (peer: Peer) => peer.page.locator(".chat-wallpaper");
const sees = (peer: Peer, text: string) => expect(wallpaper(peer).getByText(text, { exact: true })).toBeVisible({ timeout: 120_000 });

async function say(peer: Peer, text: string): Promise<void> {
  const box = peer.page.getByPlaceholder("Message…");
  await expect(box).toBeEnabled({ timeout: 120_000 });
  await box.fill(text);
  await box.press("Enter");
  await expect(wallpaper(peer).getByText(text, { exact: true })).toBeVisible();
}

async function join(peer: Peer, url: string): Promise<void> {
  await peer.page.goto(url);
  await expect(groupChat(peer)).toHaveAttribute("data-status", "active", { timeout: 120_000 });
}

test("a community left and joined again by its link shows only what came after, with no reload", { tag: ["@feature:groups.community.leave", "@feature:groups.community.late-joiner"] }, async ({ peer }) => {
  test.setTimeout(6 * 60_000);
  const [alice, bob] = await Promise.all(["alice", "bob"].map(name => peer(name)));
  await bob.page.goto("/#/profile");
  await bob.page.getByTestId("account-nickname").fill("Bob");
  await expect(bob.page.getByTestId("account-nickname")).toHaveValue("Bob");
  await bob.page.goto("/#/");
  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await expect(alice.page.getByTestId("new-group-kind-community").getByRole("radio")).toBeChecked();
  await alice.page.getByTestId("new-group-name").fill("Plaza");
  await alice.page.getByTestId("new-group-create").click();
  const dialog = alice.page.getByTestId("group-share-dialog");
  const url = await dialog.getByTestId("group-link-url").inputValue();
  await dialog.getByTestId("group-share-done").click();

  await join(bob, url);
  await expect(bob.page.getByTestId("group-members")).toContainText("2 members · connected", { timeout: 120_000 });
  await say(bob, "said before leaving");
  await say(alice, "answered before");
  await sees(bob, "answered before");
  await sees(alice, "said before leaving");

  // Bob leaves: the group is off his list at once.
  await bob.page.getByTestId("group-options").click();
  await bob.page.getByTestId("group-leave").click();
  await bob.page.getByTestId("group-leave-confirm").click();
  await expect(groupChat(bob)).toHaveCount(0);
  await expect(bob.page.getByTestId("sidebar").getByTestId("group-row")).toHaveCount(0);
  // Alice still names what he wrote, now that he is out of the roster.
  await expect(alice.page.getByTestId("group-members")).toContainText("1 member", { timeout: 120_000 });
  const before = wallpaper(alice).locator("[data-message-id]").filter({ has: alice.page.getByText("said before leaving", { exact: true }) });
  await expect(before.getByTestId("message-nick")).toHaveText("~Bob");

  // In again by the same link, in the same page: only what comes now.
  await join(bob, url);
  await expect(bob.page.getByTestId("group-members")).toContainText("2 members · connected", { timeout: 120_000 });
  await say(alice, "said after the return");
  await sees(bob, "said after the return");
  await expect(wallpaper(bob).getByText("said before leaving", { exact: true })).toHaveCount(0);
  await expect(wallpaper(bob).getByText("answered before", { exact: true })).toHaveCount(0);
  // Alice keeps what was said while Bob was in.
  await sees(alice, "said before leaving");
});
