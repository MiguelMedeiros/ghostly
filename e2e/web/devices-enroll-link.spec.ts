import { expect, test } from "../support/fixtures";
import { DEVICE_SET_PASSWORD } from "../support/devices";

/**
 * A phone that already has a profile, with a chat, adds itself to the desktop's profile by opening the Add a device
 * QR code's link, as its own camera does (WISP 06 § Adding a device). The link carries the code in the fragment: it
 * leaves the address at once, the phone asks first, and the code goes into a new, empty profile, which opens at the
 * device's name with the code filled in. The phone's own profile and its chat stay as they were.
 */

/** The chats a page's storage holds, by key: what must not change. */
const chats = (page: import("@playwright/test").Page) =>
  page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((key) => /"mySeedB64"/.test(localStorage.getItem(key) ?? "")).map((key) => [key, localStorage.getItem(key)])));

test("a phone in use opens the QR code's link: it asks, adds itself in a new profile, and its own profile is untouched", { tag: ["@feature:devices.enroll"] }, async ({ peer }) => {
  const [desktop, phone] = await Promise.all([peer("desktop"), peer("phone", { mobile: true })]);

  // The phone is in use: it has a chat.
  await phone.page.getByTitle("New Chat").click();
  await expect.poll(async () => Object.keys(await chats(phone.page)).length).toBe(1);
  const before = await chats(phone.page);

  // The desktop: Profile, Devices, Add a device. The QR code is the code's link on this web app.
  await desktop.page.goto("/#/profile");
  await desktop.page.getByTestId("device-add-open").click();
  const add = desktop.page.getByTestId("device-add");
  await add.getByTestId("device-add-password").fill(DEVICE_SET_PASSWORD);
  await add.getByTestId("device-add-password-again").fill(DEVICE_SET_PASSWORD);
  await add.getByTestId("device-add-next").click();
  await expect(add).toContainText("Scan this with your phone's camera.");
  const code = (await add.getByTestId("device-add-code").getAttribute("data-code"))!;
  expect(code).toMatch(/^ghostly1z/);
  await expect(add.getByRole("button", { name: "Copy link" })).toBeVisible();

  // The phone's camera opens the link: a new start of the app, in capitals as a QR code holds it.
  const origin = new URL(phone.page.url()).origin;
  await phone.page.close();
  const page = await phone.context.newPage();
  await page.goto(`${origin}/#${code.toUpperCase()}`);
  const ask = page.getByTestId("device-join-another");
  await expect(ask).toContainText("Add this device to another profile?");
  // Out of the address, and so out of the history, at once.
  expect(page.url()).not.toMatch(/ghostly1z/i);
  await ask.getByTestId("device-join-another-go").click();

  // The new profile opens at the device's name, the code filled in: no scanner.
  const form = page.getByTestId("device-join-name-form");
  await expect(form).toHaveAttribute("data-code-given", "true");
  await page.getByTestId("device-join-name").fill("Phone");
  await page.getByTestId("device-join-next").click();

  const desktopDigits = add.getByTestId("device-add-digits");
  await expect(desktopDigits).toBeVisible();
  const digits = await desktopDigits.getAttribute("data-digits");
  await expect(page.getByTestId("device-join-digits")).toHaveAttribute("data-digits", digits!);
  await add.getByTestId("device-add-match").click();
  await expect(add.getByTestId("device-add-done")).toHaveText("Phone added. It is on standby.");
  await expect(page.getByTestId("device-join-done")).toHaveAttribute("data-step", "done");
  await page.getByTestId("device-join-continue").click();
  await expect(page.getByTestId("device-standby")).toHaveAttribute("data-state", "standby");

  // The phone's own profile still holds its chat, as it was, and the new profile is the only one that changed.
  const after = await chats(page);
  for (const [key, value] of Object.entries(before)) expect(after[key]).toBe(value);
  expect(page.url()).not.toMatch(/ghostly1z/i);
});

test("a phone in use with a group and no chat opens the QR code's link: the refusal in its own profile goes on to a new profile, code kept", { tag: ["@feature:devices.enroll"] }, async ({ peer }) => {
  const [desktop, phone] = await Promise.all([peer("desktop"), peer("phone", { mobile: true })]);

  // The phone is in use with a group only: the chat list has no 1:1 chat, so the link opens straight at the name here.
  await phone.page.getByTestId("sidebar-new-more").click();
  await phone.page.getByTestId("new-group").click();
  await phone.page.getByTestId("new-group-name").fill("Family");
  await phone.page.getByTestId("new-group-create").click();
  await phone.page.getByTestId("group-share-dialog").getByTestId("group-share-done").click();

  await desktop.page.goto("/#/profile");
  await desktop.page.getByTestId("device-add-open").click();
  const add = desktop.page.getByTestId("device-add");
  await add.getByTestId("device-add-password").fill(DEVICE_SET_PASSWORD);
  await add.getByTestId("device-add-password-again").fill(DEVICE_SET_PASSWORD);
  await add.getByTestId("device-add-next").click();
  const code = (await add.getByTestId("device-add-code").getAttribute("data-code"))!;

  const origin = new URL(phone.page.url()).origin;
  await phone.page.close();
  const page = await phone.context.newPage();
  await page.goto(`${origin}/#${code.toUpperCase()}`);
  await page.getByTestId("device-join-name").fill("Phone");
  await page.getByTestId("device-join-next").click();

  // The engine refuses this profile (it holds a group): no dead end, the ask-first sheet, and the code goes with it.
  const ask = page.getByTestId("device-join-another");
  await expect(ask).toContainText("Add this device to another profile?");
  await expect(page.getByTestId("device-join-error")).toHaveCount(0);
  await ask.getByTestId("device-join-another-go").click();
  await expect(page.getByTestId("device-join-name-form")).toHaveAttribute("data-code-given", "true");
  await page.getByTestId("device-join-name").fill("Phone");
  await page.getByTestId("device-join-next").click();

  const desktopDigits = add.getByTestId("device-add-digits");
  await expect(desktopDigits).toBeVisible();
  await expect(page.getByTestId("device-join-digits")).toHaveAttribute("data-digits", (await desktopDigits.getAttribute("data-digits"))!);
  await add.getByTestId("device-add-match").click();
  await expect(add.getByTestId("device-add-done")).toHaveText("Phone added. It is on standby.");
  await expect(page.getByTestId("device-join-done")).toHaveAttribute("data-step", "done");
});
