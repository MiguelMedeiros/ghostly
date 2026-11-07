import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ESCAPES, HISTORY_WAYS, PRECONNECT_PROBES, RTC_PROBES, appEntry, hitTags, startListeners, type Listeners, type ProbeTargets } from "../support/appsSandbox";
import { chessEntryHtml } from "../support/chessFixture";
import { RUNNER_CSP } from "../../apps/web/runnerPolicy";

/**
 * The security floor of mini-apps on the web (WISP 1200 § Before phase 1 ships): a malicious app in the runner
 * (apps/web/public/app-frame.html) and the broker (apps/ui/src/lib/apps/broker.ts) tries every way out it knows, and
 * listeners in this process count what reaches them: an HTTP listener, a TCP one per preconnect way, and a STUN (UDP) and
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
  open(launch: { ref: string; version: string; title: string; permissions: string[]; entry: string; chat?: { linkId: string } | null; files?: Record<string, string>; unguarded?: boolean }): number;
  status(handle: number): { phase: string; stopped: string | null };
  inputs(): number;
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

async function open(page: Page, ref: string, entry: string, extra: { permissions?: string[]; chat?: { linkId: string }; files?: Record<string, string>; unguarded?: boolean } = {}): Promise<number> {
  return page.evaluate(({ ref, entry, extra }) => (window as unknown as { __ghostlyApps: Hook }).__ghostlyApps.open({ ref, version: "1.0.0", title: ref, permissions: extra.permissions ?? [], entry, chat: extra.chat ?? null, files: extra.files, unguarded: extra.unguarded }), { ref, entry, extra });
}

const stored = (page: Page, ref: string, scope = "alone") => page.evaluate(({ ref, scope }) => (window as unknown as { __ghostlyApps: Hook }).__ghostlyApps.stored(ref, scope), { ref, scope });
const inputs = (page: Page) => page.evaluate(() => (window as unknown as { __ghostlyApps: Hook }).__ghostlyApps.inputs());
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

  // Nothing reached any listener: every HTTP way, every preconnect way, and WebRTC in the runner and in every frame.
  expect(table(listeners.hits)).toEqual({});

  const r = report.readings;
  expect(r.origin).toBe("null");
  expect(r.topIsSelf).toBe(false);
  // Every app sees the same API; what it was not granted is refused (chat and files below).
  expect(r.ghostly).toBe("chat,close,context,file,files,remote,storage");
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
  expect(r.filesList).toBe("refused: not-allowed");
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

test("the nonce lock alone (the runner without its hint guard): no frame the app makes reaches WebRTC; in WebKit preconnect still connects", {
  tag: ["@feature:apps.web-sandbox"],
}, async ({ page, browserName }, testInfo) => {
  // The hint guard keeps the app's frames out before the lock is reached. The e2e build also serves the runner
  // without it, so this measures the lock (and what is left without the guard) on its own.
  await appPage(page);
  listeners.reset();
  const ref = "evilpublisherkey/lock-alone";
  await open(page, ref, appEntry("net", { ...listeners.targets, victim: VICTIM }), { unguarded: true });
  await expect.poll(() => stored(page, ref), { timeout: 30_000 }).toHaveProperty("report");
  await page.waitForTimeout(4_000);
  const report = (await stored(page, ref)).report as { readings: Record<string, unknown> };
  testInfo.annotations.push({ type: `lock alone hits (${browserName})`, description: JSON.stringify(table(listeners.hits)) });
  testInfo.annotations.push({ type: `lock alone readings (${browserName})`, description: JSON.stringify(report.readings) });
  const preconnect = new Set<string>(PRECONNECT_PROBES);
  // Every frame kind was made (the guard is off), and none ran a script: 0 WebRTC hits, 0 HTTP hits, no nonce.
  expect(table(new Map([...listeners.hits].filter(([tag]) => !preconnect.has(tag))))).toEqual({});
  expect(report.readings.found).toEqual([]);
  expect(report.readings.guesses).toBe(0);
  expect(report.readings.blankWrite).toBe("no access");
  // What the guard is for: WebKit, and only WebKit, connects for <link rel=preconnect> under every policy.
  const preconnected = hitTags(listeners.hits).filter((tag) => preconnect.has(tag));
  if (browserName === "webkit") expect(preconnected.length).toBeGreaterThan(0);
  else expect(preconnected).toEqual([]);
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

const FRAGMENT_WAYS = new Set<string>(["history-hash", "history-link-hash", "history-assign-hash"]);

test("an app adds no entry to the page's history and moves the page nowhere: Back still leaves it", {
  tag: ["@feature:apps.web-sandbox"],
}, async ({ page, browserName }, testInfo) => {
  await appPage(page);
  // The page's own entries carry a query (the router follows the hash only, and sends a fresh profile's routes to `#/`).
  const where = () => page.evaluate(() => location.search + location.hash);
  const length = () => page.evaluate(() => history.length);
  const outcome: Record<string, unknown> = {};
  for (const way of HISTORY_WAYS) {
    await test.step(way, async () => {
      // Where the person was, and where they are when the app opens.
      await page.evaluate((way) => { history.pushState(null, "", `?was=${way}${location.hash}`); history.pushState(null, "", `?is=${way}${location.hash}`); }, way);
      const was = `?was=${way}#/`;
      const is = await where();
      expect(is).toBe(`?is=${way}#/`);
      const before = await length();
      const ref = `evilpublisherkey/${way}`;
      const handle = await open(page, ref, appEntry("history", { way }));
      await expect.poll(() => stored(page, ref)).toMatchObject({ started: true });
      await page.waitForTimeout(2_000);
      const now = await status(page, handle);
      outcome[way] = { ...now, tried: (await stored(page, ref)).outcome ?? null, at: await where(), added: (await length()) - before };
      // The page did not move.
      expect(await where(), way).toBe(is);
      if (FRAGMENT_WAYS.has(way)) {
        // A fragment navigation (location.hash, a link to "#…") is the one way no policy refuses: it becomes a load, and
        // the app is gone. What it pushed before its first one was heard stays in the history (WISP 1200, threats).
        expect(now, way).toEqual({ phase: "stopped", stopped: "navigated" });
        return;
      }
      // Its history has no entry of the app's: one Back takes the person where they were.
      expect(now, way).toEqual({ phase: "running", stopped: null });
      expect(await length(), way).toBe(before);
      await page.evaluate(() => history.back());
      await expect.poll(where, { message: way }).toBe(was);
    });
  }
  testInfo.annotations.push({ type: `history (${browserName})`, description: JSON.stringify(outcome) });
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

test("an app that keeps sending far past the request rate is stopped, and the page stays smooth", {
  tag: ["@feature:apps.web-sandbox"],
}, async ({ page }) => {
  await appPage(page);
  const ref = "evilpublisherkey/storm";
  const handle = await open(page, ref, appEntry("storm"));
  await expect.poll(() => status(page, handle), { timeout: 30_000 }).toEqual({ phase: "stopped", stopped: "protocol" });
  await expect(page.locator("iframe")).toHaveCount(0);
  // Only the first second's 50 reached the host, and the page's timers run on time once the app is gone.
  const calls = await page.evaluate(() => (window as unknown as { __ghostlyApps: Hook }).__ghostlyApps.calls());
  expect(calls.filter((c) => c.ref === ref && c.op === "storage.get").length).toBeLessThanOrEqual(50);
  const gap = await page.evaluate(() => new Promise<number>((done) => {
    let longest = 0;
    let last = performance.now();
    const started = last;
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      if (now - started > 2_000) { clearInterval(timer); done(longest); }
    }, 10);
  }));
  expect(gap).toBeLessThan(500);
});

test("an app that reads its own 16 MiB file 50 times a second gets one a second, and the page stays smooth", {
  tag: ["@feature:apps.web-sandbox"],
}, async ({ page }, testInfo) => {
  await appPage(page);
  const ref = "evilpublisherkey/file-flood";
  const handle = await open(page, ref, appEntry("fileFlood"), { files: { "big.bin": "x".repeat(16 * 1024 * 1024) } });
  // Watched once the hook has its 16 MiB (encoding it is the test's, not the app's), before the frame has loaded: the
  // longest the page's timers wait while the app reads.
  await page.evaluate(() => {
    const watch = ((window as unknown as { __gap: { longest: number } }).__gap = { longest: 0 });
    let last = performance.now();
    setInterval(() => { const now = performance.now(); watch.longest = Math.max(watch.longest, now - last); last = now; }, 10);
  });
  await expect.poll(() => stored(page, ref), { timeout: 60_000 }).toHaveProperty("report");
  const report = (await stored(page, ref)).report as { ok: number; refused: string[] };
  const gap = await page.evaluate(() => (window as unknown as { __gap: { longest: number } }).__gap.longest);
  testInfo.annotations.push({ type: "file flood", description: JSON.stringify({ ...report, gap: Math.round(gap) }) });
  // 16 MiB of answers a second: the first read of each second, at most one more where a second's edge falls between.
  expect(report.ok).toBeGreaterThanOrEqual(3);
  expect(report.ok).toBeLessThanOrEqual(6);
  expect(report.refused).toEqual(["too-fast"]);
  // Measured on a 4-core host: 36-40 ms; 453-473 ms while every read was answered (149 of 150, 2.3 GB copied).
  expect(gap).toBeLessThan(300);
  expect(await status(page, handle)).toEqual({ phase: "running", stopped: null });
});

/** The longest the page's 10 ms timer waits over `ms`: what the person feels of the page's thread. */
const longestGap = (page: Page, ms: number) => page.evaluate((ms) => new Promise<number>((done) => {
  let longest = 0;
  let last = performance.now();
  const started = last;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    if (now - started > ms) { clearInterval(timer); done(longest); }
  }, 10);
}), ms);

test("an app that stops answering for longer than the watchdog's bound is closed, and one busy for less runs on", {
  tag: ["@feature:apps.web-sandbox"],
}, async ({ page }, testInfo) => {
  await appPage(page);
  // Busy for 3 s once, under the bound: a chess engine thinking on the app's thread. It runs on.
  const busy = "honestpublisherkey/thinker";
  const busyHandle = await open(page, busy, appEntry("hang", { ms: 3_000 }));
  await expect.poll(() => stored(page, busy), { timeout: 30_000 }).toHaveProperty("ready");
  await page.waitForTimeout(5_000);
  expect(await status(page, busyHandle)).toEqual({ phase: "running", stopped: null });
  // Closed before the next: where frames share the page's thread, the page cannot tell which app held it, and stops
  // every app that runs then.
  await page.evaluate((handle) => (window as unknown as { __ghostlyApps: { stop(handle: number): void } }).__ghostlyApps.stop(handle), busyHandle);
  // Then one that answers nothing for 15 s.
  const ref = "evilpublisherkey/hang";
  const handle = await open(page, ref, appEntry("hang", { ms: 15_000 }));
  await expect.poll(() => stored(page, ref), { timeout: 30_000 }).toHaveProperty("ready");
  const started = Date.now();
  // Where the frame shares the page's thread (WebKit, Chromium without site isolation) nothing on the page runs while
  // the app loops, so it is seen once the loop gives the thread back; where it has its own, at the bound.
  await expect.poll(() => status(page, handle), { timeout: 40_000 }).toEqual({ phase: "stopped", stopped: "unresponsive" });
  testInfo.annotations.push({ type: "closed after", description: `${Date.now() - started} ms` });
  expect(Date.now() - started).toBeLessThan(25_000);
  await expect(page.locator(`iframe[data-app="${ref}"]`)).toHaveCount(0);
  expect(await longestGap(page, 2_000)).toBeLessThan(500);
});

test("an app in an endless loop, in a frame with a thread of its own, is closed at the bound while the page runs on", {
  tag: ["@feature:apps.web-sandbox"],
}, async ({ browser, browserName, baseURL }, testInfo) => {
  // Desktop Chrome's own isolation, which gives the runner's frame a process of its own. WebKit has none to turn on:
  // there an endless loop holds the tab's one thread (WISP 1200 § Threats).
  test.skip(browserName !== "chromium", "only Chromium can give the frame a thread of its own");
  const isolated = await browser.browserType().launch({ args: ["--site-per-process", "--enable-features=IsolateSandboxedIframes"] });
  try {
    const page = await isolated.newPage({ baseURL, serviceWorkers: "block" });
    await appPage(page);
    const ref = "evilpublisherkey/forever";
    const handle = await open(page, ref, appEntry("hang", { ms: 0 }));
    await expect.poll(() => stored(page, ref), { timeout: 30_000 }).toHaveProperty("ready");
    const started = Date.now();
    const gap = longestGap(page, 8_000);
    expect(await gap).toBeLessThan(500);
    await expect.poll(() => status(page, handle), { timeout: 30_000 }).toEqual({ phase: "stopped", stopped: "unresponsive" });
    testInfo.annotations.push({ type: "closed after", description: `${Date.now() - started} ms` });
    await expect(page.locator(`iframe[data-app="${ref}"]`)).toHaveCount(0);
  } finally {
    await isolated.close();
  }
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

test("what an app posts to the other app frames of the page reaches none of them: not an app with internet, not its own instance in another chat", {
  tag: ["@feature:apps.web-sandbox"],
}, async ({ page }) => {
  await appPage(page);
  const talker = "gamepublisherkey/talker";
  const outbound = "netpublisherkey/outbound";
  // The same app in two chats: its storage is scoped per chat, so one instance must not hand data to the other.
  await open(page, outbound, appEntry("eavesdropper"), { permissions: ["internet"] });
  await open(page, talker, appEntry("eavesdropper"), { permissions: ["chat"], chat: { linkId: "link-other" } });
  await expect.poll(() => stored(page, outbound)).toMatchObject({ ready: true });
  await expect.poll(() => stored(page, talker, "link-other")).toMatchObject({ ready: true });
  await open(page, talker, appEntry("talker", { name: "talker" }), { permissions: ["chat"], chat: { linkId: "link-one" } });
  await expect.poll(() => stored(page, talker, "link-one"), { timeout: 30_000 }).toHaveProperty("talked");
  // It did post: to every app frame of the page, about 30 times each.
  expect((await stored(page, talker, "link-one")).talked).toMatchObject({ frames: 3, n: expect.any(Number) });
  await expect.poll(() => stored(page, outbound), { timeout: 30_000 }).toHaveProperty("heard");
  await expect.poll(() => stored(page, talker, "link-other"), { timeout: 30_000 }).toHaveProperty("heard");
  expect((await stored(page, outbound)).heard).toEqual([]);
  expect((await stored(page, talker, "link-other")).heard).toEqual([]);
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

test("an app may ask for the pointer after a click (mouse look): its sandbox no longer refuses it", {
  tag: ["@feature:apps.web-sandbox"],
}, async ({ page }) => {
  await appPage(page);
  const ref = "gamepublisherkey/look";
  // What the frame's sandbox decides shows in the refusal's name: SecurityError ("the frame is sandboxed and the
  // 'allow-pointer-lock' permission is not set") before; past it, a browser driven by a test still refuses for want of
  // window focus (WrongDocumentError), or gives the lock. A person's click in a focused window gets it, and Esc frees it.
  const entry = `<!doctype html><title>look</title><body style="margin:0"><div id=pad style="width:100vw;height:100vh;background:#123"></div><script>
    const g = window.ghostly, pad = document.getElementById("pad");
    pad.addEventListener("click", () => {
      try {
        const asked = pad.requestPointerLock();
        if (asked && asked.then) asked.then(() => g.storage.set("lock", "held"), (e) => g.storage.set("lock", e.name));
      } catch (e) { g.storage.set("lock", e.name); }
    });
    g.storage.set("ready", true);
  </script>`;
  await open(page, ref, entry);
  await expect.poll(() => stored(page, ref)).toMatchObject({ ready: true });
  await expect(page.locator(`iframe[data-app="${ref}"]`)).toHaveAttribute("sandbox", "allow-scripts allow-pointer-lock");
  await page.frameLocator(`iframe[data-app="${ref}"]`).locator("#pad").click();
  await expect.poll(async () => (await stored(page, ref)).lock).toBeDefined();
  expect(["held", "WrongDocumentError"]).toContain((await stored(page, ref)).lock);
});

test("an app writes nothing to the clipboard: not on load, not in a tap, not from a timer after one", {
  tag: ["@feature:apps.web-sandbox"],
}, async ({ page, context, browserName }) => {
  // Read only, for the check at the end. Playwright's Chromium lets the copy through even on load, with no tap.
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read"]);
  await appPage(page);
  const ref = "evilpublisherkey/clipboard";
  // Every way the app has to `execCommand` a clipboard command, on a selected textarea; the browser's answer (true:
  // it wrote) goes to storage. And the async Clipboard API, which only Chromium refuses for the frame's `allow=""`:
  // whether the app finds each of its calls ("none": it does not), and how a write it tries ends.
  const entry = `<!doctype html><title>clip</title><body style="margin:0"><textarea id=t></textarea><div id=pad style="width:100vw;height:90vh"></div><script>
    const g = window.ghostly, t = document.getElementById("t"), proto = Document.prototype;
    const exec = proto.execCommand;
    const api = {};
    const asks = (tag) => {
      const c = navigator.clipboard, out = { item: typeof ClipboardItem === "function" ? "there" : "none" };
      const text = "bc1q-APP-" + tag + "-api";
      const writes = {
        writeText: () => c.writeText(text),
        write: () => c.write([new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }) })]),
      };
      for (const way of ["writeText", "write", "readText", "read"]) {
        if (!c || typeof c[way] !== "function") { out[way] = "none"; continue; }
        if (!writes[way]) { out[way] = "there"; continue; }
        out[way] = "pending";
        try {
          writes[way]().then(() => { out[way] = "wrote"; g.storage.set("api", api); }, (e) => { out[way] = e.name; g.storage.set("api", api); });
        } catch (e) { out[way] = e.name; }
      }
      api[tag] = out;
      g.storage.set("api", api);
    };
    const framed = () => {
      try {
        const frame = document.createElement("iframe");
        document.body.appendChild(frame);
        const w = frame.contentWindow, c = w && w.navigator.clipboard;
        if (!c || typeof c.writeText !== "function") { g.storage.set("framed", "none"); return; }
        c.writeText("bc1q-APP-framed").then(() => g.storage.set("framed", "wrote"), (e) => g.storage.set("framed", e.name));
      } catch (e) { g.storage.set("framed", e.name); }
    };
    asks("load");
    const tries = (tag) => {
      const out = {};
      const ways = {
        copy: () => document.execCommand("copy"),
        COPY: () => document.execCommand("COPY"),
        cut: () => document.execCommand("cut"),
        paste: () => document.execCommand("paste"),
        taken: () => exec.call(document, "copy"),
        proto: () => proto.execCommand.call(document, "copy", false),
        other: () => document.implementation.createHTMLDocument("").execCommand("copy"),
      };
      for (const way in ways) {
        t.value = "bc1q-APP-" + tag + "-" + way;
        t.select();
        try { out[way] = ways[way](); } catch (e) { out[way] = e.name; }
      }
      g.storage.set(tag, out);
    };
    tries("load");
    let taps = 0;
    document.getElementById("pad").addEventListener("pointerdown", () => {
      if (taps++) return;
      asks("tap");
      framed();
      tries("tap");
      t.value = "";
      t.focus();
      const typed = document.execCommand("insertText", false, "typed");
      g.storage.set("edit", typed + " " + t.value);
      setTimeout(() => tries("timer"), 1000);
    });
    g.storage.set("ready", true);
  </script>`;
  await open(page, ref, entry);
  await expect.poll(() => stored(page, ref)).toMatchObject({ ready: true });
  await page.frameLocator(`iframe[data-app="${ref}"]`).locator("#pad").click();
  await expect.poll(async () => (await stored(page, ref)).timer, { timeout: 10_000 }).toBeDefined();
  const seen = await stored(page, ref);
  test.info().annotations.push({ type: `clipboard (${browserName})`, description: JSON.stringify(seen) });
  for (const tag of ["load", "tap", "timer"]) {
    for (const [way, wrote] of Object.entries(seen[tag] as Record<string, unknown>)) expect(`${tag} ${way}: ${String(wrote)}`).toBe(`${tag} ${way}: false`);
  }
  // The app finds no async Clipboard API, on load or in a tap (WebKit and Firefox let it write, on load too).
  const none = { item: "none", writeText: "none", write: "none", readText: "none", read: "none" };
  expect(seen.api).toEqual({ load: none, tap: none });
  // Nor through a frame it makes.
  expect(seen.framed).toBeDefined();
  expect(seen.framed).not.toBe("wrote");
  // None of the app's text is in the system clipboard, and an editing command still edits.
  if (browserName === "chromium") expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain("bc1q-APP");
  expect(seen.edit).toBe("true typed");
});

test("the person's copy and cut in an app put what they selected on the clipboard, never what the app's listeners say", {
  tag: ["@feature:apps.web-sandbox"],
}, async ({ page }) => {
  await appPage(page);
  const ref = "evilpublisherkey/swap";
  // Every place an app can listen for the person's copy or cut, each one swapping what goes on the clipboard.
  const entry = `<!doctype html><title>swap</title><body><p><span id=shown>bc1qREALADDRESS</span></p><textarea id=t>bc1qCUTADDRESS</textarea><script>
    const g = window.ghostly;
    const swap = (where) => (e) => {
      g.storage.set("heard", where);
      try { e.clipboardData.setData("text/plain", "bc1qSWAPPEDBYAPP"); } catch (error) { /* refused */ }
      e.preventDefault();
    };
    for (const type of ["copy", "cut"]) {
      addEventListener(type, swap("window capture"), true);
      addEventListener(type, swap("window"));
      document.addEventListener(type, swap("document"), true);
      document.addEventListener(type, swap("document"));
      document.getElementById("shown").addEventListener(type, swap("element"));
      document.getElementById("t").addEventListener(type, swap("element"));
    }
    window.oncopy = swap("oncopy");
    document.body.oncut = swap("oncut");
    g.storage.set("ready", true);
  </script>`;
  await open(page, ref, entry);
  await expect.poll(() => stored(page, ref)).toMatchObject({ ready: true });
  const frame = page.frameLocator(`iframe[data-app="${ref}"]`);
  // What the clipboard holds, pasted by the person into a field of the page itself.
  const pasted = async () => {
    await page.evaluate(() => { const field = document.createElement("textarea"); field.id = "pasted"; document.body.append(field); });
    await page.locator("#pasted").focus();
    await page.keyboard.press("ControlOrMeta+V");
    const value = await page.locator("#pasted").inputValue();
    await page.evaluate(() => document.getElementById("pasted")!.remove());
    return value;
  };

  await frame.locator("#shown").dblclick();
  await page.keyboard.press("ControlOrMeta+C");
  expect(await pasted()).toBe("bc1qREALADDRESS");

  // A click, as the person does: a focus moved into the app by script alone is taken back (the app beside a chat cannot take it).
  await frame.locator("#t").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+X");
  expect(await pasted()).toBe("bc1qCUTADDRESS");
  // The cut took the text out, as a cut does.
  await expect(frame.locator("#t")).toHaveValue("");
  // None of the app's listeners heard either.
  expect((await stored(page, ref)).heard).toBeUndefined();

  // An app that opens its document again (which erases the window's listeners) and listens in the new one.
  const reopened = "evilpublisherkey/reopen";
  await open(page, reopened, `<!doctype html><title>reopen</title><body><script>
    const g = window.ghostly;
    setTimeout(() => {
      document.open();
      const body = document.appendChild(document.createElement("html")).appendChild(document.createElement("body"));
      body.innerHTML = "<span id=shown>bc1qREALADDRESS</span>";
      document.addEventListener("copy", (e) => { g.storage.set("heard", true); e.clipboardData.setData("text/plain", "bc1qSWAPPEDBYAPP"); e.preventDefault(); });
      g.storage.set("ready", true);
    }, 100);
  </script>`);
  await expect.poll(() => stored(page, reopened)).toMatchObject({ ready: true });
  await page.frameLocator(`iframe[data-app="${reopened}"]`).locator("#shown").dblclick();
  await page.keyboard.press("ControlOrMeta+C");
  expect(await pasted()).toBe("bc1qREALADDRESS");
  expect((await stored(page, reopened)).heard).toBeUndefined();
});

test("an app that opens its document again keeps the runner's listeners: no other frame's message, a # link ends it, the person's taps count", {
  tag: ["@feature:apps.web-sandbox"],
}, async ({ page }) => {
  await appPage(page);
  const ref = "evilpublisherkey/reopen-listeners";
  // `document.open()` with no close erases the window's listeners and the app runs on, in a document of its own making.
  const handle = await open(page, ref, `<!doctype html><title>reopen</title><body><script>
    const g = window.ghostly;
    setTimeout(() => {
      document.open();
      const body = document.appendChild(document.createElement("html")).appendChild(document.createElement("body"));
      body.innerHTML = "<div id=pad style='width:100vw;height:100vh'></div>";
      addEventListener("message", (e) => g.storage.set("heard", String(e.data)));
      document.getElementById("pad").addEventListener("click", () => setTimeout(() => { location.hash = "#gone"; }, 1000));
      g.storage.set("ready", true);
    }, 100);
  </script>`);
  await expect.poll(() => stored(page, ref)).toMatchObject({ ready: true });
  // What another frame of the page posts to it, as one more app frame would (parent.frames[i]).
  await page.evaluate((ref) => document.querySelector<HTMLIFrameElement>(`iframe[data-app="${ref}"]`)!.contentWindow!.postMessage("from another frame", "*"), ref);
  const before = await inputs(page);
  // The person's tap in the app, after which the app follows a link to "#gone".
  await page.frameLocator(`iframe[data-app="${ref}"]`).locator("#pad").click();
  await page.waitForTimeout(3_000);
  expect.soft((await stored(page, ref)).heard).toBeUndefined();
  expect.soft(await inputs(page)).toBeGreaterThan(before);
  expect.soft(await status(page, handle)).toEqual({ phase: "stopped", stopped: "navigated" });
});

test("Chess, as it is built, runs under the runner's lock", {
  tag: ["@feature:apps.web-sandbox", "@feature:apps.chess"],
}, async ({ page }) => {
  await appPage(page);
  const ref = "chesspublisherkey/chess";
  await open(page, ref, chessEntryHtml(), { permissions: ["chat"], chat: { linkId: "link-chess" } });
  const board = page.frameLocator(`iframe[data-app="${ref}"]`).locator(".board");
  await expect(board).toBeVisible();
  await expect(board.locator("button")).toHaveCount(64);
  // Its one script ran with the runner's nonce, and what it keeps went to its own scope in that chat.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ghostlyApps: Hook }).__ghostlyApps.calls().filter((c) => c.ref === "chesspublisherkey/chess").every((c) => !c.scope || c.scope === "link-chess"))).toBe(true);
});

test.describe("an app granted internet", () => {
  // The HTTPS listener has a throwaway certificate.
  test.use({ ignoreHTTPSErrors: true });

  test("runs in the network runner: HTTPS and WSS go out; plain HTTP, remote script, frames, forms and WebRTC do not", {
    tag: ["@feature:apps.web-sandbox"],
  }, async ({ page, browserName }, testInfo) => {
    await appPage(page);
    listeners.reset();
    const ref = "netpublisherkey/weather";
    await open(page, ref, appEntry("internet", listeners.targets), { permissions: ["internet"] });
    await expect(page.locator(`iframe[data-app="${ref}"]`)).toHaveAttribute("src", "/app-frame-net.html");
    await expect.poll(() => stored(page, ref), { timeout: 30_000 }).toHaveProperty("report");
    await page.waitForTimeout(1_500);
    const report = (await stored(page, ref)).report as Record<string, string>;
    testInfo.annotations.push({ type: `internet app (${browserName})`, description: JSON.stringify({ report, hits: table(listeners.hits) }) });
    expect(report.fetch).toBe("x");
    expect(report.http).toMatch(/^refused/);
    expect(report.rtc).toBe("none");
    expect(hitTags(listeners.hits)).toEqual(["net-fetch", "net-img", "net-wss"]);
  });

  test("an app not granted it, in the same browser, reaches the HTTPS listener no more than any other", {
    tag: ["@feature:apps.web-sandbox"],
  }, async ({ page }) => {
    await appPage(page);
    listeners.reset();
    const ref = "netpublisherkey/no-grant";
    await open(page, ref, appEntry("internet", listeners.targets), { permissions: [] });
    await expect(page.locator(`iframe[data-app="${ref}"]`)).toHaveAttribute("src", "/app-frame.html");
    await expect.poll(() => stored(page, ref), { timeout: 30_000 }).toHaveProperty("report");
    await page.waitForTimeout(1_500);
    expect((await stored(page, ref)).report).toMatchObject({ fetch: expect.stringMatching(/^refused/), rtc: "none" });
    expect(table(listeners.hits)).toEqual({});
  });
});
