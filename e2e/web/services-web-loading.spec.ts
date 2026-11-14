import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pasteInvite } from "../support/clipboard";
import { expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * A contact's shared web app, opened on the web, while the contact's machine has not answered its first page yet: the
 * view says the app is opening, in its status line, rather than showing the bridge's empty white page for as long as
 * the contact takes (up to the "too slow" answer, 70 s on). The bridge says when a page of the app has loaded
 * (`BRIDGE_SHOWN`, apps/web/src/svc/bridge.ts). Needs the suite's build with a services host, as
 * services-web-open.spec.ts.
 */
test.describe.configure({ timeout: 5 * 60_000 });

test("a contact's app the contact's machine is slow to answer is said as opening until its page is there", {
  tag: ["@feature:services.web-open", "@feature:headless.web-interop"],
}, async ({ peer, relay }, info) => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const app = createServer(async (request, response) => {
    if (request.url !== "/") { response.writeHead(404); response.end(); return; }
    // The contact's machine is slow: its first page comes only when the test says so.
    await released;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Demo</title><p id="title">Hello from the demo</p><p id="width"></p><script>document.getElementById("width").textContent = String(innerWidth);</script>`);
  });
  await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Demo bot");
    const person = await peer("person", { serviceWorkers: "allow", beforeOpen: async (context) => { await context.addInitScript(() => {
      try { if (location.hostname === "localhost") localStorage.setItem("ghostly-test-services", "on"); } catch { /* opaque origin */ }
    }); } });
    const invite = await bot.run("invite", "create", "--label", "person");
    await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(person.page, invite.invite as string);
    await expect(person.page.getByPlaceholder("Message…")).toBeEnabled();
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    await bot.run("service", "add", "Demo", `http://127.0.0.1:${(app.address() as AddressInfo).port}`);
    await bot.run("service", "share", "demo", invite.chat as string);

    const open = person.page.getByTestId("open-service").filter({ hasText: "Demo" });
    await expect(open).toBeVisible({ timeout: 120_000 });
    await open.click();
    const view = person.page.locator("#ghostly-service-view");
    const notice = view.getByRole("status");
    const frame = view.getByTestId("service-view-frame");
    // Said, and busy, while the contact's machine has not answered; the frame (the bridge's white page) under it unseen.
    // It was the bridge's white page alone, with nothing said, for as long as the contact took.
    await expect(notice.locator("p")).toHaveText("Opening Demo on your contact's machine…");
    await expect(notice).toHaveAttribute("aria-busy", "true");
    await expect(view.getByTestId("service-view-retry")).toBeHidden();
    await expect(frame).toBeHidden();
    await person.page.waitForTimeout(5_000);
    await expect(notice.locator("p")).toHaveText("Opening Demo on your contact's machine…");

    release();
    const demo = person.page.frameLocator("[data-testid=service-view-frame]").frameLocator("iframe");
    await expect(demo.locator("#title")).toHaveText("Hello from the demo", { timeout: 60_000 });
    await expect(notice).toBeHidden();
    await expect(frame).toBeVisible();
    // It laid itself out for the screen it is on: the frame kept its size under the notice while it loaded.
    const width = (await frame.boundingBox())!.width;
    expect(Number(await demo.locator("#width").textContent())).toBe(Math.round(width));
  } catch (error) {
    await bot.attachLogs(info);
    throw error;
  } finally {
    release();
    await bot.stop();
    app.close();
  }
});

test("a contact's app is shown once its page is there, not held under \"Opening\" while an image of it is still on its way", {
  tag: ["@feature:services.web-open", "@feature:headless.web-interop"],
}, async ({ peer, relay }, info) => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const app = createServer(async (request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Demo</title><p id="title">Hello from the demo</p><img src="/photo.png" alt="">`);
      return;
    }
    if (request.url !== "/photo.png") { response.writeHead(404); response.end(); return; }
    // A big picture over a slow link, or a thumbnail the contact's machine is slow to make: it comes only when the test says so.
    await released;
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Demo bot");
    const person = await peer("person", { serviceWorkers: "allow", beforeOpen: async (context) => { await context.addInitScript(() => {
      try { if (location.hostname === "localhost") localStorage.setItem("ghostly-test-services", "on"); } catch { /* opaque origin */ }
    }); } });
    const invite = await bot.run("invite", "create", "--label", "person");
    await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(person.page, invite.invite as string);
    await expect(person.page.getByPlaceholder("Message…")).toBeEnabled();
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    await bot.run("service", "add", "Demo", `http://127.0.0.1:${(app.address() as AddressInfo).port}`);
    await bot.run("service", "share", "demo", invite.chat as string);

    const open = person.page.getByTestId("open-service").filter({ hasText: "Demo" });
    await expect(open).toBeVisible({ timeout: 120_000 });
    await open.click();
    const view = person.page.locator("#ghostly-service-view");
    const demo = person.page.frameLocator("[data-testid=service-view-frame]").frameLocator("iframe");
    await expect(demo.locator("#title")).toHaveText("Hello from the demo", { timeout: 60_000 });
    // The page is there: it is shown, though its picture is not (the frame's `load` waits for it, up to the 70 s
    // "too slow" answer). It stayed hidden under "Opening Demo…" all that time.
    await expect(view.getByRole("status")).toBeHidden({ timeout: 15_000 });
    await expect(view.getByTestId("service-view-frame")).toBeVisible();
  } catch (error) {
    await bot.attachLogs(info);
    throw error;
  } finally {
    release();
    await bot.stop();
    app.close();
  }
});

test("a link a contact's app opens in a new tab opens while a picture of its page is still on its way", {
  tag: ["@feature:services.web-open", "@feature:headless.web-interop"],
}, async ({ peer, relay }, info) => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const app = createServer(async (request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Demo</title><p id="title">Hello from the demo</p><p><a id="docs" href="https://docs.example/guide" target="_blank" style="display:block;padding:40px">Docs</a></p><img src="/photo.png" alt="">`);
      return;
    }
    if (request.url !== "/photo.png") { response.writeHead(404); response.end(); return; }
    // Its picture is slow: the page is shown before its `load`.
    await released;
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Demo bot");
    const person = await peer("person", { serviceWorkers: "allow", beforeOpen: async (context) => { await context.addInitScript(() => {
      try { if (location.hostname === "localhost") localStorage.setItem("ghostly-test-services", "on"); } catch { /* opaque origin */ }
    }); } });
    const invite = await bot.run("invite", "create", "--label", "person");
    await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(person.page, invite.invite as string);
    await expect(person.page.getByPlaceholder("Message…")).toBeEnabled();
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    await bot.run("service", "add", "Demo", `http://127.0.0.1:${(app.address() as AddressInfo).port}`);
    await bot.run("service", "share", "demo", invite.chat as string);
    await person.page.context().route("https://docs.example/**", (route) => route.fulfill({ status: 200, body: "Docs" }));

    const open = person.page.getByTestId("open-service").filter({ hasText: "Demo" });
    await expect(open).toBeVisible({ timeout: 120_000 });
    await open.click();
    const view = person.page.locator("#ghostly-service-view");
    const demo = person.page.frameLocator("[data-testid=service-view-frame]").frameLocator("iframe");
    await expect(demo.locator("#title")).toHaveText("Hello from the demo", { timeout: 60_000 });
    await expect(view.getByTestId("service-view-offline")).toBeHidden({ timeout: 15_000 });
    // Past the seconds the tap on Open counts as one on Ghostly's page (it would be offered on the bar instead).
    await person.page.waitForTimeout(6_000);
    // The person's tap on its link, its picture still on its way: a new tab. The view's sandbox dropped it with no word.
    const tab = person.page.context().waitForEvent("page", { timeout: 10_000 });
    await demo.locator("#docs").click();
    expect((await tab).url()).toBe("https://docs.example/guide");
  } catch (error) {
    await bot.attachLogs(info);
    throw error;
  } finally {
    release();
    await bot.stop();
    app.close();
  }
});
