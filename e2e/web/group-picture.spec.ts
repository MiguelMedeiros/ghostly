import { expect, test, type Peer } from "../support/fixtures";

/**
 * A group's picture (WISP 9xx § Metadata) between three browsers that never pair: the admin sets it
 * and a member sees it everywhere the group is shown; someone who joins later by the link sees it
 * without the admin doing anything; the admin changes it, then removes it, and everyone follows.
 */
const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const headerPicture = (peer: Peer) => peer.page.getByTestId("group-avatar");
const rowPicture = (peer: Peer) => peer.page.getByTestId("group-row").getByTestId("group-row-avatar");

async function setName(peer: Peer, name: string): Promise<void> {
  await peer.page.getByTestId("account-profile").click();
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

async function join(peer: Peer, url: string): Promise<void> {
  await peer.page.goto(url);
  await expect(groupChat(peer)).toBeVisible({ timeout: 30_000 });
  await expect(groupChat(peer)).toHaveAttribute("data-status", "active", { timeout: 180_000 });
}

/** Opens the members panel, and closes it with its button (a second Escape without a gesture between may be ignored). */
async function openMembers(peer: Peer): Promise<void> {
  await peer.page.getByTestId("group-members").click();
  await expect(peer.page.getByTestId("group-members-dialog")).toBeVisible();
}
async function closeMembers(peer: Peer): Promise<void> {
  const dialog = peer.page.getByTestId("group-members-dialog");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
}

/** A PNG drawn in the page: a picture file as someone would pick it (not square, bigger than what is sent). */
async function pictureFile(peer: Peer, color: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const dataUrl = await peer.page.evaluate((fill) => {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 200;
    const context = canvas.getContext("2d")!;
    context.fillStyle = fill; context.fillRect(0, 0, 320, 200);
    context.fillStyle = "#fff"; context.fillRect(140, 80, 40, 40);
    return canvas.toDataURL("image/png");
  }, color);
  return { name: `${color}.png`, mimeType: "image/png", buffer: Buffer.from(dataUrl.split(",")[1], "base64") };
}

/** The picture a peer shows for the group in the header, the chat list and the members panel: the same one. */
async function shows(peer: Peer, picture: string | null): Promise<void> {
  const state = picture ? "set" : "none";
  await expect(headerPicture(peer)).toHaveAttribute("data-picture", state, { timeout: 120_000 });
  await expect(rowPicture(peer)).toHaveAttribute("data-picture", state);
  if (picture) {
    await expect(headerPicture(peer).locator("img")).toHaveAttribute("src", picture);
    await expect(rowPicture(peer).locator("img")).toHaveAttribute("src", picture);
  }
  await openMembers(peer);
  await expect(peer.page.getByTestId("group-members-avatar")).toHaveAttribute("data-picture", state);
  await closeMembers(peer);
}

test("three people: the admin sets the group's picture, a late joiner by link sees it, it changes and goes for everyone", { tag: ["@feature:groups.picture.set", "@feature:groups.picture.late-joiner"] }, async ({ peer }) => {
  test.setTimeout(12 * 60_000);
  const [alice, bob, carol] = await Promise.all(["alice", "bob", "carol"].map(name => peer(name)));
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob"), setName(carol, "Carol")]);

  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Book club");
  await alice.page.getByTestId("new-group-create").click();
  const share = alice.page.getByTestId("group-share-dialog");
  const url = await share.getByTestId("group-link-url").inputValue();
  await expect(share.getByTestId("group-share-avatar")).toHaveAttribute("data-picture", "none");
  await share.getByTestId("group-share-done").click();
  await expect(headerPicture(alice)).toHaveAttribute("data-picture", "none");

  await join(bob, url);
  await expect(bob.page.getByTestId("group-members")).toContainText("2 members", { timeout: 120_000 });
  // Only the admin may change it.
  await openMembers(bob);
  await expect(bob.page.getByTestId("group-picture-input")).toHaveCount(0);
  await closeMembers(bob);

  // Alice picks a picture: cropped square and made small before anything leaves her app.
  await openMembers(alice);
  await alice.page.getByTestId("group-picture-input").setInputFiles(await pictureFile(alice, "#c0392b"));
  await expect(alice.page.getByTestId("group-members-avatar")).toHaveAttribute("data-picture", "set");
  await closeMembers(alice);
  const first = await headerPicture(alice).locator("img").getAttribute("src");
  expect(first).toMatch(/^data:image\/jpeg;base64,/);
  expect(first!.length).toBeLessThan(40_000);
  await shows(alice, first);
  await shows(bob, first);
  await expect(bob.page.getByTestId("group-event").filter({ hasText: "Alice changed the group's picture" })).toBeVisible();

  // Carol joins later by the link and sees it; nobody had to set it again.
  await join(carol, url);
  await shows(carol, first);
  // The share screen shows it too.
  await carol.page.getByTestId("group-share").click();
  await expect(carol.page.getByTestId("group-share-dialog").getByTestId("group-share-avatar").locator("img")).toHaveAttribute("src", first!);
  await carol.page.getByTestId("group-share-dialog").getByTestId("group-share-done").click();

  // A new picture replaces it for everyone.
  await openMembers(alice);
  await alice.page.getByTestId("group-picture-input").setInputFiles(await pictureFile(alice, "#2471a3"));
  await expect(alice.page.getByTestId("group-members-avatar").locator("img")).not.toHaveAttribute("src", first!);
  await closeMembers(alice);
  const second = await headerPicture(alice).locator("img").getAttribute("src");
  await shows(bob, second);
  await shows(carol, second);

  // Removed: everyone is back to the group glyph.
  await openMembers(alice);
  await alice.page.getByTestId("group-picture-remove").click();
  await expect(alice.page.getByTestId("group-members-avatar")).toHaveAttribute("data-picture", "none");
  await closeMembers(alice);
  await shows(alice, null);
  await shows(bob, null);
  await shows(carol, null);
  // Carol may reach Alice only through a hub, and in a community names travel with messages: whoever it names, the line is there.
  await expect(carol.page.getByTestId("group-event").filter({ hasText: /removed the group's picture$/ })).toBeVisible();
});
