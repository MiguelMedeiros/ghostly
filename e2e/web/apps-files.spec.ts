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
 * in ranges by the ids the client gave. Cancel answers `cancelled`, and a pick at once after it `too-fast`.
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
    // The runner's frame attaches a moment after the panel shows: until then there is nothing to count, not an error.
    await expect.poll(() => ana.page.frames().find((f) => f.url().includes("app-frame"))?.locator("#pick").count() ?? 0).toBe(1);

    // The folder, through the browser's picker, which the sheet's button opens.
    const sheet = ana.page.getByTestId("app-files-sheet");
    await appFrame(ana).locator("#pick").click();
    await expect(sheet).toContainText("Reader asks to read a folder");
    const chooser = ana.page.waitForEvent("filechooser");
    await sheet.getByTestId("app-files-choose").click();
    await (await chooser).setFiles(films);
    await expect(appFrame(ana).locator("#out")).toHaveText(JSON.stringify([["Films/a.txt", 11, true, 22]]));
    await appFrame(ana).locator("#read").click();
    await expect(appFrame(ana).locator("#out")).toHaveText("read world");

    // The sheet is modal: Tab and Shift+Tab stay on its buttons, never on the app's Close or frame under the backdrop.
    await appFrame(ana).locator("#pick").click();
    await expect(sheet).toBeVisible();
    const inSheet = () => ana.page.evaluate(() => !!document.activeElement?.closest("[data-testid=app-files-sheet]"));
    for (const key of ["Tab", "Tab", "Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
      await ana.page.keyboard.press(key);
      expect(await inSheet(), key).toBe(true);
    }
    // The app stops while the sheet is up: the sheet goes with it, and no picker opens for an app that is gone.
    // A tick later, so the evaluate answers before the frame goes.
    await appFrame(ana).evaluate(() => { setTimeout(() => (window as unknown as { ghostly: { close(): void } }).ghostly.close(), 0); });
    await expect(ana.page.getByTestId("mini-app")).toHaveCount(0);
    await expect(sheet).toHaveCount(0);
    await ana.page.getByTestId("installed-app").getByTestId("installed-app-open").click();
    await expect.poll(() => ana.page.frames().find((f) => f.url().includes("app-frame"))?.locator("#pick").count() ?? 0).toBe(1);

    // Cancel: the app hears `cancelled`, and asking again at once is `too-fast`, so the picker does not come straight
    // back in front of the person who closed it.
    await appFrame(ana).locator("#pick").click();
    await sheet.getByTestId("app-files-cancel").click();
    await expect(sheet).toHaveCount(0);
    await expect(appFrame(ana).locator("#out")).toHaveText("refused cancelled");
    await appFrame(ana).locator("#pick").click();
    await expect(appFrame(ana).locator("#out")).toHaveText("refused too-fast");
    await expect(sheet).toHaveCount(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

