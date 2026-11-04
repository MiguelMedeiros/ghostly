import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame } from "@playwright/test";
import { chat, expect, test, type Peer } from "../support/fixtures";
import { STORE_URL, serveStore, testStore } from "../support/appStore";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";

/*
 * The read lane (WISP 1200 § A read lane to the contact: `app-ranges/1`), between two web clients of the e2e suite's
 * build: Ana's app serves a file she picked (`ghostly.files.serve`) and tells Bob's app its serve id in its own
 * `chat.send`; Bob's app reads the whole file with `ghostly.remote.stat` and `remote.read`, in ranges of 1 MiB, over
 * the chat's session and not through `apps/1`. While it serves, Ana's panel says so in its header; when Bob closes the
 * app, the serve ends with it.
 */

/** Ana's side picks and serves; Bob's reads every byte and says how many, with a checksum of them. */
const ENTRY = `<!doctype html><meta charset=utf-8><title>Cinema</title><body style="font:16px system-ui">
<button id=serve>Serve</button> <pre id=peer>closed</pre> <pre id=out></pre>
<script>
const out = document.getElementById("out");
ghostly.chat.on("peer", (p) => { document.getElementById("peer").textContent = p.open ? "open" : "closed"; });
ghostly.context().then((c) => { if (c.peer) document.getElementById("peer").textContent = "open"; });
document.getElementById("serve").addEventListener("click", async () => {
  try {
    const [film] = await ghostly.files.pick({ accept: ["bin"] });
    const serve = await ghostly.files.serve(film.id);
    await ghostly.chat.send({ serve });
    out.textContent = "serving " + film.size;
  } catch (e) { out.textContent = "refused " + e.message; }
});
ghostly.chat.on("message", async (m) => {
  try {
    const { size } = await ghostly.remote.stat(m.serve);
    let sum = 0, read = 0;
    while (read < size) {
      const bytes = new Uint8Array(await ghostly.remote.read(m.serve, { offset: read, length: Math.min(1048576, size - read) }));
      for (const b of bytes) sum = (sum * 31 + b) >>> 0;
      read += bytes.length;
    }
    out.textContent = "got " + read + " " + sum;
  } catch (e) { out.textContent = "refused " + e.message; }
});
</script>`;

const SIZE = 3 * 1024 * 1024 + 12_345;
const FILM = Buffer.from(Uint8Array.from({ length: SIZE }, (_, i) => (i * 7 + (i >> 11)) & 0xff));
const CHECKSUM = FILM.reduce((sum, b) => (sum * 31 + b) >>> 0, 0);

function appFrame(peer: Peer): Frame {
  const frame = peer.page.frames().find((f) => f.url().includes("app-frame"));
  if (!frame) throw new Error("no app frame");
  return frame;
}
const frameShows = (peer: Peer, selector: string) => expect.poll(() => peer.page.frames().find((f) => f.url().includes("app-frame"))?.locator(selector).count() ?? 0);

async function setNickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

test("Bob's app reads, in ranges, a file Ana's app serves in their chat, and Ana's header says she shares it", {
  tag: ["@feature:apps.ranges.wire", "@feature:apps.linked-files"],
}, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const dir = mkdtempSync(join(tmpdir(), "ghostly-ranges-"));
  const film = join(dir, "film.bin");
  writeFileSync(film, FILM);
  try {
    const store = await testStore({ permissions: ["chat", "files"], title: "Cinema", tagline: "Films with a contact", entry: ENTRY });
    const [ana, bob] = await Promise.all([peer("ana"), peer("bob")]);
    // The input's path: Playwright cannot answer the File System Access pickers.
    await ana.context.addInitScript(() => { delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker; delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker; });
    await ana.page.reload();
    await Promise.all([serveStore(ana.context, store), serveStore(bob.context, store)]);
    await setNickname(ana, "Ana");
    await setNickname(bob, "Bob");

    await ana.page.getByTestId("account-apps").click();
    await ana.page.getByTestId("apps-add").click();
    await ana.page.getByTestId("apps-add-url").fill(STORE_URL);
    await ana.page.getByTestId("apps-add-check").click();
    await ana.page.getByTestId("apps-add-store-confirm").click();
    await ana.page.getByTestId("app-store").filter({ hasText: store.storeName }).getByTestId("app-listing-install").click();
    await ana.page.getByTestId("app-install").getByTestId("app-install-confirm").click();
    await expect(ana.page.getByTestId("installed-app")).toContainText("Cinema");
    await ana.page.goto("/#/");
    await pair(ana, bob);
    await (await composerRow(ana.page, "composer-apps")).click();
    await ana.page.getByTestId("chat-apps").getByTestId("chat-app-open").click();
    await frameShows(ana, "#serve").toBe(1);

    // Bob installs it from Ana's card and opens it: both sides have it open.
    await chat(bob).getByTestId("app-card").getByTestId("app-card-install").click();
    await bob.page.getByTestId("app-install").getByTestId("app-install-confirm").click();
    await frameShows(bob, "#out").toBe(1);
    await expect(appFrame(ana).locator("#peer")).toHaveText("open", { timeout: 30_000 });

    const sheet = ana.page.getByTestId("app-files-sheet");
    await appFrame(ana).locator("#serve").click();
    const chooser = ana.page.waitForEvent("filechooser");
    await sheet.getByTestId("app-files-choose").click();
    await (await chooser).setFiles(film);
    await expect(appFrame(ana).locator("#out")).toHaveText(`serving ${SIZE}`);
    await expect(ana.page.getByTestId("mini-app-with")).toHaveText("sharing a file with Bob");

    // Every byte, in four reads of at most 1 MiB, the same as on Ana's disk.
    await expect(appFrame(bob).locator("#out")).toHaveText(`got ${SIZE} ${CHECKSUM}`, { timeout: 60_000 });

    // Bob closes the app: Ana's serve ends with it, and her header says so.
    await bob.page.getByTestId("mini-app").getByTestId("mini-app-close").click();
    await expect(ana.page.getByTestId("mini-app-with")).toHaveText("with Bob");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
