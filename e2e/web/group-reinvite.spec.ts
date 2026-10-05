import { expect, openProfilePage, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * A private group's member removed and then invited again (bug hunt r4b, r6a). A removal keeps the history on the removed
 * member's device (WISP 902 mesh: only leaving drops it), and what that member wrote before keeps its name for everyone
 * (#677: its old member key is in no roster any more). Back with a new key, the member reads nothing said while it was
 * out, and what it says is named as before.
 */
const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const wallpaper = (peer: Peer) => peer.page.locator(".chat-wallpaper");
const sees = (peer: Peer, text: string) => expect(wallpaper(peer).getByText(text, { exact: true })).toBeVisible({ timeout: 90_000 });
const reachable = (peer: Peer, n: number, of: number) => expect(peer.page.getByTestId("group-members")).toContainText(`${n} of ${of} reachable`, { timeout: 120_000 });

async function setName(peer: Peer, name: string): Promise<void> {
  await openProfilePage(peer.page);
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

async function say(peer: Peer, text: string): Promise<void> {
  const box = peer.page.getByPlaceholder("Message…");
  await expect(box).toBeEnabled({ timeout: 60_000 });
  await box.fill(text);
  await box.press("Enter");
  await expect(wallpaper(peer).getByText(text, { exact: true })).toBeVisible();
}

async function invite(admin: Peer, name: string): Promise<void> {
  await admin.page.getByTestId("group-members").click();
  const row = admin.page.getByTestId("group-invite-contact").filter({ hasText: name });
  await expect(row.getByTestId("group-invite")).toBeEnabled({ timeout: 60_000 });
  await row.getByTestId("group-invite").click();
  await expect(row).toContainText("Invited…");
  await admin.page.keyboard.press("Escape");
}

async function accept(peer: Peer, groupName: string): Promise<void> {
  const row = peer.page.getByTestId("group-row").filter({ hasText: groupName });
  await row.getByTestId("group-accept").click();
  await expect(row.getByTestId("group-accept")).toHaveCount(0);
  await expect(row).toContainText(/\d+ members?/, { timeout: 60_000 });
  await row.click();
  await expect(groupChat(peer)).toHaveAttribute("data-status", "active", { timeout: 60_000 });
}

/** The message's row names its author as `~name`, never as an unknown member. */
async function namedBy(peer: Peer, text: string, name: string): Promise<void> {
  const message = wallpaper(peer).locator("[data-message-id]").filter({ has: peer.page.getByText(text, { exact: true }) });
  await expect(message).toHaveCount(1);
  await expect(message.getByTestId("message-nick")).toHaveText(`~${name}`);
}

test("a member removed and invited again: the history kept on removal, the names kept for everyone", { tag: ["@feature:groups.remove-member", "@feature:groups.invite"] }, async ({ peer }) => {
  test.setTimeout(10 * 60_000);
  const [alice, bob, carol] = await Promise.all([peer("alice"), peer("bob"), peer("carol")]);
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob"), setName(carol, "Carol")]);
  await pair(alice, bob);
  await pair(alice, carol);

  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Ghosts");
  await alice.page.getByTestId("new-group-kind-mesh").click();
  await alice.page.getByTestId("new-group-create").click();
  await alice.page.getByTestId("group-share-done").click();
  await invite(alice, "Bob");
  await invite(alice, "Carol");
  await accept(bob, "Ghosts");
  await accept(carol, "Ghosts");
  for (const p of [alice, bob, carol]) await reachable(p, 2, 2);

  await say(carol, "carol before");
  await say(bob, "bob before");
  for (const p of [alice, bob]) await sees(p, "carol before");
  await sees(carol, "bob before");

  // Removed: Carol is told, and keeps what was said; Alice and Bob still name what she wrote.
  await alice.page.getByTestId("group-members").click();
  await alice.page.getByTestId("group-member").filter({ hasText: "Carol" }).getByTestId("group-remove-member").click();
  await alice.page.getByTestId("group-remove-confirm").click();
  await alice.page.keyboard.press("Escape");
  await expect(groupChat(carol)).toHaveAttribute("data-status", "removed", { timeout: 60_000 });
  await expect(bob.page.getByTestId("group-event").filter({ hasText: "Carol is no longer a member" })).toBeVisible({ timeout: 60_000 });
  for (const text of ["carol before", "bob before"]) await sees(carol, text);
  for (const p of [alice, bob]) await namedBy(p, "carol before", "Carol");
  await say(alice, "while carol is out");
  await sees(bob, "while carol is out");

  // Invited again over the same chat: back with a new member key. Before she accepts, what she kept still names who
  // wrote it (it read "Member xxxx" until she was in again).
  await invite(alice, "Carol");
  const invitation = carol.page.getByTestId("group-row").filter({ hasText: "Ghosts" });
  await expect(invitation.getByTestId("group-accept")).toBeVisible({ timeout: 60_000 });
  await invitation.click();
  await namedBy(carol, "bob before", "Bob");
  await accept(carol, "Ghosts");
  for (const p of [alice, bob, carol]) await reachable(p, 2, 2);
  await say(carol, "carol again");
  for (const p of [alice, bob]) {
    await sees(p, "carol again");
    await namedBy(p, "carol again", "Carol");
    await namedBy(p, "carol before", "Carol");
  }
  // What was said while she was out stays unread by her; what she had before her removal stays.
  await sees(carol, "carol before");
  await expect(wallpaper(carol).getByText("while carol is out", { exact: true })).toHaveCount(0);
  // After a reload too: the names come from what the app keeps, not from the live roster alone.
  await alice.page.reload();
  await expect(groupChat(alice)).toBeVisible({ timeout: 60_000 });
  await namedBy(alice, "carol before", "Carol");
  await namedBy(alice, "carol again", "Carol");
});
