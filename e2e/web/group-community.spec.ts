import { expect, openProfilePage, test, type Peer } from "../support/fixtures";

/**
 * A community group (`group-community/1`) between six browsers that never pair: the link is the
 * way in and any member lets people in, so people join while the admin's tab is closed; everyone
 * reads everyone through the hubs; someone who was away is caught up by whoever is there, not by the
 * author; the admin, back, removes someone who then reads nothing more; a late joiner reads nothing
 * from before.
 */
const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const wallpaper = (peer: Peer) => peer.page.locator(".chat-wallpaper");
const sees = (peer: Peer, text: string) => expect(wallpaper(peer).getByText(text, { exact: true })).toBeVisible({ timeout: 180_000 });

async function setName(peer: Peer, name: string): Promise<void> {
  await openProfilePage(peer.page);
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

async function say(peer: Peer, text: string): Promise<void> {
  const box = peer.page.getByPlaceholder("Message…");
  await expect(box).toBeEnabled({ timeout: 120_000 });
  await box.fill(text);
  await box.press("Enter");
  await expect(wallpaper(peer).getByText(text, { exact: true })).toBeVisible();
}

async function join(peer: Peer, url: string): Promise<void> {
  await peer.page.goto(url);
  await expect(groupChat(peer)).toBeVisible({ timeout: 30_000 });
  await expect(groupChat(peer)).toHaveAttribute("data-status", "active", { timeout: 180_000 });
}

/** Closes a peer's tab (its app goes away) and reopens it later on the group. */
async function away(peer: Peer): Promise<string> {
  const url = peer.page.url();
  await peer.page.close();
  return url;
}
async function back(peer: Peer, url: string): Promise<void> {
  peer.page = await peer.context.newPage();
  await peer.page.goto(url);
  await expect(groupChat(peer)).toHaveAttribute("data-status", "active", { timeout: 60_000 });
}

test("six people: join by link with the admin away, everyone reads everyone, catch-up, removal, a late joiner", { tag: ["@feature:groups.community.create", "@feature:groups.community.join", "@feature:groups.community.send", "@feature:groups.community.catch-up", "@feature:groups.community.remove", "@feature:groups.community.late-joiner", "@feature:groups.link.share"] }, async ({ peer }) => {
  test.setTimeout(20 * 60_000);
  const [alice, bob, carol, dave, erin, frank] = await Promise.all(["alice", "bob", "carol", "dave", "erin", "frank"].map(name => peer(name)));
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob"), setName(carol, "Carol"), setName(dave, "Dave"), setName(erin, "Erin"), setName(frank, "Frank")]);

  // A community is what New group makes by default; it opens on its link.
  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await expect(alice.page.getByTestId("new-group-kind-community").getByRole("radio")).toBeChecked();
  await alice.page.getByTestId("new-group-name").fill("Plaza");
  await alice.page.getByTestId("new-group-create").click();
  const dialog = alice.page.getByTestId("group-share-dialog");
  await expect(dialog.getByTestId("group-link-note")).toContainText("works while you are away");
  const url = await dialog.getByTestId("group-link-url").inputValue();
  expect(url).toMatch(/#\/join\/group2\//);
  await dialog.getByTestId("group-share-done").click();

  // Bob joins while Alice is there; then Alice closes her app.
  await join(bob, url);
  await expect(bob.page.getByTestId("group-name")).toHaveText("Plaza");
  const aliceUrl = await away(alice);

  // Carol, Dave and Erin join with the admin gone: Bob's app lets them in.
  await Promise.all([join(carol, url), join(dave, url), join(erin, url)]);
  for (const p of [bob, carol, dave, erin]) await expect(p.page.getByTestId("group-members")).toContainText("5 members", { timeout: 180_000 });
  // Every member can hand the link out.
  await expect(carol.page.getByTestId("group-share")).toBeVisible();

  // Everyone reads everyone, with names, though nobody is connected to everybody.
  await say(bob, "bob says hi");
  await say(carol, "carol says hi");
  await say(dave, "dave says hi");
  await say(erin, "erin says hi");
  for (const p of [bob, carol, dave, erin]) for (const text of ["bob says hi", "carol says hi", "dave says hi", "erin says hi"]) await sees(p, text);
  await expect(wallpaper(bob).getByText("~Carol")).toBeVisible();

  // Dave goes away; Carol says something and leaves too. Back, Dave gets it from whoever is there.
  const daveUrl = await away(dave);
  await say(carol, "carol while dave is away");
  await sees(bob, "carol while dave is away");
  const carolUrl = await away(carol);
  await back(dave, daveUrl);
  await sees(dave, "carol while dave is away");

  // Alice returns, is caught up, and removes Erin, who is told and reads nothing more.
  await back(alice, aliceUrl);
  await sees(alice, "erin says hi");
  await sees(alice, "carol while dave is away");
  await alice.page.getByTestId("group-members").click();
  await alice.page.getByTestId("group-member").filter({ hasText: "Erin" }).getByTestId("group-remove-member").click();
  await expect(alice.page.getByTestId("group-member")).toHaveCount(4);
  await alice.page.keyboard.press("Escape");
  await expect(groupChat(erin)).toHaveAttribute("data-status", "removed", { timeout: 120_000 });
  await expect(erin.page.getByPlaceholder("Message…")).toBeDisabled();
  await say(bob, "after erin");
  await sees(dave, "after erin");
  await sees(alice, "after erin");
  await expect(wallpaper(erin).getByText("after erin")).toHaveCount(0);

  // Frank joins late: none of the earlier messages are his to read; what comes next is.
  await join(frank, url);
  await say(dave, "welcome frank");
  await sees(frank, "welcome frank");
  await sees(bob, "welcome frank");
  await expect(wallpaper(frank).getByText("bob says hi")).toHaveCount(0);
  await expect(wallpaper(frank).getByText("after erin")).toHaveCount(0);
  void carolUrl;
});
