import { readFileSync } from "node:fs";
import { expect, test } from "../support/fixtures";

// WISP 05: a whole profile backed up to a file, sealed with a passphrase, and restored as a new profile.
// Offline: no S3, no second peer.
const PASSPHRASE = "a file backup passphrase";

test("a profile goes to a file and comes back as a new profile, only with its passphrase", async ({ peer }) => {
  const { page } = await peer("backup-file");

  // A profile worth keeping: a name of its own, a chat and a nickname.
  await page.getByTitle("New Chat").click();
  await expect(page.getByTestId("invite-card")).toBeVisible();
  await page.getByTestId("account-profile").click();
  await expect(page.getByTestId("profile-page")).toBeVisible();
  await page.getByTestId("profile-name").fill("Diary");
  await page.getByTestId("profile-name").press("Enter");
  await expect(page.getByTestId("account-profile")).toHaveAttribute("title", /Diary/);
  await page.getByTestId("account-nickname").fill("Nick Kept Secret");
  await expect(page.getByTestId("profile-links")).toContainText("1 chat");
  const backups = page.getByTestId("profile-backups");

  // The passphrase rules: 12 characters or more, typed twice the same. Until then, nothing to download.
  await backups.getByTestId("backup-open").click();
  const download = backups.getByTestId("backup-download");
  await expect(download).toBeDisabled();
  await backups.getByTestId("backup-passphrase").fill("too short");
  await backups.getByTestId("backup-confirm").fill("too short");
  await expect(download, "a passphrase under 12 characters").toBeDisabled();
  await backups.getByTestId("backup-passphrase").fill(PASSPHRASE);
  await backups.getByTestId("backup-confirm").fill(`${PASSPHRASE}!`);
  await expect(download, "a passphrase that does not match its repeat").toBeDisabled();
  await backups.getByTestId("backup-confirm").fill(PASSPHRASE);
  await expect(download).toBeEnabled();

  // Downloaded: the page says so, and the file is a sealed bundle, the nickname nowhere in clear.
  const downloading = page.waitForEvent("download");
  await download.click();
  const file = await downloading;
  await expect(backups.getByTestId("backup-done")).toContainText(/Downloaded · \d+(\.\d)? (KB|MB)/);
  await expect(backups.getByTestId("backup-passphrase"), "the passphrase is not left in the page").toHaveValue("");
  expect(file.suggestedFilename()).toMatch(/\.ghostly-backup$/);
  const bundle = readFileSync((await file.path())!, "utf8");
  const envelope = JSON.parse(bundle) as { format: string; ciphertext: string };
  expect(envelope.format).toBe("ghostly-backup");
  expect(envelope.ciphertext.length).toBeGreaterThan(0);
  expect(bundle).not.toContain("Nick Kept Secret");
  expect(bundle).not.toContain("Diary");

  // Restoring with the wrong passphrase opens nothing and adds no profile.
  await backups.getByTestId("restore-open").click();
  await backups.getByTestId("restore-file").setInputFiles({ name: file.suggestedFilename(), mimeType: "application/json", buffer: Buffer.from(bundle) });
  await backups.getByTestId("restore-passphrase").fill("not the passphrase at all");
  await backups.getByTestId("restore-go").click();
  await expect(backups.getByTestId("backup-error")).toContainText("Wrong passphrase");
  await expect(page.getByTestId("profile-row")).toHaveCount(1);
  await expect(page.getByTestId("profile-name")).toHaveValue("Diary");

  // With the right one: a new profile, and Ghostly switches to it, chat and nickname included.
  await backups.getByTestId("restore-passphrase").fill(PASSPHRASE);
  await backups.getByTestId("restore-go").click();
  await expect(page.getByTestId("profile-name")).toHaveValue("Diary (restored)", { timeout: 60_000 });
  await expect(page.getByTestId("profile-links")).toContainText("1 chat");
  await expect(page.getByTestId("account-nickname")).toHaveValue("Nick Kept Secret");

  // The original is still there, and still has its own.
  const rows = page.getByTestId("profile-row");
  await expect(rows).toHaveCount(2);
  const original = rows.filter({ has: page.getByText("Diary", { exact: true }) });
  await expect(original).toHaveCount(1);
  await original.getByTestId("profile-switch").click();
  await expect(page.getByTestId("profile-name")).toHaveValue("Diary", { timeout: 30_000 });
  await expect(page.getByTestId("profile-links")).toContainText("1 chat");
  await expect(page.getByTestId("account-nickname")).toHaveValue("Nick Kept Secret");
});
