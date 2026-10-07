import http from "node:http";
import { test, expect, desktopWindows, type DesktopApp } from "../support/desktop";
import { STORE_URL, testStore } from "../support/appStore";

/*
 * Mini-apps on Desktop (WISP 1200, "Per client", Desktop row), on the e2e suite's build (VITE_APPS_TEST): Chess is
 * installed from a test store and opens in an app-* window of its own, on the ghostly-app runner, where it reaches the
 * broker in the Ghostly window and nothing else. WebDriver cannot route a request as Playwright does on the web, so
 * the store's files come from a local server the build's test fetcher reads (apps/ui/src/desktop/appsTestFetch.ts).
 */

/** What the app does once written: every broker call it may make, a request over 64 KiB, and two ways out. */
const PROBE = `<!doctype html><meta charset=utf-8><title>Chess</title><body style="font:16px system-ui"><h1>Chess</h1><pre id=out></pre>
<script>
(async () => {
  const out = {};
  try {
    const context = await ghostly.context();
    out.version = context.version;
    out.inChat = context.inChat;
    await ghostly.storage.set("board", { fen: "start" });
    out.stored = await ghostly.storage.get("board");
    out.keys = await ghostly.storage.keys();
    const file = await ghostly.file("index.html");
    out.file = file instanceof ArrayBuffer ? new TextDecoder().decode(file).includes("<title>Chess</title>") : typeof file;
    try { await ghostly.storage.set("big", "x".repeat(70000)); out.big = "stored"; } catch (e) { out.big = e.message; }
    try { await ghostly.chat.send({ move: "e4" }); out.send = "sent"; } catch (e) { out.send = e.message; }
    out.rtc = typeof RTCPeerConnection;
    out.origin = self.origin;
    try { await fetch("https://example.com/"); out.fetch = "fetched"; } catch (e) { out.fetch = "refused"; }
  } catch (e) { out.error = String((e && e.message) || e); }
  document.getElementById("out").textContent = JSON.stringify(out);
  document.body.dataset.done = "1";
})();
</script>`;

/** Serves the store's files at `/<host><path>`, as appsTestFetch asks for them; returns its address and what it was asked. */
async function storeServer(files: Map<string, Uint8Array>): Promise<{ base: string; asked: string[]; close: () => Promise<void> }> {
  const asked: string[] = [];
  const server = http.createServer((request, response) => {
    const url = `https:/${request.url ?? ""}`;
    asked.push(url);
    const body = files.get(url);
    response.writeHead(body ? 200 : 404, { "content-type": "application/octet-stream", "access-control-allow-origin": "*" });
    response.end(body ? Buffer.from(body) : "404: Not Found");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, asked, close: () => new Promise((done) => server.close(() => done())) };
}

/** Clicks the first element under `selector` whose text has `text` (the store's row among others). */
async function clickWithText(app: DesktopApp, selector: string, text: string): Promise<void> {
  await expect.poll(() => app.execute<boolean>(`
    const hit = [...document.querySelectorAll(arguments[0])].find((e) => e.textContent.includes(arguments[1]) && !e.disabled);
    if (hit) hit.click();
    return !!hit;`, selector, text)).toBe(true);
}

test("installs Chess from a store and opens it in an app window of its own, which reaches the broker and nothing else", { tag: ["@feature:apps.desktop-sandbox"] }, async ({ app }) => {
  const store = await testStore({ entry: PROBE });
  const server = await storeServer(store.files);
  try {
    await expect.poll(() => app.text('[title="New chat"]')).not.toBeNull();
    await app.execute("window.__ghostlyAppsStore = arguments[0]", server.base);

    // Apps shows on Desktop: Rust serves the runner with its policy, so nothing is asked of any server for it.
    await app.click('[data-testid="account-apps"]');
    await expect.poll(() => app.text('[data-testid="apps-page"]')).not.toBeNull();
    expect(server.asked).toEqual([]);
    await app.click('[data-testid="apps-add"]');
    await app.type('[data-testid="apps-add-url"]', STORE_URL);
    await app.click('[data-testid="apps-add-check"]');
    await expect.poll(() => app.text('[data-testid="apps-add-store"]')).toContain(store.storeName);
    await app.click('[data-testid="apps-add-store-confirm"]');
    await clickWithText(app, '[data-testid="app-store"] button[aria-expanded]', store.storeName);
    await expect.poll(() => app.text('[data-testid="app-listing-install"]')).not.toBeNull();
    await app.click('[data-testid="app-listing-install"]');
    await expect.poll(() => app.text('[data-testid="app-install"]')).toContain("Talk to the same app on your contact's side");
    await app.click('[data-testid="app-install-confirm"]');
    await expect.poll(() => app.text('[data-testid="installed-app"]')).toContain(store.title);

    // Open: a second window appears, and WebDriver can go to it.
    const windows = desktopWindows(app);
    const main = await windows.window();
    const before = await windows.windows();
    await app.click('[data-testid="installed-app-open"]');
    let appWindow: string | undefined;
    await expect.poll(async () => {
      appWindow = (await windows.windows()).find((handle) => !before.includes(handle));
      return appWindow;
    }, { message: "the app's own window, as WebDriver sees it" }).toBeDefined();
    await windows.switchTo(appWindow!);
    // The runner's address, under its sandbox: an opaque origin.
    expect(await app.execute<string>("return location.href")).toBe("ghostly-app://localhost/");
    await expect.poll(() => app.execute<string | null>("return document.body && document.body.dataset.done || null")).toBe("1");
    const out = JSON.parse((await app.text("#out")) ?? "{}") as Record<string, unknown>;
    expect(out).toEqual({
      version: "1.2.0",
      inChat: false,
      stored: { fen: "start" },
      keys: ["board"],
      file: true,
      // Refused in Rust, before the broker: the request is over 64 KiB.
      big: "too-large",
      // Opened alone, not in a chat.
      send: "not-allowed",
      rtc: "undefined",
      origin: "null",
      fetch: "refused",
    });
    // Nothing else may be called from here (only `app_broker`): the bridge refuses.
    const other = await app.executeAsync<string>(`
      const done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke("get_profile").then(() => done("answered"), (e) => done(String(e)));`);
    expect(other).toMatch(/not allowed/i);

    // The app closes itself: its window goes, and the Ghostly window is all there is again.
    await app.execute("ghostly.close()");
    await windows.switchTo(main);
    await expect.poll(() => windows.windows()).toEqual([main]);
    await expect.poll(() => app.text('[data-testid="installed-app"]')).toContain(store.title);
  } finally {
    await server.close();
  }
});
