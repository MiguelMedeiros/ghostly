import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame } from "@playwright/test";
import { expect, test, type Peer } from "../support/fixtures";
import { STORE_URL, serveStore, testStore, type TestStore } from "../support/appStore";

/*
 * Linked files on the web (WISP 1200 · Linked files), on the e2e suite's build: an app granted `files` asks
 * `ghostly.files.pick`; the client, not the frame, asks with its own sheet, and the person's click there opens the
 * browser's picker. The app gets what the person picked, minus hidden files and what it did not ask for, and reads it
 * in ranges by the ids the client gave. Cancel answers `cancelled`.
 *
 * It runs the path Safari and Firefox take, a hidden `<input type=file>`, by taking the File System Access pickers away.
 * Chromium's path (`showDirectoryPicker`, the folder's handle kept in IndexedDB and read again after a restart) is not
 * here: Playwright cannot answer that picker, and its headless Chromium closes the whole browser when a page reads a
 * folder handle back from IndexedDB after a reload (measured 2026-10-13 with an origin-private folder's handle). The
 * unit tests cover it (apps/ui/src/test/apps/webFiles.test.ts), and it is a hand check in Chrome.
 */

/** The app: buttons that pick a folder, read the first file's start, and say what they got. */
const ENTRY = `<!doctype html><meta charset=utf-8><title>Reader</title><body style="font:16px system-ui">
<button id=pick>Pick</button> <button id=read>Read</button> <pre id=out></pre>
<script>
const out = document.getElementById("out");
let files = [];
document.getElementById("pick").addEventListener("click", () => {
  ghostly.files.pick({ folder: true, accept: ["txt"] }).then((picked) => {
    files = picked;
    out.textContent = JSON.stringify(picked.map((f) => [f.path, f.size, f.available, f.id.length]));
  }, (e) => { out.textContent = "refused " + e.message; });
});
document.getElementById("read").addEventListener("click", () => {
  ghostly.files.read(files[0].id, { offset: 6, length: 5 }).then((bytes) => {
    out.textContent = "read " + new TextDecoder().decode(bytes);
  }, (e) => { out.textContent = "refused " + e.message; });
});
</script>`;

async function install(peer: Peer, store: TestStore): Promise<void> {
  await peer.page.getByTestId("account-apps").click();
  await peer.page.getByTestId("apps-add").click();
  await peer.page.getByTestId("apps-add-url").fill(STORE_URL);
  await peer.page.getByTestId("apps-add-check").click();
  await peer.page.getByTestId("apps-add-store-confirm").click();
  await peer.page.getByTestId("app-store").filter({ hasText: store.storeName }).getByTestId("app-listing-install").click();
  await peer.page.getByTestId("app-install").getByTestId("app-install-confirm").click();
  await expect(peer.page.getByTestId("installed-app")).toContainText(store.title);
}

function appFrame(peer: Peer): Frame {
  const frame = peer.page.frames().find((f) => f.url().includes("app-frame"));
  if (!frame) throw new Error("no app frame");
  return frame;
}

test("an app granted files reads a folder the person picks through the client's sheet", { tag: ["@feature:apps.linked-files"] }, async ({ peer }) => {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-files-"));
  const films = join(dir, "Films");
  mkdirSync(join(films, ".hidden"), { recursive: true });
  writeFileSync(join(films, "a.txt"), "hello world");
  writeFileSync(join(films, "b.mp4"), "not asked for");
  writeFileSync(join(films, ".secret.txt"), "hidden");
  writeFileSync(join(films, ".hidden", "c.txt"), "hidden too");
  try {
    const store = await testStore({ permissions: ["files"], view: "full", title: "Reader", tagline: "Reads what you pick", entry: ENTRY });
    const ana = await peer("ana");
    // The input's path (Safari, Firefox): no File System Access pickers.
    await ana.context.addInitScript(() => { delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker; delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker; });
    await ana.page.reload();
    await serveStore(ana.context, store);
    await install(ana, store);
    await ana.page.getByTestId("installed-app").getByTestId("installed-app-open").click();
    await expect(ana.page.getByTestId("mini-app")).toBeVisible();
    await expect.poll(() => appFrame(ana).locator("#pick").count()).toBe(1);

    // Cancel first: the app hears `cancelled`.
    await appFrame(ana).locator("#pick").click();
    const sheet = ana.page.getByTestId("app-files-sheet");
    await expect(sheet).toContainText("Reader asks to read a folder");
    await sheet.getByTestId("app-files-cancel").click();
    await expect(sheet).toHaveCount(0);
    await expect(appFrame(ana).locator("#out")).toHaveText("refused cancelled");

    // Then the folder, through the browser's picker, which the sheet's button opens.
    await appFrame(ana).locator("#pick").click();
    const chooser = ana.page.waitForEvent("filechooser");
    await sheet.getByTestId("app-files-choose").click();
    await (await chooser).setFiles(films);
    await expect(appFrame(ana).locator("#out")).toHaveText(JSON.stringify([["Films/a.txt", 11, true, 22]]));
    await appFrame(ana).locator("#read").click();
    await expect(appFrame(ana).locator("#out")).toHaveText("read world");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

