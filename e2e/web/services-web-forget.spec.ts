import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { pasteInvite } from "../support/clipboard";
import { expect, test, type Peer, type PeerOptions } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * What a contact's shared web app keeps on its own origin on the web (apps/web/src/svc/): its localStorage, an IndexedDB
 * database, a Cache Storage entry and the services worker the bridge registered. They stayed on the device for good once
 * the chat was deleted, or after Clear all data: the origin is named from the chat's key, so nothing opened it again.
 * Read back as the browser keeps them, from a frame on the app's origin under the web app's page (its partition).
 */
test.describe.configure({ timeout: 5 * 60_000 });

/** A web app on the bot's machine that keeps one of each kind of storage, then says so. */
async function keepingApp(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Keeper</title><p id="out">…</p><script>
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

/** What the browser keeps for `origin` in this page's partition, as a frame of it reads it. */
async function kept(page: Page, origin: string): Promise<{ ls: string[]; idb: string[]; caches: string[]; workers: number }> {
  // A frame of its own each time (the page may have reloaded, as after Clear all data).
  await page.evaluate((src) => new Promise<void>((loaded) => {
    document.getElementById("kept-probe")?.remove();
    const f = document.createElement("iframe");
    f.id = "kept-probe";
    f.style.display = "none";
    f.onload = () => loaded();
    f.src = src;
    document.body.append(f);
  }), `${origin}/_ghostly-svc/bridge.html`);
  const frame = (await page.locator("#kept-probe").elementHandle())!.contentFrame();
  return (await frame)!.evaluate(async () => ({
    // Only what the contact's app wrote: the suite's own init script puts `ghostly-test-*` in every frame.
    ls: Object.keys(localStorage).filter((k) => !k.startsWith("ghostly-test-")),
    idb: (await indexedDB.databases()).map((d) => d.name ?? ""),
    caches: await caches.keys(),
    workers: (await navigator.serviceWorker.getRegistrations()).length,
  }));
}

/** A person on the web with a chat with a bot that shares `keepingApp`; the app opened once, its storage kept, closed. */
async function openedOnce(peer: (name: string, options?: PeerOptions) => Promise<Peer>, relayUrl: string, bot: HeadlessBot, port: number) {
  await bot.start(relayUrl, "Keeper bot");
  const person = await peer("person", { serviceWorkers: "allow", beforeOpen: async (context) => { await context.addInitScript(() => {
    try { if (location.hostname === "localhost") localStorage.setItem("ghostly-test-services", "on"); } catch { /* opaque origin */ }
  }); } });
  const invite = await bot.run("invite", "create", "--label", "person");
  await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(person.page, invite.invite as string);
  await expect(person.page.getByPlaceholder("Message…")).toBeEnabled();
  await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
  await bot.run("service", "add", "Keeper", `http://127.0.0.1:${port}`);
  await bot.run("service", "share", "keeper", invite.chat as string);
  const open = person.page.getByTestId("open-service").filter({ hasText: "Keeper" });
  await expect(open).toBeVisible({ timeout: 120_000 });
  await open.click();
  const origin = new URL((await person.page.getByTestId("service-view-frame").getAttribute("src"))!).origin;
  await expect(person.page.frameLocator("[data-testid=service-view-frame]").frameLocator("iframe").locator("#out")).toHaveText("kept", { timeout: 60_000 });
  await person.page.getByTestId("service-view-close").click();
  await expect(person.page.locator("#ghostly-service-view")).toHaveCount(0);
  // Kept, as the browser holds it: what the delete must take away.
  expect(await kept(person.page, origin)).toEqual({ ls: ["probe-k"], idb: ["probe-db"], caches: ["probe-cache"], workers: 1 });
  await person.page.evaluate(() => document.getElementById("kept-probe")?.remove());
  return { person, origin };
}

const EMPTY = { ls: [], idb: [], caches: [], workers: 0 };

test("deleting the chat erases what the contact's app kept on its origin", {
  tag: ["@feature:services.web-open", "@feature:chat.paired.storage"],
}, async ({ peer, relay }, info) => {
  const url = await relay.listen();
  const app = await keepingApp();
  const bot = new HeadlessBot();
  try {
    const { person, origin } = await openedOnce(peer, url, bot, app.port);
    await person.page.getByTestId("chat-options").click();
    await person.page.getByTestId("chat-options").locator("..").getByRole("button", { name: "Delete chat", exact: true }).click();
    await person.page.getByRole("dialog").getByRole("button", { name: "Delete chat", exact: true }).click();
    await expect(person.page.getByTestId("chat-row")).toHaveCount(0);
    await expect.poll(() => kept(person.page, origin), { timeout: 30_000 }).toEqual(EMPTY);
  } catch (error) {
    await bot.attachLogs(info);
    throw error;
  } finally {
    await bot.stop();
    app.server.close();
  }
});

test("Clear all data erases what the contacts' apps the profile opened kept on their origins", {
  tag: ["@feature:services.web-open", "@feature:app.clear-data"],
}, async ({ peer, relay }, info) => {
  const url = await relay.listen();
  const app = await keepingApp();
  const bot = new HeadlessBot();
  try {
    const { person, origin } = await openedOnce(peer, url, bot, app.port);
    await person.page.goto("/#/settings");
    await person.page.getByTestId("clear-all-data").click();
    await person.page.getByTestId("clear-all-data-confirm").click();
    await expect(person.page).not.toHaveURL(/#\/settings/);
    await expect(person.page.getByTitle("New Chat")).toBeVisible();
    await expect.poll(() => kept(person.page, origin), { timeout: 30_000 }).toEqual(EMPTY);
  } catch (error) {
    await bot.attachLogs(info);
    throw error;
  } finally {
    await bot.stop();
    app.server.close();
  }
});
