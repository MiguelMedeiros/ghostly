import type { Page } from "@playwright/test";
import { expect, openProfilePage, test } from "../support/fixtures";

// WISP 05: a device with no room left for a backup or a restore says so in words a person can act on, and keeps
// nothing of what it could not finish. Chromium only: the room is taken away through its DevTools protocol.
const PASSPHRASE = "a file backup passphrase";
// A few words, then what to do (lib/problemText.ts): the notice reads the two as one text.
const NO_ROOM = "No room for this backup" + "Free some space, then try again.";
const MIB = 1024 * 1024;
const SMALL = [{ id: "seed-in-s0", size: 150_000 }, { id: "seed-in-s1", size: 200_000 }];
/** Too large to keep in the database: in pieces here, and written to file storage by a restore. */
const BIG = { id: "seed-in-big", size: 18 * MIB + 7 };

async function seedFiles(page: Page): Promise<void> {
  await page.evaluate(async ({ blobs, big, step }) => {
    const pattern = (length: number, seed: number) => { const out = new Uint8Array(length); for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 17 + (i >> 8)) & 255; return out; };
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("ghostly"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const tx = db.transaction(["files", "fileChunks", "fileState"], "readwrite");
    blobs.forEach((f, i) => tx.objectStore("files").put({ id: f.id, linkId: "seed", direction: "in", createdAt: i, blob: new Blob([pattern(f.size, i)], { type: "image/png" }), metadata: { name: `${f.id}.png`, size: f.size, mime: "image/png", timestamp: i } }));
    const bytes = pattern(big.size, 60);
    for (let index = 0; index * step < big.size; index++) { const part = bytes.subarray(index * step, (index + 1) * step); tx.objectStore("fileChunks").put({ id: big.id, index, length: part.length, data: new Blob([part]) }); }
    tx.objectStore("files").put({ id: big.id, linkId: "seed", direction: "in", createdAt: 60, metadata: { name: "big.mp4", size: big.size, mime: "video/mp4", timestamp: 60 } });
    tx.objectStore("fileState").put({ id: big.id, bytes: "idb", transfer: { state: "done", transferred: big.size, size: big.size } });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); });
    db.close();
  }, { blobs: SMALL, big: BIG, step: MIB });
}

/** What this origin holds now: its usage, what is staged of a backup, and its profile databases. */
async function held(page: Page): Promise<{ usage: number; staged: number; databases: string[] }> {
  return page.evaluate(async () => {
    let staged = 0;
    try {
      const folder = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("ghostly-files")).getDirectoryHandle("ghostly");
      for await (const [name, handle] of (folder as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }).entries()) if (name.startsWith("save-")) staged += (await handle.getFile()).size;
    } catch { /* no folder: nothing staged */ }
    const databases = (await indexedDB.databases()).map((d) => d.name ?? "").filter((name) => name.startsWith("ghostly_")).sort();
    return { usage: (await navigator.storage.estimate()).usage ?? 0, staged, databases };
  });
}

test("a device with no room left says so, for a backup and for a restore, and keeps nothing of either", { tag: ["@feature:backup.stream", "@feature:backup.progress"] }, async ({ peer, browserName }) => {
  test.skip(browserName !== "chromium", "The room is taken away through Chromium's DevTools protocol");
  test.setTimeout(6 * 60_000);
  // A backup made on a device with room, to restore on the one without.
  const maker = (await peer("backup-room-maker")).page;
  await seedFiles(maker);
  await openProfilePage(maker);
  const made = maker.getByTestId("profile-backups");
  await made.getByTestId("backup-open").click();
  await made.getByTestId("backup-passphrase").fill(PASSPHRASE);
  await made.getByTestId("backup-confirm").fill(PASSPHRASE);
  const downloading = maker.waitForEvent("download");
  await made.getByTestId("backup-download").click();
  const bundle = (await (await downloading).path())!;
  await expect(made.getByTestId("backup-done")).toContainText("Downloaded");

  // The device without: eight megabytes left, and a profile whose backup needs nineteen.
  const { page, context } = await peer("backup-room");
  await seedFiles(page);
  await openProfilePage(page);
  const backups = page.getByTestId("profile-backups");
  const devtools = await context.newCDPSession(page);
  const origin = new URL(page.url()).origin;
  await devtools.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: (await held(page)).usage + 8 * MIB });

  // A backup is staged in file storage as it is made: there is no room for all of it.
  let downloads = 0;
  page.on("download", () => { downloads += 1; });
  await backups.getByTestId("backup-open").click();
  await backups.getByTestId("backup-passphrase").fill(PASSPHRASE);
  await backups.getByTestId("backup-confirm").fill(PASSPHRASE);
  await backups.getByTestId("backup-download").click();
  await expect(backups.getByTestId("backup-error")).toHaveText(NO_ROOM, { timeout: 120_000 });
  await expect(page.getByTestId("backup-progress")).toHaveCount(0);
  await expect(backups.getByTestId("backup-passphrase"), "the passphrase stays, to try again").toHaveValue(PASSPHRASE);
  expect((await held(page)).staged, "no half-written bundle is left where it was being staged").toBe(0);
  expect(downloads).toBe(0);

  // A restore runs out while it writes the large file to file storage.
  await backups.getByTestId("restore-open").click();
  await backups.getByTestId("restore-file").setInputFiles(bundle);
  await backups.getByTestId("restore-passphrase").fill(PASSPHRASE);
  await backups.getByTestId("restore-go").click();
  await expect(backups.getByTestId("backup-error")).toHaveText(NO_ROOM, { timeout: 120_000 });
  await expect(page.getByTestId("profile-row")).toHaveCount(1);
  expect((await held(page)).databases, "the database the restore had made is gone").toEqual([]);
  await devtools.send("Storage.overrideQuotaForOrigin", { origin });
});
