import { expect, test } from "../support/fixtures";

/**
 * Opening a chat on a touch screen leaves the message field for a tap: its focus would bring the keyboard up over
 * the chat before anyone asked. With a mouse the field takes the caret at once, as before. Once the person has
 * tapped it and sent, the field keeps the focus (the keyboard is up by their own doing).
 */
test("a touch screen: opening a chat or a group leaves the keyboard down; a tap on the field, then a send, keeps it", { tag: ["@feature:app.mobile-layout", "@feature:chat.paired.send"] }, async ({ peer }) => {
  const { page } = await peer("alice", { mobile: true, viewport: { width: 390, height: 844 } });
  expect(await page.evaluate(() => matchMedia("(any-pointer: fine)").matches)).toBe(false);

  await page.getByTitle("New Chat").click();
  const input = page.getByPlaceholder("Message…");
  await expect(input).toBeVisible();
  await page.waitForTimeout(300);
  await expect(input).not.toBeFocused();

  // The person's own tap: the field takes the focus, and keeps it after the send.
  await input.tap();
  await expect(input).toBeFocused();
  await input.fill("first");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();

  // A group opens the same way.
  await page.getByTestId("chat-back").click();
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  await page.getByTestId("new-group-name").fill("Quiet");
  await page.getByTestId("new-group-create").click();
  await page.getByTestId("group-share-dialog").getByTestId("group-share-done").click();
  const groupInput = page.getByTestId("group-chat").getByPlaceholder("Message…");
  await expect(groupInput).toBeVisible();
  await page.waitForTimeout(300);
  await expect(groupInput).not.toBeFocused();
});

test("with a mouse: opening a chat puts the caret in the message field, and a send keeps it there", { tag: ["@feature:chat.paired.send"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await page.getByTitle("New Chat").click();
  const input = page.getByPlaceholder("Message…");
  await expect(input).toBeFocused();
  await input.fill("first");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
});
