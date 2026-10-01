import type { Page } from "@playwright/test";
import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

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

/** Work, a new profile of alice's device, with checking the others turned on. */
async function workWithPeek(page: Page): Promise<void> {
  await page.getByTestId("account-profile").click();
  await switcher(page).getByTestId("profile-switcher-add").click();
  await page.getByTestId("profile-new-name").fill("Work");
  await page.getByTestId("profile-create").click();
  await profileIs(page, "Work");
  await page.getByTestId("account-settings").click();
  await page.getByTestId("settings-profile-peek").click();
  await expect(page.getByTestId("settings-profile-peek")).toBeChecked();
}

test("a community group's new message for a profile that is not running shows as New, from the beacon's head", { tag: ["@feature:profiles.peek", "@feature:groups.community.head"] }, async ({ peer }) => {
  test.setTimeout(6 * 60_000);
  const [alice, bob] = await Promise.all(["alice", "bob"].map((name) => peer(`peek-group-${name}`))) as [Peer, Peer];
  const { page } = alice;
  await page.addInitScript(() => localStorage.setItem("ghostly-test-peek-ms", "5000"));

  // Personal (alice) makes a community group; bob joins by its link.
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  await page.getByTestId("new-group-name").fill("Open plaza");
  await page.getByTestId("new-group-create").click();
  const share = page.getByTestId("group-share-dialog");
  const url = await share.getByTestId("group-link-url").inputValue();
  await share.getByTestId("group-share-done").click();
  await bob.page.goto(url);
  await expect(bob.page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 180_000 });
  await say(bob, "hi from bob");
  await expect(page.locator(".chat-wallpaper").getByText("hi from bob")).toBeVisible({ timeout: 120_000 });

  // Alice goes to Work: Personal is not running, and bob, alone, is the group's hub.
  await workWithPeek(page);
  // Two looks in: the head names "hi from bob", which Personal took. Nothing new.
  await page.waitForTimeout(12_000);
  await expect(page.getByTestId("account-profile-others-new")).toHaveCount(0);
  await say(bob, "while you were away");
  // Bob's hub republishes the beacon within 30 s with the newest frame it holds.
  await expect(page.getByTestId("account-profile-others-new")).toBeVisible({ timeout: 120_000 });
  await page.getByTestId("account-profile").click();
  await expect(item(page, "Personal").getByTestId("profile-switcher-new")).toHaveText("New");

  // One tap: Personal runs and is caught up by bob.
  await item(page, "Personal").click();
  await profileIs(page, "Personal");
  await expect(page.getByTestId("profile-switch-splash")).toHaveCount(0, { timeout: 15_000 });
  await page.getByText("Open plaza").first().click();
  await expect(page.locator(".chat-wallpaper").getByText("while you were away")).toBeVisible({ timeout: 120_000 });
});
