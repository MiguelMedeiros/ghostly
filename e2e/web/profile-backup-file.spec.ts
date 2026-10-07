import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { TEST_COINS, expect, getTestCoins, openProfilePage, openWallet, test, useTestnet } from "../support/fixtures";
import { choose } from "../support/select";
import { strangerInvoice } from "../support/bolt11";

// WISP 05: a whole profile backed up to a file, sealed with a passphrase, and restored as a new profile.
// Offline: no S3, no second peer.
const PASSPHRASE = "a file backup passphrase";
/**
 * In WebKit (playwright.webkit.config.ts) the profile is on disk, as a person's Safari or the desktop app's is: its
 * in-memory contexts keep no Blob in IndexedDB, which is where the app keeps pictures and voice messages.
 *
 * Playwright's WebKit keeps the origin-private file system of every such profile in one place of this machine
 * (`~/Library/WebKit/org.webkit.Playwright` on a Mac), not in the profile's folder: a test would find the files of
 * the one before it, and of every run before. So each starts by emptying it, and the WebKit config runs one test at
 * a time.
 */
const storage = (browserName: string) => (browserName === "webkit" ? { persistent: true, beforeOpen: emptyFileStorage } : {});
async function emptyFileStorage(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  await page.goto("/version.json");
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    for (const name of names) await root.removeEntry(name, { recursive: true });
  });
  await page.close();
}

test("a profile goes to a file and comes back as a new profile, only with its passphrase", { tag: ["@feature:backup.profile.file", "@feature:backup.profile.same-device", "@feature:backup.passphrase-rules", "@feature:backup.envelope", "@feature:profiles.switch"] }, async ({ peer, browserName }) => {
  const { page } = await peer("backup-file", storage(browserName));

  // A profile worth keeping: a name of its own, a chat and a nickname.
  await page.getByTitle("New Chat").click();
  await expect(page.getByTestId("invite-card")).toBeVisible();
  await openProfilePage(page);
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
  await expect(backups.getByTestId("backup-done")).toContainText(/Downloaded [\w-]+\.ghostly-backup · \d+(\.\d)? (KB|MB)/);
  await expect(backups.getByTestId("backup-passphrase"), "the passphrase is not left in the page").toHaveValue("");
  expect(file.suggestedFilename()).toMatch(/\.ghostly-backup$/);
  const bundle = readFileSync((await file.path())!);
  expect(headerOf(bundle)).toMatchObject({ format: "ghostly-backup", version: 2, protection: "passphrase", kdf: { name: "PBKDF2-SHA256", iterations: 600_000 }, cipher: { name: "AES-256-GCM" } });
  expect(bundle.toString("latin1")).not.toContain("Nick Kept Secret");
  expect(bundle.toString("latin1")).not.toContain("Diary");

  // Restoring with the wrong passphrase opens nothing and adds no profile.
  await backups.getByTestId("restore-open").click();
  await backups.getByTestId("restore-file").setInputFiles({ name: file.suggestedFilename(), mimeType: "application/octet-stream", buffer: bundle });
  await backups.getByTestId("restore-passphrase").fill("not the passphrase at all");
  await backups.getByTestId("restore-go").click();
  await expect(backups.getByTestId("backup-error")).toContainText("Wrong passphrase");
  await expect(page.getByTestId("profile-row")).toHaveCount(1);
  await expect(page.getByTestId("profile-name")).toHaveValue("Diary");

  // With the right one: the backup is of Diary, still on this device, so Ghostly warns before restoring anything.
  await backups.getByTestId("restore-passphrase").fill(PASSPHRASE);
  await backups.getByTestId("restore-go").click();
  const warning = backups.getByTestId("restore-same-device");
  await expect(warning).toContainText("This backup is “Diary”, which is on this device");
  await expect(warning).toContainText("Both would act as the same person to your contacts.");
  await expect(warning.getByTestId("restore-replace"), "the first profile cannot be removed").toHaveCount(0);
  await expect(page.getByTestId("profile-row")).toHaveCount(1);
  // A copy anyway: a new profile, and Ghostly switches to it, chat and nickname included.
  await warning.getByTestId("restore-copy").click();
  // The name field holds the name alone; "Restored" is a tag beside it.
  await expect(page.getByTestId("profile-restored-tag")).toHaveText("Restored", { timeout: 60_000 });
  await expect(page.getByTestId("profile-name")).toHaveValue("Diary");
  await expect(page.getByTestId("profile-links")).toContainText("1 chat");
  await expect(page.getByTestId("account-nickname")).toHaveValue("Nick Kept Secret");

  // The original is still there, and still has its own.
  const rows = page.getByTestId("profile-row");
  await expect(rows).toHaveCount(2);
  const original = rows.filter({ has: page.getByText("Diary", { exact: true }) });
  await expect(original).toHaveCount(1);
  await original.getByTestId("profile-switch").click();
  await expect(page.getByTestId("profile-restored-tag")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("profile-name")).toHaveValue("Diary");
  await expect(page.getByTestId("profile-links")).toContainText("1 chat");
  await expect(page.getByTestId("account-nickname")).toHaveValue("Nick Kept Secret");
});

// The first profile never renamed is called by the app's language. A backup made in Portuguese carried "Pessoal", and
// the restored copy kept it in English too: the backup now carries the built-in name, which every language translates.
test("the first profile never renamed, backed up in Portuguese and restored, is called by the language of the app", { tag: ["@feature:backup.profile.file", "@feature:app.i18n"] }, async ({ peer, browserName }) => {
  const { page } = await peer("backup-default-name", storage(browserName));
  await page.goto("/#/settings");
  await choose(page.getByTestId("settings-language"), "pt");
  // A chat, so the copy is of a profile still on this device: Ghostly asks first, and always the same way.
  await page.getByTitle("Nova conversa").click();
  await expect(page.getByTestId("invite-card")).toBeVisible();
  await openProfilePage(page);
  await expect(page.getByTestId("profile-name")).toHaveValue("Pessoal");

  const backups = page.getByTestId("profile-backups");
  await backups.getByTestId("backup-open").click();
  await backups.getByTestId("backup-passphrase").fill(PASSPHRASE);
  await backups.getByTestId("backup-confirm").fill(PASSPHRASE);
  const downloading = page.waitForEvent("download");
  await backups.getByTestId("backup-download").click();
  const file = await downloading;
  const bundle = readFileSync((await file.path())!);

  await backups.getByTestId("restore-open").click();
  await backups.getByTestId("restore-file").setInputFiles({ name: file.suggestedFilename(), mimeType: "application/octet-stream", buffer: bundle });
  await backups.getByTestId("restore-passphrase").fill(PASSPHRASE);
  await backups.getByTestId("restore-go").click();
  await expect(backups.getByTestId("restore-same-device")).toContainText("“Pessoal”");
  await backups.getByTestId("restore-copy").click();
  await expect(page.getByTestId("profile-restored-tag")).toHaveText("Restaurado", { timeout: 60_000 });
  await expect(page.getByTestId("profile-name")).toHaveValue("Pessoal");

  // The restored profile, now in English: its name follows.
  await page.goto("/#/settings");
  await choose(page.getByTestId("settings-language"), "en");
  await expect(page.getByTitle("New Chat")).toBeVisible();
  await openProfilePage(page);
  await expect(page.getByTestId("profile-restored-tag")).toHaveText("Restored");
  await expect(page.getByTestId("profile-name")).toHaveValue("Personal");
  await expect(page.getByTestId("profile-row").filter({ hasText: "Pessoal" })).toHaveCount(0);
});

// A restored profile holds the ecash of the day its backup was made. What the original spent afterwards still counted in
// the copy's balance, for good, and its payments failed with the mint's "Token already spent".
test("a restored copy's Cashu balance is what the mint still holds, and it pays", { tag: ["@feature:backup.profile.file", "@feature:backup.profile.same-device", "@feature:wallet.cashu.pay-invoice"] }, async ({ peer, browserName }) => {
  test.skip(!process.env.E2E_MINT_URL?.startsWith("http://127.0.0.1:"), "Requires an explicitly local fake mint (E2E_MINT_URL=http://127.0.0.1:…)");
  const alice = await peer("backup-cashu", storage(browserName));
  const page = alice.page;
  // A chat, so the copy is of a profile still on this device: Ghostly asks first, and always the same way.
  await page.getByTitle("New Chat").click();
  await expect(page.getByTestId("invite-card")).toBeVisible();
  await useTestnet(alice);
  await getTestCoins(alice);
  const balance = async () => Number(((await page.getByTestId("wallet-balance").textContent()) ?? "").match(/^([\d,]+)/)?.[1].replace(/,/g, "") ?? NaN);
  const pay = async (sats: number, note: string) => {
    await page.getByTestId("wallet-send").click();
    await page.getByTestId("wallet-pay-input").fill(strangerInvoice(sats, note));
    await page.getByRole("button", { name: `Pay ${sats.toLocaleString("en-US")} test sats` }).click();
    await page.getByTestId("wallet-pay-confirm").click();
    await expect(page.getByText("Paid.", { exact: true })).toBeVisible({ timeout: 30_000 });
  };
  await expect.poll(balance).toBe(TEST_COINS);

  // The backup, with all 10,000 test sats in it.
  await openProfilePage(page);
  const backups = page.getByTestId("profile-backups");
  await backups.getByTestId("backup-open").click();
  await backups.getByTestId("backup-passphrase").fill(PASSPHRASE);
  await backups.getByTestId("backup-confirm").fill(PASSPHRASE);
  const downloading = page.waitForEvent("download");
  await backups.getByTestId("backup-download").click();
  const file = await downloading;
  const bundle = readFileSync((await file.path())!);

  // Then the profile spends some of them.
  await openWallet(alice, "cashu-testnet");
  await pay(2000, "after the backup");
  await expect.poll(balance).toBeLessThan(TEST_COINS - 2000);

  // The copy: its wallet asks the mint, and what was spent since the backup is not in its balance.
  await openProfilePage(page);
  await backups.getByTestId("restore-open").click();
  await backups.getByTestId("restore-file").setInputFiles({ name: file.suggestedFilename(), mimeType: "application/octet-stream", buffer: bundle });
  await backups.getByTestId("restore-passphrase").fill(PASSPHRASE);
  await backups.getByTestId("restore-go").click();
  await backups.getByTestId("restore-same-device").getByTestId("restore-copy").click();
  await expect(page.getByTestId("profile-restored-tag")).toHaveText("Restored", { timeout: 60_000 });
  await openWallet(alice, "cashu-testnet");
  await expect.poll(balance).toBeLessThan(TEST_COINS - 2000);
  const held = await balance();
  expect(held, "what the original did not spend is still the copy's").toBeGreaterThan(600);
  // And what it shows is there to spend.
  await pay(500, "from the copy");
  await expect.poll(balance).toBeLessThan(held - 499);
});

/** The clear header of a bundle: its first line. */
function headerOf(bundle: Buffer): Record<string, unknown> {
  return JSON.parse(bundle.subarray(0, bundle.indexOf(10)).toString("utf8")) as Record<string, unknown>;
}

const MIB = 1024 * 1024;
/** Bytes that differ everywhere: the same in the page that stores them and in the test that checks them. */
const pattern = (length: number, seed: number) => { const out = Buffer.alloc(length); for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 17 + (i >> 8)) & 255; return out; };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** The files of the profile under test: pictures kept in the database, and one too large for it, kept in file storage. */
const SMALL = Array.from({ length: 40 }, (_, i) => ({ id: `seed-in-s${i}`, size: 150_000 + i * 1000, seed: i }));
const MID = [{ id: "seed-in-m0", size: 5 * MIB + 11, seed: 50 }, { id: "seed-in-m1", size: 6 * MIB, seed: 51 }];
const BIG = { id: "seed-in-big", size: 18 * MIB + 7, seed: 60 };
const EXPECTED = Object.fromEntries([...SMALL, ...MID, BIG].map((f) => [f.id, { size: f.size, digest: digest(pattern(f.size, f.seed)) }]));

/** Puts the files into the running profile's storage as the app keeps them: Blobs on records, a large file in pieces. */
async function seedFiles(page: Page): Promise<void> {
  await page.evaluate(async ({ blobs, big, step }) => {
    const pattern = (length: number, seed: number) => { const out = new Uint8Array(length); for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 17 + (i >> 8)) & 255; return out; };
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("ghostly"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const tx = db.transaction(["files", "fileChunks", "fileState"], "readwrite");
    for (const f of blobs) tx.objectStore("files").put({ id: f.id, linkId: "seed", direction: "in", createdAt: f.seed, blob: new Blob([pattern(f.size, f.seed)], { type: "image/png" }), metadata: { name: `${f.id}.png`, size: f.size, mime: "image/png", timestamp: f.seed } });
    const bytes = pattern(big.size, big.seed);
    for (let index = 0; index * step < big.size; index++) { const part = bytes.subarray(index * step, (index + 1) * step); tx.objectStore("fileChunks").put({ id: big.id, index, length: part.length, data: new Blob([part]) }); }
    tx.objectStore("files").put({ id: big.id, linkId: "seed", direction: "in", createdAt: big.seed, metadata: { name: "big.mp4", size: big.size, mime: "video/mp4", timestamp: big.seed } });
    tx.objectStore("fileState").put({ id: big.id, bytes: "idb", transfer: { state: "done", transferred: big.size, size: big.size } });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); });
    db.close();
  }, { blobs: [...SMALL, ...MID], big: BIG, step: MIB });
}

type Restored = Record<string, Record<string, { size: number; where: string; digest: string }>>;
/** Every stored file of every restored profile on this device: its size, where its bytes are, and their SHA-256. */
async function restoredFiles(page: Page): Promise<Restored> {
  return page.evaluate(async () => {
    const hex = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
    const wrap = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const out: Record<string, Record<string, { size: number; where: string; digest: string }>> = {};
    for (const { name } of await indexedDB.databases()) {
      if (!name?.startsWith("ghostly_")) continue;
      const db = await wrap(indexedDB.open(name));
      const files = await wrap(db.transaction("files").objectStore("files").getAll()) as { id: string; blob?: Blob; bytes?: string }[];
      const found: (typeof out)[string] = {};
      for (const file of files) {
        let bytes: ArrayBuffer, where: string;
        if (file.blob) { bytes = await file.blob.arrayBuffer(); where = `blob:${file.blob.type}`; }
        else if (file.bytes === "opfs") {
          const folder = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("ghostly-files")).getDirectoryHandle(name);
          bytes = await (await (await folder.getFileHandle(file.id)).getFile()).arrayBuffer(); where = "opfs";
        } else {
          const pieces = await wrap(db.transaction("fileChunks").objectStore("fileChunks").getAll(IDBKeyRange.bound([file.id, 0], [file.id, Infinity]))) as { data: Blob }[];
          bytes = await new Blob(pieces.map((piece) => piece.data)).arrayBuffer(); where = `pieces:${file.bytes}`;
        }
        found[file.id] = { size: bytes.byteLength, where, digest: await hex(bytes) };
      }
      db.close();
      out[name] = found;
    }
    return out;
  });
}
const whatCameBack = (profile: Restored[string]) => Object.fromEntries(Object.entries(profile).map(([id, f]) => [id, { size: f.size, digest: f.digest }]));

// A profile with files: pictures by the dozen and one file too large to keep in the database. The backup shows its
// progress, holds every byte, and restores them where the restoring browser keeps files. Then the same without a
// passphrase, made from the restored copy: its large file is read back from file storage this time.
test("a profile with many files and a large one is backed up with its progress and comes back byte for byte, with a passphrase and without", { tag: ["@feature:backup.profile.file", "@feature:backup.stream", "@feature:backup.progress", "@feature:backup.unprotected", "@feature:backup.profile.same-device"] }, async ({ peer, browserName }) => {
  test.setTimeout(6 * 60_000);
  const { page } = await peer("backup-files", storage(browserName));
  await page.getByTitle("New Chat").click();
  await expect(page.getByTestId("invite-card")).toBeVisible();
  await seedFiles(page);
  await openProfilePage(page);
  const backups = page.getByTestId("profile-backups");

  // What a backup holds, and what it does not, is said behind the ⓘ.
  await backups.getByTestId("row-info").first().click();
  await expect(backups).toContainText("files of any size");
  await expect(backups).toContainText("Not in it: S3 storage keys");

  await backups.getByTestId("backup-open").click();
  await backups.getByTestId("backup-passphrase").fill(PASSPHRASE);
  await backups.getByTestId("backup-confirm").fill(PASSPHRASE);
  const downloading = page.waitForEvent("download");
  await backups.getByTestId("backup-download").click();
  // The progress: a dialog with the stage, the file and the bytes, and a way to stop.
  const progress = page.getByTestId("backup-progress");
  await expect(progress).toBeVisible();
  await expect(progress.getByTestId("backup-progress-cancel")).toBeVisible();
  await expect(progress.getByTestId("backup-progress-files")).toHaveText(/^Files \d+ of 43$/);
  await expect(progress.getByTestId("backup-progress-bytes")).toHaveText(/ of 35\.\d MB$/);
  const file = await downloading;
  await expect(progress).toHaveCount(0);
  await expect(backups.getByTestId("backup-done")).toHaveText(/^Downloaded [\w-]+\.ghostly-backup · 35\.\d MB$/);
  const path = (await file.path())!;
  const total = Object.values(EXPECTED).reduce((sum, f) => sum + f.size, 0);
  expect(statSync(path).size, "every file's bytes are in the bundle").toBeGreaterThan(total);
  expect(statSync(path).size, "and little else: no base64, no second copy").toBeLessThan(total * 1.02 + MIB);
  expect(headerOf(readFileSync(path))).toMatchObject({ version: 2, protection: "passphrase" });

  // Restored from the file on disk, read in ranges: a copy of the profile, files and all.
  await backups.getByTestId("restore-open").click();
  await backups.getByTestId("restore-file").setInputFiles(path);
  await backups.getByTestId("restore-passphrase").fill(PASSPHRASE);
  await backups.getByTestId("restore-go").click();
  await backups.getByTestId("restore-same-device").getByTestId("restore-copy").click();
  await expect(page.getByTestId("profile-restored-tag")).toHaveText("Restored", { timeout: 120_000 });
  await expect(page.getByTestId("profile-links")).toContainText("1 chat");
  let first: Restored = {};
  await expect(async () => { first = await restoredFiles(page); expect(Object.keys(first)).toHaveLength(1); }).toPass({ timeout: 60_000 });
  const [copy] = Object.values(first);
  expect(whatCameBack(copy)).toEqual(EXPECTED);
  expect(copy["seed-in-s3"].where).toBe("blob:image/png");
  expect(copy["seed-in-m1"].where).toBe("blob:image/png");
  // Over 16 MiB: in this browser's file storage, under the new profile's own space, not in a database record.
  expect(copy[BIG.id].where).toBe("opfs");

  // The copy, backed up without a passphrase: chosen, warned about, confirmed.
  const again = page.getByTestId("profile-backups");
  await again.getByTestId("backup-open").click();
  await again.getByRole("radio", { name: "No passphrase" }).click();
  await expect(again.getByTestId("backup-unprotected-warning")).toHaveText("Not encrypted" + "Anyone with the file gets your keys, chats and money.");
  await expect(again.getByTestId("backup-unprotected-mainnet"), "no real money in this profile").toHaveCount(0);
  await expect(again.getByTestId("backup-download")).toBeDisabled();
  await again.getByTestId("backup-unprotected-confirm").check();
  const second = page.waitForEvent("download");
  await again.getByTestId("backup-download").click();
  const open = (await (await second).path())!;
  await expect(again.getByTestId("backup-done")).toContainText("Downloaded");
  expect(headerOf(readFileSync(open))).toEqual({ format: "ghostly-backup", version: 2, protection: "none", check: { name: "SHA-256-chain" } });

  // Restoring it asks for no passphrase and says the file was not protected.
  await again.getByTestId("restore-open").click();
  await again.getByTestId("restore-file").setInputFiles(open);
  await expect(again.getByTestId("restore-unprotected")).toHaveText("This backup has no passphrase. Anyone who had the file could read it.");
  await expect(again.getByTestId("restore-passphrase")).toHaveCount(0);
  await again.getByTestId("restore-go").click();
  await again.getByTestId("restore-same-device").getByTestId("restore-copy").click();
  await expect(page.getByTestId("profile-row")).toHaveCount(3, { timeout: 120_000 });
  // The app starts again on the new profile: asked again if the page was still changing.
  await expect(async () => {
    const all = await restoredFiles(page);
    expect(Object.keys(all)).toHaveLength(2);
    for (const profile of Object.values(all)) expect(whatCameBack(profile)).toEqual(EXPECTED);
  }).toPass({ timeout: 60_000 });
});

// Cancel: the backup stops, nothing is downloaded, and nothing of it stays in the browser's storage. A damaged file
// is refused in words, and adds no profile.
test("a cancelled backup saves nothing, and a damaged file restores nothing", { tag: ["@feature:backup.progress", "@feature:backup.stream"] }, async ({ peer, browserName }) => {
  test.setTimeout(6 * 60_000);
  const { page } = await peer("backup-cancel", storage(browserName));
  await seedFiles(page);
  await openProfilePage(page);
  const backups = page.getByTestId("profile-backups");
  await backups.getByTestId("backup-open").click();
  await backups.getByTestId("backup-passphrase").fill(PASSPHRASE);
  await backups.getByTestId("backup-confirm").fill(PASSPHRASE);
  let downloads = 0;
  page.on("download", () => { downloads += 1; });
  await backups.getByTestId("backup-download").click();
  await page.getByTestId("backup-progress-cancel").click();
  await expect(page.getByTestId("backup-progress")).toHaveCount(0);
  await expect(backups.getByTestId("backup-done")).toHaveText("Cancelled. Nothing was saved.");
  await expect(backups.getByTestId("backup-passphrase"), "the passphrase stays, to try again").toHaveValue(PASSPHRASE);
  // No copy of the half-made bundle is left where it was being staged.
  const staged = await page.evaluate(async () => {
    const names: string[] = [];
    try {
      const folder = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("ghostly-files")).getDirectoryHandle("ghostly");
      for await (const name of (folder as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    } catch { /* no folder: nothing staged */ }
    return names.filter((name) => name.startsWith("save-"));
  });
  expect(staged).toEqual([]);
  expect(downloads).toBe(0);

  // Made whole this time, then damaged on disk: a byte changed, and the file cut short.
  const downloading = page.waitForEvent("download");
  await backups.getByTestId("backup-download").click();
  const bundle = readFileSync((await (await downloading).path())!);
  await expect(backups.getByTestId("backup-done")).toContainText("Downloaded");
  const changed = Buffer.from(bundle); changed[Math.floor(bundle.length * 0.9)] ^= 1;
  // Cut inside the large file, which comes first in the bundle: the restore is writing it to file storage when the file ends.
  const cutInLarge = bundle.subarray(0, 8 * MIB);
  const foldersBefore = await fileFolders(page);
  await backups.getByTestId("restore-open").click();
  for (const damaged of [changed, bundle.subarray(0, bundle.length - 1000), cutInLarge]) {
    await backups.getByTestId("restore-file").setInputFiles({ name: "damaged.ghostly-backup", mimeType: "application/octet-stream", buffer: damaged });
    await backups.getByTestId("restore-passphrase").fill(PASSPHRASE);
    await backups.getByTestId("restore-go").click();
    // Its first frames are whole, so it opens and is recognised as this profile's; the damage is met while restoring.
    await backups.getByTestId("restore-same-device").getByTestId("restore-copy").click();
    await expect(backups.getByTestId("backup-error")).toHaveText("This backup is damaged" + "Try another copy of the file.", { timeout: 120_000 });
    await expect(page.getByTestId("profile-row")).toHaveCount(1);
    expect(Object.keys(await restoredFiles(page)), "what the restore had written is gone").toEqual([]);
    expect(await fileFolders(page), "and so is the large file it was writing to file storage").toEqual(foldersBefore);
  }
});

/** The profile folders in this browser's file storage (the origin-private file system), by name. */
async function fileFolders(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const names: string[] = [];
    try {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("ghostly-files");
      for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    } catch { /* no folder yet */ }
    return names.sort();
  });
}
