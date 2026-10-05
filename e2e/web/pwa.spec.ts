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

    // What the worker kept: its own cache, the app's page and the build's files (the boot guard is one: the
    // page asks for it offline too). Never the update check (the app
    // asked for it by now), the sign-in callback, anything with a query, or another origin.
    const entries = await cached(ana.page);
    expect(entries.map((e) => e.path)).toContain("/");
    for (const { cache, path } of entries) {
      expect(cache).toMatch(/^ghostly-shell-/);
      expect(path, `${path} is a file of the build`).toMatch(/^\/($|assets\/[\w.-]+$|[\w-]+\.(png|svg|json)$|boot-guard\.js$)/);
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

/**
 * What Chromium does when the app can be installed: `beforeinstallprompt`, whose `prompt()` shows the browser's own
 * dialog. Here the prompt counts its calls in `window.installPrompts` instead.
 */
async function offerInstall(page: Page): Promise<void> {
  await page.evaluate(() => {
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt: () => { (window as { installPrompts?: number }).installPrompts = ((window as { installPrompts?: number }).installPrompts ?? 0) + 1; return Promise.resolve(); },
      userChoice: Promise.resolve({ outcome: "dismissed" as const }),
    });
    dispatchEvent(event);
  });
}
const installPrompts = (page: Page) => page.evaluate(() => (window as { installPrompts?: number }).installPrompts ?? 0);

/** Opens the account menu (the profile switcher over the account bar) and says whether Install app is in it. */
async function menuOffersInstall(page: Page): Promise<boolean> {
  await page.getByTestId("account-profile").click();
  await expect(page.getByTestId("profile-switcher")).toBeVisible();
  const offered = await page.getByTestId("install-app-menu").isVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("profile-switcher")).toBeHidden();
  return offered;
}

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const MAC_FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0";

test.describe("installing the app", () => {
  test("Chromium: Install app in the account menu, a hint once there is a chat, and both ask the browser", { tag: ["@feature:app.pwa.install-entry", "@feature:app.pwa.install"] }, async ({ peer }) => {
    const ana = await peer("Ana");
    const page = ana.page;
    // No offer from the browser: nothing to install, nowhere.
    await expect(page.getByTestId("install-hint")).toBeHidden();
    expect(await menuOffersInstall(page)).toBe(false);

    await offerInstall(page);
    expect(await menuOffersInstall(page)).toBe(true);
    // A first visit with nothing in it yet: no hint.
    await expect(page.getByTestId("install-hint")).toBeHidden();

    await page.getByTitle("New Chat").click();
    await expect(page.getByTestId("invite-card")).toBeVisible();
    await page.goto("/#/");
    await expect(page.getByTestId("install-hint")).toBeVisible();
    await page.getByTestId("install-hint-install").click();
    await expect.poll(() => installPrompts(page)).toBe(1);
    // It has done its job, whatever the person answered the browser.
    await expect(page.getByTestId("install-hint")).toBeHidden();

    // The browser offers again later: the menu has it, and asks the browser too.
    await offerInstall(page);
    await expect(page.getByTestId("install-hint")).toBeHidden();
    await page.getByTestId("account-profile").click();
    await page.getByTestId("install-app-menu").click();
    await expect(page.getByTestId("profile-switcher")).toBeHidden();
    await expect.poll(() => installPrompts(page)).toBe(2);

    // Installed: gone from the menu and from Settings.
    await offerInstall(page);
    await page.evaluate(() => dispatchEvent(new Event("appinstalled")));
    expect(await menuOffersInstall(page)).toBe(false);
    await page.goto("/#/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await expect(page.getByTestId("install-app")).toBeHidden();
  });

  test("Not now puts the hint away for good; Install stays in Settings", { tag: ["@feature:app.pwa.install-entry"] }, async ({ peer }) => {
    const ana = await peer("Ana");
    const page = ana.page;
    // The second visit, no chat yet: the hint may show.
    await page.reload();
    await expect(page.getByTitle("New Chat")).toBeVisible();
    await offerInstall(page);
    await expect(page.getByTestId("install-hint")).toBeVisible();
    await page.getByTestId("install-hint-later").click();
    await expect(page.getByTestId("install-hint")).toBeHidden();

    await page.reload();
    await expect(page.getByTitle("New Chat")).toBeVisible();
    await offerInstall(page);
    expect(await menuOffersInstall(page)).toBe(true);
    await expect(page.getByTestId("install-hint")).toBeHidden();
    await page.goto("/#/settings");
    await page.getByTestId("install-app").click();
    await expect.poll(() => installPrompts(page)).toBe(1);
  });

  // CI has Chromium only: these say they are Safari and Firefox, which is all the app goes by.
  test("iPhone Safari: Install shows where Add to Home Screen is", { tag: ["@feature:app.pwa.install-entry", "@feature:app.pwa.install"] }, async ({ peer }) => {
    const ana = await peer("Ana", { mobile: true, userAgent: IPHONE_SAFARI });
    const page = ana.page;
    await page.reload();
    await expect(page.getByTitle("New Chat")).toBeVisible();
    await expect(page.getByTestId("install-hint")).toBeVisible();
    await page.getByTestId("install-hint-install").click();
    const steps = page.getByTestId("install-steps");
    await expect(steps).toBeVisible();
    await expect(steps).toHaveAttribute("data-kind", "ios");
    await expect(steps).toContainText("Add Ghostly to your Home Screen");
    await expect(steps.getByTestId("install-share-glyph")).toBeVisible();
    // iOS 26 keeps Add to Home Screen under More in the Share sheet.
    await expect(steps).toContainText("Choose Add to Home Screen (under More if you don't see it).");
    await steps.getByTestId("install-steps-done").click();
    await expect(steps).toBeHidden();
    // Shown once: Safari never says the app was added, so having seen the steps is enough.
    await expect(page.getByTestId("install-hint")).toBeHidden();

    // Settings still has it, and the same steps.
    await page.getByTestId("mobile-tab-settings").click();
    await page.getByTestId("install-app").click();
    await expect(steps).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(steps).toBeHidden();
  });

  test("Safari on a Mac: Install app shows File, Add to Dock; Firefox offers nothing", { tag: ["@feature:app.pwa.install-entry"] }, async ({ peer }) => {
    const ana = await peer("Ana", { userAgent: MAC_SAFARI });
    await ana.page.getByTestId("account-profile").click();
    await ana.page.getByTestId("install-app-menu").click();
    const steps = ana.page.getByTestId("install-steps");
    await expect(steps).toHaveAttribute("data-kind", "dock");
    await expect(steps).toContainText("In the menu bar, choose File.");
    await expect(steps).toContainText("Choose Add to Dock.");
    await steps.getByTestId("install-steps-done").click();
    await expect(steps).toBeHidden();

    const bo = await peer("Bo", { userAgent: MAC_FIREFOX });
    await bo.page.reload();
    await expect(bo.page.getByTitle("New Chat")).toBeVisible();
    await expect(bo.page.getByTestId("install-hint")).toBeHidden();
    expect(await menuOffersInstall(bo.page)).toBe(false);
    await bo.page.goto("/#/settings");
    await expect(bo.page.getByTestId("settings-page")).toBeVisible();
    await expect(bo.page.getByTestId("install-app")).toBeHidden();
  });
});
