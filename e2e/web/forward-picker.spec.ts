import { expect, test } from "../support/fixtures";

/**
 * The Forward dialog's list of chats, on a phone. A contact with no name or picture yet shows a pattern of their key
 * (an identicon): it stays in its 36px circle, never over the dialog. The list is as tall as its rows: in WebKit a
 * list with a basis of 0 in a dialog as tall as its content had no height at all (seen on the iOS Simulator; this
 * suite runs Chromium, where the list had its rows either way).
 */
test("Forward on a phone: the chats to pick are listed, each picture in its circle", { tag: ["@feature:chat.forward", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const { page } = await peer("alice", { mobile: true, viewport: { width: 390, height: 844 } });
  await page.getByTitle("New Chat").click();
  const input = page.getByPlaceholder("Message…");
  await input.fill("to pass on");
  await input.press("Enter");
  await page.getByTestId("message-options").first().click();
  await page.getByTestId("message-forward").click();

  const dialog = page.getByTestId("forward-dialog");
  const row = dialog.getByTestId("forward-target").first();
  await expect(row).toBeVisible();
  const list = (await row.boundingBox())!;
  expect(list.height).toBeGreaterThan(40);

  const picture = row.getByTestId("identicon");
  await expect(picture).toBeVisible();
  const box = (await picture.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(37);
  expect(box.height).toBeLessThanOrEqual(37);
  // Picking the chat is not hidden under anything.
  await row.click();
  await expect(row).toHaveAttribute("aria-checked", "true");
});
