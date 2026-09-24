import { expect, test, type Peer } from "../support/fixtures";

/**
 * The group header's connection control (WISP 9xx § Mesh): an icon summing up the edges, and a popover
 * listing each member's — reachable over WebRTC, or not, and since when. It follows a member who goes
 * away, comes back, and leaves.
 */
const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const trigger = (peer: Peer) => peer.page.getByTestId("group-connection-options");
const row = (peer: Peer, name: string) => peer.page.getByTestId("group-connection-member").filter({ hasText: name });

async function setName(peer: Peer, name: string): Promise<void> {
  await peer.page.getByTestId("account-profile").click();
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

/** Opens the popover if it is closed. */
async function popover(peer: Peer): Promise<void> {
  if ((await trigger(peer).getAttribute("aria-expanded")) !== "true") await trigger(peer).click();
  await expect(peer.page.getByRole("dialog", { name: "Group connection" })).toBeVisible();
}

test("the group's connection: every member's edge, down when one goes away, gone when one leaves", { tag: ["@feature:groups.connection"] }, async ({ peer }) => {
  test.setTimeout(8 * 60_000);
  const [alice, bob, carol] = await Promise.all([peer("alice"), peer("bob"), peer("carol")]);
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob"), setName(carol, "Carol")]);

  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Mesh");
  await alice.page.getByTestId("new-group-create").click();
  const url = await alice.page.getByTestId("group-share-dialog").getByTestId("group-link-url").inputValue();
  await alice.page.getByTestId("group-share-done").click();
  // Alone, the control says so.
  await expect(trigger(alice)).toHaveAttribute("aria-label", "Group connection: Only you so far");
  for (const p of [bob, carol]) {
    await p.page.goto(url);
    await expect(groupChat(p)).toHaveAttribute("data-status", "active", { timeout: 120_000 });
  }

  // Everyone reaches everyone, over WebRTC, and the popover says so member by member.
  for (const p of [alice, bob, carol]) await expect(trigger(p)).toHaveAttribute("data-state", "connected", { timeout: 120_000 });
  await popover(alice);
  await expect(alice.page.getByTestId("group-connection-state")).toHaveText("2 of 2 reachable");
  for (const name of ["Bob", "Carol"]) {
    await expect(row(alice, name)).toHaveAttribute("data-state", "open");
    await expect(row(alice, name).getByTestId("group-connection-member-status")).toHaveText("Connected · WebRTC");
  }
  await expect(alice.page.getByTestId("group-connection-note")).toContainText("not offered in groups yet");
  await alice.page.keyboard.press("Escape");
  // The members panel carries the same line for each member.
  await carol.page.getByTestId("group-members").click();
  await expect(carol.page.getByTestId("group-member").filter({ hasText: "Alice" }).getByTestId("group-member-status")).toHaveText("Connected · WebRTC");
  await carol.page.keyboard.press("Escape");

  // Carol goes away: her edge goes down on the others, honestly, with when she was last there.
  const carolGroup = carol.page.url();
  await carol.page.close();
  await expect(trigger(alice)).toHaveAttribute("data-state", "partial", { timeout: 120_000 });
  await expect(trigger(alice)).toHaveAttribute("aria-label", "Group connection: 1 of 2 reachable");
  await popover(alice);
  await expect(row(alice, "Carol")).not.toHaveAttribute("data-state", "open");
  // Away, or, when the relay pushes back while her app is gone, a connection issue that says why: never "Connected".
  await expect(row(alice, "Carol").getByTestId("group-connection-member-status")).toHaveText(/^((Not reachable|Connection issue) · last seen (just now|\d+ min ago)|Connecting…)$/);
  await expect(row(alice, "Bob").getByTestId("group-connection-member-status")).toHaveText("Connected · WebRTC");
  await alice.page.keyboard.press("Escape");

  // She comes back: reachable again.
  carol.page = await carol.context.newPage();
  await carol.page.goto(carolGroup);
  await expect(groupChat(carol)).toHaveAttribute("data-status", "active", { timeout: 60_000 });
  await expect(trigger(alice)).toHaveAttribute("data-state", "connected", { timeout: 120_000 });

  // She leaves: she is no longer a member, so no longer an edge anyone lists.
  await carol.page.getByTestId("group-options").click();
  await carol.page.getByTestId("group-leave").click();
  await carol.page.getByTestId("group-leave-confirm").click();
  await expect(groupChat(carol)).toHaveCount(0);
  for (const p of [alice, bob]) {
    await expect(trigger(p)).toHaveAttribute("aria-label", "Group connection: 1 of 1 reachable", { timeout: 120_000 });
    await popover(p);
    await expect(row(p, "Carol")).toHaveCount(0);
    await expect(p.page.getByTestId("group-connection-member")).toHaveCount(1);
  }
});
