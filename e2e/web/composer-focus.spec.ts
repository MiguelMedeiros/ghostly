import { chat, connect, expect, link, test } from "../support/fixtures";

/**
 * After Enter the caret stays in the composer, so the next message can be typed at once. A 1:1 chat disables the field
 * while a send goes out, and Chrome takes the focus from a disabled field: the words typed next went nowhere.
 */
test("after a message goes, the next one is typed straight into the composer", { tag: ["@feature:chat.paired.send"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("focus-alice"), peer("focus-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const { page } = alice;
  const box = page.getByPlaceholder("Message…");
  await box.click();
  await page.keyboard.type("first", { delay: 40 });
  await page.keyboard.press("Enter");
  await expect(chat(bob).getByText("first", { exact: true })).toBeVisible();
  // The keyboard, not the locator: a locator would put the focus back itself.
  await page.keyboard.type("second", { delay: 40 });
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("second");
  await page.keyboard.press("Enter");
  await expect(chat(bob).getByText("second", { exact: true })).toBeVisible();
});
