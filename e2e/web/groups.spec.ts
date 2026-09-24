import { expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * A private group (WISP 900, `group-mesh/1`) between four browsers: created by one, joined by two
 * from its contacts, read by everyone; one goes away and is caught up on return; one is removed and
 * reads nothing more; the admin role moves, and the new admin brings in a fourth member.
 */
const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const wallpaper = (peer: Peer) => peer.page.locator(".chat-wallpaper");

async function setName(peer: Peer, name: string): Promise<void> {
  await peer.page.getByTestId("account-profile").click();
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

async function say(peer: Peer, text: string): Promise<void> {
  const box = peer.page.getByPlaceholder("Message…");
  await expect(box).toBeEnabled();
  await box.fill(text);
  await box.press("Enter");
  await expect(wallpaper(peer).getByText(text, { exact: true })).toBeVisible();
}

const sees = (peer: Peer, text: string) => expect(wallpaper(peer).getByText(text, { exact: true })).toBeVisible({ timeout: 90_000 });

/** From the members panel of the admin, invites the contact by name and closes the panel. */
async function invite(admin: Peer, name: string): Promise<void> {
  await admin.page.getByTestId("group-members").click();
  const row = admin.page.getByTestId("group-invite-contact").filter({ hasText: name });
  await expect(row.getByTestId("group-invite")).toBeEnabled({ timeout: 60_000 });
  await row.getByTestId("group-invite").click();
  await expect(row).toContainText("Invited…");
  await admin.page.keyboard.press("Escape");
}

/** Accepts the invitation in the chat list and opens the group. */
async function accept(peer: Peer, groupName: string): Promise<void> {
  const row = peer.page.getByTestId("group-row").filter({ hasText: groupName });
  await row.getByTestId("group-accept").click();
  await expect(row.getByTestId("group-accept")).toHaveCount(0);
  // The welcome turns the invitation into a group with a member count.
  await expect(row).toContainText(/\d+ members?/, { timeout: 60_000 });
  await row.click();
  await expect(groupChat(peer)).toHaveAttribute("data-status", "active", { timeout: 60_000 });
}

/** The header says how many of the other members are reachable over their edges. */
const reachable = (peer: Peer, n: number, of: number) => expect(peer.page.getByTestId("group-members")).toContainText(`${n} of ${of} reachable`, { timeout: 120_000 });

test("four people: create, invite, everyone reads everyone, catch-up, removal, admin change, rotation", async ({ peer }) => {
  test.setTimeout(12 * 60_000);
  const [alice, bob, carol, dave] = await Promise.all([peer("alice"), peer("bob"), peer("carol"), peer("dave")]);
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob"), setName(carol, "Carol"), setName(dave, "Dave")]);
  // Alice knows Bob and Carol; Bob knows Dave. Nobody else knows anybody: the group brings them together.
  await pair(alice, bob);
  await pair(alice, carol);
  await pair(bob, dave);

  // Create.
  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Ghosts");
  await alice.page.getByTestId("new-group-create").click();
  await expect(alice.page.getByTestId("group-name")).toHaveText("Ghosts");
  await expect(alice.page.getByTestId("group-event").first()).toContainText("Group created");
  // The honest note is in the members panel.
  await alice.page.getByTestId("group-members").click();
  await expect(alice.page.getByTestId("group-read-note")).toContainText("cannot read what came before");
  await alice.page.keyboard.press("Escape");

  // Invite two; both accept.
  await invite(alice, "Bob");
  await invite(alice, "Carol");
  await accept(bob, "Ghosts");
  await accept(carol, "Ghosts");
  await expect(alice.page.getByTestId("group-event").filter({ hasText: "Bob joined" })).toBeVisible({ timeout: 60_000 });
  await expect(alice.page.getByTestId("group-event").filter({ hasText: "Carol joined" })).toBeVisible({ timeout: 60_000 });
  // Bob and Carol never paired: their edge comes from the roster alone.
  await reachable(alice, 2, 2);
  await reachable(bob, 2, 2);
  await reachable(carol, 2, 2);

  // Everyone reads everyone.
  await say(alice, "hello from alice");
  await say(bob, "hello from bob");
  await say(carol, "hello from carol");
  for (const p of [alice, bob, carol]) for (const text of ["hello from alice", "hello from bob", "hello from carol"]) await sees(p, text);
  // Sender names come with the messages.
  await expect(wallpaper(alice).getByText("~Bob")).toBeVisible();
  await expect(wallpaper(bob).getByText("~Carol")).toBeVisible();

  // One goes away, misses two messages and a rotation, and is caught up when back.
  const groupUrl = bob.page.url();
  await bob.page.close();
  await reachable(alice, 1, 2);
  await say(alice, "alice while bob is away");
  await say(carol, "carol while bob is away");
  await alice.page.getByTestId("group-options").click();
  await alice.page.getByTestId("group-rotate").click();
  await expect(alice.page.getByTestId("group-event").filter({ hasText: "Keys rotated" })).toBeVisible();
  await say(alice, "after the rotation");
  await sees(carol, "after the rotation");
  bob.page = await bob.context.newPage();
  await bob.page.goto(groupUrl);
  await expect(groupChat(bob)).toBeVisible();
  await sees(bob, "alice while bob is away");
  await sees(bob, "carol while bob is away");
  await sees(bob, "after the rotation");
  await expect(bob.page.getByTestId("group-event").filter({ hasText: "Keys rotated" })).toBeVisible();
  await say(bob, "bob is back");
  await sees(alice, "bob is back");
  await sees(carol, "bob is back");

  // Carol is removed: she is told, and reads nothing sent afterwards.
  await alice.page.getByTestId("group-members").click();
  await alice.page.getByTestId("group-member").filter({ hasText: "Carol" }).getByTestId("group-remove-member").click();
  await expect(alice.page.getByTestId("group-member")).toHaveCount(2);
  await alice.page.keyboard.press("Escape");
  await expect(groupChat(carol)).toHaveAttribute("data-status", "removed", { timeout: 60_000 });
  await expect(carol.page.getByTestId("group-notice")).toContainText("removed");
  await expect(carol.page.getByPlaceholder("Message…")).toBeDisabled();
  await expect(bob.page.getByTestId("group-event").filter({ hasText: "Carol is no longer a member" })).toBeVisible({ timeout: 60_000 });
  await say(alice, "after carol left");
  await say(bob, "just the two of us");
  await sees(bob, "after carol left");
  await sees(alice, "just the two of us");
  await expect(wallpaper(carol).getByText("after carol left")).toHaveCount(0);
  await expect(wallpaper(carol).getByText("just the two of us")).toHaveCount(0);

  // The admin role moves to Bob; Alice can no longer manage members, Bob can, and brings Dave in.
  await alice.page.getByTestId("group-members").click();
  await alice.page.getByTestId("group-member").filter({ hasText: "Bob" }).getByTestId("group-make-admin").click();
  await expect(alice.page.getByTestId("group-member").filter({ hasText: "Bob" })).toHaveAttribute("data-role", "admin");
  await expect(alice.page.getByTestId("group-make-admin")).toHaveCount(0);
  await alice.page.keyboard.press("Escape");
  await expect(bob.page.getByTestId("group-event").filter({ hasText: "You are now the admin" })).toBeVisible({ timeout: 60_000 });
  await invite(bob, "Dave");
  await accept(dave, "Ghosts");
  await reachable(dave, 2, 2);
  await say(dave, "dave here");
  await sees(alice, "dave here");
  await sees(bob, "dave here");
  // Dave joined after everything above: none of it is his to read.
  await expect(wallpaper(dave).getByText("hello from alice")).toHaveCount(0);
  await expect(wallpaper(dave).getByText("just the two of us")).toHaveCount(0);
  await expect(wallpaper(carol).getByText("dave here")).toHaveCount(0);

  // Alice leaves; the two who stay see it.
  await alice.page.getByTestId("group-options").click();
  await alice.page.getByTestId("group-leave").click();
  await alice.page.getByTestId("group-leave-confirm").click();
  // Gone from her list at once, not kept as a dead row.
  await expect(alice.page.getByTestId("group-row")).toHaveCount(0);
  await expect(groupChat(alice)).toHaveCount(0);
  await expect(bob.page.getByTestId("group-event").filter({ hasText: "Alice is no longer a member" })).toBeVisible({ timeout: 60_000 });
  await bob.page.getByTestId("group-members").click();
  await expect(bob.page.getByTestId("group-member")).toHaveCount(2);
  await bob.page.keyboard.press("Escape");
  await say(dave, "still here with bob");
  await sees(bob, "still here with bob");
  await expect(wallpaper(alice).getByText("still here with bob")).toHaveCount(0);
});
