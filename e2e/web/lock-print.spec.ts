import type { Page } from "@playwright/test";
import { chat, expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * Printing a locked tab (Ctrl+P, Save as PDF) prints the lock screen only: the app kept under it (Lock Now, the idle
 * lock) is not laid out on paper, so the PDF's text has none of its chats, names or messages.
 */

const say = async (from: Peer, to: Peer, text: string) => {
  await from.page.getByPlaceholder("Message…").fill(text);
  await from.page.getByPlaceholder("Message…").press("Enter");
  await expect(chat(to).getByText(text, { exact: true })).toBeVisible({ timeout: 30_000 });
};

/** The text a print of the page holds: what is laid out under print media. */
const printed = async (page: Page): Promise<string> => {
  await page.emulateMedia({ media: "print" });
  const text = await page.evaluate(() => document.body.innerText);
  await page.emulateMedia({ media: null });
  return text;
};

test("a locked tab prints the lock screen, nothing of the app under it", { tag: ["@feature:settings.lock.now"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("lockprint-alice"), peer("lockprint-bob")]);
  await bob.page.goto("/#/settings");
  await bob.page.getByPlaceholder("Enter your nickname...").fill("Slimer");
  await bob.page.goto("/#/");
  await pair(alice, bob);
  await expect(alice.page.getByTestId("chat-name")).toHaveText("Slimer", { timeout: 30_000 });
  await say(bob, alice, "ectoplasm in the library");
  const chatUrl = alice.page.url();

  await alice.page.getByTestId("account-settings").click();
  await alice.page.getByRole("switch", { name: "Lock Screen" }).click();
  const passwords = alice.page.getByTestId("settings-password-form").locator("input[type=password]");
  await passwords.nth(0).fill("spooky");
  await passwords.nth(1).fill("spooky");
  await alice.page.getByRole("button", { name: "Set password" }).click();
  await alice.page.getByRole("button", { name: "Lock Now" }).click();
  await expect(alice.page.getByText("Ghostly is locked")).toBeVisible();
  // The chat open under the lock, and a message that comes while locked.
  await alice.page.goto(chatUrl);
  await bob.page.getByPlaceholder("Message…").fill("the keymaster is here");
  await bob.page.getByPlaceholder("Message…").press("Enter");
  await expect(chat(alice).getByText("the keymaster is here", { exact: true })).toBeAttached({ timeout: 30_000 });
  expect(await alice.page.evaluate(() => document.body.innerText), "on screen the app is there, under the lock").toContain("ectoplasm in the library");

  const paper = await printed(alice.page);
  expect(paper).toContain("Ghostly is locked");
  for (const secret of ["ectoplasm in the library", "the keymaster is here", "Slimer"]) expect(paper, secret).not.toContain(secret);
  await alice.page.pdf({ path: testInfo.outputPath("locked.pdf"), printBackground: true });

  // Unlocked, a print is the app again.
  await alice.page.getByPlaceholder("Password").fill("spooky");
  await alice.page.getByRole("button", { name: "Unlock" }).click();
  await expect(alice.page.getByText("Ghostly is locked")).toHaveCount(0);
  expect(await printed(alice.page)).toContain("ectoplasm in the library");
});
