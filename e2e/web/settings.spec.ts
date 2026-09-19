import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../support/fixtures";

const version = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "web", "package.json"), "utf8")).version;

test("shows the version being released", async ({ peer }) => {
  test.skip(!!process.env.E2E_WEB_URL, "a deployed app may be on another version");
  const { page } = await peer("alice");
  await page.getByTitle("Settings").click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText(version, { exact: true })).toBeVisible();
});

test("the nickname is kept, and can be made up", async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings");
  const nick = page.getByPlaceholder("Enter your nickname...");
  await nick.fill("Casper");
  await page.reload();
  await expect(nick).toHaveValue("Casper");
  await page.getByTitle("Generate random name").click();
  await expect(nick).not.toHaveValue("Casper");
  await expect(nick).not.toHaveValue("");
});

test("color theme and mode apply at once and survive a reload", async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings");
  const html = page.locator("html");
  await page.getByRole("button", { name: /Purple/ }).click();
  await expect(html).toHaveAttribute("data-color-theme", "purple");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(html).toHaveAttribute("data-color-theme", "purple");
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: /Monochrome/ }).click();
  await expect(html).toHaveAttribute("data-color-theme", "monochrome");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
});

test("the language changes the interface", async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings");
  await page.locator("select").first().selectOption("pt");
  await expect(page.getByTitle("Nova Conversa")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Configurações" })).toBeVisible();
  await page.reload();
  await expect(page.getByTitle("Nova Conversa")).toBeVisible();
  await page.locator("select").first().selectOption("en");
  await expect(page.getByTitle("New Chat")).toBeVisible();
});

test("reduce motion is a switch", async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings");
  const reduce = page.getByRole("switch", { name: "Reduce motion" });
  await expect(reduce).toHaveAttribute("aria-checked", "false");
  await reduce.click();
  await expect(reduce).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", /.*/);
  const sounds = page.getByRole("switch", { name: "Notification sounds" });
  await expect(sounds).toHaveAttribute("aria-checked", "true");
  await sounds.click();
  await expect(sounds).toHaveAttribute("aria-checked", "false");
  await page.reload();
  await expect(sounds).toHaveAttribute("aria-checked", "false");
});

test("lock screen: a password locks the app, only it unlocks it", async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings");
  await page.getByRole("switch", { name: "Lock Screen" }).click();
  const passwords = page.locator("input[type=password]");

  await passwords.nth(0).fill("boo");
  await passwords.nth(1).fill("boo");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Password must be at least 4 characters")).toBeVisible();

  await passwords.nth(0).fill("spooky");
  await passwords.nth(1).fill("spookier");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Passwords do not match")).toBeVisible();

  await passwords.nth(1).fill("spooky");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Password set successfully")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Lock Screen" })).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Lock Now" }).click();
  await expect(page.getByText("Ghostly is locked")).toBeVisible();
  await page.getByPlaceholder("Password").fill("wrong");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Incorrect password, try again")).toBeVisible();
  await expect(page.getByText("Ghostly is locked")).toBeVisible();
  await page.getByPlaceholder("Password").fill("spooky");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Ghostly is locked")).toHaveCount(0);

  // Removing it asks for the current one.
  await page.goto("/#/settings");
  await passwords.nth(0).fill("wrong");
  await page.getByRole("button", { name: "Remove password" }).click();
  await expect(page.getByText("Incorrect password")).toBeVisible();
  await passwords.nth(0).fill("spooky");
  await page.getByRole("button", { name: "Remove password" }).click();
  await expect(page.getByText("Password removed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Lock Now" })).toHaveCount(0);
});

test("lock screen: locks by itself after the chosen idle time", async ({ peer }) => {
  const { page } = await peer("alice");
  await page.clock.install();
  await page.goto("/#/settings");
  await page.getByRole("switch", { name: "Lock Screen" }).click();
  const passwords = page.locator("input[type=password]");
  await passwords.nth(0).fill("spooky");
  await passwords.nth(1).fill("spooky");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Password set successfully")).toBeVisible();
  await page.locator("select").filter({ hasText: "1 minute" }).selectOption("1");
  await page.clock.runFor(30_000);
  await expect(page.getByText("Ghostly is locked")).toHaveCount(0);
  await page.clock.runFor(45_000);
  await expect(page.getByText("Ghostly is locked")).toBeVisible();
});

test("network: relays can be changed and reset", async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings");
  const relays = page.getByTestId("network-relays");
  await expect(relays).toHaveValue("https://pkarr.pubky.org\nhttps://pkarr.pubky.app");
  await relays.fill("https://relay.example.org/\nnot a url");
  await page.getByTestId("network-save").click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  // Kept normalized, and what is not a URL is dropped.
  await expect(relays).toHaveValue("https://relay.example.org");
  await page.getByRole("button", { name: "Reset to defaults" }).click();
  await page.getByTestId("network-save").click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(relays).toHaveValue("https://pkarr.pubky.org\nhttps://pkarr.pubky.app");
});
