import { expect, test } from "../support/fixtures";

/**
 * A group's header on a phone: the line under the name (members, and how the group is reached) is cut short with an
 * ellipsis where the header's buttons begin. It used to run on under the connection icon: its width was 60% of the
 * screen, wider than what the buttons leave on a phone. The narrowest phone (320px), where even "1 member ·
 * connecting…" does not fit; wider ones see it with the longer lines ("your app relays for others").
 */
test("on a phone the group's member line stops before the header's buttons", { tag: ["@feature:app.mobile-layout", "@feature:groups.community.create"] }, async ({ peer }) => {
  const { page } = await peer("alice", { mobile: true, viewport: { width: 320, height: 568 } });
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  await page.getByTestId("new-group-name").fill("Phone test");
  await page.getByTestId("new-group-create").click();
  await page.getByTestId("group-share-dialog").getByTestId("group-share-done").click();

  const line = page.getByTestId("group-members");
  await expect(line).toContainText("1 member");
  const buttons = page.getByTestId("group-connection");
  await expect(buttons).toBeVisible();
  const text = (await line.boundingBox())!;
  const first = (await buttons.boundingBox())!;
  expect(text.x + text.width).toBeLessThanOrEqual(first.x);
});

for (const phone of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
  test(`a new group on a ${phone.width}×${phone.height} phone: "Go to the group" is in view without scrolling`, { tag: ["@feature:app.mobile-layout", "@feature:groups.community.create"] }, async ({ peer }) => {
    // The group's ready dialog (QR, link, Share and Copy, the note, the admin's link controls) ran past the screen,
    // and its only way on sat under the fold: in the iOS Simulator an iPhone 17 had to scroll the dialog to reach it.
    const { page } = await peer("alice", { mobile: true, viewport: phone });
    await page.getByTestId("sidebar-new-more").click();
    await page.getByTestId("new-group").click();
    await page.getByTestId("new-group-name").fill("Phone plaza");
    await page.getByTestId("new-group-create").click();
    const dialog = page.getByTestId("group-share-dialog");
    const done = dialog.getByTestId("group-share-done");
    await expect(done).toBeInViewport({ ratio: 1 });
    // Still a QR a phone's camera reads from across a table.
    expect((await dialog.getByTestId("group-link-qr").locator("svg").boundingBox())!.width).toBeGreaterThanOrEqual(140);
    await done.click();
    await expect(dialog).toHaveCount(0);
  });
}
