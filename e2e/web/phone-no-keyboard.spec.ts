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
  // Send tapped rather than Enter: the field keeps the focus, and the keyboard stays up.
  await input.fill("second");
  await page.getByRole("button", { name: "Send message" }).tap();
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

test.describe("a touch screen: the focus as a chat opens", () => {
  // The field waits for a tap, and the row or New that opened the chat is hidden with the list: the focus fell to the
  // page's body. The chat's name takes it, as a Settings section's title does on a phone.
  test("a chat from New chat and from its row, and a group from its row: the focus is on the name at the top, not the page", { tag: ["@feature:app.mobile-layout", "@feature:app.accessibility"] }, async ({ peer }) => {
    const { page } = await peer("alice", { mobile: true, viewport: { width: 375, height: 667 } });
    const input = page.getByPlaceholder("Message…");
    const chatHeading = page.locator("h1", { has: page.getByTestId("chat-name") });
    const onBody = () => page.evaluate(() => document.activeElement === document.body);

    await page.getByTitle("New Chat").click();
    await expect(input).toBeVisible();
    await expect(chatHeading).toBeFocused();
    expect(await onBody()).toBe(false);
    await expect(input).not.toBeFocused();

    await page.getByTestId("chat-back").click();
    await page.getByTestId("chat-row").first().click();
    await expect(input).toBeVisible();
    await expect(chatHeading).toBeFocused();
    await expect(input).not.toBeFocused();

    await page.getByTestId("chat-back").click();
    await page.getByTestId("sidebar-new-more").click();
    await page.getByTestId("new-group").click();
    await page.getByTestId("new-group-name").fill("Quiet");
    await page.getByTestId("new-group-create").click();
    await page.getByTestId("group-share-dialog").getByTestId("group-share-done").click();
    await page.getByTestId("group-chat").getByTestId("chat-back").click();
    await page.getByTestId("group-row").filter({ hasText: "Quiet" }).click();
    const groupInput = page.getByTestId("group-chat").getByPlaceholder("Message…");
    await expect(groupInput).toBeVisible();
    await expect(page.getByTestId("group-name")).toBeFocused();
    await expect(groupInput).not.toBeFocused();
  });
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
