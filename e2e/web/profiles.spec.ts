import { expect, openProfilePage, test } from "../support/fixtures";

// Local profiles (WISP 04): each one keeps its own chats, settings and look, and switching restarts the
// app as the other profile.
test("profiles keep chats and settings apart, each in its own color", { tag: ["@feature:profiles.create", "@feature:profiles.switch", "@feature:profiles.delete", "@feature:profiles.name-optional", "@feature:settings.nickname", "@feature:app.theme"] }, async ({ peer }) => {
  const { page } = await peer("profiles");
  const theme = () => page.evaluate(() => document.documentElement.getAttribute("data-color-theme"));

  // A chat and a name in the first profile.
  await page.getByTitle("New Chat").click();
  await expect(page.getByTestId("invite-card")).toBeVisible();
  await openProfilePage(page);
  await expect(page.getByTestId("profile-page")).toBeVisible();
  await page.getByTestId("profile-name").fill("Pessoal");
  await page.getByTestId("profile-name").press("Enter");
  await expect(page.getByTestId("account-profile")).toHaveAttribute("title", /Pessoal/);
  // The place in the account bar wears the profile's name.
  await expect(page.getByTestId("account-profile").locator(".account-label")).toHaveText("Pessoal");
  await page.getByTestId("account-nickname").fill("Miguel");
  const firstTheme = await theme();
  await expect(page.getByTestId("profile-links")).toContainText("1 chat");

  // A new profile: its own name, a different color, and nothing from the first one.
  await page.getByTestId("profile-new").click();
  await page.getByTestId("profile-new-name").fill("Work");
  await page.getByTestId("profile-create").click();
  await expect(page.getByTestId("profile-name")).toHaveValue("Work", { timeout: 30000 });
  expect(await theme(), "a new profile gets a color of its own").not.toBe(firstTheme);
  await expect(page.getByTestId("profile-links")).toContainText("0 chats");
  await expect(page.getByTestId("account-nickname")).toHaveValue("");
  await expect(page.getByTestId("profile-row")).toHaveCount(2);

  // Changing the look is one click, and stays with this profile.
  await page.getByTestId("profile-theme-monochrome").click();
  await expect.poll(theme).toBe("monochrome");

  // Back to the first profile: its chat, its name and its color return.
  await page.getByTestId("profile-row").filter({ hasText: "Pessoal" }).getByTestId("profile-switch").click();
  await expect(page.getByTestId("profile-name")).toHaveValue("Pessoal", { timeout: 30000 });
  await expect.poll(theme).toBe(firstTheme);
  await expect(page.getByTestId("account-nickname")).toHaveValue("Miguel");
  await expect(page.getByTestId("profile-links")).toContainText("1 chat");

  // And the second one kept its own color.
  await page.getByTestId("profile-row").filter({ hasText: "Work" }).getByTestId("profile-switch").click();
  await expect(page.getByTestId("profile-name")).toHaveValue("Work", { timeout: 30000 });
  await expect.poll(theme).toBe("monochrome");

  // Deleting a profile: never the one in use, and only after typing its name.
  await expect(page.getByTestId("profile-row").filter({ hasText: "Work" }).getByTestId("profile-delete")).toHaveCount(0);
  await page.getByTestId("profile-row").filter({ hasText: "Pessoal" }).getByTestId("profile-switch").click();
  await expect(page.getByTestId("profile-name")).toHaveValue("Pessoal", { timeout: 30000 });
  await expect(page.getByTestId("profile-row").filter({ hasText: "Pessoal" }).getByTestId("profile-delete"), "the first profile stays").toHaveCount(0);
  await page.getByTestId("profile-row").filter({ hasText: "Work" }).getByTestId("profile-delete").click();
  const dialog = page.getByTestId("delete-profile");
  await expect(dialog.getByTestId("delete-profile-summary")).toContainText("0 chats");
  await expect(dialog.getByTestId("delete-profile-go")).toBeDisabled();
  await dialog.getByTestId("delete-profile-confirm").fill("Work");
  await dialog.getByTestId("delete-profile-go").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("profile-row")).toHaveCount(1);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => /^ghostly_[a-z0-9]{10}_/.test(key))), "nothing of Work is left").toEqual([]);
  await expect(page.getByTestId("profile-links")).toContainText("1 chat");
});
