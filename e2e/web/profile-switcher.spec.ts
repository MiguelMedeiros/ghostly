import type { Page } from "@playwright/test";
import { connect, expect, link, say, test } from "../support/fixtures";

// The account switcher (WISP 04): the profiles saved on this device, one tap away from the account bar,
// each reopened where it was left, a locked one behind its own password, and a phone's tab bar holding it too.

const switcher = (page: Page) => page.getByTestId("profile-switcher");
const item = (page: Page, name: string) => switcher(page).getByTestId("profile-switcher-item").filter({ hasText: name });
const profileIs = (page: Page, name: string) => expect(page.getByTestId("account-profile")).toHaveAttribute("title", new RegExp(`: ${name}$`), { timeout: 30_000 });
const locked = (page: Page) => page.getByText("Ghostly is locked");
/** The rows of the chat list, and the unread count on one. */
const rows = (page: Page) => page.locator("div.group").filter({ has: page.getByTitle("Delete chat") });
const unreadBadge = (page: Page) => rows(page).locator("span").filter({ hasText: /^(\d+|99\+)$/ });

test("the account bar switches profiles in one tap, each one reopening where it was left", { tag: ["@feature:profiles.switcher", "@feature:profiles.switch", "@feature:profiles.create"] }, async ({ peer }) => {
  const alice = await peer("switcher-alice");
  const bob = await peer("switcher-bob");
  const { page } = alice;

  // Personal has a chat, where bob writes while alice is elsewhere: unread messages stay in Personal.
  await link(alice, bob);
  await connect(alice, bob);
  await page.getByTestId("wallet-chip").click();
  await expect(page.getByTestId("wallet")).toBeVisible();
  await say(bob, "are you there?");
  await say(bob, "call me");
  await expect(unreadBadge(page)).toHaveText("2");

  // The chevron opens the switcher: the active profile on top, then Add and Manage.
  await page.getByTestId("account-profile-switcher").click();
  await expect(switcher(page)).toBeVisible();
  await expect(switcher(page).getByTestId("profile-switcher-current")).toHaveAttribute("aria-checked", "true");
  await expect(switcher(page).getByTestId("profile-switcher-current")).toContainText("Personal");
  await expect(switcher(page).getByTestId("profile-switcher-item")).toHaveCount(0);
  // Escape closes it and gives the focus back.
  await page.keyboard.press("Escape");
  await expect(switcher(page)).toHaveCount(0);
  await expect(page.getByTestId("account-profile-switcher")).toBeFocused();

  // Add a profile goes to Profile with the form open.
  await page.getByTestId("account-profile-switcher").click();
  await switcher(page).getByTestId("profile-switcher-add").click();
  await page.getByTestId("profile-new-name").fill("Work");
  await page.getByTestId("profile-create").click();
  await expect(page.getByTestId("profile-name")).toHaveValue("Work", { timeout: 30_000 });
  await profileIs(page, "Work");

  // Work is left on its Settings page.
  await page.getByTestId("account-settings").click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  // Personal has something unread: a ring on the Profile picture, a count on its line in the switcher.
  await expect(page.getByTestId("account-profile-others")).toBeVisible();
  await expect(page.getByTestId("account-profile")).toHaveAccessibleName(/unread messages in another profile/);
  await page.getByTestId("account-profile").click({ button: "right" });
  await expect(item(page, "Personal").getByTestId("profile-switcher-unread")).toBeVisible();
  await expect(item(page, "Personal").getByTestId("profile-switcher-unread")).toHaveText("2");
  await expect(item(page, "Personal")).toHaveAccessibleName("Switch to Personal, 2 unread");

  // One tap: the switch shows Personal coming up, then Personal is back where it was left (its Profile page,
  // where Work was added), with its chat and what is unread in it.
  // The overlay can come and go between two polls: the page itself writes down what it showed.
  await page.addInitScript(() => new MutationObserver(() => {
    const splash = document.querySelector("[data-testid=profile-switch-splash]");
    if (splash) sessionStorage.setItem("e2e-splash", splash.textContent ?? "");
  }).observe(document, { childList: true, subtree: true }));
  await item(page, "Personal").click();
  await profileIs(page, "Personal");
  expect(await page.evaluate(() => sessionStorage.getItem("e2e-splash")), "the restart showed Personal coming up").toBe("POpening Personal…");
  await expect(page.getByTestId("profile-switch-splash")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("profile-name")).toHaveValue("Personal");
  await expect(page).toHaveURL(/#\/profile$/);
  await expect(rows(page)).toHaveCount(1);
  await expect(unreadBadge(page)).toHaveText("2");

  // Back to Work from the keyboard (Alt+Shift+P, arrows, Enter): its Settings page, and none of Personal's chats.
  await page.keyboard.press("Alt+Shift+KeyP");
  await expect(switcher(page)).toBeVisible();
  await expect(item(page, "Work")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(switcher(page).getByTestId("profile-switcher-add")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(item(page, "Work")).toBeFocused();
  await page.keyboard.press("Enter");
  await profileIs(page, "Work");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId("account-profile-others")).toBeVisible();

  // Manage profiles is the Profile page, which lists both.
  await page.getByTestId("account-profile-switcher").click();
  await switcher(page).getByTestId("profile-switcher-manage").click();
  await expect(page.getByTestId("profile-page")).toBeVisible();
  await expect(page.getByTestId("profile-row")).toHaveCount(2);
});

test("switching to a locked profile asks its password first, and the switcher says it is locked", { tag: ["@feature:profiles.switcher", "@feature:profiles.lock"] }, async ({ peer }) => {
  const { page } = await peer("switcher-lock");
  await page.getByTestId("account-profile-switcher").click();
  await switcher(page).getByTestId("profile-switcher-add").click();
  await page.getByTestId("profile-new-name").fill("Side");
  await page.getByTestId("profile-create").click();
  await expect(page.getByTestId("profile-name")).toHaveValue("Side", { timeout: 30_000 });

  // Personal gets a lock of its own.
  await page.getByTestId("account-profile-switcher").click();
  await item(page, "Personal").click();
  await profileIs(page, "Personal");
  await page.goto("/#/settings");
  await page.getByRole("switch", { name: "Lock Screen" }).click();
  await page.getByLabel("New password", { exact: true }).fill("personal secret");
  await page.getByLabel("Confirm password", { exact: true }).fill("personal secret");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Password set successfully")).toBeVisible();

  // From Side, Personal is marked locked, with no count or picture of what is inside.
  await page.getByTestId("account-profile-switcher").click();
  await item(page, "Side").click();
  await profileIs(page, "Side");
  await page.getByTestId("account-profile-switcher").click();
  await expect(item(page, "Personal").getByTestId("profile-switcher-locked")).toBeVisible();
  await expect(item(page, "Personal")).toHaveAccessibleName("Switch to Personal, locked");

  // Switching to it: the lock screen first, naming the profile, and nothing of the app behind it.
  await item(page, "Personal").click();
  await expect(locked(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("lock-profile")).toContainText("Personal");
  await expect(page.getByTestId("account-bar")).toHaveCount(0);
  await page.getByPlaceholder("Password").fill("personal secret");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(locked(page)).toHaveCount(0);
  await profileIs(page, "Personal");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
});

test("on a phone, holding Settings opens the switcher as a sheet", { tag: ["@feature:profiles.switcher", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const { page } = await peer("switcher-phone", { mobile: true });
  await page.getByTestId("mobile-tab-settings").click();
  await expect(page.getByTestId("mobile-tab-profile")).toBeVisible();

  // Settings holds the switcher's visible way in.
  await page.getByTestId("settings-profile-switch").click();
  await expect(switcher(page)).toBeVisible();
  await switcher(page).getByTestId("profile-switcher-add").click();
  await page.getByTestId("profile-new-name").fill("Work");
  await page.getByTestId("profile-create").click();
  await expect(page.getByTestId("profile-name")).toHaveValue("Work", { timeout: 30_000 });

  await expect(page.getByTestId("profile-switch-splash")).toHaveCount(0, { timeout: 15_000 });

  // A long press on the Settings tab: the sheet, then one tap back to Personal.
  const tab = page.getByTestId("mobile-tab-settings");
  const box = (await tab.boundingBox())!;
  await tab.dispatchEvent("pointerdown", { pointerType: "touch", clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, isPrimary: true });
  await expect(switcher(page)).toBeVisible();
  await tab.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true });
  const width = await switcher(page).evaluate((el) => el.getBoundingClientRect().width);
  expect(width, "the sheet spans the phone").toBeGreaterThanOrEqual(389);
  await item(page, "Personal").click();
  await expect(page.getByTestId("mobile-tab-settings")).toHaveAccessibleName(/Personal/, { timeout: 30_000 });
});
