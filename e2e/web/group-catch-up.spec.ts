import { expect, openProfilePage, test, type Peer } from "../support/fixtures";

/**
 * Any member catches up the others (WISP 9xx group mesh, revision 0.9): a member whose app was closed gets, when it
 * opens again, what an author sent meanwhile even though the author's app is closed by then too. The third member,
 * who was there, hands it on. Before, only the author re-sent, and only while both were open.
 */
const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const wallpaper = (peer: Peer) => peer.page.locator(".chat-wallpaper");
const sees = (peer: Peer, text: string) => expect(wallpaper(peer).getByText(text, { exact: true })).toBeVisible({ timeout: 120_000 });
const reachable = (peer: Peer, n: number, of: number) => expect(peer.page.getByTestId("group-members")).toContainText(`${n} of ${of} reachable`, { timeout: 150_000 });

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

test("a member back after its app was closed gets what an author sent meanwhile, from a third member", { tag: ["@feature:groups.catch-up", "@feature:groups.link.join"] }, async ({ peer }) => {
  test.setTimeout(8 * 60_000);
  const [alice, bob, carol] = await Promise.all([peer("alice"), peer("bob"), peer("carol")]);
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob"), setName(carol, "Carol")]);

  // A private group (group-mesh/1) whose link Bob and Carol open.
  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Status");
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
  await say(alice, "everyone here");
  for (const p of [bob, carol]) await sees(p, "everyone here");

  // Carol closes her app. Bob posts a status, then closes his too.
  const groupUrl = carol.page.url();
  await carol.page.close();
  await reachable(alice, 1, 2);
  await say(bob, "status while carol is away");
  await sees(alice, "status while carol is away");
  await bob.page.close();
  await reachable(alice, 0, 2);

  // Carol is back: Alice hands Bob's status on, signed by Bob and named as his.
  carol.page = await carol.context.newPage();
  await carol.page.goto(groupUrl);
  await expect(groupChat(carol)).toBeVisible();
  await sees(carol, "status while carol is away");
  await expect(wallpaper(carol).getByText("~Bob")).toBeVisible();
  await expect(carol.page.getByTestId("group-members")).toContainText("1 of 2 reachable");
});
