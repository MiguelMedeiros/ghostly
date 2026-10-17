import { expect, link, test } from "../support/fixtures";

/**
 * The admin's members dialog from the keyboard: after each action the focus is somewhere in the dialog that says what
 * happened, never on the page. A rename (saved or let go) turned its field and Save disabled and then took them away, so
 * Chromium handed the focus to <body>; Remove picture and Invite were disabled while they ran, then went. A screen
 * reader said nothing, and the next Tab started over from the dialog's first control. happy-dom keeps the focus on a
 * disabled button, so only a real browser shows it.
 */
test("the members dialog's Rename, Remove picture and Invite keep the keyboard's focus in the dialog", { tag: ["@feature:groups.rename", "@feature:groups.picture.set", "@feature:groups.invite"] }, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  const { page } = alice;
  await page.goto("/#/");
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  await page.getByTestId("new-group-name").fill("Book club");
  await page.getByTestId("new-group-kind-mesh").click();
  await page.getByTestId("new-group-create").click();
  await page.getByTestId("group-share-dialog").getByTestId("group-share-done").click();
  await page.getByTestId("group-members").click();
  const dialog = page.getByTestId("group-members-dialog");
  const rename = dialog.getByTestId("group-rename"), field = dialog.getByTestId("group-rename-input");

  // Saved with Enter: back on Rename.
  await rename.focus();
  await page.keyboard.press("Enter");
  await expect(field).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" two");
  await page.keyboard.press("Enter");
  await expect(dialog.getByTestId("group-members-name")).toHaveText("Book club two");
  await expect(rename).toBeFocused();
  // Saved with Save, and let go with Escape and with Cancel: back on Rename each time, and the dialog stays.
  await page.keyboard.press("Enter");
  await page.keyboard.press("End");
  await page.keyboard.type(" 3");
  await dialog.getByTestId("group-rename-save").focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByTestId("group-members-name")).toHaveText("Book club two 3");
  await expect(rename).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(rename).toBeFocused();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Enter");
  await dialog.getByTestId("group-rename-cancel").focus();
  await page.keyboard.press("Enter");
  await expect(rename).toBeFocused();

  // Remove picture: on Add picture's control, which stays.
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    canvas.getContext("2d")!.fillRect(0, 0, 64, 64);
    return canvas.toDataURL("image/png");
  });
  await dialog.getByTestId("group-picture-input").setInputFiles({ name: "black.png", mimeType: "image/png", buffer: Buffer.from(png.split(",")[1], "base64") });
  await expect(dialog.getByTestId("group-members-avatar")).toHaveAttribute("data-picture", "set");
  await dialog.getByTestId("group-picture-remove").focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByTestId("group-members-avatar")).toHaveAttribute("data-picture", "none");
  await expect(dialog.getByTestId("group-picture-input")).toBeFocused();

  // Invite: on the contact's row, which now says so.
  const invite = dialog.getByTestId("group-invite");
  await expect(invite).toBeVisible({ timeout: 60_000 });
  await invite.focus();
  await page.keyboard.press("Enter");
  const row = dialog.getByTestId("group-invite-contact");
  await expect(row).toContainText("Invited…", { timeout: 60_000 });
  await expect(row).toBeFocused();
});
