import type { Page } from "@playwright/test";
import { copyInvite } from "../support/clipboard";
import { expect, link, test } from "../support/fixtures";

/**
 * The installable web app (docs/WEB.md § Install it): the service worker, the offline shell, the share target, the
 * `web+ghostly:` links and the icon's shortcuts. The rest of the web suite runs with service workers blocked
 * (e2e/playwright.config.ts); the peers here let the worker run. Against a deployed copy (E2E_WEB_URL) the worker
 * specs are left out: they post a form to the share target, which the deployed CSP refuses (`form-action 'none'`).
 */
const deployed = !!process.env.E2E_WEB_URL;

/** Until the page is controlled by the app's worker (it claims the pages it finds when it first activates). */
async function controlled(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? "")).toMatch(/\/sw\.js$/);
}

/** Every request the worker's caches hold, as `cache name → path`. */
function cached(page: Page): Promise<{ cache: string; path: string }[]> {
  return page.evaluate(async () => {
    const found: { cache: string; path: string }[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) {
        const url = new URL(request.url);
        found.push({ cache: name, path: url.origin === location.origin ? url.pathname + url.search : url.href });
      }
    }
    return found;
  });
}

test.describe("service worker", () => {
  test.skip(deployed, "posts a form to the share target, which the deployed CSP refuses");

  test("the app opens offline with its chats, and the worker caches the build's files only", { tag: ["@feature:app.pwa.offline"] }, async ({ peer }) => {
    const ana = await peer("Ana", { serviceWorkers: "allow" });
    await controlled(ana.page);
    await ana.page.getByTitle("New Chat").click();
    await expect(ana.page.getByTestId("invite-card")).toBeVisible();
    await ana.page.goto("/#/");
    await expect(ana.page.getByTestId("chat-row")).toHaveCount(1);

    // What the worker kept: its own cache, the app's page and the build's files. Never the update check (the app
    // asked for it by now), the sign-in callback, anything with a query, or another origin.
    const entries = await cached(ana.page);
    expect(entries.map((e) => e.path)).toContain("/");
    for (const { cache, path } of entries) {
      expect(cache).toMatch(/^ghostly-shell-/);
      expect(path, `${path} is a file of the build`).toMatch(/^\/($|assets\/[\w.-]+$|[\w-]+\.(png|svg|json)$)/);
      expect(path).not.toMatch(/version\.json|oidc-callback|sw\.js/);
    }

    await ana.context.setOffline(true);
    try {
      await ana.page.reload();
      await expect(ana.page.getByTitle("New Chat")).toBeVisible();
      await expect(ana.page.getByTestId("offline-banner")).toBeVisible();
      await expect(ana.page.getByTestId("chat-row")).toHaveCount(1);
    } finally {
      await ana.context.setOffline(false);
    }
    await expect(ana.page.getByTestId("offline-banner")).toBeHidden();
  });

  test("text, a link and a file shared from another app open the chat's composer", { tag: ["@feature:app.pwa.share-target"] }, async ({ peer }) => {
    const ana = await peer("Ana", { serviceWorkers: "allow" });
    const bo = await peer("Bo");
    await link(ana, bo);
    await controlled(ana.page);
    await ana.page.goto("/#/");

    // What the system does when a person shares into the installed app: a navigation that posts the manifest's form.
    await ana.page.evaluate(() => {
      const form = Object.assign(document.createElement("form"), { method: "post", enctype: "multipart/form-data", action: "/share-target" });
      for (const [name, value] of [["title", "A ghost"], ["text", "Look at this"], ["url", "https://example.com/boo"]]) {
        form.append(Object.assign(document.createElement("input"), { type: "hidden", name, value }));
      }
      const files = Object.assign(document.createElement("input"), { type: "file", name: "files", multiple: true });
      const transfer = new DataTransfer();
      transfer.items.add(new File(["boo"], "ghost.txt", { type: "text/plain" }));
      files.files = transfer.files;
      form.append(files);
      document.body.append(form);
      form.submit();
    });

    await expect(ana.page).toHaveURL(/#\/shared$/);
    await expect(ana.page.getByTestId("share-picker")).toBeVisible();
    await expect(ana.page.getByTestId("share-files")).toHaveText("ghost.txt");
    await expect(ana.page.getByTestId("share-text")).toHaveText("Look at this\nhttps://example.com/boo");
    await ana.page.getByTestId("share-chat").click();

    await expect(ana.page).toHaveURL(/#\/chat\//);
    await expect(ana.page.getByTestId("attachment-sheet")).toBeVisible();
    await expect(ana.page.getByTestId("attachment-item")).toContainText("ghost.txt");
    await ana.page.keyboard.press("Escape");
    await expect(ana.page.getByPlaceholder("Message…")).toHaveValue("Look at this\nhttps://example.com/boo");

    // Held in memory until taken, and taken once: the page again finds nothing waiting.
    await ana.page.goto("/#/shared");
    await expect(ana.page.getByTestId("share-none")).toHaveText("Nothing was shared, or it was already picked up.", { timeout: 15_000 });
  });
});

test("a web+ghostly: link opens the invite and leaves the address", { tag: ["@feature:app.pwa.protocol"] }, async ({ peer }) => {
  const ana = await peer("Ana");
  const bo = await peer("Bo");
  await ana.page.getByTitle("New Chat").click();
  const code = (await copyInvite(ana.page)).split("#").pop()!;
  expect(code).toMatch(/^ghostly1/);

  // What the browser opens for `web+ghostly:<code>` (manifest `protocol_handlers`, url `/#%s`): the link, escaped.
  await bo.page.goto(`/#${encodeURIComponent(`web+ghostly:${code}`)}`);
  await expect(bo.page.getByPlaceholder("Message…")).toBeVisible();
  await expect(bo.page).toHaveURL(/#\/chat\/[^/]+$/);
  expect(bo.page.url()).not.toContain("ghostly1");

  // Not an invite: refused like a bad invite, and gone from the address all the same.
  await bo.page.goto(`/#${encodeURIComponent("web+ghostly:nonsense")}`);
  await expect(bo.page.getByTestId("invite-link-invalid")).toBeVisible();
  expect(bo.page.url()).not.toContain("nonsense");
});

test("the app icon's shortcuts: New chat, Scan invite, Wallets", { tag: ["@feature:app.pwa.shortcuts"] }, async ({ peer }) => {
  const ana = await peer("Ana");
  // The suite's contract (e2e/playwright.config.ts): a peer that did not ask for the worker runs without one.
  await ana.page.waitForFunction(() => document.readyState === "complete");
  expect(await ana.page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r))).toBe(false);
  await ana.page.goto("/#/new");
  await expect(ana.page.getByTestId("invite-card")).toBeVisible();
  await expect(ana.page).toHaveURL(/#\/chat\//);
  await expect(ana.page.getByTestId("chat-row")).toHaveCount(1);
  // The shortcut left the history: Back does not make another chat.
  await ana.page.goBack();
  await expect(ana.page.getByTestId("chat-row")).toHaveCount(1);

  await ana.page.goto("/#/scan");
  await expect(ana.page.getByLabel("QR camera preview")).toBeVisible();
  await expect(ana.page).toHaveURL(/#\/$/);
  await ana.page.keyboard.press("Escape");

  await ana.page.goto("/#/wallet");
  await expect(ana.page.getByTestId("wallet")).toBeVisible();
});
