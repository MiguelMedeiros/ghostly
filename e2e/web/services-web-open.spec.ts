import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pasteInvite } from "../support/clipboard";
import { expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";
import { choose } from "../support/select";

/**
 * A contact's shared web app, opened on the web (WISP 701; apps/web/src/svc/): a bot on the headless Ghostly shares a
 * web app on its machine with a person on the web app, who opens it from the chat. The app runs full screen, on an
 * origin of its own (not the app's), and every request it makes, its scripts, a POST and its cookie included, goes over
 * the chat's data link to the bot's machine.
 *
 * Needs a build made with a services host: the suite's own sets one (`VITE_SERVICES_HOST`, e2e/playwright.config.ts),
 * `http://*.localhost:<port>`, which Chromium and Firefox resolve to this machine. In Firefox
 * (e2e/playwright.firefox.config.ts) the POST's body takes another way through the services worker: Firefox's
 * `Request` has no body stream.
 */
test.describe.configure({ timeout: 5 * 60_000 });

/**
 * A small web app on the bot's machine: a page, a script it loads, an API it posts to, a cookie it sets, and a worker
 * that loads a script of its own and evaluates one. Its script also tries a server on the person's machine (`local`,
 * a port on 127.0.0.1), outside its own origin.
 */
async function demoApp(local: number): Promise<{ server: Server; port: number; seen: { method: string; path: string; cookie?: string }[] }> {
  const seen: { method: string; path: string; cookie?: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push({ method: request.method ?? "", path: request.url ?? "", cookie: request.headers.cookie });
      if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "visit=1; Path=/; HttpOnly", "x-frame-options": "DENY" });
        response.end(`<!doctype html><title>Demo</title><h1 id="title">Hello from the demo</h1><p id="out">…</p><p id="popup">…</p><p id="local">…</p><p id="worker">…</p><a id="docs" href="https://docs.example/guide" target="_blank">Docs</a> <a id="near" href="http://127.0.0.1:${local}/near" target="_blank">Near</a><script src="/app.js"></script>`);
      } else if (request.url === "/app.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(`document.getElementById("popup").textContent = window.open("/popup") ? "opened" : "refused";
          new Worker("/worker.js").onmessage = (event) => { document.getElementById("worker").textContent = event.data; };
          fetch("http://127.0.0.1:${local}/local", { mode: "no-cors" }).then(() => "reached", () => "refused").then((said) => { document.getElementById("local").textContent = said; });
          fetch("/api/echo?x=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hello: "ghost" }) })
          .then((r) => r.json()).then((j) => { document.getElementById("out").textContent = JSON.stringify({ ...j, origin: location.origin, storage: (() => { try { return Object.keys(localStorage); } catch (e) { return "refused"; } })() }); });`);
      } else if (request.url === "/worker.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(`try { importScripts("/lib.js"); postMessage(eval("self.lib + 1")); } catch (e) { postMessage(e.name); }`);
      } else if (request.url === "/lib.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end("self.lib = 41;");
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
  const localSeen: string[] = [];
  const local = createServer((request, response) => { localSeen.push(request.url ?? ""); response.end("ok"); });
  await new Promise<void>((done) => local.listen(0, "127.0.0.1", done));
  const app = await demoApp((local.address() as AddressInfo).port);
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
    // Its worker runs its scripts: Trusted Types, there for the app's pages, would refuse them in a worker.
    await expect(demo.locator("#worker")).toHaveText("42");
    // It opens no window of its own: one would be a tab on its origin, outliving the view and the lock.
    await expect(demo.locator("#popup")).toHaveText("refused");
    expect(app.seen.map((r) => r.path)).not.toContain("/popup");
    // It talks to its own origin only, as on Desktop and in the extension: not to a service on this machine.
    await expect(demo.locator("#local")).toHaveText("refused");
    // A link it opens in a new tab, tapped, opens in a tab of the browser's own with no opener, as Desktop opens it in
    // the system browser: the view's sandbox alone dropped it with no word. One to this machine opens nowhere.
    const context = person.page.context();
    await context.route("https://docs.example/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Docs</title>docs" }));
    const tab = context.waitForEvent("page");
    await demo.locator("#docs").click();
    const docs = await tab;
    await expect(docs).toHaveURL("https://docs.example/guide");
    expect(await docs.evaluate(() => window.opener)).toBeNull();
    await docs.close();
    const pages = context.pages().length;
    // Past the 2 s a view waits between two links.
    await person.page.waitForTimeout(2_500);
    await demo.locator("#near").click();
    await person.page.waitForTimeout(2_000);
    expect(context.pages()).toHaveLength(pages);
    expect(localSeen).toEqual([]);
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
    // Forward after it: the closed view's entry is no place to stop, back on the chat itself (it stayed on that dead
    // entry, and the next Back only left it).
    await person.page.goForward();
    await expect.poll(() => person.page.evaluate(() => JSON.stringify(history.state))).not.toContain("ghostlyServiceView");
    await expect(view).toHaveCount(0);
    await expect(person.page).toHaveURL(chat);

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
    local.close();
  }
});

/**
 * Taps and keys in a contact's app go to its frame, never to the Ghostly page: with the lock after 1 minute, a person
 * writing in it was locked out mid-use, and the lock closed the app with what they wrote. Real time, not the page's
 * clock: the peer that carries the app's requests runs in the same page. While the person writes, the test only types
 * and clicks (page.keyboard, page.mouse): Playwright's evaluations and checks act as user gestures in Chromium, and a
 * check in the frame would count as input of its own.
 */
test("taps and keys in a contact's app keep the lock away while the person uses it; left alone, it locks and closes the app", {
  tag: ["@feature:services.web-open", "@feature:settings.lock.idle"],
}, async ({ peer, relay }, info) => {
  test.setTimeout(6 * 60_000);
  const url = await relay.listen();
  const notes = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Notes</title><textarea id="notes" style="position:fixed;inset:0;width:100%;height:100%"></textarea>`);
  });
  await new Promise<void>((done) => notes.listen(0, "127.0.0.1", done));
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Notes bot");
    const person = await peer("person", { serviceWorkers: "allow", beforeOpen: async (context) => { await context.addInitScript(() => {
      try { if (location.hostname === "localhost") localStorage.setItem("ghostly-test-services", "on"); } catch { /* opaque origin */ }
    }); } });
    const invite = await bot.run("invite", "create", "--label", "person");
    await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(person.page, invite.invite as string);
    await expect(person.page.getByPlaceholder("Message…")).toBeEnabled();
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    await bot.run("service", "add", "Notes", `http://127.0.0.1:${(notes.address() as AddressInfo).port}`);
    await bot.run("service", "share", "notes", invite.chat as string);
    const open = person.page.getByTestId("open-service").filter({ hasText: "Notes" });
    await expect(open).toBeVisible({ timeout: 120_000 });

    // Lock after 1 minute, then back to the chat.
    const chat = person.page.url();
    await person.page.getByTestId("account-settings").click();
    await person.page.getByRole("switch", { name: "Lock Screen" }).click();
    const passwords = person.page.getByTestId("settings-password-form").locator("input[type=password]");
    await passwords.nth(0).fill("spooky");
    await passwords.nth(1).fill("spooky");
    await person.page.getByRole("button", { name: "Set password" }).click();
    await expect(person.page.getByText("Password set successfully")).toBeVisible();
    await choose(person.page.getByTestId("settings-timeout"), "1");
    await person.page.goto(chat);
    await open.click();
    const frame = person.page.getByTestId("service-view-frame");
    const field = person.page.frameLocator("[data-testid=service-view-frame]").frameLocator("iframe").locator("#notes");
    await expect(field).toBeVisible({ timeout: 60_000 });
    const box = (await frame.boundingBox())!;

    // Ninety seconds of writing in the app, past the lock time.
    const started = Date.now();
    let typed = "";
    while (Date.now() - started < 90_000) {
      await person.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await person.page.keyboard.type("note ");
      typed += "note ";
      await person.page.waitForTimeout(4_000);
    }
    await expect(person.page.getByText("Ghostly is locked")).toHaveCount(0);
    await expect(field).toHaveValue(typed);

    // Left alone, the lock comes, and the app closes with it (the checks above count as a gesture of up to 5 s).
    await person.page.waitForTimeout(80_000);
    await expect(person.page.getByText("Ghostly is locked")).toBeVisible();
    await expect(person.page.locator("#ghostly-service-view")).toHaveCount(0);
  } catch (error) {
    await bot.attachLogs(info);
    throw error;
  } finally {
    await bot.stop();
    notes.close();
  }
});
