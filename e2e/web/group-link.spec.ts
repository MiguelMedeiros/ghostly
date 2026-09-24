import { expect, test, type Peer } from "../support/fixtures";
import { setClipboard } from "../support/clipboard";

/**
 * A group's link (`group-entry/1`): the admin shares one address, and people who are nobody's
 * contact join through it — one by opening it, one by pasting it into Join — and everyone reads
 * everyone. Replacing the link leaves the old one reaching nobody.
 */
const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const wallpaper = (peer: Peer) => peer.page.locator(".chat-wallpaper");
const sees = (peer: Peer, text: string) => expect(wallpaper(peer).getByText(text, { exact: true })).toBeVisible({ timeout: 90_000 });

async function setName(peer: Peer, name: string): Promise<void> {
  await peer.page.getByTestId("account-profile").click();
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

test("strangers join a group through its link, and a replaced link reaches nobody", { tag: ["@feature:groups.link.enable", "@feature:groups.link.join", "@feature:groups.link.replace", "@feature:groups.create", "@feature:groups.send"] }, async ({ peer }) => {
  test.setTimeout(8 * 60_000);
  const [alice, bob, carol, dave] = await Promise.all([peer("alice"), peer("bob"), peer("carol"), peer("dave")]);
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob"), setName(carol, "Carol")]);

  // The group comes from New's arrow; one click on New itself is still a chat.
  const header = alice.page.getByTestId("sidebar-chat-actions");
  await expect(header.getByRole("button")).toHaveCount(3); // New, its arrow, Join
  await alice.page.getByTestId("sidebar-new-more").click();
  await expect(alice.page.getByTestId("sidebar-new-menu")).toBeVisible();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Open ghosts");
  await alice.page.getByTestId("new-group-create").click();
  await expect(alice.page.getByTestId("group-name")).toHaveText("Open ghosts");

  // The new group opens on its link, already on.
  const shareDialog = alice.page.getByTestId("group-share-dialog");
  await expect(shareDialog.getByTestId("group-link-url")).toHaveValue(/#\/join\/group1\//);
  const url = await shareDialog.getByTestId("group-link-url").inputValue();
  expect(url.startsWith(new URL(alice.page.url()).origin)).toBe(true);
  await shareDialog.getByTestId("group-share-done").click();
  const field = alice.page.getByTestId("group-link-url");

  // Bob opens it. The address loses the link at once; the group waits for Alice's app, then lets him in.
  await bob.page.goto(url);
  await expect(groupChat(bob)).toBeVisible({ timeout: 30_000 });
  expect(bob.page.url()).not.toContain("group1");
  await expect(groupChat(bob)).toHaveAttribute("data-status", "active", { timeout: 120_000 });
  await expect(bob.page.getByTestId("group-name")).toHaveText("Open ghosts");
  await expect(alice.page.getByTestId("group-event").filter({ hasText: "Bob joined" })).toBeVisible({ timeout: 60_000 });

  // Carol pastes it into Join, as she would a chat invite.
  await setClipboard(carol.page, url);
  await carol.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await carol.page.getByRole("button", { name: "Paste from clipboard", exact: true }).click();
  await expect(carol.page.getByRole("dialog")).toHaveCount(0);
  await expect(groupChat(carol)).toHaveAttribute("data-status", "active", { timeout: 120_000 });
  await expect(alice.page.getByTestId("group-event").filter({ hasText: "Carol joined" })).toBeVisible({ timeout: 60_000 });

  // Nobody paired with anybody, and everyone reads everyone, by name.
  await expect(alice.page.getByTestId("group-members")).toContainText("2 of 2 reachable", { timeout: 120_000 });
  await expect(bob.page.getByTestId("group-members")).toContainText("2 of 2 reachable", { timeout: 120_000 });
  await say(alice, "welcome, strangers");
  await say(bob, "bob here");
  await say(carol, "carol here");
  for (const p of [alice, bob, carol]) for (const text of ["welcome, strangers", "bob here", "carol here"]) await sees(p, text);
  await expect(wallpaper(bob).getByText("~Carol")).toBeVisible();
  await expect(wallpaper(carol).getByText("~Alice")).toBeVisible();
  // Joined through a link, they are still nobody's contacts: the group is all their list holds.
  for (const p of [bob, carol]) await expect(p.page.getByTestId("sidebar").getByTestId("group-row")).toHaveCount(1);

  // Only the admin sees the link.
  await bob.page.getByTestId("group-members").click();
  await expect(bob.page.getByTestId("group-link")).toHaveCount(0);
  await bob.page.keyboard.press("Escape");

  // A new link: the old one reaches nobody. Dave opens the old one and is left waiting.
  await alice.page.getByTestId("group-members").click();
  await alice.page.getByTestId("group-link-reset").click();
  await expect(field).not.toHaveValue(url);
  await alice.page.keyboard.press("Escape");
  await dave.page.goto(url);
  await expect(dave.page.getByTestId("group-joining")).toContainText("Waiting for the admin's app", { timeout: 30_000 });
  await dave.page.waitForTimeout(20_000);
  await expect(groupChat(dave)).toHaveAttribute("data-status", "invitation");
  await expect(alice.page.getByTestId("group-members")).toContainText("3 members");
  // Giving up forgets it.
  await dave.page.getByTestId("group-joining-cancel").click();
  await expect(dave.page.getByTestId("group-row")).toHaveCount(0);
});
