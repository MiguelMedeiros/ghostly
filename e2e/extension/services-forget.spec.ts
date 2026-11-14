import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "../support/extension";
import type { Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * What a contact's shared web app keeps on its viewer origin in Ghostly Browser (`https://<service>.<peer>.<tag>.invalid`):
 * a cookie (one for the origin, one for the chat's whole site `<tag>.invalid`), its localStorage, an IndexedDB database,
 * a Cache Storage entry and an OPFS file, in the person's Chrome profile. They stayed there for good once the chat was
 * deleted, after Clear all data, or once the profile was deleted: the origin is named from the chat's key, so nothing
 * opened it again. Read back as Chrome keeps them, from a tab on that origin the extension does not serve.
 */
test.describe.configure({ timeout: 8 * 60_000 });

/** A web app on A's machine that keeps one of each kind of storage, then says so. */
async function keepingApp(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Keeper</title><p id="out">…</p><script>
        document.cookie = "probe-c=1; Secure; SameSite=Lax; Max-Age=3600";
        document.cookie = "probe-d=1; Domain=" + location.hostname.split(".").slice(2).join(".") + "; Secure; SameSite=Lax; Max-Age=3600";
        localStorage.setItem("probe-k", "1");
        const file = () => navigator.storage.getDirectory()
          .then((dir) => dir.getFileHandle("probe-f", { create: true }))
          .then((handle) => handle.createWritable())
          .then((writable) => writable.write("x").then(() => writable.close()));
        const open = indexedDB.open("probe-db", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("s");
        open.onsuccess = () => {
          open.result.close();
          caches.open("probe-cache").then((c) => c.put("/probe", new Response("x"))).then(file)
            .then(() => { document.getElementById("out").textContent = "kept"; }, (error) => { document.getElementById("out").textContent = String(error); });
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

type Kept = { cookies: string[]; ls: string[]; idb: string[]; caches: string[]; opfs: string[] };

/**
 * Takes `page` to `url` and waits for its document, without `page.goto`: should the extension close the tab as the
 * navigation ends, Playwright answers the goto with a response it already let go of (with tracing on, as in CI) and
 * fails the test from outside any promise of it ("Object with guid response@… was not bound"). Here a close is an
 * error the caller sees.
 */
async function open(page: Page, url: string): Promise<void> {
  await page.evaluate((to) => { location.href = to; }, url).catch(() => {});
  for (const end = Date.now() + 30_000; ;) {
    const at = await page.evaluate(() => (document.readyState === "complete" ? location.href : "")).catch(() => "");
    if (at === url) return;
    if (page.isClosed() || Date.now() > end) throw new Error(`The probe did not open ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** What Chrome keeps for `origin`, read from a plain tab on it (answered here, not by the extension). */
async function kept(context: BrowserContext, origin: string): Promise<Kept> {
  const probe = `${origin}/__probe`;
  await context.route(probe, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>probe</title>" }).catch(() => {}));
  const page = await context.newPage();
  try {
    await open(page, probe);
    const inPage = await page.evaluate(async () => ({
      ls: Object.keys(localStorage),
      idb: (await indexedDB.databases()).map((d) => d.name ?? ""),
      caches: await caches.keys(),
      opfs: await navigator.storage.getDirectory().then((dir) => dir.getFileHandle("probe-f")).then(() => ["probe-f"], () => []),
    }));
    return { cookies: (await context.cookies(origin)).map((c) => c.name).sort(), ...inPage };
  } finally {
    await page.close();
    await context.unroute(probe);
  }
}

/**
 * `kept`, polled while a clear runs: the extension closes any tab at a viewer origin it does not serve
 * (`closeLeftoverViewers`), the probe's too, and a read cut short that way is tried again.
 */
const keptSoon = (context: BrowserContext, origin: string) => kept(context, origin).catch(() => null);

const EMPTY: Kept ={ cookies: [], ls: [], idb: [], caches: [], opfs: [] };
const FULL: Kept = { cookies: ["probe-c", "probe-d"], ls: ["probe-k"], idb: ["probe-db"], caches: ["probe-cache"], opfs: ["probe-f"] };

/** A shares the keeping app with B. */
async function shareKeeper(a: Peer, b: Peer, port: number): Promise<void> {
  await pair(a, b);
  await a.page.getByTestId("account-services").click();
  await a.page.getByTestId("add-service").click();
  await a.page.getByTestId("service-name").fill("Keeper");
  await a.page.getByTestId("service-target").fill(`localhost:${port}`);
  await a.page.getByTestId("service-save").click();
  const item = a.page.getByTestId("service-item").filter({ hasText: "Keeper" });
  await item.getByTestId("service-people").click();
  const grant = item.getByTestId("service-grant").getByRole("switch");
  await grant.click();
  await expect(grant).toHaveAttribute("aria-checked", "true");
}

/** B opens the shared app in a viewer tab, which keeps its storage; the tab stays open. */
async function openKeeper(b: Peer): Promise<{ viewer: Page; origin: string }> {
  const open = b.page.getByTestId("open-service").filter({ hasText: "Keeper" });
  await expect(open).toBeVisible({ timeout: 120_000 });
  const viewerPromise = b.context.waitForEvent("page");
  await open.click();
  const viewer = await viewerPromise;
  await expect(viewer.locator("#out")).toHaveText("kept", { timeout: 150_000 });
  const origin = new URL(viewer.url()).origin;
  expect(new URL(origin).hostname.endsWith(".invalid"), "a virtual origin").toBe(true);
  // Kept, as Chrome holds it: what the delete must take away.
  expect(await kept(b.context, origin)).toEqual(FULL);
  return { viewer, origin };
}

async function deleteChat(b: Peer): Promise<void> {
  await b.page.getByTestId("chat-options").click();
  await b.page.getByTestId("chat-options").locator("..").getByRole("button", { name: "Delete chat", exact: true }).click();
  await b.page.getByRole("dialog").getByRole("button", { name: "Delete chat", exact: true }).click();
  await expect(b.page.getByTestId("chat-row")).toHaveCount(0);
}

test("deleting the chat closes the contact's app still open and erases what it kept on its viewer origin", {
  tag: ["@feature:services.open", "@feature:chat.paired.storage"],
}, async ({ extensionPeer }) => {
  const app = await keepingApp();
  try {
    const [a, b] = await Promise.all([extensionPeer("forget-chat-a"), extensionPeer("forget-chat-b")]);
    await shareKeeper(a, b, app.port);
    // The viewer tab stays open: it closes first, or the app in it would write its data again.
    const { viewer, origin } = await openKeeper(b);
    await b.page.bringToFront();
    await deleteChat(b);
    await expect.poll(() => viewer.isClosed(), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => keptSoon(b.context, origin), { timeout: 30_000 }).toEqual(EMPTY);
  } finally {
    app.server.close();
  }
});

test("Clear all data erases what the contacts' apps the profile opened kept on their viewer origins", {
  tag: ["@feature:services.open", "@feature:app.clear-data"],
}, async ({ extensionPeer }) => {
  const app = await keepingApp();
  try {
    const [a, b] = await Promise.all([extensionPeer("forget-clear-a"), extensionPeer("forget-clear-b")]);
    await shareKeeper(a, b, app.port);
    const { viewer, origin } = await openKeeper(b);
    await viewer.close();
    await b.page.goto(b.page.url().replace(/#.*$/, "#/settings"));
    await b.page.getByTestId("clear-all-data").click();
    await b.page.getByTestId("clear-all-data-confirm").click();
    await expect(b.page.getByTitle("New Chat")).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => keptSoon(b.context, origin), { timeout: 30_000 }).toEqual(EMPTY);
  } finally {
    app.server.close();
  }
});

test("deleting a profile erases what the contacts' apps it opened kept, and another profile's stays", {
  tag: ["@feature:services.open", "@feature:profiles.delete"],
}, async ({ extensionPeer, relay }) => {
  test.setTimeout(10 * 60_000);
  const app = await keepingApp();
  try {
    const [a, b, a2] = await Promise.all([extensionPeer("forget-profile-a"), extensionPeer("forget-profile-b"), extensionPeer("forget-profile-a2")]);
    const { page } = b;
    // The first profile opens the app from its chat with A.
    await shareKeeper(a, b, app.port);
    const first = await openKeeper(b);
    await first.viewer.close();

    // A second profile, on the test relay too, opens it from its own chat with A2.
    await page.evaluate(() => { location.hash = "#/profile"; });
    await page.getByTestId("profile-new").click();
    await page.getByTestId("profile-new-name").fill("Work");
    await page.getByTestId("profile-create").click();
    await expect(page.getByTestId("profile-name")).toHaveValue("Work", { timeout: 60_000 });
    await page.evaluate(() => { location.hash = "#/settings/network"; });
    await page.getByTestId("network-relays").fill(await relay.listen());
    await page.getByTestId("network-save").click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.evaluate(() => { location.hash = "#/"; });
    await expect(page.getByTitle("New Chat")).toBeVisible();
    await shareKeeper(a2, b, app.port);
    const work = await openKeeper(b);
    await work.viewer.close();
    expect(work.origin).not.toBe(first.origin);

    // Back to the first profile, and Work deleted from there.
    await page.evaluate(() => { location.hash = "#/profile"; });
    const rows = page.getByTestId("profile-row");
    const others = rows.filter({ hasNot: page.getByText("Work", { exact: true }) });
    const reloaded = page.waitForEvent("load", { timeout: 60_000 });
    await others.getByTestId("profile-switch").click();
    await reloaded;
    await expect(page.getByTestId("profile-name")).not.toHaveValue("Work", { timeout: 60_000 });
    await rows.filter({ has: page.getByText("Work", { exact: true }) }).getByTestId("profile-delete").click();
    const dialog = page.getByTestId("delete-profile");
    await dialog.getByTestId("delete-profile-confirm").fill("Work");
    await dialog.getByTestId("delete-profile-go").click();
    await expect(dialog).toBeHidden();
    await expect(rows).toHaveCount(1);

    await expect.poll(() => keptSoon(b.context, work.origin), { timeout: 30_000 }).toEqual(EMPTY);
    expect(await kept(b.context, first.origin), "the first profile's app keeps its data").toEqual(FULL);
  } finally {
    app.server.close();
  }
});
