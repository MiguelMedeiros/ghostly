import type { Page } from "@playwright/test";
import { chat, connect, expect, link, say, test } from "../support/fixtures";

// Checking other profiles for new messages (WISP 04 § Checking other profiles): while Work runs, a contact writes to
// Personal, which is not running. Work sees it waiting and says "New"; one tap opens Personal, which fetches it itself.

const switcher = (page: Page) => page.getByTestId("profile-switcher");
const item = (page: Page, name: string) => switcher(page).getByTestId("profile-switcher-item").filter({ hasText: name });
const profileIs = async (page: Page, name: string) => {
  await expect(page.getByTestId("account-profile")).toHaveAttribute("title", new RegExp(`: ${name}$`), { timeout: 30_000 });
};

test("a message for a profile that is not running shows as New, and one tap opens it", { tag: ["@feature:profiles.peek", "@feature:profiles.switcher"] }, async ({ peer }) => {
  const alice = await peer("peek-alice");
  const bob = await peer("peek-bob");
  const { page } = alice;
  // Looks every few seconds instead of every few minutes.
  await page.addInitScript(() => localStorage.setItem("ghostly-test-peek-ms", "5000"));

  // Personal has a chat with bob.
  await link(alice, bob);
  await connect(alice, bob);

  // Work: a new profile. On the web, checking the others is off until turned on.
  await page.getByTestId("account-profile").click();
  await switcher(page).getByTestId("profile-switcher-add").click();
  await page.getByTestId("profile-new-name").fill("Work");
  await page.getByTestId("profile-create").click();
  await profileIs(page, "Work");
  await page.getByTestId("account-settings").click();
  const check = page.getByTestId("settings-profile-peek");
  await expect(check).not.toBeChecked();
  await expect(page.getByTestId("settings-profile-peek-notify")).toHaveCount(0);
  await check.click();
  await expect(check).toBeChecked();
  await expect(page.getByTestId("settings-profile-peek-notify")).not.toBeChecked();

  // Personal is not running: bob's text waits in his DHT mailbox for it.
  await say(bob, "while you were away");
  await expect(page.getByTestId("account-profile-others-new")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("account-profile")).toHaveAccessibleName(/new messages in another profile/);
  await page.getByTestId("account-profile").click();
  await expect(item(page, "Personal").getByTestId("profile-switcher-new")).toHaveText("New");
  await expect(item(page, "Personal")).toHaveAccessibleName(/^Switch to Personal, new messages/);

  // One tap: Personal runs, fetches the text itself, and has nothing marked New any more.
  await item(page, "Personal").click();
  await profileIs(page, "Personal");
  await expect(page.getByTestId("profile-switch-splash")).toHaveCount(0, { timeout: 15_000 });
  await page.locator("div.group").filter({ has: page.getByTitle("Delete chat") }).first().click();
  await expect(chat(alice).getByText("while you were away")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("account-profile-others-new")).toHaveCount(0);
});
