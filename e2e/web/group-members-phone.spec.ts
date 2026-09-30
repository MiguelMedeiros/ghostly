import { expect, say, test, type Peer } from "../support/fixtures";

/**
 * On a phone the admin's members list names each member beside Make admin and Remove. The key label kept its width
 * and the name gave way, down to nothing: the admin saw a key fragment next to Remove, not who it removes. Then the
 * two buttons still left the name ~7 characters ("Beatriz A…"): they go under it when the row is too narrow.
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
  await setName(member, "Beatriz Albuquerque");
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
  const row = admin.page.getByTestId("group-member").filter({ hasText: "Beatriz Albuquerque" });
  await expect(row.getByTestId("group-remove-member")).toBeVisible();
  await expect(row.getByTestId("group-make-admin")).toBeVisible();
  // The whole name shows: it is not cut short to make room for the buttons.
  const name = row.getByText("Beatriz Albuquerque", { exact: true });
  await expect.poll(() => name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().width >= 100)).toBe(true);
  // The buttons are under it, inside the dialog, and still in reach.
  const [nameBox, removeBox, dialogBox] = await Promise.all([name.boundingBox(), row.getByTestId("group-remove-member").boundingBox(), admin.page.getByTestId("group-members-dialog").boundingBox()]);
  expect(removeBox!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height - 1);
  expect(removeBox!.x + removeBox!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width);});
