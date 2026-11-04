import type { Page } from "@playwright/test";
import { expect, openProfilePage, test } from "../support/fixtures";

/**
 * The page header's Back and the browser's: home (the chat list with New and Join) sits at the bottom of the
 * history, the places of the account bar and the tab bar replace each other on it, and a page opened from
 * inside another (a sub-page) goes up to that one (apps/ui/src/lib/navigation.ts).
 */

const home = async (page: Page) => {
  await expect(page).toHaveURL(/\/(#\/)?$/);
  await expect(page.getByTestId("home-chat-actions")).toBeVisible();
  await expect(page.getByTestId("home-chat-actions").getByRole("button")).toHaveCount(2);
};
const back = (page: Page) => page.getByTestId("page-back");

test("the header's Back goes home after Wallets → Identities → Settings, not back through them", { tag: ["@feature:app.navigation.back", "@feature:app.home"] }, async ({ peer }) => {
  const { page } = await peer("places");
  await page.getByTestId("wallet-chip").click();
  await expect(page.getByTestId("wallet")).toBeVisible();
  await page.getByTestId("account-identities").click();
  await expect(page.getByRole("heading", { level: 1, name: "Identities" })).toBeVisible();
  await page.getByTestId("account-settings").click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();

  await back(page).click();
  await home(page);

  // And the browser's Back from a place is home too, not the place visited before it.
  await page.getByTestId("wallet-chip").click();
  await page.getByTestId("account-services").click();
  await expect(page).toHaveURL(/#\/services$/);
  await page.goBack();
  await home(page);
});

test("a sub-page's Back goes up to the page it was opened from, then home", { tag: ["@feature:app.navigation.back"] }, async ({ peer }) => {
  const { page } = await peer("subpages");
  await openProfilePage(page);
  await expect(page.getByTestId("profile-page")).toBeVisible();
  await expect(back(page)).toHaveAttribute("data-goes", "home");

  // Profile → Wallets: a sub-page of Profile.
  await page.getByTestId("profile-page").getByRole("button", { name: /^Wallets/ }).click();
  await expect(page.getByTestId("wallet")).toBeVisible();
  await expect(back(page)).toHaveAttribute("data-goes", "up");
  await back(page).click();
  await expect(page.getByTestId("profile-page")).toBeVisible();

  // Profile → Settings → Back → Profile → Back → home.
  await page.getByTestId("profile-page").getByRole("button", { name: /^Settings/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await back(page).click();
  await expect(page.getByTestId("profile-page")).toBeVisible();
  await back(page).click();
  await home(page);
});

test("on a phone: the browser's Back from a tab goes home, and Profile goes up to Settings", { tag: ["@feature:app.navigation.back", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const { page } = await peer("pocket", { mobile: true });
  const tabs = page.getByTestId("mobile-tabs");
  // Apps holds Services' tab on a phone in the suite's build (WISP 1200).
  for (const tab of ["Wallets", "Identities", "Apps", "Settings"]) await tabs.getByRole("button", { name: tab }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  // The tab bar is the way home: no header Back on a tab of its own.
  await expect(back(page)).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/\/(#\/)?$/);
  await expect(tabs.getByRole("button", { name: "Chats" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByPlaceholder("Search chats...")).toBeVisible();

  // Settings → Profile: a sub-page, with a Back of its own that goes up to Settings.
  await tabs.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("settings-profile-link").click();
  await expect(page.getByTestId("profile-page")).toBeVisible();
  await expect(back(page)).toBeVisible();
  await back(page).click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/(#\/)?$/);

  // A chat's back arrow goes home, and the browser's Back from home does not return to the chat.
  await page.getByTitle("New Chat").click();
  await expect(page.getByTestId("chat-back")).toBeVisible();
  await page.getByTestId("chat-back").click();
  await expect(page).toHaveURL(/\/(#\/)?$/);
  await expect(page.getByPlaceholder("Search chats...")).toBeVisible();
});

test("a deep link gets home under it: Back from it goes home, not out of the app", { tag: ["@feature:app.navigation.back", "@feature:app.navigation"] }, async ({ peer }) => {
  const { page } = await peer("deep");
  await page.getByTitle("New Chat").click();
  await expect(page).toHaveURL(/#\/chat\/[0-9a-f]+$/);
  const chatUrl = page.url();

  // Opened afresh, from somewhere else.
  for (const address of [chatUrl, "/#/settings"]) {
    await page.goto("about:blank");
    await page.goto(address);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await page.goBack();
    await home(page);
  }

  // The header's Back on a page opened that way goes home too.
  await page.goto("about:blank");
  await page.goto("/#/wallet");
  await expect(page.getByTestId("wallet")).toBeVisible();
  await back(page).click();
  await home(page);

  // And an address typed into a running app.
  await page.evaluate(() => (location.hash = "/identities"));
  await expect(page.getByRole("heading", { level: 1, name: "Identities" })).toBeVisible();
  await page.goBack();
  await home(page);
});

test("a page of the menu whose file did not load says so in its place, and Try again or Reload shows it", { tag: ["@feature:app.navigation"] }, async ({ peer }) => {
  // A page of the menu is a file of its own, asked for when it is first opened: the connection drops just then.
  let offline = true;
  const { page } = await peer("blip", {
    beforeOpen: async (context) => {
      await context.route(/\/assets\/Settings-[^/]+\.js$/, (route) => (offline ? route.abort("internetdisconnected") : route.fallback()));
      // And the question Reload asks first: is the app's page there to reload into?
      await context.route((url) => url.pathname === "/", (route) => (offline && route.request().method() === "HEAD" ? route.abort("internetdisconnected") : route.fallback()));
    },
  });
  await page.getByTestId("account-settings").click();
  const notice = page.getByTestId("page-not-loaded");
  await expect(notice).toContainText("This page did not load.");
  // Not the app-wide error screen, whose only way out is a reload: the chat list is still there.
  await expect(page.getByTestId("app-error")).toHaveCount(0);
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTitle("New Chat")).toBeVisible();

  // Still no connection: the notice stays, with the keyboard focus on its button.
  const again = page.getByTestId("page-not-loaded-retry");
  await again.click();
  await expect(again).not.toHaveAttribute("aria-busy", "true");
  await expect(notice).toBeVisible();
  await expect(again).toBeFocused();

  // The other pages are files of their own, and open meanwhile.
  await page.getByTestId("wallet-chip").click();
  await expect(page.getByTestId("wallet")).toBeVisible();
  await page.getByTestId("account-settings").click();
  await expect(notice).toBeVisible();

  // Reload is offered once Try again has failed. With no connection it would leave the browser's own error page: the app stays.
  const reload = page.getByTestId("page-not-loaded-reload");
  await page.evaluate(() => { (window as unknown as { sameDocument?: boolean }).sameDocument = true; });
  await reload.click();
  await expect(reload).not.toHaveAttribute("aria-disabled", "true");
  await expect(notice).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument)).toBe(true);

  // The connection is back: Try again asks the server again and shows Settings, in this page. Chromium kept a failed
  // import for as long as the page lived up to Playwright 1.58's build, so there only Reload brought it.
  offline = false;
  await again.click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument)).toBe(true);
  await expect(notice).toHaveCount(0);
  await expect(page.getByTestId("app-error")).toHaveCount(0);
  await expect(page.getByTestId("sidebar")).toBeVisible();
});
