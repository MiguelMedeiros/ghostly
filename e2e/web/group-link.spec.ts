import { expect, openProfilePage, test, type Peer } from "../support/fixtures";
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
  // A private group (group-mesh/1): this spec is about that profile.
  await alice.page.getByTestId("new-group-kind-mesh").click();
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

/**
 * With the admin's app open, a join through the link takes seconds, not a minute: the side of a
 * connection that answers used to leave the offer to its 30 s background poll, on the entry session
 * and again on the edge to the admin, so a join took 5–45 s and reaching the admin 11–143 s (10 runs).
 * Now 6–7 s and 9–12 s (e2e/web/group-join-timing.spec.ts). Two people join, so the old wait, which
 * struck about three joins in five, cannot slip through by luck; the bounds leave room for a busy machine.
 */
const JOIN_BOUND_MS = 12_000;
const REACH_BOUND_MS = 20_000;

/** Every step the joining card shows, in order, however quickly they go by. */
function watchSteps(): void {
  const w = window as unknown as { __stages?: string[] };
  if (w.__stages) return;
  w.__stages = [];
  new MutationObserver(() => {
    const stage = document.querySelector("[data-testid=group-joining-steps]")?.getAttribute("data-stage");
    if (stage && w.__stages!.at(-1) !== stage) w.__stages!.push(stage);
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-stage"] });
}

test("with the admin's app open, joining through the link takes seconds and shows each step", { tag: ["@feature:groups.link.join"] }, async ({ peer }) => {
  test.setTimeout(3 * 60_000);
  const [alice, bob, carol] = await Promise.all([peer("alice"), peer("bob"), peer("carol")]);
  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Quick ghosts");
  // A private group (group-mesh/1): this spec is about that profile.
  await alice.page.getByTestId("new-group-kind-mesh").click();
  await alice.page.getByTestId("new-group-create").click();
  const shareDialog = alice.page.getByTestId("group-share-dialog");
  const url = await shareDialog.getByTestId("group-link-url").inputValue();
  await shareDialog.getByTestId("group-share-done").click();

  for (const [joiner, members] of [[bob, 2], [carol, 3]] as const) {
    await joiner.page.addInitScript(watchSteps);
    await joiner.page.evaluate(watchSteps);
    const started = Date.now();
    await joiner.page.goto(url);
    await expect(groupChat(joiner)).toHaveAttribute("data-status", "active", { timeout: JOIN_BOUND_MS });
    const joined = Date.now() - started;
    // The admin at least: the other members come up at their own pace.
    await expect(joiner.page.getByTestId("group-members")).toContainText(new RegExp(`${members} members · [1-9] of`), { timeout: REACH_BOUND_MS });
    const reached = Date.now() - started;
    console.log(`  ${joiner.name} joined in ${joined} ms, reached the admin in ${reached} ms`);
    expect(joined).toBeLessThan(JOIN_BOUND_MS);
    expect(reached).toBeLessThan(REACH_BOUND_MS);
    // The steps went forward only, and the card said something before the group opened.
    const stages = await joiner.page.evaluate(() => (window as unknown as { __stages: string[] }).__stages);
    const order = ["knocking", "knocked", "answered", "admitted"];
    expect(stages.length).toBeGreaterThan(0);
    expect(stages.map(s => order.indexOf(s))).toEqual(stages.map(s => order.indexOf(s)).sort((a, b) => a - b));
    await expect(alice.page.getByTestId("group-members")).toContainText(`${members} members`);
  }
});
