import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { expect, test, type TestInfo } from "@playwright/test";
import { desktopPerson, type DesktopPerson } from "../matrix/people";
import { HYPERDHT_TESTNET } from "../matrix/desktop";
import { forgetSharedData, openMacDesktop, type MacDesktop } from "../support/desktopMac";
import { HeadlessBot } from "../support/headless";
import { LocalRelay } from "../support/relay";

/**
 * What a contact's shared web app kept on the Mac (its localStorage, an IndexedDB database, a Cache Storage entry) goes
 * when the chat is deleted and on Clear all data, as on the web and on Linux. The app opens on Desktop in a viewer
 * window on `ghostly-svc://<service>.<peer>.<tag>/` (apps/desktop/src/viewer.rs), sharing the Ghostly window's
 * WKWebsiteDataStore: what it writes lands under `~/Library/WebKit/<bundle id>/WebsiteData/`, in folders whose `origin`
 * file names that origin, so the contact's key and the chat's tag. The test reads those folders as WebKit left them.
 *
 *   npm run desktop:macos:build
 *   npm run test:e2e:desktop-macos -- services-forget
 */

// 49790-49799: this test's ports.
const PORTS = { relay: 49791, dht: 49792, a: 49795 };
const NAME = "forget";

/** A web app on the bot's machine that keeps one of each kind of storage, then says so. */
async function keepingApp(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Keeper</title><p id="out">…</p><script>
        localStorage.setItem("probe-k", "1");
        const open = indexedDB.open("probe-db", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("s");
        open.onsuccess = () => {
          const tx = open.result.transaction("s", "readwrite");
          tx.objectStore("s").put("v", "k");
          tx.oncomplete = () => { open.result.close(); caches.open("probe-cache").then((c) => c.put("/probe", new Response("x"))).then(() => { document.getElementById("out").textContent = "kept"; }, (e) => { document.getElementById("out").textContent = "kept, no caches: " + e; }); };
        };
      </script>`);
    } else {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not here");
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { server, port: (server.address() as AddressInfo).port };
}

/** Where WebKit keeps what this copy's pages stored (support/desktopMac.ts `libraryPaths`). */
const webKitFolders = (bundleId: string) => [join(homedir(), "Library", "WebKit", bundleId), join(homedir(), "Library", "Caches", bundleId)];

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (folder: string) => {
    let names: string[];
    try { names = readdirSync(folder); } catch { return; }
    for (const name of names) {
      const path = join(folder, name);
      let isDir: boolean;
      try { isDir = statSync(path).isDirectory(); } catch { continue; }
      if (isDir) walk(path); else found.push(path);
    }
  };
  walk(dir);
  return found.sort();
}

/** Every file of the copy's WebKit data, by its path under ~/Library. */
const listing = (bundleId: string) => webKitFolders(bundleId).flatMap(filesUnder).map((f) => relative(join(homedir(), "Library"), f));

/** What the Keeper app writes: its localStorage key, its database's name and its cache's. */
const KEPT = ["probe-k", "probe-db", "probe-cache"];

/** Whether the file at `file` (under ~/Library) holds one of `words`, in ASCII or UTF-16. */
function holds(file: string, words: string[]): boolean {
  let bytes: Buffer;
  try { bytes = readFileSync(join(homedir(), "Library", file)); } catch { return false; }
  return words.some((word) => bytes.includes(Buffer.from(word, "latin1")) || bytes.includes(Buffer.from(word, "utf16le")));
}

/** The files that name `host` (`<service>.<peer>.<tag>`), by their path or by their bytes (ASCII or UTF-16). */
function naming(bundleId: string, host: string): string[] {
  return listing(bundleId).filter((file) => file.toLowerCase().includes(host.toLowerCase()) || holds(file, [host]));
}

test("on a Mac, deleting the chat and Clear all data erase what a contact's app kept", {
  tag: ["@client:desktop", "@feature:services.desktop-viewer", "@feature:services.open", "@feature:chat.paired.storage", "@feature:app.clear-data"],
}, async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "macOS only: the system WKWebView");
  test.setTimeout(8 * 60_000);
  const relay = new LocalRelay();
  const { default: testnet } = (await import(HYPERDHT_TESTNET)) as { default: (size: number, opts?: { port?: number }) => Promise<{ bootstrap: { host: string; port: number }[]; destroy(): Promise<void> }> };
  const dht = await testnet(3, { port: PORTS.dht });
  const relayUrl = await relay.listen(PORTS.relay);
  const bootstrap = dht.bootstrap.map((node) => `${node.host}:${node.port}`).join(",");
  const env = { GHOSTLY_PKARR_RELAYS: relayUrl, GHOSTLY_HYPERDHT_BOOTSTRAP: bootstrap };
  // The bot's processes inherit this: the same HyperDHT network as the app.
  process.env.GHOSTLY_HYPERDHT_BOOTSTRAP = bootstrap;
  const keeper = await keepingApp();
  const bot = new HeadlessBot();
  const apps: MacDesktop[] = [];
  let person: DesktopPerson | undefined;
  forgetSharedData();
  const keep = async (info: TestInfo, name: string, body: string) => {
    writeFileSync(info.outputPath(name), body);
    await info.attach(name, { path: info.outputPath(name), contentType: "text/plain" });
  };
  try {
    await bot.start(relayUrl, "Keeper bot");
    await bot.run("service", "add", "Keeper", `http://127.0.0.1:${keeper.port}`);
    person = await desktopPerson("a", {
      env,
      open: async () => {
        // Opened again on what it kept (the next launch's cleanup): the same copy's WebKit data.
        const desktop = await openMacDesktop({ name: NAME, port: PORTS.a, env, keepData: apps.length > 0 });
        apps.push(desktop);
        return { app: desktop.app, stop: () => desktop.stop({ keep: true }) };
      },
    });
    const app = person;
    const bundleId = () => apps.at(-1)!.bundleId;

    /** A chat with the bot, its Keeper app opened from it once, kept its storage and closed. The origin's host. */
    const openedOnce = async (label: string): Promise<string> => {
      const invite = await bot.run("invite", "create", "--label", label);
      await app.join(invite.link as string);
      await expect.poll(() => app.canWrite(), { timeout: 120_000 }).toBe(true);
      await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
      await bot.run("service", "share", "keeper", invite.chat as string);
      const driver = apps.at(-1)!.app;
      await expect.poll(() => app.app.text('[data-testid="open-service"]'), { timeout: 120_000, message: "the app sees the bot's Keeper in the chat" }).toContain("Keeper");
      const before = new Set(await driver.windows());
      await app.app.click('[data-testid="open-service"]');
      let window = "";
      await expect.poll(async () => (window = (await driver.windows()).find((w) => !before.has(w)) ?? ""), { timeout: 30_000, message: "Keeper opens in a window" }).not.toBe("");
      const viewer = driver.in(window);
      await expect.poll(() => viewer.text("#out").catch(() => null), { timeout: 90_000, message: "Keeper kept its storage" }).toMatch(/^kept/);
      const host = await viewer.execute<string>(`return location.host;`);
      expect(host).toMatch(/^keeper\.[a-z0-9]{52}\.[a-z0-9]{16}$/);
      // Left open: forgetting the origin closes it (a window still showing the app would go on writing there).
      viewerWindow = window;
      return host;
    };

    let viewerWindow = "";
    /** The files naming `host` after `what`, kept in the report, then the same after the app was quit and opened again. */
    const gone = async (what: string, host: string, before: string[], beforeAll: string[]) => {
      // The page forgets in the background, after the chat or the data went: the app's window closes first.
      await expect.poll(async () => (await apps.at(-1)!.app.windows()).includes(viewerWindow), { timeout: 30_000, message: `${what}: the app's window closed` }).toBe(false);
      // Its folders: the ones whose `origin` file names it.
      const folders = [...new Set(before.filter((f) => f.endsWith("/origin")).map((f) => f.slice(0, -"/origin".length)))];
      const inFolders = () => listing(bundleId()).filter((f) => folders.some((d) => f.startsWith(d + "/")));
      // At once: what the app kept is gone from its folder (the folder itself, still held by WebKit, waits for the next launch).
      const kept = () => inFolders().filter((f) => /\/(LocalStorage|IndexedDB)\//.test(f) || holds(f, KEPT));
      await expect.poll(kept, { timeout: 30_000 }).toEqual([]).catch(() => {});
      const keptNow = kept(), now = naming(bundleId(), host), inFoldersNow = inFolders();
      testInfo.annotations.push({ type: `${what}: files naming the origin at once`, description: JSON.stringify(now) });
      await app.away().then((back) => back());
      const relaunched = naming(bundleId(), host);
      await keep(testInfo, `${what}-listing.txt`, [
        `origin: ghostly-svc://${host}`,
        "--- before, naming it ---", ...before,
        "--- before, every file ---", ...beforeAll,
        "--- at once after, naming it ---", ...now,
        "--- at once after, in its folders ---", ...inFoldersNow,
        "--- after the next launch, naming it ---", ...relaunched,
        "--- after the next launch, every file ---", ...listing(bundleId()),
      ].join("\n"));
      expect(keptNow, `${what}: at once, no localStorage or IndexedDB file, nor a file holding what it kept, is left in its folder`).toEqual([]);
      expect(relaunched, `${what}: no file names the contact's app after the next launch`).toEqual([]);
    };

    await test.step("Delete chat: the app's storage goes with it", async () => {
      const host = await openedOnce("chat");
      const before = naming(bundleId(), host);
      const beforeAll = listing(bundleId());
      testInfo.annotations.push({ type: "chat: files naming the origin before", description: JSON.stringify(before) });
      // What the test reads must be there before it can show it gone.
      expect(before.length, JSON.stringify(listing(bundleId()))).toBeGreaterThan(0);
      await app.app.click('[data-testid="chat-options"]');
      await app.press("Delete chat");
      await app.press("Delete chat", "dialog[open]");
      await expect.poll(() => app.app.execute<number>(`return document.querySelectorAll('[data-testid="chat-row"]').length;`), { timeout: 30_000 }).toBe(0);
      await gone("delete-chat", host, before, beforeAll);
    });

    await test.step("Clear all data: the storage of the apps the profile opened goes", async () => {
      const host = await openedOnce("clear");
      const before = naming(bundleId(), host);
      const beforeAll = listing(bundleId());
      expect(before.length).toBeGreaterThan(0);
      await app.go("#/settings");
      await app.app.click('[data-testid="clear-all-data"]');
      await app.app.click('[data-testid="clear-all-data-confirm"]');
      await expect.poll(() => app.app.text('[title="New chat"]'), { timeout: 60_000 }).not.toBeNull();
      await gone("clear-all-data", host, before, beforeAll);
    });
  } catch (error) {
    if (person) await keep(testInfo, "app-page.txt", await person.snapshot().catch((e: unknown) => String(e)));
    await bot.attachLogs(testInfo);
    throw error;
  } finally {
    for (const d of apps) await keep(testInfo, `${d.bundleId}-log-${apps.indexOf(d)}.txt`, d.log.join(""));
    // The running copy first, then the ones it was opened again from (the same bundle id, already quit): each goes
    // with everything it stored.
    for (const d of [...apps].reverse()) await d.stop();
    await bot.stop();
    forgetSharedData();
    keeper.server.close();
    relay.close();
    await dht.destroy();
  }
});
