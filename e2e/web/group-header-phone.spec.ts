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
