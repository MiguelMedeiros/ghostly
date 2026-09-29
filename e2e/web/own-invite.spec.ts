import { copyInvite, manualFallback, pasteInvite } from "../support/clipboard";
import { expect, openProfilePage, test, type Peer } from "../support/fixtures";
import type { Page } from "@playwright/test";

/**
 * An invite this profile already has a chat for makes no second chat (WISP 801 Q9): its own invite is
 * refused with the way to the chat that owns it, one it already joined by opens that chat, and another
 * profile on the same app is another person, who may join it.
 */

/** Chats kept by this browser for the running profile, counted the way the app stores them. */
const storedChats = (page: Page, prefix = "ghostly_") =>
  page.evaluate(
    (prefix) =>
      Object.keys(localStorage).filter((key) => {
        try {
          const value = JSON.parse(localStorage.getItem(key) ?? "");
          return key.startsWith(prefix) && value?.mySeedB64 && value?.peerPubKeyB64;
        } catch {
          return false;
        }
      }).length,
    prefix,
  );

async function newInvite(host: Peer): Promise<{ link: string; code: string; chatUrl: string }> {
  await host.page.getByTitle("New Chat").click();
  const link = await copyInvite(host.page);
  expect(link).toMatch(/^https:\/\/ghostly\.tools\/#ghostly1p[02-9ac-hj-np-z]{211}$/);
  await expect(host.page).toHaveURL(/#\/chat\/[0-9a-f]+$/);
  return { link, code: link.split("#")[1], chatUrl: host.page.url() };
}

async function openJoin(peer: Peer) {
  await peer.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
}

test("my own invite makes no second chat: Join says it is mine and opens the chat that owns it", { tag: ["@feature:invite.own", "@feature:invite.link"] }, async ({ peer }) => {
  const alice = await peer("alice");
  const { link, code, chatUrl } = await newInvite(alice);
  await alice.page.goto("/#/");
  await expect(alice.page.getByTitle("New Chat")).toBeVisible();

  // Pasted as its link.
  await openJoin(alice);
  await pasteInvite(alice.page, link);
  const dialog = alice.page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toHaveText("This is your own invite. Share it with a contact; they join with it.");
  await expect(dialog.getByPlaceholder("Paste invite…")).toHaveCount(0);
  expect(await storedChats(alice.page)).toBe(1);
  await dialog.getByTestId("join-open-chat").click();
  await expect(dialog).toBeHidden();
  await expect(alice.page).toHaveURL(chatUrl);
  await expect(alice.page.getByTestId("invite-card")).toBeVisible();

  // Typed as the bare code, in capitals as a QR holds it.
  await openJoin(alice);
  await manualFallback(alice.page);
  await alice.page.getByPlaceholder("Paste invite…").fill(code.toUpperCase());
  await dialog.getByRole("button", { name: "Join chat", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("This is your own invite. Share it with a contact; they join with it.");
  await dialog.getByRole("button", { name: "Close join" }).click();
  await expect(dialog).toBeHidden();

  // Opened as a link in this very app: the chat that owns it, with a word, and still one chat.
  await alice.page.evaluate((code) => (location.hash = code), code);
  await expect(alice.page).toHaveURL(chatUrl);
  await expect(alice.page.getByTestId("join-notice")).toHaveText("This is your own invite. Share it with a contact; they join with it.");
  expect(await storedChats(alice.page)).toBe(1);
  expect(alice.page.url()).not.toContain(code.slice(9, 60));
});

test("a contact's invite pasted twice opens the chat it already made", { tag: ["@feature:invite.rejoin"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  const { link } = await newInvite(alice);
  await openJoin(bob);
  await pasteInvite(bob.page, link);
  await expect(bob.page).toHaveURL(/#\/chat\/[0-9a-f]+$/);
  const chatUrl = bob.page.url();
  await bob.page.goto("/#/");
  await expect(bob.page.getByTitle("New Chat")).toBeVisible();

  await openJoin(bob);
  await pasteInvite(bob.page, link);
  await expect(bob.page.getByRole("dialog")).toBeHidden();
  await expect(bob.page).toHaveURL(chatUrl);
  await expect(bob.page.getByTestId("join-notice")).toHaveText("You're already in this chat.");
  expect(await storedChats(bob.page)).toBe(1);
  await expect(bob.page.getByTitle("Delete chat")).toHaveCount(1);
});

test("two profiles on one app can still join each other", { tag: ["@feature:invite.own", "@feature:profiles.switch"] }, async ({ peer }) => {
  const { page } = await peer("carol");
  const { link } = await newInvite({ name: "carol", page } as Peer);

  // A second profile: another person on this app, with chats of its own.
  await openProfilePage(page);
  await page.getByTestId("profile-new").click();
  await page.getByTestId("profile-new-name").fill("Work");
  await page.getByTestId("profile-create").click();
  await expect(page.getByTestId("profile-name")).toHaveValue("Work", { timeout: 30000 });
  await expect(page.getByTestId("profile-links")).toContainText("0 chats");
  await page.goto("/#/");
  await expect(page.getByTitle("New Chat")).toBeVisible();

  await page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(page, link);
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page).toHaveURL(/#\/chat\/[0-9a-f]+$/);
  await expect(page.getByPlaceholder("Message…")).toBeVisible();
  await expect(page.getByTestId("join-notice")).toHaveCount(0);
  // The first profile's chat and the second's: one each, kept apart.
  expect(await storedChats(page)).toBe(2);
  expect(await storedChats(page, "ghostly_" + (await page.evaluate(() => JSON.parse(localStorage.getItem("ghostly_profiles") ?? "{}").active ?? "")) + "_")).toBe(1);
});
