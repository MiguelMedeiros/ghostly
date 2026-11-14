import type { Page } from "@playwright/test";
import { copyInvite } from "../support/clipboard";
import { chat, connect, expect, link, type Peer, test } from "../support/fixtures";
import { choose } from "../support/select";

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
      // Whole paths: a build's hashed name may end in `sw` (`/assets/fr-CszXulsw.js`).
      expect(path).not.toMatch(/^\/(version\.json|oidc-callback\.html|sw\.js)$/);
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

  test("the install leaves the online-only libraries and the other languages out; a language picked later opens offline too", { tag: ["@feature:app.pwa.offline"] }, async ({ peer }) => {
    const ana = await peer("Ana", { serviceWorkers: "allow" });
    await controlled(ana.page);
    const paths = async () => (await cached(ana.page)).map((entry) => entry.path);
    // Pubky's approval, a Keet proof and the USDT wallet need the network, and the browser reads in English.
    expect((await paths()).filter((path) => /^\/assets\/(pubky|keet-identity-key|usdt|ar|es|fr|it|ja|pt|zh)-/.test(path))).toEqual([]);

    await ana.page.goto("/#/settings");
    await choose(ana.page.getByTestId("settings-language"), "fr");
    await expect(ana.page.getByTitle("Nouvelle conversation", { exact: true })).toBeVisible();
    // Fetched through the worker, so kept like any file of the build.
    await expect.poll(async () => (await paths()).filter((path) => /^\/assets\/fr-/.test(path)).length).toBe(1);

    await ana.context.setOffline(true);
    try {
      await ana.page.reload();
      await expect(ana.page.getByTitle("Nouvelle conversation", { exact: true })).toBeVisible();
      await expect(ana.page.getByTestId("offline-banner")).toBeVisible();
    } finally {
      await ana.context.setOffline(false);
    }
  });

  test("a chat opened offline says Offline in its header, not a connection issue with the relays' errors", { tag: ["@feature:app.pwa.offline"] }, async ({ peer }) => {
    const ana = await peer("Ana", { serviceWorkers: "allow" });
    const bo = await peer("Bo");
    await link(ana, bo);
    await controlled(ana.page);
    await expect(ana.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /);
    const chat = ana.page.url();

    // No network: Playwright's offline mode leaves routed requests alone, and the test relay is one, so it goes too.
    let offline = false;
    await ana.context.route(/^https:\/\/(pkarr\.pubky\.(org|app)|relay\.pkarr\.org|pkarr\.miguelmedeiros\.dev)\//, (r) => (offline ? r.abort("internetdisconnected") : r.fallback()));
    await ana.page.goto("about:blank");
    offline = true;
    await ana.context.setOffline(true);
    try {
      await ana.page.goto(chat);
      await expect(ana.page.getByTestId("offline-banner")).toBeVisible();
      const header = ana.page.getByTestId("connection-options");
      await expect(header).toHaveAccessibleName("Connection options: Offline");
      // Meanwhile the relays fail and the DHT cannot be read: still Offline, and none of their errors.
      const seen = new Set<string>();
      for (let i = 0; i < 16; i++) { seen.add(await header.getAttribute("aria-label") ?? ""); await ana.page.waitForTimeout(500); }
      expect([...seen]).toEqual(["Connection options: Offline"]);
      await header.click();
      await expect(ana.page.getByTestId("connection-state")).toHaveText("Offline");
      // (Details, closed, keeps each relay's health for whoever looks.)
      await expect(ana.page.getByText(/Pkarr|relay is cooling|Publish failed|DHT delivery/).filter({ visible: true })).toHaveCount(0);
      await ana.page.keyboard.press("Escape");
    } finally {
      offline = false;
      await ana.context.setOffline(false);
    }
    await expect(ana.page.getByTestId("offline-banner")).toBeHidden();
    await expect(ana.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
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
    // The picker opened by itself: the share takes a press only once it has been said.
    await expect(ana.page.getByTestId("share-next")).toContainText("ghost.txt");
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

  test("a share into the same window waits behind the one in the picker, and shares past the three that can wait are said, never dropped without a word", { tag: ["@feature:app.pwa.share-target"] }, async ({ peer }) => {
    const ana = await peer("Ana", { serviceWorkers: "allow" });
    const bo = await peer("Bo");
    await link(ana, bo);
    await controlled(ana.page);
    await ana.page.goto("/#/");
    const text = (page: Page) => page.getByTestId("share-text");

    // One window, two shares: the second replaces the page, which hands the first to the next one, ahead of it.
    await postShare(ana.page, "share number 1");
    await expect(text(ana.page)).toHaveText("share number 1");
    await postShare(ana.page, "share number 2");
    await expect(text(ana.page)).toHaveText("share number 1");

    // Three more, each from a tab of its own, as a desktop system delivers them: one fits, two do not.
    for (const n of [3, 4, 5]) {
      const tab = await ana.context.newPage();
      await tab.goto("/");
      await postShare(tab, `share number ${n}`);
      await expect(tab.getByTestId("other-tab")).toHaveAttribute("data-state", "shared");
    }
    await expect(ana.page.getByTestId("share-dropped-title")).toHaveText("2 more shares couldn't be kept: 3 were already waiting.", { timeout: 15_000 });
    await expect(text(ana.page)).toHaveText("share number 1");
    await expect(ana.page.getByTestId("share-next")).toContainText("share number 1");
    for (const n of [2, 3]) {
      await ana.page.getByTestId("share-cancel").click();
      await expect(text(ana.page)).toHaveText(`share number ${n}`);
      await expect(ana.page.getByTestId("share-dropped")).toBeHidden();
      // The next share takes a press only once it has been said.
      await expect(ana.page.getByTestId("share-next")).toContainText(`share number ${n}`);
    }
    await ana.page.getByTestId("share-cancel").click();
    await expect(ana.page).toHaveURL(/#\/$/);
  });

  test("a share picked for a chat with another waiting shows the next one, and a share made later opens the picker again", { tag: ["@feature:app.pwa.share-target"] }, async ({ peer }) => {
    const ana = await peer("Ana", { serviceWorkers: "allow" });
    const bo = await peer("Bo");
    await link(ana, bo);
    await controlled(ana.page);
    await ana.page.goto("/#/");
    const text = ana.page.getByTestId("share-text");
    const shareFromTab = (value: string) => shareFromOwnTab(ana, value);

    await shareFromTab("share number 1");
    await expect(ana.page).toHaveURL(/#\/shared$/, { timeout: 15_000 });
    await expect(text).toHaveText("share number 1");
    await shareFromTab("share number 2");
    await expect(text).toHaveText("share number 1");

    // Picked for a chat: the picker shows the one that waited behind it, and the last one picked opens its chat.
    await expect(ana.page.getByTestId("share-next")).toContainText("share number 1");
    await ana.page.getByTestId("share-chat").click();
    await expect(text).toHaveText("share number 2");
    await expect(ana.page).toHaveURL(/#\/shared$/);
    // The next share takes a press only once it has been said.
    await expect(ana.page.getByTestId("share-next")).toContainText("share number 2");
    await ana.page.getByTestId("share-chat").click();
    await expect(ana.page).toHaveURL(/#\/chat\//);
    // Both went to that chat's composer, in their order.
    await expect(ana.page.getByPlaceholder("Message…")).toHaveValue("share number 1\nshare number 2");

    // A later share opens the picker again.
    await shareFromTab("share number 3");
    await expect(ana.page).toHaveURL(/#\/shared$/, { timeout: 15_000 });
    await expect(text).toHaveText("share number 3");
  });

  test("a share picked for a chat where one of my messages is being edited waits for the edit to end, then goes in the draft", { tag: ["@feature:app.pwa.share-target", "@feature:chat.edit"] }, async ({ peer }) => {
    const ana = await peer("Ana", { serviceWorkers: "allow" });
    const bo = await peer("Bo");
    await link(ana, bo);
    await connect(ana, bo);
    await controlled(ana.page);
    const field = ana.page.getByPlaceholder("Message…");
    const editBar = ana.page.getByTestId("composer-edit");

    // ↑ in the empty composer edits Ana's last message; then she shares into the app and picks this chat.
    await field.click();
    await field.press("ArrowUp");
    await expect(editBar).toBeVisible();
    await expect(field).toHaveValue("hello from Ana");
    await shareFromOwnTab(ana, "shared words");
    await expect(ana.page).toHaveURL(/#\/shared$/, { timeout: 15_000 });
    await expect(ana.page.getByTestId("share-next")).toContainText("shared words");
    await ana.page.getByTestId("share-chat").click();
    await expect(ana.page).toHaveURL(/#\/chat\//);

    // The edit is as it was: the shared words are not in it, and Enter would save only the edit.
    await expect(editBar).toBeVisible();
    await expect(field).toHaveValue("hello from Ana");
    // The edit left: the draft comes back with the shared words in it, and the message was never edited.
    await field.press("Escape");
    await expect(editBar).toBeHidden();
    await expect(field).toHaveValue("shared words");
    await expect(chat(ana).getByTestId("message-edited")).toHaveCount(0);
  });

  test.describe("the next share waiting", () => {
    test("is said and gets the focus off the button pressed: a second Enter or a double click never acts on it unseen", { tag: ["@feature:app.pwa.share-target"] }, async ({ peer }) => {
      const ana = await peer("Ana", { serviceWorkers: "allow" });
      const bo = await peer("Bo");
      await link(ana, bo);
      await controlled(ana.page);
      await ana.page.goto("/#/");
      const text = ana.page.getByTestId("share-text");
      const said = ana.page.getByTestId("share-next");
      const heading = ana.page.getByTestId("share-picker").getByRole("heading", { level: 1 });
      await shareFromOwnTab(ana, "share number 1");
      await expect(ana.page).toHaveURL(/#\/shared$/, { timeout: 15_000 });
      for (const n of [2, 3]) await shareFromOwnTab(ana, `share number ${n}`);
      await expect(text).toHaveText("share number 1");

      // A chat picked with Enter: the focus goes to the page's heading, so Enter again picks nothing.
      await expect(said).toContainText("share number 1");
      await ana.page.getByTestId("share-chat").focus();
      await ana.page.keyboard.press("Enter");
      await expect(text).toHaveText("share number 2");
      await expect(heading).toBeFocused();
      await ana.page.keyboard.press("Enter");
      await expect(said).toContainText("share number 2");
      await expect(said).toHaveAttribute("aria-live", "polite");
      await expect(text).toHaveText("share number 2");
      await expect(ana.page).toHaveURL(/#\/shared$/);

      // A double click (or tap) on Cancel puts aside the share it was pressed for, not the next one too.
      await ana.page.getByTestId("share-cancel").dblclick();
      await expect(text).toHaveText("share number 3");
      await expect(said).toContainText("share number 3");
      await expect(ana.page).toHaveURL(/#\/shared$/);
      await ana.page.getByTestId("share-chat").click();
      await expect(ana.page).toHaveURL(/#\/chat\//);
      await expect(ana.page.getByPlaceholder("Message…")).toHaveValue("share number 1\nshare number 3");
    });
  });
});

/** A share from a tab of its own, as a desktop system delivers them: the app's tab (`ana`'s page) gets them all. */
async function shareFromOwnTab(ana: Peer, value: string): Promise<void> {
  const tab = await ana.context.newPage();
  await tab.goto("/");
  await postShare(tab, value);
  await expect(tab.getByTestId("other-tab")).toHaveAttribute("data-state", "shared");
}

/** What the system does when a person shares text into the installed app: a navigation of `page` that posts the manifest's form. */
async function postShare(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    const form = Object.assign(document.createElement("form"), { method: "post", enctype: "multipart/form-data", action: "/share-target" });
    form.append(Object.assign(document.createElement("input"), { type: "hidden", name: "text", value }));
    document.body.append(form);
    form.submit();
  }, text);
}

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
  // Any site can send the browser here: New opens with Chat focused, and only a press makes the chat.
  await expect(ana.page.getByTestId("sidebar-new-menu")).toBeVisible();
  await expect(ana.page).toHaveURL(/#\/$/);
  await expect(ana.page.getByTestId("chat-row")).toHaveCount(0);
  await ana.page.keyboard.press("Enter");
  await expect(ana.page.getByTestId("invite-card")).toBeVisible();
  await expect(ana.page).toHaveURL(/#\/chat\//);
  await expect(ana.page.getByTestId("chat-row")).toHaveCount(1);
  // The shortcut left the history: Back does not open New again, nor make another chat.
  await ana.page.goBack();
  await expect(ana.page.getByTestId("sidebar-new-menu")).toBeHidden();
  await expect(ana.page.getByTestId("chat-row")).toHaveCount(1);

  // Join opens with Scan focused, and the camera starts only on a press.
  await ana.page.goto("/#/scan");
  await expect(ana.page.getByRole("button", { name: "Scan QR" })).toBeFocused();
  await expect(ana.page).toHaveURL(/#\/$/);
  await expect(ana.page.getByLabel("QR camera preview")).toBeHidden();
  await ana.page.keyboard.press("Enter");
  await expect(ana.page.getByLabel("QR camera preview")).toBeVisible();
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

/**
 * The person opens the web app again later: the tab closed, a new one. A reload is the same visit, so it never makes
 * the second one the hint waits for (installPrompt.ts `countInstallVisit`).
 */
async function openAgain(peer: Peer): Promise<void> {
  await peer.page.close();
  peer.page = await peer.context.newPage();
  await peer.page.goto("/");
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
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
    await page.getByTestId("install-hint-install").focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => installPrompts(page)).toBe(1);
    // It has done its job, whatever the person answered the browser. The key that pressed it lands on New chat.
    await expect(page.getByTestId("install-hint")).toBeHidden();
    await expect(page.getByTitle("New Chat")).toBeFocused();

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
    // A reload of the first visit, no chat yet: still no hint.
    await ana.page.reload();
    await expect(ana.page.getByTitle("New Chat")).toBeVisible();
    await offerInstall(ana.page);
    expect(await menuOffersInstall(ana.page)).toBe(true);
    await expect(ana.page.getByTestId("install-hint")).toBeHidden();

    // The second visit, no chat yet: the hint may show.
    await openAgain(ana);
    let page = ana.page;
    await offerInstall(page);
    await expect(page.getByTestId("install-hint")).toBeVisible();
    await page.getByTestId("install-hint-later").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("install-hint")).toBeHidden();
    await expect(page.getByTitle("New Chat")).toBeFocused();

    await openAgain(ana);
    page = ana.page;
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
    await openAgain(ana);
    const page = ana.page;
    await expect(page.getByTestId("install-hint")).toBeVisible();
    await page.getByTestId("install-hint-install").click();
    const steps = page.getByTestId("install-steps");
    await expect(steps).toBeVisible();
    await expect(steps).toHaveAttribute("data-kind", "ios");
    await expect(steps).toContainText("Add Ghostly to your Home Screen");
    await expect(steps.getByTestId("install-share-glyph")).toBeVisible();
    // iOS 26 keeps Add to Home Screen under More in the Share sheet.
    await expect(steps).toContainText("Choose Add to Home Screen (under More if you don't see it).");
    await expect(steps.getByTestId("install-steps-done")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(steps).toBeHidden();
    // Shown once: Safari never says the app was added, so having seen the steps is enough. The hint's Install went
    // with it, so the focus goes to New chat.
    await expect(page.getByTestId("install-hint")).toBeHidden();
    await expect(page.getByTitle("New Chat")).toBeFocused();

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
    await openAgain(bo);
    await expect(bo.page.getByTestId("install-hint")).toBeHidden();
    expect(await menuOffersInstall(bo.page)).toBe(false);
    await bo.page.goto("/#/settings");
    await expect(bo.page.getByTestId("settings-page")).toBeVisible();
    await expect(bo.page.getByTestId("install-app")).toBeHidden();
  });
});
