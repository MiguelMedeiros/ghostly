import { expect, openProfilePage, test, type Peer } from "../support/fixtures";

/**
 * Typing in a private group (WISP 902 · Group Mesh § Typing): the members see who is writing in the header, in place
 * of the member count; two at once are both named; a message ends its writer's line, and a member who stops typing
 * is gone from it a few seconds later. Nothing of it is stored: the history holds only the messages.
 */
const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const wallpaper = (peer: Peer) => peer.page.locator(".chat-wallpaper");
const typing = (peer: Peer) => peer.page.getByTestId("group-typing");
const box = (peer: Peer) => peer.page.getByPlaceholder("Message…");
const reachable = (peer: Peer, n: number, of: number) => expect(peer.page.getByTestId("group-members")).toContainText(`${n} of ${of} reachable`, { timeout: 150_000 });

async function setName(peer: Peer, name: string): Promise<void> {
  await openProfilePage(peer.page);
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

test("a private group shows who is typing, both of two, and a message or a pause ends it", { tag: ["@feature:groups.typing", "@feature:groups.link.join"] }, async ({ peer }) => {
  test.setTimeout(8 * 60_000);
  const [alice, bob, carol] = await Promise.all([peer("alice"), peer("bob"), peer("carol")]);
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob"), setName(carol, "Carol")]);

  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Crew");
  await alice.page.getByTestId("new-group-kind-mesh").click();
  await alice.page.getByTestId("new-group-create").click();
  const shareDialog = alice.page.getByTestId("group-share-dialog");
  await expect(shareDialog.getByTestId("group-link-url")).toHaveValue(/#\/join\/group1\//);
  const url = await shareDialog.getByTestId("group-link-url").inputValue();
  await shareDialog.getByTestId("group-share-done").click();
  for (const p of [bob, carol]) {
    await p.page.goto(url);
    await expect(groupChat(p)).toHaveAttribute("data-status", "active", { timeout: 120_000 });
  }
  for (const p of [alice, bob, carol]) await reachable(p, 2, 2);
  for (const p of [alice, bob, carol]) await expect(box(p)).toBeEnabled({ timeout: 60_000 });

  // Carol writes: Alice and Bob see her named in the header, where the member count was.
  await box(carol).fill("on my");
  for (const p of [alice, bob]) await expect(typing(p)).toHaveText("Carol is typing…", { timeout: 15_000 });
  await expect(alice.page.getByTestId("group-members")).not.toContainText("reachable");
  await expect(typing(carol)).toHaveCount(0);

  // Bob writes too: Alice sees both.
  await box(bob).fill("same");
  await box(carol).fill("on my way");
  await expect(typing(alice)).toHaveText(/^(Carol and Bob|Bob and Carol) are typing…$/, { timeout: 15_000 });

  // Carol's message ends her line at once; Bob is still there.
  await box(bob).fill("same here");
  await box(carol).press("Enter");
  await expect(wallpaper(alice).getByText("on my way", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(typing(alice)).toHaveText("Bob is typing…", { timeout: 5_000 });

  // Bob stops typing (his text stays in the composer): his line goes by itself.
  await expect(typing(alice)).toHaveCount(0, { timeout: 15_000 });
  await expect(alice.page.getByTestId("group-members")).toContainText("2 of 2 reachable");
  // Nothing of it was stored: one message in the history.
  await expect(wallpaper(alice).getByText(/typing/)).toHaveCount(0);
});
