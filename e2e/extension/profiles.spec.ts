import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { chat, say, type Peer } from "../support/fixtures";
import { expect, test } from "../support/extension";
import { pair } from "../support/paired";

/**
 * Local profiles in the extension (WISP 04). Its one peer runs in the offscreen document, so a switch
 * restarts that document on the other profile: what a contact reaches is the profile in use, and a
 * restored backup is a profile of its own the person can switch to (and back from).
 */
const PASSPHRASE = "an extension backup passphrase";

const profileName = (page: Page) => page.getByTestId("profile-name");
const rows = (page: Page) => page.getByTestId("profile-row");
const row = (page: Page, name: string) => rows(page).filter({ has: page.getByText(name, { exact: true }) });

async function openProfile(page: Page): Promise<void> {
  await page.evaluate(() => { location.hash = "#/profile"; });
  await expect(page.getByTestId("profile-page")).toBeVisible();
}

/** Switches from the Profile page; the app starts again as that profile. */
async function switchTo(page: Page, name: string): Promise<void> {
  await row(page, name).getByTestId("profile-switch").click();
  await expect(profileName(page)).toHaveValue(name, { timeout: 60_000 });
}

/** A profile's network settings are its own: point a new one at the test relay too, so nothing leaves the machine. */
async function useRelay(page: Page, relay: string): Promise<void> {
  await page.evaluate(() => { location.hash = "#/settings/advanced"; });
  await page.getByTestId("network-relays").fill(relay);
  await page.getByTestId("network-save").click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
}

async function openChatAt(peer: Peer, hash: string): Promise<void> {
  await peer.page.evaluate((h) => { location.hash = h; }, hash);
  await expect(chat(peer)).toBeVisible();
}

/** What a message from the contact proves: the peer running now holds this profile's keys. */
async function reaches(from: Peer, to: Peer, text: string): Promise<void> {
  await expect(async () => {
    await say(from, text);
    await expect(chat(to).getByText(text).first()).toBeVisible({ timeout: 20_000 });
  }).toPass({ timeout: 180_000 });
}

const databases = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).sort());

test("the extension keeps several profiles: create, switch, restore a backup into a new one, switch back, delete", {
  tag: ["@client:extension", "@client:web", "@feature:profiles.create", "@feature:profiles.switch", "@feature:profiles.switcher", "@feature:profiles.delete", "@feature:backup.profile.file", "@feature:extension.engine"],
}, async ({ extensionPeer, webPeer, relay }) => {
  test.setTimeout(10 * 60_000);
  const [ext, web] = await Promise.all([extensionPeer("ext-profiles"), webPeer("contact")]);
  const { page } = ext;
  const relayUrl = await relay.listen();

  // An install from before profiles: its one profile is the first, on the original names, no registry.
  expect(await page.evaluate(() => localStorage.getItem("ghostly_profiles"))).toBeNull();
  expect(await databases(page)).toContain("ghostly");

  // A contact, and something said, in the first profile.
  await pair(web, ext);
  const chatHash = new URL(page.url()).hash;
  await reaches(web, ext, "before the backup");
  await say(ext, "hi from the extension");
  await expect(chat(web).getByText("hi from the extension")).toBeVisible({ timeout: 60_000 });

  await openProfile(page);
  await profileName(page).fill("Pessoal");
  await profileName(page).press("Enter");
  await expect(page.getByTestId("account-profile")).toHaveAttribute("title", /Pessoal/);
  await expect(page.getByTestId("profile-links")).toContainText("1 chat");
  await expect(page.getByText("One profile only in this client, for now.")).toHaveCount(0);

  // Backed up to a file.
  const backups = page.getByTestId("profile-backups");
  await backups.getByTestId("backup-open").click();
  await backups.getByTestId("backup-passphrase").fill(PASSPHRASE);
  await backups.getByTestId("backup-confirm").fill(PASSPHRASE);
  const downloading = page.waitForEvent("download");
  await backups.getByTestId("backup-download").click();
  const file = await downloading;
  const bundle = readFileSync((await file.path())!);

  // A second profile: empty, on its own database, and the contact's chat is not in it.
  await page.getByTestId("profile-new").click();
  await page.getByTestId("profile-new-name").fill("Work");
  await page.getByTestId("profile-create").click();
  await expect(profileName(page)).toHaveValue("Work", { timeout: 60_000 });
  await expect(page.getByTestId("profile-links")).toContainText("0 chats");
  await expect(rows(page)).toHaveCount(2);
  const workId = await page.evaluate(() => (JSON.parse(localStorage.getItem("ghostly_profiles")!) as { active: string }).active);
  expect(workId).toMatch(/^[a-z0-9]{10}$/);
  // Its peer opens that profile's own database once the offscreen document has started again.
  await expect.poll(() => databases(page), { timeout: 60_000 }).toContain(`ghostly_${workId}`);
  await useRelay(page, relayUrl);
  await openProfile(page);

  // Back to the first: its chat, and the peer that answers the contact is the first profile's again.
  await switchTo(page, "Pessoal");
  await expect(page.getByTestId("profile-links")).toContainText("1 chat");
  await openChatAt(ext, chatHash);
  await expect(chat(ext).getByText("before the backup")).toBeVisible();
  await reaches(web, ext, "back home");

  // The backup restored: a new profile, and the extension switches to it, chat and history included.
  await openProfile(page);
  await backups.getByTestId("restore-open").click();
  await backups.getByTestId("restore-file").setInputFiles({ name: file.suggestedFilename(), mimeType: "application/json", buffer: bundle });
  await backups.getByTestId("restore-passphrase").fill(PASSPHRASE);
  await backups.getByTestId("restore-go").click();
  await expect(profileName(page)).toHaveValue("Pessoal (restored)", { timeout: 60_000 });
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByTestId("profile-links")).toContainText("1 chat");
  await openChatAt(ext, chatHash);
  await expect(chat(ext).getByText("before the backup")).toBeVisible();
  await expect(chat(ext).getByText("hi from the extension")).toBeVisible();
  await reaches(web, ext, "to the restored one");
  await say(ext, "restored and here");
  await expect(chat(web).getByText("restored and here")).toBeVisible({ timeout: 120_000 });

  // And back to the first profile, which still has its own.
  await openProfile(page);
  await switchTo(page, "Pessoal");
  await expect(rows(page)).toHaveCount(3);
  await openChatAt(ext, chatHash);
  await expect(chat(ext).getByText("back home").first()).toBeVisible();

  // The account bar's switcher does the same in one tap, and the peer follows it too.
  await page.getByTestId("account-profile-switcher").click();
  await page.getByTestId("profile-switcher").getByTestId("profile-switcher-item").filter({ hasText: "Pessoal (restored)" }).click();
  await expect(page.getByTestId("account-profile")).toHaveAttribute("title", /: Pessoal \(restored\)$/, { timeout: 60_000 });
  await openChatAt(ext, chatHash);
  await reaches(web, ext, "switched in one tap");
  await page.getByTestId("account-profile-switcher").click();
  await page.getByTestId("profile-switcher").getByTestId("profile-switcher-item").filter({ hasText: "Pessoal" }).filter({ hasNotText: "restored" }).click();
  await expect(page.getByTestId("account-profile")).toHaveAttribute("title", /: Pessoal$/, { timeout: 60_000 });

  // Another tab of the extension follows a switch made in this one: one peer, one profile in use.
  const other = await ext.context.newPage();
  await openProfile(page);
  await other.goto(page.url().replace(/#.*$/, "#/profile"));
  await expect(profileName(other)).toHaveValue("Pessoal");
  await switchTo(page, "Work");
  await expect(profileName(other)).toHaveValue("Work", { timeout: 60_000 });
  await switchTo(page, "Pessoal");
  await expect(profileName(other)).toHaveValue("Pessoal", { timeout: 60_000 });
  await other.close();

  // Deleting a profile: never the one in use; the other one goes with its database.
  await expect(row(page, "Pessoal").getByTestId("profile-delete")).toHaveCount(0);
  await row(page, "Work").getByTestId("profile-delete").click();
  const dialog = page.getByTestId("delete-profile");
  await dialog.getByTestId("delete-profile-confirm").fill("Work");
  await dialog.getByTestId("delete-profile-go").click();
  await expect(dialog).toBeHidden();
  await expect(rows(page)).toHaveCount(2);
  await expect.poll(() => databases(page)).not.toContain(`ghostly_${workId}`);
  expect(await databases(page)).toContain("ghostly");
});
