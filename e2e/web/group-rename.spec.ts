import { expect, openProfilePage, test, type Peer } from "../support/fixtures";

/**
 * A group's name (WISP 9xx § Metadata) between three browsers that never pair: only the admin may
 * rename it; the admin sets a picture and renames the group, and a member sees the new name in the
 * chat list, the header and the members panel with the picture kept; someone who joins later by the
 * link sees the new name; removing the picture keeps the name.
 */
const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const headerPicture = (peer: Peer) => peer.page.getByTestId("group-avatar");

async function setName(peer: Peer, name: string): Promise<void> {
  await openProfilePage(peer.page);
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

async function openMembers(peer: Peer): Promise<void> {
  await peer.page.getByTestId("group-members").click();
  await expect(peer.page.getByTestId("group-members-dialog")).toBeVisible();
}
async function closeMembers(peer: Peer): Promise<void> {
  const dialog = peer.page.getByTestId("group-members-dialog");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
}

/** A PNG drawn in the page, as someone would pick it. */
async function pictureFile(peer: Peer): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const dataUrl = await peer.page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 200; canvas.height = 200;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#27ae60"; context.fillRect(0, 0, 200, 200);
    return canvas.toDataURL("image/png");
  });
  return { name: "green.png", mimeType: "image/png", buffer: Buffer.from(dataUrl.split(",")[1], "base64") };
}

/** The name a peer shows for the group in the header, the chat list and the members panel: the same one. */
async function shows(peer: Peer, name: string): Promise<void> {
  await expect(peer.page.getByTestId("group-name")).toHaveText(name, { timeout: 120_000 });
  await expect(peer.page.getByTestId("group-row")).toContainText(name);
  await openMembers(peer);
  await expect(peer.page.getByTestId("group-members-name")).toHaveText(name);
  await closeMembers(peer);
}

test("three people: only the admin renames the group, everyone sees the new name with the picture kept, a late joiner by link too", { tag: ["@feature:groups.rename"] }, async ({ peer }) => {
  test.setTimeout(12 * 60_000);
  const [alice, bob, carol] = await Promise.all(["alice", "bob", "carol"].map(name => peer(name)));
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob"), setName(carol, "Carol")]);

  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Book club");
  await alice.page.getByTestId("new-group-create").click();
  const share = alice.page.getByTestId("group-share-dialog");
  const url = await share.getByTestId("group-link-url").inputValue();
  await share.getByTestId("group-share-done").click();

  await join(bob, url);
  await expect(bob.page.getByTestId("group-members")).toContainText("2 members", { timeout: 120_000 });
  await shows(bob, "Book club");
  // Only the admin may rename it.
  await openMembers(bob);
  await expect(bob.page.getByTestId("group-rename")).toHaveCount(0);
  await closeMembers(bob);

  // Alice sets a picture, then renames the group: spaces around and between words are cleaned up.
  await openMembers(alice);
  await alice.page.getByTestId("group-picture-input").setInputFiles(await pictureFile(alice));
  await expect(alice.page.getByTestId("group-members-avatar")).toHaveAttribute("data-picture", "set");
  await alice.page.getByTestId("group-rename").click();
  await alice.page.getByTestId("group-rename-input").fill("  Reading   circle ");
  await alice.page.getByTestId("group-rename-input").press("Enter");
  await expect(alice.page.getByTestId("group-members-name")).toHaveText("Reading circle");
  await closeMembers(alice);
  await shows(alice, "Reading circle");

  await shows(bob, "Reading circle");
  await expect(headerPicture(bob)).toHaveAttribute("data-picture", "set");
  await expect(bob.page.getByTestId("group-event").filter({ hasText: "Alice renamed the group to “Reading circle”" })).toBeVisible();

  // Carol joins later by the link and sees the new name; nobody renamed it again.
  await join(carol, url);
  await shows(carol, "Reading circle");
  await expect(headerPicture(carol)).toHaveAttribute("data-picture", "set", { timeout: 120_000 });
  // Named and pictured before she got in: no line tells her Alice just renamed it or changed its picture.
  await expect(carol.page.getByTestId("group-event").filter({ hasText: /renamed the group|changed the group's picture/ })).toHaveCount(0);

  // The picture goes; the name stays. Alice changes it once she has Carol's admission: a change sealed under the epoch
  // before it reaches Carol only on a later sync.
  await expect(alice.page.getByTestId("group-members")).toContainText("3 members", { timeout: 120_000 });
  await openMembers(alice);
  await alice.page.getByTestId("group-picture-remove").click();
  await expect(alice.page.getByTestId("group-members-avatar")).toHaveAttribute("data-picture", "none");
  await closeMembers(alice);
  await expect(headerPicture(bob)).toHaveAttribute("data-picture", "none", { timeout: 120_000 });
  await shows(bob, "Reading circle");
  await expect(headerPicture(carol)).toHaveAttribute("data-picture", "none", { timeout: 120_000 });
  await shows(carol, "Reading circle");
});
