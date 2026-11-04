import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext } from "@playwright/test";
import { expect, test } from "../support/extension";
import type { Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * What a contact's shared web app keeps on its viewer origin in Ghostly Browser (`https://<service>.<peer>.<tag>.invalid`):
 * a cookie, its localStorage, an IndexedDB database and a Cache Storage entry, in the person's Chrome profile. They
 * stayed there for good once the chat was deleted, or after Clear all data: the origin is named from the chat's key, so
 * nothing opened it again. Read back as Chrome keeps them, from a tab on that origin the extension does not serve.
 */
test.describe.configure({ timeout: 8 * 60_000 });

/** A web app on A's machine that keeps one of each kind of storage, then says so. */
async function keepingApp(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Keeper</title><p id="out">…</p><script>
        document.cookie = "probe-c=1; Secure; SameSite=Lax; Max-Age=3600";
        localStorage.setItem("probe-k", "1");
        const open = indexedDB.open("probe-db", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("s");
        open.onsuccess = () => { open.result.close(); caches.open("probe-cache").then((c) => c.put("/probe", new Response("x"))).then(() => { document.getElementById("out").textContent = "kept"; }); };
      </script>`);
    } else {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not here");
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { server, port: (server.address() as AddressInfo).port };
}

/** What Chrome keeps for `origin`, read from a plain tab on it (answered here, not by the extension). */
async function kept(context: BrowserContext, origin: string): Promise<{ cookies: string[]; ls: string[]; idb: string[]; caches: string[] }> {
  const probe = `${origin}/__probe`;
  await context.route(probe, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>probe</title>" }));
  const page = await context.newPage();
  try {
    await page.goto(probe);
    const inPage = await page.evaluate(async () => ({
      ls: Object.keys(localStorage),
      idb: (await indexedDB.databases()).map((d) => d.name ?? ""),
      caches: await caches.keys(),
    }));
    return { cookies: (await context.cookies(origin)).map((c) => c.name), ...inPage };
  } finally {
    await page.close();
    await context.unroute(probe);
  }
}

const EMPTY = { cookies: [], ls: [], idb: [], caches: [] };

/** A shares the keeping app with B; B opens it once in a viewer tab, which keeps its storage, and closes it. */
async function openedOnce(extensionPeer: (name: string) => Promise<Peer>, port: number, name: string) {
  const [a, b] = await Promise.all([extensionPeer(`${name}-a`), extensionPeer(`${name}-b`)]);
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

  const open = b.page.getByTestId("open-service").filter({ hasText: "Keeper" });
  await expect(open).toBeVisible({ timeout: 120_000 });
  const viewerPromise = b.context.waitForEvent("page");
  await open.click();
  const viewer = await viewerPromise;
  await expect(viewer.locator("#out")).toHaveText("kept", { timeout: 150_000 });
  const origin = new URL(viewer.url()).origin;
  expect(new URL(origin).hostname.endsWith(".invalid"), "a virtual origin").toBe(true);
  await viewer.close();
  // Kept, as Chrome holds it: what the delete must take away.
  expect(await kept(b.context, origin)).toEqual({ cookies: ["probe-c"], ls: ["probe-k"], idb: ["probe-db"], caches: ["probe-cache"] });
  return { b, origin };
}

test("deleting the chat erases what the contact's app kept on its viewer origin", {
  tag: ["@feature:services.open", "@feature:chat.paired.storage"],
}, async ({ extensionPeer }) => {
  const app = await keepingApp();
  try {
    const { b, origin } = await openedOnce(extensionPeer, app.port, "forget-chat");
    await b.page.getByTestId("chat-options").click();
    await b.page.getByTestId("chat-options").locator("..").getByRole("button", { name: "Delete chat", exact: true }).click();
    await b.page.getByRole("dialog").getByRole("button", { name: "Delete chat", exact: true }).click();
    await expect(b.page.getByTestId("chat-row")).toHaveCount(0);
    await expect.poll(() => kept(b.context, origin), { timeout: 30_000 }).toEqual(EMPTY);
  } finally {
    app.server.close();
  }
});

test("Clear all data erases what the contacts' apps the profile opened kept on their viewer origins", {
  tag: ["@feature:services.open", "@feature:app.clear-data"],
}, async ({ extensionPeer }) => {
  const app = await keepingApp();
  try {
    const { b, origin } = await openedOnce(extensionPeer, app.port, "forget-clear");
    await b.page.goto(b.page.url().replace(/#.*$/, "#/settings"));
    await b.page.getByTestId("clear-all-data").click();
    await b.page.getByTestId("clear-all-data-confirm").click();
    await expect(b.page.getByTitle("New Chat")).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => kept(b.context, origin), { timeout: 30_000 }).toEqual(EMPTY);
  } finally {
    app.server.close();
  }
});
