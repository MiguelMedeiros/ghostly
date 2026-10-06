import type { Page } from "@playwright/test";
import { chat, expect, say, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * A call that comes while the app is locked since it started (WISP 601 § Locked): nothing of the app has been drawn,
 * yet the call rings and the lock screen shows who calls. Nothing of the chat reaches the page before the password.
 */

const clock = /^\d{1,2}:\d{2}$/;
const SECRETS = ["boo secret from alice", "boo secret from bob"];

async function setNickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

/** Alice and Bob pair and talk; Alice sets a lock password and her app starts again, locked. */
async function startLocked(peer: (name: string) => Promise<Peer>, prefix: string): Promise<[Peer, Peer]> {
  const [alice, bob] = await Promise.all([peer(`${prefix}-alice`), peer(`${prefix}-bob`)]);
  await setNickname(bob, "Slimer");
  await pair(alice, bob);
  await expect(alice.page.getByTestId("chat-name")).toHaveText("Slimer", { timeout: 30_000 });
  await say(alice, SECRETS[0]);
  await say(bob, SECRETS[1]);
  for (const p of [alice, bob]) for (const text of SECRETS) await expect(chat(p).getByText(text)).toBeVisible();

  await alice.page.getByTestId("account-settings").click();
  await alice.page.getByRole("switch", { name: "Lock Screen" }).click();
  const passwords = alice.page.getByTestId("settings-password-form").locator("input[type=password]");
  await passwords.nth(0).fill("spooky");
  await passwords.nth(1).fill("spooky");
  await alice.page.getByRole("button", { name: "Set password" }).click();
  await expect(alice.page.getByText("Password set successfully")).toBeVisible();

  await alice.page.reload();
  await expect(alice.page.getByText("Ghostly is locked")).toBeVisible();
  await expect(alice.page.getByTitle("New Chat"), "nothing of the app is drawn before the password").toHaveCount(0);
  // Her app said goodbye on the way out; the chat is live again once her peer, running behind the lock, is back.
  await expect(bob.page.getByTestId("call-audio")).toBeDisabled({ timeout: 15_000 }).catch(() => {});
  await expect(bob.page.getByTestId("call-audio")).toBeEnabled({ timeout: 90_000 });
  return [alice, bob];
}

/** Nothing of the chat is in the page, read or not: only the lock screen and who calls. */
async function nothingOfTheChat(page: Page): Promise<void> {
  const html = await page.evaluate(() => document.body.innerHTML);
  for (const text of SECRETS) expect(html, "no message of the chat is in the page").not.toContain(text);
  await expect(page.getByPlaceholder("Message…")).toHaveCount(0);
  // What a screen reader can reach: the lock screen's own controls and nothing else.
  const lock = page.getByRole("dialog", { name: "Ghostly is locked" });
  for (const role of ["button", "textbox", "link"] as const) {
    expect(await page.getByRole(role).count(), `every ${role} is the lock screen's`).toBe(await lock.getByRole(role).count());
  }
}

test("locked since start: a call rings on the lock screen, and Decline leaves it locked", { tag: ["@feature:calls.lock-ring-start", "@feature:calls.decline"] }, async ({ peer }) => {
  const [alice, bob] = await startLocked(peer, "lockstart-decline");
  await bob.page.getByTestId("call-audio").click();

  const card = alice.page.getByTestId("lock-call");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(alice.page.getByTestId("lock-call-name")).toHaveText("Slimer");
  await expect(alice.page.getByTestId("lock-call-kind")).toHaveText("Incoming audio call...");
  await nothingOfTheChat(alice.page);

  await alice.page.getByRole("button", { name: "Decline" }).click();
  await expect(card).toHaveCount(0);
  await expect(alice.page.getByText("Ghostly is locked")).toBeVisible();
  await expect(alice.page.getByRole("button", { name: "Unlock" })).toBeVisible();
  await expect(bob.page.getByTitle("End call")).toHaveCount(0);
  await expect(chat(bob).getByText("Audio call declined")).toBeVisible();
  await nothingOfTheChat(alice.page);
});

test("locked since start: Answer takes the password, unlocks and answers at once", { tag: ["@feature:calls.lock-ring-start", "@feature:calls.paired"] }, async ({ peer }) => {
  const [alice, bob] = await startLocked(peer, "lockstart-answer");
  await bob.page.getByTestId("call-video").click();

  const card = alice.page.getByTestId("lock-call");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(alice.page.getByTestId("lock-call-kind")).toHaveText("Incoming video call...");
  await nothingOfTheChat(alice.page);

  await alice.page.getByRole("button", { name: "Answer" }).click();
  const password = alice.page.getByPlaceholder("Password");
  await expect(password).toBeFocused();
  await password.fill("not it");
  await password.press("Enter");
  await expect(alice.page.getByTestId("lock-error")).toHaveText("Incorrect password, try again");
  await expect(card).toBeVisible();
  await expect(bob.page.getByText("Calling...")).toBeVisible();
  await nothingOfTheChat(alice.page);

  await password.fill("spooky");
  await password.press("Enter");
  await expect(alice.page.getByText("Ghostly is locked")).toHaveCount(0);
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible({ timeout: 30_000 });
  await expect(alice.page.getByTestId("chat-name")).toHaveText("Slimer");

  await bob.page.getByTitle("End call").click();
  for (const p of [alice, bob]) await expect(p.page.getByTitle("End call")).toHaveCount(0);
  for (const p of [alice, bob]) await expect(chat(p).getByText("Video call ended")).toBeVisible();
  // The chat is all there once unlocked.
  for (const text of SECRETS) await expect(chat(alice).getByText(text)).toBeVisible();
});
