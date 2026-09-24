import { readFileSync } from "node:fs";
import { expect, test } from "../support/fixtures";
import { signS3 } from "../../packages/browser/src/backup/s3";

// WISP 05 / 1000 / 1002: a whole profile backed up to S3-compatible storage and to a file, and each
// restored as a new profile. Opt-in: a disposable local S3 server (MinIO) on GHOSTLY_S3_ENDPOINT.
const endpoint = process.env.GHOSTLY_S3_ENDPOINT ?? "";
const credentials = { region: "us-east-1", accessKeyId: process.env.GHOSTLY_S3_KEY ?? "", secretAccessKey: process.env.GHOSTLY_S3_SECRET ?? "" };
const bucket = `ghostly-e2e-${Date.now()}`;

test("a whole profile goes to S3 and to a file, and each comes back as a new profile", { tag: ["@feature:backup.profile.s3", "@feature:backup.profile.file", "@feature:backup.passphrase-rules", "@gated"] }, async ({ peer }) => {
  test.skip(!endpoint.startsWith("http://127.0.0.1:"), "Requires a disposable local S3 server");
  test.setTimeout(4 * 60_000);
  const url = new URL(`${endpoint}/${bucket}`);
  const created = await fetch(url, { method: "PUT", headers: await signS3({ method: "PUT", url }, credentials) });
  expect(created.ok, "test bucket").toBe(true);

  const { page } = await peer("profile-backup");
  await page.getByTitle("New Chat").click();
  await expect(page.getByTestId("invite-card")).toBeVisible();
  await page.getByTestId("account-profile").click();
  await page.getByTestId("account-nickname").fill("Backed Up");
  const backups = page.getByTestId("profile-backups");

  // S3 storage, set up and proven from the page.
  await backups.getByTestId("s3-setup").click();
  await backups.getByTestId("s3-endpoint").fill(endpoint);
  await backups.getByTestId("s3-bucket").fill(bucket);
  await backups.getByTestId("s3-accessKeyId").fill(credentials.accessKeyId);
  await backups.getByTestId("s3-secretAccessKey").fill(credentials.secretAccessKey);
  await backups.getByTestId("s3-save").click();
  await expect(backups.getByTestId("backup-done")).toContainText(`Connected · ${bucket}/ghostly`, { timeout: 30000 });

  await backups.getByTestId("backup-open").click();
  await backups.getByTestId("backup-passphrase").fill("an e2e backup passphrase");
  await backups.getByTestId("backup-confirm").fill("an e2e backup passphrase");
  await backups.getByTestId("backup-s3").click();
  await expect(backups.getByTestId("backup-done")).toContainText("Saved to S3", { timeout: 60000 });

  // And a file, the simplest place.
  await backups.getByTestId("backup-passphrase").fill("an e2e backup passphrase");
  await backups.getByTestId("backup-confirm").fill("an e2e backup passphrase");
  const downloading = page.waitForEvent("download");
  await backups.getByTestId("backup-download").click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^\d{8}T\d{6}Z-[a-z2-7]{8}\.ghostly-backup$/);
  const bundle = readFileSync((await download.path())!, "utf8");
  expect(bundle).not.toContain("Backed Up");
  expect(bundle).not.toContain(credentials.secretAccessKey);

  // Restore from S3: a new profile, with the chat and the name, and Ghostly switches to it.
  await backups.getByTestId("restore-open").click();
  await backups.getByRole("radio", { name: "S3" }).click();
  await backups.getByTestId("restore-list").click();
  await expect(backups.getByTestId("restore-pick").locator("option")).toHaveCount(1);
  await backups.getByTestId("restore-passphrase").fill("wrong passphrase here");
  await backups.getByTestId("restore-go").click();
  await expect(backups.getByTestId("backup-error")).toContainText("Wrong passphrase");
  await backups.getByTestId("restore-passphrase").fill("an e2e backup passphrase");
  await backups.getByTestId("restore-go").click();
  await expect(page.getByTestId("profile-name")).toHaveValue("Personal (restored)", { timeout: 60000 });
  await expect(page.getByTestId("profile-links")).toContainText("1 chat");
  await expect(page.getByTestId("account-nickname")).toHaveValue("Backed Up");
  await expect(page.getByTestId("profile-row")).toHaveCount(2);

  // Restore the file too: a third profile.
  await page.getByTestId("profile-backups").getByTestId("restore-open").click();
  await page.getByTestId("profile-backups").getByTestId("restore-file").setInputFiles({ name: download.suggestedFilename(), mimeType: "application/json", buffer: Buffer.from(bundle) });
  await page.getByTestId("profile-backups").getByTestId("restore-passphrase").fill("an e2e backup passphrase");
  await page.getByTestId("profile-backups").getByTestId("restore-go").click();
  await expect(page.getByTestId("profile-row")).toHaveCount(3, { timeout: 60000 });
  await expect(page.getByTestId("profile-links")).toContainText("1 chat");
});
