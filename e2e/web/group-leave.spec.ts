import { expect, test, type Peer } from "../support/fixtures";

/**
 * Leaving a group takes it off the list at once, even while the admin is away (the admin hears it
 * when they meet again), and an admin who leaves hands the role to a member who is online.
 */
const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const rows = (peer: Peer) => peer.page.getByTestId("sidebar").getByTestId("group-row");
const event = (peer: Peer, text: string) => expect(peer.page.getByTestId("group-event").filter({ hasText: text })).toBeVisible({ timeout: 120_000 });

async function setName(peer: Peer, name: string): Promise<void> {
  await peer.page.getByTestId("account-profile").click();
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

async function leave(peer: Peer): Promise<void> {
  await peer.page.getByTestId("group-options").click();
  await peer.page.getByTestId("group-leave").click();
  await peer.page.getByTestId("group-leave-confirm").click();
  await expect(groupChat(peer)).toHaveCount(0);
  await expect(rows(peer)).toHaveCount(0);
}

test("leaving: gone from the list at once, heard by an admin who was away, and the admin hands over its role", async ({ peer }) => {
  test.setTimeout(8 * 60_000);
  const [alice, bob, carol] = await Promise.all([peer("alice"), peer("bob"), peer("carol")]);
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob"), setName(carol, "Carol")]);

  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Leavers");
  await alice.page.getByTestId("new-group-create").click();
  await alice.page.getByTestId("group-members").click();
  await alice.page.getByTestId("group-link-enable").click();
  const url = await alice.page.getByTestId("group-link-url").inputValue();
  await alice.page.keyboard.press("Escape");
  for (const p of [bob, carol]) {
    await p.page.goto(url);
    await expect(groupChat(p)).toHaveAttribute("data-status", "active", { timeout: 120_000 });
  }
  for (const p of [alice, bob, carol]) await expect(p.page.getByTestId("group-members")).toContainText("2 of 2 reachable", { timeout: 120_000 });

  // The admin goes away; Bob leaves meanwhile. His list is empty at once, and stays so after a reload.
  const groupUrl = alice.page.url();
  await alice.page.close();
  await expect(bob.page.getByTestId("group-members")).toContainText("1 of 2 reachable", { timeout: 120_000 });
  await leave(bob);
  await bob.page.reload();
  await expect(bob.page.getByTitle("New Chat")).toBeVisible();
  await expect(rows(bob)).toHaveCount(0);

  // Back, the admin hears it from Bob's app and removes him; Carol sees it too.
  alice.page = await alice.context.newPage();
  await alice.page.goto(groupUrl);
  await event(alice, "Bob is no longer a member");
  await event(carol, "Bob is no longer a member");
  await expect(alice.page.getByTestId("group-members")).toContainText("2 members");

  // The admin leaves: the dialog names who takes over, and that member is the admin after.
  await alice.page.getByTestId("group-options").click();
  await alice.page.getByTestId("group-leave").click();
  await expect(alice.page.getByTestId("group-leave-successor")).toContainText("Carol");
  await alice.page.getByTestId("group-leave-confirm").click();
  await expect(rows(alice)).toHaveCount(0);
  await event(carol, "You are now the admin");
  await event(carol, "Alice is no longer a member");
  await expect(carol.page.getByTestId("group-members")).toContainText("1 member");
});
