import { expect, openProfilePage, test, type Peer } from "../support/fixtures";

/**
 * The group header's connection control (WISP 902 § Mesh): an icon summing up the edges, and a popover
 * listing each member's — reachable over WebRTC, or not, and since when. It follows a member who goes
 * away, comes back, and leaves.
 */
const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const trigger = (peer: Peer) => peer.page.getByTestId("group-connection-options");
const row = (peer: Peer, name: string) => peer.page.getByTestId("group-connection-member").filter({ hasText: name });

async function setName(peer: Peer, name: string): Promise<void> {
  await openProfilePage(peer.page);
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
  // A private group (group-mesh/1): this spec is about its member-to-member edges.
  await alice.page.getByTestId("new-group-kind-mesh").click();
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
  // Her edge was live: the app reconnects it by itself, and says so.
  await expect(trigger(alice)).toHaveAttribute("aria-label", /^Group connection: 1 of 2 reachable( · Reconnecting…)?$/);
  await popover(alice);
  await expect(row(alice, "Carol")).not.toHaveAttribute("data-state", "open");
  // Reconnecting, or, when the relay pushes back while her app is gone, a connection issue that says why: never "Connected".
  await expect(row(alice, "Carol").getByTestId("group-connection-member-status")).toHaveText(/^(Reconnecting…( · attempt \d+)?|Connection issue · last seen (just now|\d+ min ago))$/);
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

/** Ghostly's own online switch, from the group: off closes every link, as a phone that lost its network. */
async function setOnline(p: Peer, online: boolean): Promise<void> {
  await p.page.getByTestId("account-services").click();
  const toggle = p.page.getByTestId("online-toggle");
  if ((await toggle.getAttribute("aria-checked")) !== String(online)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(online));
  await p.page.goBack();
  await expect(groupChat(p)).toBeVisible();
}

test("a member who drops and comes back is reconnected by itself: the header says Reconnecting…, and nobody taps anything", { tag: ["@feature:groups.connection.auto-reconnect"] }, async ({ peer }) => {
  test.setTimeout(6 * 60_000);
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob")]);
  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Back");
  await alice.page.getByTestId("new-group-kind-mesh").click();
  await alice.page.getByTestId("new-group-create").click();
  const url = await alice.page.getByTestId("group-share-dialog").getByTestId("group-link-url").inputValue();
  await alice.page.getByTestId("group-share-done").click();
  await bob.page.goto(url);
  await expect(groupChat(bob)).toHaveAttribute("data-status", "active", { timeout: 120_000 });
  for (const p of [alice, bob]) await expect(trigger(p)).toHaveAttribute("data-state", "connected", { timeout: 120_000 });

  // Bob's app loses its network: Alice's edge to him was live, so hers reconnects by itself and says so.
  await setOnline(bob, false);
  await expect(trigger(alice)).toHaveAttribute("aria-label", "Group connection: Reconnecting…", { timeout: 120_000 });
  await expect(trigger(alice)).toHaveAttribute("data-reconnecting", "1");
  await popover(alice);
  await expect(row(alice, "Bob").getByTestId("group-connection-member-status")).toHaveText(/^Reconnecting…( · attempt \d+)?$/);
  // A way to skip the wait is there, as a secondary action; this test never takes it.
  await expect(row(alice, "Bob").getByRole("button", { name: "Retry now" })).toBeVisible();
  await alice.page.keyboard.press("Escape");

  // He is back: the group is live again on both sides, with no tap.
  await setOnline(bob, true);
  for (const p of [alice, bob]) await expect(trigger(p)).toHaveAttribute("data-state", "connected", { timeout: 180_000 });
  await expect(trigger(alice)).not.toHaveAttribute("data-reconnecting");
  await bob.page.getByPlaceholder("Message…").fill("back without a tap");
  await bob.page.getByPlaceholder("Message…").press("Enter");
  await expect(groupChat(alice).getByText("back without a tap")).toBeVisible({ timeout: 60_000 });
});

test("in Arabic on a wide screen the group's connection panel and its tooltip open inside the window", { tag: ["@feature:groups.connection", "@feature:app.i18n"] }, async ({ peer }) => {
  const alice = await peer("alice");
  await alice.page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language: "ar" }));
  });
  await alice.page.reload();
  await expect(alice.page.locator("html")).toHaveAttribute("dir", "rtl");
  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Mesh");
  await alice.page.getByTestId("new-group-create").click();
  await alice.page.getByTestId("group-share-done").click();

  // Right to left, the control sits at the header's left: a box held by its right edge grew past the window's left
  // edge (the panel started at x -123 at 1280 px), cutting its first lines.
  const inside = (box: { x: number; width: number } | null) => !!box && box.x >= 0 && box.x + box.width <= 1280;
  await trigger(alice).hover();
  const tip = alice.page.getByTestId("group-connection-tooltip");
  await expect(tip).toBeVisible();
  expect(inside(await tip.boundingBox())).toBe(true);
  await trigger(alice).click();
  const panel = alice.page.getByRole("dialog").filter({ has: alice.page.getByTestId("group-connection-state") });
  await expect(panel).toBeVisible();
  await expect.poll(async () => inside(await panel.boundingBox())).toBe(true);
});
