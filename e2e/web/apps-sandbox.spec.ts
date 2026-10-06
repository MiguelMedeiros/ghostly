import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { expect, test, type Page } from "@playwright/test";
import { ESCAPES, RTC_PROBES, appEntry, hitTags, startListeners, type Listeners, type ProbeTargets } from "../support/appsSandbox";
import { RUNNER_CSP } from "../../apps/web/runnerPolicy";

/**
 * The security floor of mini-apps on the web (WISP 1200 § Before phase 1 ships): a malicious app in the runner
 * (apps/web/public/app-frame.html) and the broker (apps/ui/src/lib/apps/broker.ts) tries every way out it knows, and
 * listeners in this process count what reaches them: an HTTP listener, a TCP one for preconnect, and a STUN (UDP) and
 * TURN (TCP) listener per WebRTC way. The same app with no runner around it is the control, so a 0 here means
 * something.
 *
 * The page carries the app's real policy (nginx-headers.conf; `vite preview` sends none), so the parent's `frame-src`
 * holds as it does in production. The suite's build runs apps through its test hook (VITE_APPS_TEST,
 * apps/ui/src/lib/apps/testHook.ts) on an in-memory host: the runner and the broker are the real ones.
 *
 * Chromium in the main suite; WebKit with `npm run test:e2e:webkit`, Firefox with
 * `npx playwright test -c e2e/playwright.firefox.config.ts`.
 */

const MAIN_CSP = /Content-Security-Policy "([^"]+)"/.exec(readFileSync(join(import.meta.dirname, "../../apps/web/nginx-headers.conf"), "utf8"))![1]!;
const EVIL = "evilpublisherkey/not-a-game";
const VICTIM = "honestpublisherkey/notes";

let listeners: Listeners;
test.beforeAll(async () => { listeners = await startListeners(); });
test.afterAll(async () => { await listeners?.close(); });

interface Hook {
  open(launch: { ref: string; version: string; title: string; permissions: string[]; entry: string; chat?: { linkId: string } | null }): number;
  status(handle: number): { phase: string; stopped: string | null };
  stored(ref: string, scope: string): Record<string, unknown>;
  calls(): { op: string; ref: string; scope?: string; key?: string }[];
  sent(): { linkId: string; ref: string; data: unknown }[];
  receive(linkId: string, frame: unknown): void;
  appId(linkId: string, ref: string): string;
  runnerAvailable(): Promise<boolean>;
}

/** The app's page with its production policy, the test hook loaded, and a watch on what reaches the page itself. */
async function appPage(page: Page): Promise<void> {
  await page.route((url) => url.pathname === "/" || url.pathname === "/index.html", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": MAIN_CSP } });
  });
  await page.goto("/");
  await page.waitForFunction(() => !!(window as unknown as { __ghostlyApps?: unknown }).__ghostlyApps, null, { timeout: 60_000 });
  await page.evaluate(() => {
    const heard: unknown[] = ((window as unknown as { __heard: unknown[] }).__heard = []);
    addEventListener("message", (event) => heard.push({ origin: event.origin, data: JSON.stringify(event.data).slice(0, 80) }));
    for (const name of ["ghostly", "ghostly-peer", "ghostly-oidc"]) new BroadcastChannel(name).onmessage = (event) => heard.push({ channel: name, data: String(event.data) });
  });
}

async function open(page: Page, ref: string, entry: string, extra: { permissions?: string[]; chat?: { linkId: string } } = {}): Promise<number> {
  return page.evaluate(({ ref, entry, extra }) => (window as unknown as { __ghostlyApps: Hook }).__ghostlyApps.open({ ref, version: "1.0.0", title: ref, permissions: extra.permissions ?? [], entry, chat: extra.chat ?? null }), { ref, entry, extra });
}

const stored = (page: Page, ref: string, scope = "alone") => page.evaluate(({ ref, scope }) => (window as unknown as { __ghostlyApps: Hook }).__ghostlyApps.stored(ref, scope), { ref, scope });
const status = (page: Page, handle: number) => page.evaluate((handle) => (window as unknown as { __ghostlyApps: Hook }).__ghostlyApps.status(handle), handle);

/** Hits per tag, for the report. */
const table = (hits: Map<string, number>) => Object.fromEntries([...hits].sort(([a], [b]) => a.localeCompare(b)));

test("control: the same app with no runner reaches the listeners by every way the runner closes", {
  tag: ["@feature:apps.web-sandbox"],
}, async ({ page, browserName }, testInfo) => {
  listeners.reset();
  const P: ProbeTargets & { victim: string } = { ...listeners.targets, victim: VICTIM };
  const stub = "<script>window.ghostly={context:async()=>({}),storage:{get:async()=>undefined,set:async(k,v)=>{if(k==='report')window.__report=v}},chat:{send:async()=>{}}};</script>";
  listeners.setControl(appEntry("net", P).replace("<head>", `<head>${stub}`));
  await page.goto(`${listeners.targets.http}/__control`);
  await page.waitForFunction(() => (window as unknown as { __report?: unknown }).__report, null, { timeout: 30_000 });
  await page.waitForTimeout(3_000);
  const tags = hitTags(listeners.hits);
  testInfo.annotations.push({ type: `control hits (${browserName})`, description: JSON.stringify(table(listeners.hits)) });
  // What reaches the network in every engine when nothing stops it: the floor the runner's zero is measured against.
  for (const tag of ["fetch", "xhr", "img", "css-background", "font", "script-src", "websocket", "eventsource", "beacon", "iframe-src", "import",
    "rtc-here", "srcdoc-static", "srcdoc-classic", "srcdoc-module", "srcdoc-later", "srcdoc-nested", "data-frame", "blob-frame", "re-policy", "handler-frame", "nonce-guess"]) {
    expect(tags, `control reaches ${tag}`).toContain(tag);
  }
});

test("a malicious app reaches nothing: no request, no WebRTC from any frame it makes, no nonce, no other app's data", {
  tag: ["@feature:apps.web-sandbox"],
}, async ({ page, context, browserName }, testInfo) => {
  await appPage(page);
  const url = page.url();
  listeners.reset();
  const victim = await open(page, VICTIM, appEntry("victim"));
  await expect.poll(() => stored(page, VICTIM)).toMatchObject({ ready: true });

  const evil = await open(page, EVIL, appEntry("net", { ...listeners.targets, victim: VICTIM }));
  await expect.poll(() => stored(page, EVIL), { timeout: 30_000 }).toHaveProperty("report");
  await page.waitForTimeout(4_000);
  const report = (await stored(page, EVIL)).report as { readings: Record<string, unknown>; errors: string[] };
  testInfo.annotations.push({ type: `runner hits (${browserName})`, description: JSON.stringify(table(listeners.hits)) });
  testInfo.annotations.push({ type: `readings (${browserName})`, description: JSON.stringify(report.readings) });

  // Nothing reached any listener: every HTTP way, preconnect, and WebRTC in the runner and in every frame.
  expect(table(listeners.hits)).toEqual({});

  const r = report.readings;
  expect(r.origin).toBe("null");
  expect(r.topIsSelf).toBe(false);
  expect(r.ghostly).toBe("chat,close,context,file,storage");
  expect(r.rtcNames).toBe("none");
  // The runner's nonce: not on the script, not in the markup, not in a violation report, not guessed.
  expect(r.nonceProperty).toBe("undefined");
  expect(r.nonceAttribute).toBe("null");
  expect(r.nonceInMarkup).toBe(false);
  expect(r.metaPolicies).toBe(0); // read before the app adds its own: the runner's policies leave no <meta> behind
  expect(r.found).toEqual([]);
  expect(r.guesses).toBe(0);
  expect(r.parentDocument).toBeUndefined();
  // The broker answered for this app only, whatever the request named.
  expect(r.otherSecret).toBeUndefined();
  expect(r.storageSet).toBe("ok");
  expect(r.context).toEqual({ version: "1.0.0", inChat: false, peer: null, theme: "dark", locale: "pt-BR" });
  expect(r.chatSend).toBe("refused: not-allowed");
  const calls = await page.evaluate(() => (window as unknown as { __ghostlyApps: Hook }).__ghostlyApps.calls());
  expect(calls.filter((c) => c.ref === VICTIM).map((c) => `${c.op} ${c.key ?? ""}`)).toEqual(["storage.set secret", "storage.set ready"]);
  expect(calls.filter((c) => c.ref !== VICTIM).every((c) => c.ref === EVIL && c.scope === "alone")).toBe(true);
  expect(await stored(page, VICTIM)).toEqual({ secret: "the victim's", ready: true });

  // Both apps still run; the page did not move, and no window opened.
  expect(await status(page, evil)).toEqual({ phase: "running", stopped: null });
  expect(await status(page, victim)).toEqual({ phase: "running", stopped: null });
  expect(page.url()).toBe(url);
  expect(context.pages()).toHaveLength(1);
  // What the app posted to the page is heard by nobody there: no listener of the app's took it, no channel reached.
  const heard = await page.evaluate(() => (window as unknown as { __heard: { channel?: string; origin?: string }[] }).__heard);
  expect(heard.filter((h) => h.channel)).toEqual([]);
  expect(heard.every((h) => h.origin === "null")).toBe(true);
});

test("ways out that take the page with them reach nothing, and a load the broker did not expect tears the app down", {
  tag: ["@feature:apps.web-sandbox"],
}, async ({ page, context, browserName }, testInfo) => {
  await appPage(page);
  const url = page.url();
  const outcome: Record<string, unknown> = {};
  for (const escape of ESCAPES) {
    await test.step(escape, async () => {
      listeners.reset();
      const ref = `evilpublisherkey/${escape}`;
      const handle = await open(page, ref, appEntry("escape", { ...listeners.targets, escape }));
      await expect.poll(() => stored(page, ref)).toMatchObject({ started: true });
      await page.waitForTimeout(2_500);
      const now = await status(page, handle);
      outcome[escape] = { ...now, hits: table(listeners.hits) };
      expect(table(listeners.hits), escape).toEqual({});
      expect(page.url(), escape).toBe(url);
      expect(context.pages(), escape).toHaveLength(1);
      // A reload and a document.open are loads the runner never asked for: the app is gone.
      if (escape === "nav-reload" || escape === "nav-document-open") expect(now, escape).toEqual({ phase: "stopped", stopped: "navigated" });
      // Otherwise the way was refused where it started (sandbox, policy) or became a load: running, or torn down.
      else expect([JSON.stringify({ phase: "running", stopped: null }), JSON.stringify({ phase: "stopped", stopped: "navigated" })], escape).toContain(JSON.stringify(now));
    });
  }
  testInfo.annotations.push({ type: `escapes (${browserName})`, description: JSON.stringify(outcome) });
});

test("the broker answers 50 requests a second and refuses one over 64 KiB", {
  tag: ["@feature:apps.web-sandbox"],
}, async ({ page }) => {
  await appPage(page);
  const ref = "evilpublisherkey/flood";
  const handle = await open(page, ref, appEntry("flood"));
  await expect.poll(() => stored(page, ref), { timeout: 30_000 }).toHaveProperty("report");
  const report = (await stored(page, ref)).report as { ok: number; refused: string[]; large: string };
  expect(report.ok).toBeGreaterThan(40);
  expect(report.ok).toBeLessThanOrEqual(50);
  expect(report.refused).toEqual(["too-fast"]);
  expect(report.large).toBe("too-large");
  expect((await stored(page, ref)).big).toBeUndefined();
  expect(await status(page, handle)).toEqual({ phase: "running", stopped: null });
});

test("an app in a chat talks to its contact's app through the broker, and keeps its data in that chat", {
  tag: ["@feature:apps.web-sandbox"],
}, async ({ page }) => {
  await appPage(page);
  const ref = "gamepublisherkey/echo";
  const linkId = "link-apps-1";
  const entry = `<!doctype html><title>echo</title><script>
    const g = window.ghostly;
    g.chat.on("peer", (p) => g.storage.set("peer", p));
    g.chat.on("message", (m) => g.storage.set("heard", m));
    g.context().then((c) => g.storage.set("context", c)).then(() => g.chat.send({ hello: "contact" }));
  </script>`;
  await open(page, ref, entry, { permissions: ["chat"], chat: { linkId } });
  await expect.poll(() => stored(page, ref, linkId)).toHaveProperty("context");
  expect((await stored(page, ref, linkId)).context).toMatchObject({ inChat: true, peer: null });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ghostlyApps: Hook }).__ghostlyApps.sent())).toEqual([{ linkId, ref, data: { hello: "contact" } }]);
  const app = await page.evaluate(({ linkId, ref }) => (window as unknown as { __ghostlyApps: Hook }).__ghostlyApps.appId(linkId, ref), { linkId, ref });
  await page.evaluate(({ linkId, app }) => { (window as unknown as { __ghostlyApps: Hook }).__ghostlyApps.receive(linkId, { app, o: "open", v: "1.1.0" }); (window as unknown as { __ghostlyApps: Hook }).__ghostlyApps.receive(linkId, { app, d: { move: "e7e5" } }); }, { linkId, app });
  await expect.poll(() => stored(page, ref, linkId)).toMatchObject({ peer: { open: true, version: "1.1.0" }, heard: { move: "e7e5" } });
  expect(await stored(page, ref)).toEqual({});
});

test("the runner refuses to run outside its sandboxed frame, and its server sends its policy", {
  tag: ["@feature:apps.web-sandbox"],
}, async ({ page, request }) => {
  const response = await request.get("/app-frame.html");
  expect(response.headers()["content-security-policy"]).toBe(RUNNER_CSP);
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  await page.goto("/app-frame.html");
  await expect(page.locator("html")).toHaveAttribute("data-ghostly-refused", "origin");
  await expect(page.locator("html")).toHaveText("This app cannot run here.");
  await appPage(page);
  expect(await page.evaluate(() => (window as unknown as { __ghostlyApps: Hook }).__ghostlyApps.runnerAvailable())).toBe(true);
  expect(RTC_PROBES.length).toBeGreaterThan(10);
});

test("Chess, as it is built, runs under the runner's lock", {
  tag: ["@feature:apps.web-sandbox", "@feature:apps.chess"],
}, async ({ page }) => {
  const out = mkdtempSync(join(tmpdir(), "ghostly-chess-"));
  try {
    const root = join(import.meta.dirname, "../../apps/mini/chess");
    await build({ configFile: join(root, "vite.config.ts"), root, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
    const entry = readFileSync(join(out, "index.html"), "utf8");
    await appPage(page);
    const ref = "chesspublisherkey/chess";
    await open(page, ref, entry, { permissions: ["chat"], chat: { linkId: "link-chess" } });
    const board = page.frameLocator(`iframe[data-app="${ref}"]`).locator(".board");
    await expect(board).toBeVisible();
    await expect(board.locator("button")).toHaveCount(64);
    // Its one script ran with the runner's nonce, and what it keeps went to its own scope in that chat.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __ghostlyApps: Hook }).__ghostlyApps.calls().filter((c) => c.ref === "chesspublisherkey/chess").every((c) => !c.scope || c.scope === "link-chess"))).toBe(true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
