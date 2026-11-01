import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pasteInvite } from "../support/clipboard";
import { expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * A contact's shared web app, opened on the web (WISP 701; apps/web/src/svc/): a bot on the headless Ghostly shares a
 * web app on its machine with a person on the web app, who opens it from the chat. The app runs full screen, on an
 * origin of its own (not the app's), and every request it makes, its scripts, a POST and its cookie included, goes over
 * the chat's data link to the bot's machine.
 *
 * Needs a build made with a services host: the suite's own sets one (`VITE_SERVICES_HOST`, e2e/playwright.config.ts),
 * `http://*.localhost:<port>`, which Chromium resolves to this machine.
 */
test.describe.configure({ timeout: 5 * 60_000 });

/** A small web app on the bot's machine: a page, a script it loads, an API it posts to, and a cookie it sets. */
async function demoApp(): Promise<{ server: Server; port: number; seen: { method: string; path: string; cookie?: string }[] }> {
  const seen: { method: string; path: string; cookie?: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push({ method: request.method ?? "", path: request.url ?? "", cookie: request.headers.cookie });
      if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "visit=1; Path=/; HttpOnly", "x-frame-options": "DENY" });
        response.end(`<!doctype html><title>Demo</title><h1 id="title">Hello from the demo</h1><p id="out">…</p><p id="popup">…</p><script src="/app.js"></script>`);
      } else if (request.url === "/app.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(`document.getElementById("popup").textContent = window.open("/popup") ? "opened" : "refused";
          fetch("/api/echo?x=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hello: "ghost" }) })
          .then((r) => r.json()).then((j) => { document.getElementById("out").textContent = JSON.stringify({ ...j, origin: location.origin, storage: (() => { try { return Object.keys(localStorage); } catch (e) { return "refused"; } })() }); });`);
      } else if (request.url?.startsWith("/api/echo")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ method: request.method, body: JSON.parse(body || "null"), query: request.url.slice("/api/echo".length), cookie: request.headers.cookie ?? null }));
      } else {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not here");
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { server, port: (server.address() as AddressInfo).port, seen };
}

test("a person on the web opens the web app a bot shares, on an origin of its own, over the chat's link", {
  tag: ["@feature:services.web-open", "@feature:headless.web-interop", "@feature:services.http"],
}, async ({ peer, relay }, info) => {
  const url = await relay.listen();
  const app = await demoApp();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Demo bot");
    // The suite's build opens contacts' apps only in a page that asks for it (apps/web/src/host.ts, `servicesUnderTest`).
    const person = await peer("person", { serviceWorkers: "allow", beforeOpen: async (context) => { await context.addInitScript(() => {
      // The app's own page only: the contact's app, on its own origin, must find its storage empty.
      try { if (location.hostname === "localhost") localStorage.setItem("ghostly-test-services", "on"); } catch { /* opaque origin */ }
    }); } });
    const invite = await bot.run("invite", "create", "--label", "person");
    await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(person.page, invite.invite as string);
    await expect(person.page.getByPlaceholder("Message…")).toBeEnabled();
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");

    // The bot shares its app with this contact only.
    expect(await bot.run("service", "add", "Demo", `http://127.0.0.1:${app.port}`)).toMatchObject({ serviceId: "demo" });
    await bot.run("service", "share", "demo", invite.chat as string);

    // The person opens it from the chat's apps strip: full screen over the app, no error under the button.
    const open = person.page.getByTestId("open-service").filter({ hasText: "Demo" });
    await expect(open).toBeVisible({ timeout: 120_000 });
    await open.click();
    await expect(person.page.getByTestId("peer-services")).not.toContainText("needs the Ghostly");
    const view = person.page.locator("#ghostly-service-view");
    await expect(view).toBeVisible();
    const demo = person.page.frameLocator("[data-testid=service-view-frame]").frameLocator("iframe");
    await expect(demo.locator("#title")).toHaveText("Hello from the demo", { timeout: 60_000 });

    // Its script ran and posted to its API; the answer came back, its cookie went with it, and it runs on its own
    // origin, with none of the app's storage.
    await expect(demo.locator("#out")).not.toHaveText("…", { timeout: 60_000 });
    const out = JSON.parse((await demo.locator("#out").textContent())!);
    expect(out).toMatchObject({ method: "POST", body: { hello: "ghost" }, query: "?x=1", cookie: "visit=1" });
    // None of the app's storage: only what the suite's own init script puts in every frame (`ghostly-test-*`).
    expect(Array.isArray(out.storage)).toBe(true);
    expect((out.storage as string[]).filter((key) => !key.startsWith("ghostly-test-"))).toEqual([]);
    const appOrigin = new URL(person.page.url()).origin;
    expect(out.origin).not.toBe(appOrigin);
    expect(out.origin).toMatch(/^http:\/\/[ybndrfg8ejkmcpqxot1uwisza345h769]{32}\.localhost:\d+$/);
    expect(app.seen.map((r) => `${r.method} ${r.path}`)).toEqual(expect.arrayContaining(["GET /", "GET /app.js", "POST /api/echo?x=1"]));
    // It opens no window of its own: one would be a tab on its origin, outliving the view and the lock.
    await expect(demo.locator("#popup")).toHaveText("refused");
    expect(app.seen.map((r) => r.path)).not.toContain("/popup");
    // The app's own storage is untouched by it, and the app still holds its chat.
    expect((await person.page.evaluate(() => Object.keys(localStorage))).filter((key) => !key.startsWith("ghostly-test-")).length).toBeGreaterThan(0);

    // Another site that knows the app's origin posts a form to it while it is open, at the top and into a frame of its
    // own: neither reaches the contact as this person (the worker forwards only the app's own frames' navigations).
    const other = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><iframe name="inner"></iframe>
        <form id="framed" method="post" target="inner" action="${out.origin}/api/steal?framed"><input name="a" value="1"></form>
        <form id="top" method="post" action="${out.origin}/api/steal?top"><input name="a" value="1"></form>
        <script>document.getElementById("framed").submit(); setTimeout(() => document.getElementById("top").submit(), 500);</script>`);
    });
    await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
    const elsewhere = await person.page.context().newPage();
    try {
      await elsewhere.goto(`http://127.0.0.1:${(other.address() as AddressInfo).port}/`);
      await elsewhere.waitForURL((at) => at.pathname === "/api/steal", { timeout: 30_000 });
      await elsewhere.waitForLoadState("load");
      await person.page.waitForTimeout(2_000);
    } finally {
      await elsewhere.close();
      other.close();
    }
    expect(app.seen.filter((r) => r.path.startsWith("/api/steal"))).toEqual([]);
    await expect(demo.locator("#title")).toHaveText("Hello from the demo");

    // An iPhone on its side (Chromium plays its safe area): ✕, the name and the app clear of the notch on either side
    // and of the home indicator. The app cannot keep clear of them itself: `env(safe-area-inset-*)` is 0 in its frame.
    // ✕ was at x=8 under the notch, and the frame ran edge to edge and to the bottom.
    const viewport = person.page.viewportSize()!;
    await person.page.setViewportSize({ width: 667, height: 375 });
    const cdp = await person.page.context().newCDPSession(person.page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, right: 47, bottom: 21, left: 47 } });
    const outside = () => view.evaluate((v) => [v.querySelector("[data-testid=service-view-close]")!, v.querySelector("[data-testid=service-view-frame]")!, v.querySelector("span")!]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.left < 47 || r.right > innerWidth - 47 || r.bottom > innerHeight - 21)
      .map((r) => `${Math.round(r.left)}..${Math.round(r.right)} x ${Math.round(r.top)}..${Math.round(r.bottom)} of ${innerWidth}x${innerHeight}`));
    await expect.poll(outside).toEqual([]);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, right: 0, bottom: 0, left: 0 } });
    await person.page.setViewportSize(viewport);

    // Closed: gone, the chat is where it was, and the focus back on Open, not on the page's body.
    const chat = person.page.url();
    await person.page.getByTestId("service-view-close").click();
    await expect(view).toHaveCount(0);
    await expect(person.page.getByPlaceholder("Message…")).toBeEnabled();
    await expect(person.page).toHaveURL(chat);
    await expect(open).toBeFocused();

    // With the keyboard: Tab stays in the view, never on the chat hidden under it; Escape closes it, back on Open.
    await person.page.keyboard.press("Enter");
    await expect(view).toBeVisible();
    await expect(person.page.getByTestId("service-view-close")).toBeFocused();
    for (let i = 0; i < 5; i++) {
      await person.page.keyboard.press("Tab");
      expect(await person.page.evaluate(() => { const el = document.activeElement; return !el || el === document.body || !!el.closest("#ghostly-service-view"); })).toBe(true);
    }
    await person.page.getByTestId("service-view-close").focus();
    await person.page.keyboard.press("Escape");
    await expect(view).toHaveCount(0);
    await expect(open).toBeFocused();
    await expect(person.page).toHaveURL(chat);

    // Opened again, Back (Android's back gesture, the browser's) closes it and leaves the chat as it was.
    await open.click();
    await expect(view).toBeVisible();
    await person.page.goBack();
    await expect(view).toHaveCount(0);
    await expect(person.page).toHaveURL(chat);
    await expect(person.page.getByPlaceholder("Message…")).toBeEnabled();

    // Open, and the contact quits Ghostly: the view says so in the app's words, in place of the app's last page (it
    // stayed up, and a click in it waited 75 s for the services worker's English "The app did not answer in time.").
    await open.click();
    await expect(demo.locator("#title")).toHaveText("Hello from the demo", { timeout: 60_000 });
    await bot.stop();
    const offline = person.page.getByTestId("service-view-offline");
    await expect(offline).toBeVisible({ timeout: 120_000 });
    await expect(offline).toContainText("Your contact is offline, so Demo cannot open now.");
    await expect(person.page.getByTestId("service-view-frame")).toBeHidden();
    await expect(person.page.getByTestId("service-view-retry")).toBeVisible();
  } catch (error) {
    await bot.attachLogs(info);
    throw error;
  } finally {
    await bot.stop();
    app.server.close();
  }
});
