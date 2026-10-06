import { devices, type Locator, type Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { pasteInvite } from "../support/clipboard";
import { DEVICE_SET_PASSWORD, finishJoin } from "../support/devices";

/**
 * A phone that already has a profile adds itself to the desktop's profile by opening the Add a device QR code's link,
 * as its own camera does (WISP 06 § Adding a device). The link carries the code in the fragment, after the profile's
 * name: it leaves the address at once, and the phone opens on one screen, "Add this phone to <profile>", with its name
 * filled in and one button. Its profile is in use, so that button makes a new profile for the code, which goes on to
 * the digits by itself. The phone's own profile and its chat stay as they were. The phone runs at phone width.
 */

/** A phone's browser, as the app reads it ("Add this phone", "Phone"). */
const PHONE = { mobile: true, userAgent: devices["Pixel 7"].userAgent, viewport: devices["Pixel 7"].viewport };

/** The chats a page's storage holds, by key: what must not change. */
const chats = (page: Page) =>
  page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((key) => /"mySeedB64"/.test(localStorage.getItem(key) ?? "")).map((key) => [key, localStorage.getItem(key)])));

/** The desktop: Profile, Devices, Add a device, the password inline, then the QR code with where it stands under it. */
async function addDevice(page: Page): Promise<{ add: Locator; code: string; link: string }> {
  await page.goto("/#/profile");
  await page.getByTestId("device-add-open").click();
  const add = page.getByTestId("device-add");
  await expect(add).toContainText("Add a device");
  await add.getByTestId("device-add-password").fill(DEVICE_SET_PASSWORD);
  await add.getByTestId("device-add-password-again").fill(DEVICE_SET_PASSWORD);
  await add.getByTestId("device-add-next").click();
  await expect(add).toContainText("Scan this with your phone's camera.");
  await expect(add.getByTestId("device-add-status")).toHaveText("Waiting for your other device…");
  const shown = add.getByTestId("device-add-code");
  const code = (await shown.getAttribute("data-code"))!;
  const link = (await shown.getAttribute("data-link"))!;
  expect(code).toMatch(/^ghostly1z/);
  await expect(add.getByRole("button", { name: "Copy link" })).toBeVisible();
  return { add, code, link };
}

test("a phone in use opens the QR code's link: one screen names the profile, Add makes a new profile, and its own profile is untouched", { tag: ["@feature:devices.enroll"] }, async ({ peer }) => {
  const [desktop, phone] = await Promise.all([peer("desktop"), peer("phone", PHONE)]);

  // The phone is in use: it has a chat.
  await phone.page.getByTitle("New Chat").click();
  await expect.poll(async () => Object.keys(await chats(phone.page)).length).toBe(1);
  const before = await chats(phone.page);

  const { add, code, link } = await addDevice(desktop.page);
  // The link names the desktop's profile before the code: `…/#<profile>#ghostly1z…`.
  const profile = decodeURIComponent(link.split("#").at(-2)!);
  expect(profile.length).toBeGreaterThan(0);
  expect(link.endsWith(`#${code}`)).toBe(true);

  // The phone's camera opens the link: a new start of the app, the code in capitals as a QR code holds it.
  const origin = new URL(phone.page.url()).origin;
  await phone.page.close();
  const page = await phone.context.newPage();
  await page.goto(`${origin}/#${encodeURIComponent(profile)}#${code.toUpperCase()}`);

  // One screen: which profile, the device's name, one button; it says a new profile is made here.
  const form = page.getByTestId("device-join-confirm");
  await expect(page.getByTestId("device-join")).toContainText(`Add this phone to “${profile}”`);
  // The code left the address, and so the history, before anything read it.
  expect(page.url()).not.toMatch(/ghostly1z/i);
  await expect(form).toHaveAttribute("data-place", "new");
  await expect(page.getByTestId("device-join-new-profile")).toContainText("Your profile here stays as it is.");
  await expect(page.getByTestId("device-join-name")).toHaveValue("Phone");
  await page.getByTestId("device-join-next").click();

  // The new profile goes on to the digits by itself.
  const desktopDigits = add.getByTestId("device-add-digits");
  await expect(desktopDigits).toBeVisible();
  await expect(add.getByTestId("device-add-status")).toHaveText("Found Phone. Check that it shows the same digits.");
  const digits = await desktopDigits.getAttribute("data-digits");
  await expect(page.getByTestId("device-join-digits")).toHaveAttribute("data-digits", digits!);
  await add.getByTestId("device-add-match").click();
  await expect(add.getByTestId("device-add-done")).toHaveText("Phone added. It is on standby.");
  await expect(page.getByTestId("device-join-done")).toHaveAttribute("data-step", "done");
  await finishJoin(page);

  // The phone's own profile still holds its chat, as it was, and the new profile is named after the desktop's.
  const after = await chats(page);
  for (const [key, value] of Object.entries(before)) expect(after[key]).toBe(value);
  const names = await page.evaluate(() => (JSON.parse(localStorage.getItem("ghostly_profiles") ?? "{}") as { profiles?: { name: string }[] }).profiles?.map((p) => p.name) ?? []);
  expect(names).toContain(profile);
  expect(page.url()).not.toMatch(/ghostly1z/i);
});

test("a phone in use with a group and no chat opens the QR code's link: the one screen sees the group and makes a new profile, code kept", { tag: ["@feature:devices.enroll"] }, async ({ peer }) => {
  const [desktop, phone] = await Promise.all([peer("desktop"), peer("phone", PHONE)]);

  // The phone is in use with a group only: the chat list has no 1:1 chat.
  await phone.page.getByTestId("sidebar-new-more").click();
  await phone.page.getByTestId("new-group").click();
  await phone.page.getByTestId("new-group-name").fill("Family");
  await phone.page.getByTestId("new-group-create").click();
  await phone.page.getByTestId("group-share-dialog").getByTestId("group-share-done").click();

  const { add, link } = await addDevice(desktop.page);

  const origin = new URL(phone.page.url()).origin;
  await phone.page.close();
  const page = await phone.context.newPage();
  await page.goto(link.replace(/^https?:\/\/[^/]+/, origin));

  // The engine says this profile holds something (a group): a new profile, said up front, no error.
  await expect(page.getByTestId("device-join-confirm")).toHaveAttribute("data-place", "new");
  await page.getByTestId("device-join-name").fill("Phone");
  await page.getByTestId("device-join-next").click();
  await expect(page.getByTestId("device-join-error")).toHaveCount(0);

  const desktopDigits = add.getByTestId("device-add-digits");
  await expect(desktopDigits).toBeVisible();
  await expect(page.getByTestId("device-join-digits")).toHaveAttribute("data-digits", (await desktopDigits.getAttribute("data-digits"))!);
  await add.getByTestId("device-add-match").click();
  await expect(add.getByTestId("device-add-done")).toHaveText("Phone added. It is on standby.");
  await expect(page.getByTestId("device-join-done")).toHaveAttribute("data-step", "done");
});

test("a phone scans the code with Join on its chat list: the same one screen", { tag: ["@feature:devices.enroll"] }, async ({ peer }) => {
  const [desktop, phone] = await Promise.all([peer("desktop"), peer("phone", PHONE)]);
  const { add, link } = await addDevice(desktop.page);
  const page = phone.page;
  // The chat list's Join, pasted as the scanner would read it.
  await page.getByTitle("Join chat").click();
  await pasteInvite(page, link);
  await expect(page.getByTestId("device-join-confirm")).toHaveAttribute("data-place", "here");
  await page.getByTestId("device-join-next").click();
  await expect(add.getByTestId("device-add-digits")).toBeVisible();
  await expect(page.getByTestId("device-join-digits")).toHaveAttribute("data-digits", (await add.getByTestId("device-add-digits").getAttribute("data-digits"))!);
  // The person says they don't match: both screens say so, and the desktop offers a new code at once.
  await add.getByTestId("device-add-no-match").click();
  await expect(add.getByTestId("device-add-failed")).toHaveAttribute("data-reason", "digits");
  await expect(page.getByTestId("device-join-failed")).toHaveAttribute("data-reason", "digits");
  await add.getByTestId("device-add-again").click();
  await expect(add.getByTestId("device-add-status")).toHaveText("Waiting for your other device…");
});

test("the link opened in a tab where Ghostly is open already: the same one screen, and the code leaves the address", { tag: ["@feature:devices.enroll"] }, async ({ peer }) => {
  const [desktop, phone] = await Promise.all([peer("desktop"), peer("phone", PHONE)]);
  const { link } = await addDevice(desktop.page);
  const page = phone.page;
  await expect(page.getByTitle("New Chat")).toBeVisible();
  // The same page, only the address's fragment changes: no new start of the app.
  await page.goto(link.replace(/^https?:\/\/[^/]+/, new URL(page.url()).origin));
  await expect(page.getByTestId("device-join-confirm")).toHaveAttribute("data-place", "here");
  await expect(page.getByTestId("device-join")).toContainText("Add this phone to “");
  expect(page.url()).not.toMatch(/ghostly1z/i);
  // Home stays under it: the profile's name in the link never becomes a route.
  await expect.poll(() => new URL(page.url()).hash).toBe("#/");
  await page.keyboard.press("Escape");
  await expect(page.getByTitle("New Chat")).toBeVisible();
});
