import { chat, connect, expect, link, say, test } from "../support/fixtures";

test("on a phone: tabs for chats, wallet, sharing and settings, and Profile through Settings", { tag: ["@feature:app.mobile-layout"] }, async ({ peer }) => {
  const { page } = await peer("alice", { mobile: true });
  const tabs = page.getByTestId("mobile-tabs");
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole("button", { name: "Chats" })).toHaveAttribute("aria-current", "page");

  await tabs.getByRole("button", { name: "Wallets" }).click();
  await expect(page).toHaveURL(/#\/wallet$/);
  await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible();
  await expect(page.getByTestId("wallet")).toBeVisible();

  await tabs.getByRole("button", { name: "Services" }).click();
  await expect(page.getByTestId("my-services")).toBeVisible();

  await tabs.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  // No account bar and no Profile tab: Settings' Profile section leads there, showing the active profile.
  await expect(page.getByTestId("account-bar")).toHaveCount(0);
  const profileLink = page.getByTestId("settings-profile-link");
  await expect(profileLink).toContainText("Name, picture, backups and other profiles");
  await profileLink.click();
  await expect(page).toHaveURL(/#\/profile$/);
  await expect(page.getByTestId("profile-page")).toBeVisible();
  await page.getByTestId("profile-name").fill("Pocket");
  await page.getByTestId("profile-name").press("Enter");
  await tabs.getByRole("button", { name: "Settings" }).click();
  await expect(profileLink).toContainText("Pocket");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await tabs.getByRole("button", { name: "Chats" }).click();
  await expect(page.getByPlaceholder("Search chats...")).toBeVisible();
  // Nothing sticks out sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("on a phone: a chat is a screen of its own", { tag: ["@feature:app.mobile-layout", "@feature:chat.paired.send"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice", { mobile: true }), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  await expect(alice.page.getByTestId("mobile-tabs")).toHaveCount(0);

  // The composer keeps the less used buttons behind "More".
  await expect(alice.page.getByTitle("Send a file")).toBeHidden();
  await alice.page.getByTestId("composer-more").click();
  await expect(alice.page.getByTitle("Send a file")).toBeVisible();
  await expect(alice.page.getByTitle("GIF")).toBeVisible();

  await say(bob, "boo on the small screen");
  await expect(chat(alice).getByText("boo on the small screen")).toBeVisible();

  await alice.page.getByTestId("chat-back").click();
  await expect(alice.page.getByTestId("mobile-tabs")).toBeVisible();
  await expect(alice.page.getByText("boo on the small screen")).toBeVisible();
});

test("on a wide screen the wallet and services are pages beside the list", { tag: ["@feature:app.navigation", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await expect(page.getByTestId("mobile-tabs")).toHaveCount(0);
  await page.getByTestId("wallet-chip").click();
  await expect(page).toHaveURL(/#\/wallet$/);
  await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible();
  await page.getByTestId("account-services").click();
  await expect(page).toHaveURL(/#\/services$/);
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
  // The old phone route still lands on the page.
  await page.goto("/#/share");
  await expect(page).toHaveURL(/#\/services$/);
});
