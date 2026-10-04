import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, guardArchive, test } from "../support/fixtures";
import type { LocalRelay } from "../support/relay";

/**
 * The web app in a browser that lacks, refuses or breaks something it starts with: a phone, the address of a
 * privacy browser built on the system WebView. Each case removes or breaks one thing before the page loads and
 * checks that the page says something a person can act on. It used to be the app's dark background and nothing
 * else (an uncaught error before the first render), or an app that looked fine and never connected.
 *
 * Three outcomes:
 * - the app works without the thing (it is optional: service workers, push, notifications, persistence, OPFS);
 * - the app says it cannot run here and names what is missing (storage, IndexedDB, Web Crypto, Web Locks);
 * - the boot guard (apps/web/public/boot-guard.js, plain HTML outside React) says the app could not start, with
 *   "Copy details": an engine too old for the bundle, WebAssembly refused, a bundle that did not load.
 */

const ANDROID_WEBVIEW = "Mozilla/5.0 (Linux; Android 9; SM-G960F Build/PPR1.180610.011; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/92.0.4515.159 Mobile Safari/537.36";

const remove = (owner: string, name: string) => `try { delete ${owner}.${name}; Object.defineProperty(${owner}, "${name}", { value: undefined, configurable: true, writable: true }); } catch (e) {}`;
const denied = `new DOMException("denied", "SecurityError")`;
const getterThrows = (owner: string, name: string) => `Object.defineProperty(${owner}, "${name}", { get() { throw ${denied}; }, configurable: true });`;
const never = "new Promise(() => {})";

async function open(browser: Browser, relay: LocalRelay, baseURL: string | undefined, script: string, options: { userAgent?: string; prepare?: (context: BrowserContext) => Promise<unknown> } = {}): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const context = await browser.newContext({ baseURL, viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, ...(options.userAgent ? { userAgent: options.userAgent } : {}) });
  await guardArchive(context);
  await relay.attach(context);
  // Offline, as the rest of the suite: no Iroh relays.
  await context.addInitScript(() => { try { localStorage.setItem("ghostly-test-iroh", "off"); } catch { /* storage is what this case breaks */ } });
  if (script) await context.addInitScript(script);
  await options.prepare?.(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  return { page, context, errors };
}

const tags = { tag: ["@feature:app.boot"] };

// ---------- optional things: the app starts and works without them ----------

const OPTIONAL: [string, string][] = [
  ["service workers", remove("Navigator.prototype", "serviceWorker")],
  ["service workers that may not even be read", getterThrows("Navigator.prototype", "serviceWorker")],
  ["a service worker registration that throws", `if (navigator.serviceWorker) ServiceWorkerContainer.prototype.register = () => { throw ${denied}; };`],
  ["Notification and Push", remove("window", "Notification") + remove("window", "PushManager")],
  ["storage persistence", `if (navigator.storage) { StorageManager.prototype.persist = undefined; StorageManager.prototype.persisted = undefined; }`],
  ["a persistence request that never answers", `if (navigator.storage) { StorageManager.prototype.persist = () => ${never}; StorageManager.prototype.persisted = () => ${never}; }`],
  ["navigator.storage", remove("Navigator.prototype", "storage")],
  ["the origin private file system", `if (navigator.storage) StorageManager.prototype.getDirectory = undefined;`],
  ["BroadcastChannel", remove("window", "BroadcastChannel")],
  ["WebRTC", remove("window", "RTCPeerConnection") + remove("window", "webkitRTCPeerConnection")],
  ["WebAssembly", remove("window", "WebAssembly")],
  // What an Android WebView lacks next to Chrome, all at once.
  ["what an Android WebView lacks", remove("Navigator.prototype", "serviceWorker") + remove("window", "Notification") + remove("window", "PushManager") + `if (navigator.storage) { StorageManager.prototype.getDirectory = undefined; StorageManager.prototype.persist = undefined; }`],
];

for (const [what, script] of OPTIONAL) {
  test(`the app starts without ${what}`, tags, async ({ browser, relay, baseURL }) => {
    const { page, context } = await open(browser, relay, baseURL, script);
    await expect(page.getByTestId("sidebar")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTitle("New Chat")).toBeVisible();
    await expect(page.getByTestId("boot-fallback")).toHaveCount(0);
    await expect(page.getByTestId("unsupported-browser")).toHaveCount(0);
    await expect(page.getByTestId("app-error")).toHaveCount(0);
    await context.close();
  });
}

test("third-party requests that are blocked or never answered do not hold the first screen", tags, async ({ browser, baseURL }) => {
  for (const hang of [false, true]) {
    const context = await browser.newContext({ baseURL, viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
    // Everything that is not this origin: a tracker blocker cancels it, or it hangs.
    await context.route((url) => !/^(localhost|127\.0\.0\.1)$/.test(url.hostname), (route) => (hang ? undefined : route.abort("blockedbyclient")));
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByTestId("sidebar")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("boot-fallback")).toHaveCount(0);
    await context.close();
  }
});

test("Settings says this browser cannot wake the app, where there is no service worker", tags, async ({ browser, relay, baseURL }) => {
  const { page, context } = await open(browser, relay, baseURL, remove("Navigator.prototype", "serviceWorker") + remove("window", "Notification") + remove("window", "PushManager"));
  await expect(page.getByTestId("sidebar")).toBeVisible({ timeout: 20_000 });
  await page.goto("/#/settings/notifications");
  await expect(page.getByTestId("settings-wake-unavailable")).toContainText("This browser can't wake Ghostly while it's closed.");
  await expect(page.getByTestId("settings-wake")).toHaveCount(0);
  await expect(page.getByTestId("settings-system-notifications-row")).toContainText("Not available here");
  await context.close();
});

// ---------- things the app cannot run without: it says which ----------

const ESSENTIAL: [string, string, string, string][] = [
  ["Web Locks", remove("Navigator.prototype", "locks"), "locks", "Web Locks is missing"],
  ["a lock request that throws", `LockManager.prototype.request = () => { throw ${denied}; };`, "locks", "Web Locks is missing"],
  ["a lock request that is refused", `LockManager.prototype.request = () => Promise.reject(${denied});`, "locks", "Web Locks is missing"],
  ["IndexedDB", remove("window", "indexedDB"), "indexedDB", "IndexedDB is off or blocked"],
  ["an IndexedDB that refuses to open", `IDBFactory.prototype.open = () => { throw ${denied}; };`, "indexedDB", "IndexedDB is off or blocked"],
  ["Web Crypto", `Object.defineProperty(Crypto.prototype, "subtle", { value: undefined, configurable: true });`, "crypto", "Web Crypto is off"],
  ["site data (localStorage refused)", getterThrows("window", "localStorage"), "storage", "Site data is blocked"],
  ["localStorage", remove("window", "localStorage"), "storage", "Site data is blocked"],
];

for (const [what, script, id, sentence] of ESSENTIAL) {
  test(`without ${what} the app says it cannot run here, and what is missing`, tags, async ({ browser, relay, baseURL }) => {
    const { page, context } = await open(browser, relay, baseURL, script);
    const screen = page.getByTestId("unsupported-browser");
    await expect(screen).toBeVisible({ timeout: 20_000 });
    await expect(screen).toContainText("Ghostly can't run in this browser");
    await expect(page.getByTestId(`unsupported-${id}`)).toContainText(sentence);
    await expect(page.getByTestId("unsupported-details")).toHaveValue(new RegExp(`missing: .*${id}`));
    // Never the misleading screens, and the guard stays away: the app drew its own.
    await expect(page.getByText("already open in another tab")).toHaveCount(0);
    await expect(page.getByTestId("sidebar")).toHaveCount(0);
    await page.waitForTimeout(2500);
    await expect(page.getByTestId("boot-fallback")).toHaveCount(0);
    await context.close();
  });
}

test("the cannot-run screen speaks the profile's language, and its details hold no address fragment", tags, async ({ browser, relay, baseURL }) => {
  const { page, context } = await open(browser, relay, baseURL, remove("Navigator.prototype", "locks") + `try { localStorage.setItem("ghostly_app_settings", JSON.stringify({ language: "pt" })); } catch (e) {}`);
  await page.goto("/#/chat/not-for-the-report");
  await page.reload();
  await expect(page.getByTestId("unsupported-browser")).toContainText("O Ghostly não roda neste navegador");
  const details = await page.getByTestId("unsupported-details").inputValue();
  expect(details).toContain("locks=no");
  expect(details).toContain("browser: ");
  expect(details).not.toContain("not-for-the-report");
  await context.close();
});

test("a lock another tab holds is still \"open in another tab\", not an error", tags, async ({ browser, relay, baseURL }) => {
  const { page, context } = await open(browser, relay, baseURL, `LockManager.prototype.request = () => ${never};`);
  await expect(page.getByText("Ghostly is already open in another tab.")).toBeVisible({ timeout: 20_000 });
  // Past the guard's wait: that screen counts as the app having drawn.
  await page.waitForTimeout(8000);
  await expect(page.getByTestId("boot-fallback")).toHaveCount(0);
  await expect(page.getByTestId("unsupported-browser")).toHaveCount(0);
  await context.close();
});

// ---------- the boot guard: the app never drew ----------

const FATAL: [string, string][] = [
  // What an engine older than the bundle's floor fails on first (Chrome and WebView before 93, Safari before 15.4).
  ["an engine too old for the bundle (no Object.hasOwn)", `Object.hasOwn = undefined;`],
  ["WebAssembly that the browser refuses to compile", `WebAssembly.Module = function () { throw new WebAssembly.CompileError("refused"); }; for (const m of ["instantiate", "compile", "instantiateStreaming", "compileStreaming"]) WebAssembly[m] = () => Promise.reject(new WebAssembly.CompileError("refused"));`],
  ["no matchMedia", remove("window", "matchMedia")],
];

for (const [what, script] of FATAL) {
  test(`${what}: the page says Ghostly could not start, with details to copy`, tags, async ({ browser, relay, baseURL }) => {
    const { page, context, errors } = await open(browser, relay, baseURL, script, { userAgent: ANDROID_WEBVIEW });
    const fallback = page.getByTestId("boot-fallback");
    await expect(fallback).toBeVisible({ timeout: 20_000 });
    await expect(fallback).toHaveAttribute("data-reason", "error");
    await expect(fallback).toContainText("Ghostly could not start");
    await expect(fallback).toContainText("open Ghostly in another one");
    // An Android WebView below the bundle's floor: the update that helps is named.
    await expect(page.getByTestId("boot-fallback-hint")).toContainText("update Android System WebView");
    const details = await page.getByTestId("boot-fallback-details").inputValue();
    expect(details).toContain("reason: error");
    expect(details).toMatch(/error: \S/);
    expect(details).toContain("Chrome/92");
    expect(details).toMatch(/build: \d+\.\d+\.\d+ \S+/);
    expect(details).toMatch(/features: .*locks=yes/);
    expect(errors.length).toBeGreaterThan(0);
    await context.close();
  });
}

test("a bundle the browser cannot parse, or that does not load: the page says so", tags, async ({ browser, relay, baseURL }) => {
  for (const broken of ["syntax", "blocked"] as const) {
    const { page, context } = await open(browser, relay, baseURL, "", {
      prepare: (context) => context.route(/\/assets\/main-[^/]+\.js$/, (route) =>
        broken === "syntax" ? route.fulfill({ contentType: "text/javascript", body: "const tooNew = #{ never: valid };" }) : route.abort("blockedbyclient")),
    });
    const fallback = page.getByTestId("boot-fallback");
    await expect(fallback).toBeVisible({ timeout: 20_000 });
    await expect(fallback).toContainText("Ghostly could not start");
    const details = await page.getByTestId("boot-fallback-details").inputValue();
    expect(details).toMatch(broken === "syntax" ? /error: SyntaxError/ : /error: script did not load: main-/);
    await context.close();
  }
});

test("a page that loads and stays empty says it is taking long, in the browser's language", tags, async ({ browser, relay, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, locale: "pt-BR", permissions: ["clipboard-read", "clipboard-write"] });
  await relay.attach(context);
  // The bundle arrives and does nothing: no error to catch, nothing drawn.
  await context.route(/\/assets\/main-[^/]+\.js$/, (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  const page = await context.newPage();
  await page.goto("/#/chat/not-for-the-report");
  const fallback = page.getByTestId("boot-fallback");
  await expect(fallback).toBeVisible({ timeout: 20_000 });
  await expect(fallback).toHaveAttribute("data-reason", "timeout");
  await expect(fallback).toHaveAttribute("lang", "pt");
  await expect(fallback).toContainText("O Ghostly está demorando para iniciar");
  await expect(fallback.getByRole("button", { name: "Recarregar" })).toBeVisible();

  // Copy details: the report, on the clipboard, without the address's fragment.
  await page.getByTestId("boot-fallback-copy").click();
  await expect(page.getByTestId("boot-fallback-copy")).toHaveText("Copiado");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("Ghostly boot report");
  expect(copied).toContain("reason: timeout");
  expect(copied).not.toContain("not-for-the-report");
  await context.close();
});
