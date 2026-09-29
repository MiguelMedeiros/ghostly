import { expect, say, test, type Peer } from "../support/fixtures";

/**
 * On a phone the admin's members list names each member beside Make admin and Remove. The key label kept its width
 * and the name gave way, down to nothing: the admin saw a key fragment next to Remove, not who it removes.
 */
async function setName(peer: Peer, name: string): Promise<void> {
  await peer.page.goto("/#/profile");
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goto("/#/");
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

test("on a phone the admin's members list shows each member's name", { tag: ["@feature:groups.remove-member", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const [admin, member] = await Promise.all([peer("names-admin", { mobile: true, viewport: { width: 375, height: 812 } }), peer("names-member")]);
  await setName(member, "Beatriz");
  await admin.page.getByTestId("sidebar-new-more").click();
  await admin.page.getByTestId("new-group").click();
  await admin.page.getByTestId("new-group-name").fill("Book club");
  await admin.page.getByTestId("new-group-create").click();
  const share = admin.page.getByTestId("group-share-dialog");
  const url = await share.getByTestId("group-link-url").inputValue();
  await share.getByTestId("group-share-done").click();
  await member.page.goto(url);
  await expect(member.page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 180_000 });
  await say(member, "hi");
  await expect(admin.page.getByTestId("group-chat").getByText("hi", { exact: true })).toBeVisible({ timeout: 120_000 });

  await admin.page.getByTestId("group-members").click();
  const row = admin.page.getByTestId("group-member").filter({ hasText: "Beatriz" });
  await expect(row.getByTestId("group-remove-member")).toBeVisible();
  // The name itself has room: its box is wide enough for a few letters, not squeezed to nothing.
  await expect.poll(() => row.getByText("Beatriz", { exact: true }).evaluate((name) => Math.round(name.getBoundingClientRect().width))).toBeGreaterThanOrEqual(40);
});
