import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { expect, link, test as base, type Peer } from "../support/fixtures";

/**
 * A tap on a wake-up notification (WISP 401 § Wake-up push) with two windows of the app open: the installed app and a
 * tab, or two profiles side by side. The tap goes to the window that runs the notice's profile and holds its peer: not
 * to a tab waiting behind it (which opened nothing), and not to another profile's window (which switched to the
 * notice's profile, closing the one it ran, and then waited behind the window that already ran it).
 *
 * Chromium (the web project) and WebKit (e2e/playwright.webkit.config.ts). A new window, when no window runs the
 * profile, opens only from a real tap, which a test cannot make: the push worker's unit test covers it.
 */
const deployed = !!process.env.E2E_WEB_URL;
const WORK = "workprofl1";

/**
 * The build's own worker script with one message added, the tap: it hands the worker's `notificationclick` listener a
 * notice of that chat, as the browser does. WebKit under Playwright shows no notification at all (and Chromium's
 * headless shell none either), so no notice is shown; where the tap goes is all the worker's own code.
 */
const TAP = `
self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "e2e-tap") return;
  const click = new Event("notificationclick");
  click.notification = { data: event.data.data, close() {} };
  click.waitUntil = (promise) => event.waitUntil(promise);
  self.dispatchEvent(click);
});`;
const TAP_SCRIPT = "/sw.js?e2e-tap";

/**
 * The suite's server, behind a server of this test's that serves `TAP_SCRIPT` as the build's `/sw.js` with the tap
 * added. Not `context.route`: WebKit fetches a worker's script past it.
 */
const test = base.extend({
  baseURL: async ({ baseURL }, use) => {
    const target = new URL(baseURL!);
    const server = createServer((incoming, answer) => {
      const tapped = incoming.url === TAP_SCRIPT;
      // The script whole, to add to: not compressed.
      const headers = { ...incoming.headers, host: target.host, ...(tapped && { "accept-encoding": "identity" }) };
      // Only the path and query asked for, always on the suite's server: a request line naming another host goes nowhere else.
      const asked = new URL(incoming.url ?? "/", "http://localhost");
      const upstream = request(target.origin + (tapped ? "/sw.js" : asked.pathname + asked.search), { method: incoming.method, headers }, (response) => {
        if (!tapped) { answer.writeHead(response.statusCode!, response.headers); response.pipe(answer); return; }
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () => {
          const { "content-length": _, ...headers } = response.headers;
          answer.writeHead(200, headers);
          answer.end(Buffer.concat(parts).toString() + TAP);
        });
      });
      upstream.on("error", () => answer.destroy());
      incoming.pipe(upstream);
    });
    await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
    await use(`http://localhost:${(server.address() as AddressInfo).port}`);
    server.closeAllConnections();
    server.close();
  },
});

/** A tap on a wake-up notice of `path` in `profile`, through that profile's push worker (`/push/<profile>/`), from a page of the origin that is not the app. */
async function tap(bo: Peer, path: string, profile: string): Promise<void> {
  const page = await bo.context.newPage();
  await page.goto("/manifest.json");
  await page.evaluate(async ({ script, scope, data }) => {
    const registration = await navigator.serviceWorker.register(script, { scope });
    const worker = registration.active ?? await new Promise<ServiceWorker>((resolve) => {
      const next = (registration.installing ?? registration.waiting)!;
      next.addEventListener("statechange", () => { if (next.state === "activated") resolve(next); });
    });
    worker.postMessage({ type: "e2e-tap", data });
  }, { script: TAP_SCRIPT, scope: `/push/${profile || "default"}/`, data: { path, profile } });
}

const waiting = (page: Page) => expect(page.getByTestId("other-tab")).toBeVisible();

test.beforeEach(() => {
  test.skip(deployed, "registers the push worker on the origin under test");
});

test("a tap opens the chat in the tab that runs the profile, not in a tab waiting behind it", { tag: ["@feature:push.wake.notify"] }, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const [ana, bo] = await Promise.all([peer("ana"), peer("bo", { serviceWorkers: "allow" })]);
  // A chat in Bo's list to open: whether it connects plays no part.
  await link(ana, bo);
  const path = new URL(bo.page.url()).hash.slice(1);
  expect(path).toMatch(/^\/chat\/[^/]+$/);
  await bo.page.goto("/#/");
  await expect(bo.page.getByTitle("New Chat")).toBeVisible();

  // A second tab of the same profile waits behind the first, and is the one in front.
  const second = await bo.context.newPage();
  await second.goto("/");
  await waiting(second);
  await second.bringToFront();

  await tap(bo, path, "");
  await expect(bo.page).toHaveURL(new RegExp(`#${path}$`));
  await waiting(second);
  await expect(second).not.toHaveURL(new RegExp(`#${path}$`));
});

test("a tap for one profile leaves another profile's window running it", { tag: ["@feature:push.wake.notify"] }, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const [ana, bo] = await Promise.all([peer("ana"), peer("bo", { serviceWorkers: "allow" })]);
  await link(ana, bo);
  const path = new URL(bo.page.url()).hash.slice(1);

  // A second profile, chosen last and opened in its own window: the newest one, in front.
  await bo.page.evaluate((id) => {
    const registry = JSON.parse(localStorage.getItem("ghostly_profiles") ?? "null") ?? { version: 1, active: "", profiles: [{ id: "", name: "Personal", createdAt: 0 }] };
    registry.profiles.push({ id, name: "Work", createdAt: Date.now() });
    registry.active = id;
    localStorage.setItem("ghostly_profiles", JSON.stringify(registry));
  }, WORK);
  // The first window keeps running Personal (a page is the profile it started as), back on its chat list.
  await bo.page.evaluate(() => { window.location.hash = "/"; });
  await expect(bo.page.getByTitle("New Chat")).toBeVisible();
  const work = await bo.context.newPage();
  await work.goto("/");
  await expect(work.getByTitle("New Chat")).toBeVisible();
  await work.bringToFront();

  await tap(bo, path, "");
  await expect(bo.page).toHaveURL(new RegExp(`#${path}$`));
  // The Work window still runs Work: it did not switch to Personal and end up waiting behind the first window.
  await work.waitForTimeout(1500);
  await expect(work.getByTestId("other-tab")).toHaveCount(0);
  await expect(work.getByTitle("New Chat")).toBeVisible();
  expect(await work.evaluate(() => (JSON.parse(localStorage.getItem("ghostly_profiles")!) as { active: string }).active)).toBe(WORK);
});
