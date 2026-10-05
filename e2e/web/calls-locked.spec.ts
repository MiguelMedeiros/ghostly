import type { Locator } from "@playwright/test";
import { chat, expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * A call that comes while the app is locked (WISP 601 § Locked): the lock screen shows who calls and what kind of call,
 * nothing else of the chat. Decline declines and the app stays locked; Answer asks for the lock password, then answers.
 */

const clock = /^\d{1,2}:\d{2}$/;

async function setNickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

/** Alice sets a lock password and locks at once (Settings → Lock Now, which leaves the chat for home). */
async function lockNow(peer: Peer, password: string): Promise<void> {
  await peer.page.getByTitle("Settings").click();
  await peer.page.getByRole("switch", { name: "Lock Screen" }).click();
  const passwords = peer.page.getByTestId("settings-password-form").locator("input[type=password]");
  await passwords.nth(0).fill(password);
  await passwords.nth(1).fill(password);
  await peer.page.getByRole("button", { name: "Set password" }).click();
  await peer.page.getByRole("button", { name: "Lock Now" }).click();
  await expect(peer.page.getByText("Ghostly is locked")).toBeVisible();
}

async function lockedPair(peer: (name: string) => Promise<Peer>, prefix: string): Promise<[Peer, Peer]> {
  const [alice, bob] = await Promise.all([peer(`${prefix}-alice`), peer(`${prefix}-bob`)]);
  await setNickname(bob, "Slimer");
  await pair(alice, bob);
  await expect(alice.page.getByTestId("chat-name")).toHaveText("Slimer", { timeout: 30_000 });
  await expect(bob.page.getByTestId("call-audio")).toBeEnabled();
  await lockNow(alice, "spooky");
  return [alice, bob];
}

/** Under the lock: `inert`, so out of reach of clicks, keys and screen readers. */
const outOfReach = (locator: Locator) => locator.evaluate((el) => !!el.closest("[inert]"));

test("a call while locked shows who calls; Answer takes the lock password, then answers", { tag: ["@feature:calls.lock-ring", "@feature:calls.paired"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await lockedPair(peer, "lockring");
  await bob.page.getByTestId("call-audio").click();

  const card = alice.page.getByTestId("lock-call");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(alice.page.getByTestId("lock-call-name")).toHaveText("Slimer");
  await expect(alice.page.getByTestId("lock-call-kind")).toHaveText("Incoming audio call...");
  // Nothing else: the chat's own ringing card is not drawn, and the app stays out of reach behind the lock.
  await expect(alice.page.getByTestId("incoming-call")).toHaveCount(0);
  expect(await outOfReach(alice.page.getByTitle("New Chat")), "the app stays behind the lock").toBe(true);
  await expect(alice.page.getByPlaceholder("Password")).toHaveCount(0);
  await alice.page.screenshot({ path: testInfo.outputPath("locked-call-desktop.png") });

  // Answer asks for the password in the same field, focused.
  await alice.page.getByRole("button", { name: "Answer" }).click();
  const password = alice.page.getByPlaceholder("Password");
  await expect(password).toBeFocused();
  await expect(alice.page.getByText("Enter your password to answer")).toBeVisible();

  // A wrong one: it says so under the field, and the call keeps ringing on both sides.
  await password.fill("not it");
  await password.press("Enter");
  await expect(alice.page.getByTestId("lock-error")).toHaveText("Incorrect password, try again");
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(card).toBeVisible();
  await expect(bob.page.getByText("Calling...")).toBeVisible();
  await alice.page.screenshot({ path: testInfo.outputPath("locked-call-wrong-password.png") });

  // The right one unlocks and answers at once: both on the call, Alice in its chat.
  await password.fill("spooky");
  await alice.page.getByRole("button", { name: "Answer" }).click();
  await expect(alice.page.getByText("Ghostly is locked")).toHaveCount(0);
  for (const p of [alice, bob]) await expect(p.page.getByText(clock).first()).toBeVisible();
  await expect(alice.page.getByTestId("chat-name")).toHaveText("Slimer");

  await bob.page.getByTitle("End call").click();
  for (const p of [alice, bob]) await expect(p.page.getByTitle("End call")).toHaveCount(0);
  for (const p of [alice, bob]) await expect(chat(p).getByText("Audio call ended")).toBeVisible();
});

test("a call declined from the lock screen leaves the app locked and the caller told", { tag: ["@feature:calls.lock-ring", "@feature:calls.decline"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await lockedPair(peer, "lockdecline");
  await bob.page.getByTestId("call-video").click();

  const card = alice.page.getByTestId("lock-call");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(alice.page.getByTestId("lock-call-kind")).toHaveText("Incoming video call...");
  // On a phone the card and its two buttons fit a 375 px screen.
  await alice.page.setViewportSize({ width: 375, height: 812 });
  await expect(alice.page.getByRole("button", { name: "Decline" })).toBeInViewport();
  await expect(alice.page.getByRole("button", { name: "Answer" })).toBeInViewport();
  await alice.page.screenshot({ path: testInfo.outputPath("locked-call-phone.png") });

  await alice.page.getByRole("button", { name: "Decline" }).click();
  await expect(card).toHaveCount(0);
  // Still locked, back to the plain lock screen.
  await expect(alice.page.getByText("Ghostly is locked")).toBeVisible();
  await expect(alice.page.getByRole("button", { name: "Unlock" })).toBeVisible();
  await expect(alice.page.getByPlaceholder("Password")).toBeFocused();
  // The caller hears a decline: neither side is on a call, and its chat says so.
  await expect(bob.page.getByTitle("End call")).toHaveCount(0);
  await expect(chat(bob).getByText("Video call declined")).toBeVisible();
});
