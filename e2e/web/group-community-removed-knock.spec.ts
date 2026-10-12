import { expect, test, type Peer } from "../support/fixtures";

/**
 * Removed from a community, then the group's link opened again while no member's app is open: the history kept on the
 * device stays readable under a line that says it waits, and Cancel joining only stops asking. The join card used to
 * cover the history for as long as nobody answered, and Cancel joining deleted the group and its history. Once a member
 * is back, the link lets the person in again, with what they had.
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

test("removed from a community, knocking again with nobody there keeps the history, and Cancel joining keeps the group", { tag: ["@feature:groups.community.remove", "@feature:groups.community.join"] }, async ({ peer }, testInfo) => {
  test.setTimeout(10 * 60_000);
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

  await bob.page.goto(url);
  await expect(groupChat(bob)).toHaveAttribute("data-status", "active", { timeout: 120_000 });
  await expect(bob.page.getByTestId("group-members")).toContainText("2 members · connected", { timeout: 120_000 });
  await say(bob, "said while a member");
  await say(alice, "answered him");
  await sees(bob, "answered him");
  await sees(alice, "said while a member");

  // Alice removes Bob, who is told; then her app closes: nobody is at the door.
  await alice.page.getByTestId("group-members").click();
  await alice.page.getByTestId("group-member").filter({ hasText: "Bob" }).getByTestId("group-remove-member").click();
  await alice.page.getByTestId("group-remove-confirm").click();
  await expect(alice.page.getByTestId("group-member")).toHaveCount(1);
  await alice.page.keyboard.press("Escape");
  await expect(groupChat(bob)).toHaveAttribute("data-status", "removed", { timeout: 120_000 });
  const notice = bob.page.getByTestId("group-notice");
  await expect(notice).toHaveText("You were removed. Open the group's link to join again.");
  const aliceUrl = alice.page.url();
  await alice.page.close();

  // Bob opens the link: he waits, with what he kept still in the page, and no card over it.
  // (Which of the join's lines it reads depends on what the door's records still say: the way to stop is what tells it.)
  await bob.page.goto(url);
  const cancel = notice.getByTestId("group-rejoin-cancel");
  await expect(cancel).toBeVisible({ timeout: 60_000 });
  await expect(notice).not.toContainText("Open the group's link to join again");
  await expect(groupChat(bob)).toHaveAttribute("data-status", "removed");
  await expect(bob.page.getByTestId("group-joining")).toHaveCount(0);
  await sees(bob, "said while a member");
  await sees(bob, "answered him");
  await expect(bob.page.getByPlaceholder("Message…")).toBeDisabled();

  // On a phone the line and its button fit the screen: nothing wider than it, the button a full touch target.
  const desktop = bob.page.viewportSize()!;
  await bob.page.setViewportSize({ width: 375, height: 720 });
  await expect(cancel).toBeVisible();
  const box = (await cancel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await bob.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await sees(bob, "said while a member");
  await testInfo.attach("knocking-again-375", { body: await bob.page.screenshot(), contentType: "image/png" });
  await bob.page.setViewportSize(desktop);
  await testInfo.attach("knocking-again-desktop", { body: await bob.page.screenshot(), contentType: "image/png" });

  // Still waiting a while later (nobody answers), then he gives up: the group is as it was before he opened the link.
  await bob.page.waitForTimeout(20_000);
  await expect(groupChat(bob)).toHaveAttribute("data-status", "removed");
  await cancel.click();
  await expect(notice).toHaveText("You were removed. Open the group's link to join again.", { timeout: 30_000 });
  await expect(groupChat(bob)).toHaveAttribute("data-status", "removed");
  await sees(bob, "said while a member");
  await expect(bob.page.getByTestId("sidebar").getByTestId("group-row")).toHaveCount(1);
  // A reload: the knock did not come back, and the history is still there.
  await bob.page.reload();
  await expect(groupChat(bob)).toHaveAttribute("data-status", "removed", { timeout: 60_000 });
  await expect(notice).toHaveText("You were removed. Open the group's link to join again.");
  await sees(bob, "said while a member");

  // Alice's app opens again; the link lets Bob in, and he still has what he had.
  alice.page = await alice.context.newPage();
  await alice.page.goto(aliceUrl);
  await expect(groupChat(alice)).toHaveAttribute("data-status", "active", { timeout: 60_000 });
  await bob.page.goto(url);
  await expect(groupChat(bob)).toHaveAttribute("data-status", "active", { timeout: 180_000 });
  await sees(bob, "said while a member");
  await say(bob, "back in");
  await sees(alice, "back in");
});
