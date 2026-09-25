import { copyInvite } from "../support/clipboard";
import { manualFallback } from "../support/clipboard";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/** Chats kept by this browser, counted the way the app stores them. */
const storedChats = (page: Page) =>
  page.evaluate(
    () =>
      Object.keys(localStorage).filter((key) => {
        try {
          const value = JSON.parse(localStorage.getItem(key) ?? "");
          return key.startsWith("ghostly_") && value?.mySeedB64 && value?.peerPubKeyB64;
        } catch {
          return false;
        }
      }).length,
  );

/**
 * The rows of the chat list. The sidebar keeps its own copy of the sessions and
 * refreshes it on a timer, so storage and list can disagree for a moment.
 */
const chatRows = (page: Page) => page.getByTitle("Delete chat");
/** A contact with no name yet, as the list and the header call it. */
const UNNAMED = /^Contact · \S{6}$/;

/**
 * The list itself has settled on `count` chats. Clicking a row before that can hit the
 * row of a chat that is about to disappear, whose confirm button then never comes back.
 */
async function expectChatRows(page: Page, count: number): Promise<void> {
  await expect(chatRows(page)).toHaveCount(count);
  if (count === 0) await expect(page.getByText("It's quiet here...")).toBeVisible();
}

async function createChat(page: Page): Promise<string> {
  const before = await storedChats(page);
  await page.getByTitle("New Chat").click();
  await expect(page.getByText("Invite your contact", { exact: true })).toBeVisible();
  await expect.poll(() => storedChats(page)).toBe(before + 1);
  return await copyInvite(page);
}

test("opens on the home screen", { tag: ["@feature:app.home"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await expect(page.getByText("Private, ephemeral messaging.")).toBeVisible();
  await expect(page.getByText("It's quiet here...")).toBeVisible();
  await page.getByTestId("wallet-chip").click();
  await expect(page.getByTestId("platform-notice")).toContainText("Pocket money only");
});

test("a web page says plainly what it cannot do", { tag: ["@feature:app.web-limits", "@feature:services.web-unavailable"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await page.getByTestId("account-services").click();
  await expect(page.getByTestId("add-service")).toHaveCount(0);
  await expect(page.getByText("needs the Ghostly browser extension or desktop app").first()).toBeVisible();
});

test("a second tab stays out of the way: one peer per browser", { tag: ["@feature:app.single-peer-per-browser"] }, async ({ peer }) => {
  const { context } = await peer("alice");
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByText("Ghostly is already open in another tab.")).toBeVisible();
  await expect(second.getByTitle("New Chat")).toHaveCount(0);
});

test("creating a chat shows an invite code, the options menu copies it", { tag: ["@feature:invite.create"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  const invite = await createChat(page);
  // A new chat's invite is one ghostly1 code (WISP 801), copied as its link on ghostly.tools.
  expect(invite).toMatch(/^https:\/\/ghostly\.tools\/#ghostly1p[02-9ac-hj-np-z]{211}$/);
  await expect(page.getByTestId("invite-link")).toHaveText(invite.replace("https://", ""));
  // The chat's keys stay out of the address bar and the history.
  await expect(page).toHaveURL(/#\/chat\/[^/]+$/);
  expect(page.url()).not.toContain(invite.split("#")[1].slice(9, 60));

  await page.getByRole("button", { name: /^(Copy invite|Copied!)$/ }).click();
  await expect(page.getByRole("button", { name: "Copied!" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(invite);

  await page.getByTitle("Options").click();
  await page.getByText("Copy invite code").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(invite);
});

test("a bad invite code is refused", { tag: ["@feature:invite.invalid"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await manualFallback(page);
  await page.getByPlaceholder("Paste invite…").fill("not an invite");
  await page.getByRole("dialog").getByRole("button",{ name: "Join chat", exact: true }).click();
  await expect(page.getByText("This is not a Ghostly invite.")).toBeVisible();
});

test("chats can be named and found", { tag: ["@feature:chats.list.rename", "@feature:chats.list.search"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await createChat(page);
  await page.getByTitle("Click to set a name").click();
  await page.getByPlaceholder("Set a name...").fill("Haunted house");
  await page.getByPlaceholder("Set a name...").press("Enter");
  await expect(page.getByTitle("Click to set a name")).toHaveText("Haunted house");
  await page.goto("/#/");
  await createChat(page);
  await page.goto("/#/");
  await expectChatRows(page, 2);

  const search = page.getByPlaceholder("Search chats...");
  await search.fill("haunted");
  await expect(page.getByText("Haunted house")).toBeVisible();
  await expect(page.getByText(UNNAMED)).toHaveCount(0);
  await search.fill("nothing like this");
  await expect(page.getByText("No results found")).toBeVisible();
  await search.fill("");
  await expect(page.getByText(UNNAMED)).toBeVisible();
});

test("tech info shows the keys of the chat", { tag: ["@feature:app.tech-info"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await createChat(page);
  await page.getByTitle("Options").click();
  await page.getByText("Tech Info").click();
  for (const section of ["Identity", "Protocol", "Sync", "ACK Status"]) await expect(page.getByText(section, { exact: true })).toBeVisible();
  await expect(page.getByText("My Key")).toBeVisible();
});

test("one chat can be deleted, from the chat or from the list", { tag: ["@feature:chats.list.delete"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await createChat(page);
  await page.getByTitle("Options").click();
  await page.getByTestId("chat-options-menu").getByRole("button", { name: "Delete chat" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete chat" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect.poll(() => storedChats(page)).toBe(0);
  await expectChatRows(page, 0);

  await createChat(page);
  await expectChatRows(page, 1);
  const row = page.getByText(UNNAMED).first();
  await row.hover();
  await chatRows(page).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete chat" }).click();
  await expectChatRows(page, 0);
  await expect.poll(() => storedChats(page)).toBe(0);
});

// Regression: "Delete all chats" used to remove the marker of the one-time import of the
// peer's links, so the next reconcile brought every chat back, empty. It also took the settings.
test("deleted chats stay deleted, settings stay", { tag: ["@feature:chats.list.delete-all"] }, async ({ peer }) => {
  test.slow();
  const { page } = await peer("alice");
  await page.evaluate(() => localStorage.setItem("ghostly_app_settings", JSON.stringify({ theme: "purple", mode: "dark", language: "en" })));
  await createChat(page);
  await page.goto("/#/");
  await createChat(page);
  // links younger than 15 s are never dropped; make these old enough to matter
  await page.waitForTimeout(16_000);

  await page.goto("/#/");
  await expectChatRows(page, 2);
  await page.getByTitle("Settings").click();
  await page.getByTestId("delete-all-chats").click();
  await expect(page.getByText("Delete all 2 chats?")).toBeVisible();
  await page.getByTestId("delete-all-chats-confirm").click();
  // reconcile runs every 5 s; a chat that comes back does so within two rounds
  await page.waitForTimeout(12_000);
  expect(await storedChats(page)).toBe(0);
  await page.reload();
  await expect(page.getByTitle("New Chat")).toBeVisible();
  await page.waitForTimeout(12_000);
  expect(await storedChats(page)).toBe(0);
  await expect(page.getByText("It's quiet here...")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("ghostly_app_settings"))).toContain("purple");
});

test("clear all data leaves nothing behind", { tag: ["@feature:app.clear-data"] }, async ({ peer }) => {
  test.slow();
  const { page } = await peer("alice");
  await createChat(page);
  await page.waitForTimeout(16_000);
  await page.goto("/#/settings");
  await page.getByRole("button", { name: "Clear all data" }).click();
  await expect(page.getByText("Are you sure? This cannot be undone.")).toBeVisible();
  await page.getByRole("button", { name: "Confirm" }).click();
  // The app starts over at once (the running peer held what was deleted), so the short "All data
  // cleared" note may be gone before anyone reads it: the restart is what to wait for.
  await expect(page).not.toHaveURL(/#\/settings/);
  await expect(page.getByTitle("New Chat")).toBeVisible();
  await page.goto("/#/");
  await page.waitForTimeout(12_000);
  expect(await storedChats(page)).toBe(0);
});
