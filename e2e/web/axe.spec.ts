import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { STORE_URL, serveStore, testStore } from "../support/appStore";
import { composerRow } from "../support/composer";
import { chat, expect, test } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * The main screens pass axe-core's WCAG 2.2 A and AA rules: no serious or critical finding (contrast, names, roles),
 * in the default colour theme, light and dark, left to right and right to left. The home screen, a 1:1 chat with its
 * ⋮ menu, + menu and payment sheet, a group, the wallets and New wallet, identities, settings, profile and services.
 * And the Apps screens on the suite's build (VITE_APPS_TEST), with the apps specs' test store: the Apps page, Add, the
 * install screen, the chat picker, + → Apps, the app's panel in a chat (beside it, and over it on a phone), the app card on
 * both sides, the app's details and Uninstall.
 */
test.describe.configure({ timeout: 6 * 60_000 });

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Language and light or dark as Settings keeps them, the app reloaded in them. */
async function look(page: Page, language: string, scheme: "light" | "dark"): Promise<void> {
  await page.evaluate(([language, scheme]) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language, colorScheme: scheme, theme: scheme }));
  }, [language, scheme]);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
  await expect(page.locator("html")).toHaveAttribute("lang", new RegExp(`^${language}`));
}

/**
 * What axe finds serious or critical on the page as it is now, one line per rule and element. `frames: false` leaves
 * out what is inside the frames: an app's own page is its publisher's, not Ghostly's. axe still reads the frames (the
 * Playwright runner always goes into them, whatever its `iframes` option says), so the findings there are dropped
 * here: a node in a frame has one selector per document on its way, the frame's and then its own. The frame element
 * itself (its title) is in the top document, still checked.
 */
async function findings(page: Page, { frames = true }: { frames?: boolean } = {}): Promise<string[]> {
  // Past the colour transitions and the fade-ins, so contrast is read on the colours as they end: until a frame has
  // none running, since one may start while another ends. Not past the loops: those that end by themselves take half
  // a minute or more (a "connecting" dot, a spinner), and none is text. Never more than a second on one look nor ten
  // in all: an animation whose end is never told would hold the test until its timeout.
  await page.evaluate(async () => {
    const until = performance.now() + 10_000;
    while (performance.now() < until) {
      await new Promise(requestAnimationFrame);
      const running = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === 1 && a.playState === "running");
      if (!running.length) return;
      await Promise.race([Promise.all(running.map((a) => a.finished.catch(() => {}))), new Promise((done) => setTimeout(done, 1000))]);
    }
  });
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical")
    .flatMap((v) => v.nodes.filter((n) => frames || n.target.length === 1).map((n) => `${v.id}: ${n.target.join(" ")} ${n.failureSummary?.split("\n").slice(1).join(" ").trim() ?? ""}`));
}

for (const [language, scheme] of [["en", "light"], ["ar", "dark"]] as const) {
  test(`the main screens pass axe in ${scheme}, ${language}`, { tag: ["@feature:app.accessibility", "@feature:app.theme", "@feature:app.i18n"] }, async ({ peer }) => {
    const [alice, bob] = await Promise.all([peer(`axe-${language}-a`), peer(`axe-${language}-b`)]);
    await pair(alice, bob);
    const page = alice.page;
    const chatUrl = new URL(page.url()).hash;
    await page.getByPlaceholder("Message…").fill("hello there");
    await page.getByPlaceholder("Message…").press("Enter");
    await expect(bob.page.locator(".chat-wallpaper").getByText("hello there")).toBeVisible();
    await page.getByTestId("sidebar-new-more").click();
    await page.getByTestId("new-group").click();
    await page.getByTestId("new-group-name").fill("Ghosts");
    await page.getByTestId("new-group-create").click();
    await page.getByTestId("group-share-done").click();
    await expect(page.getByTestId("group-name")).toHaveText("Ghosts");
    const groupUrl = new URL(page.url()).hash;
    await look(page, language, scheme);

    const found: Record<string, string[]> = {};
    const check = async (screen: string) => { const f = await findings(page); if (f.length) found[screen] = f; };

    await page.goto("/#/");
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await check("home");
    await page.goto(`/${chatUrl}`);
    await expect(page.getByTestId("connection-options")).toHaveAccessibleName(/ · /);
    await check("chat");
    await page.getByTestId("chat-options").click();
    await check("chat ⋮");
    await page.keyboard.press("Escape");
    await composerRow(page, "payment-button");
    await check("composer +");
    await (await composerRow(page, "payment-button")).click();
    await expect(page.getByTestId("payment-composer")).toBeVisible();
    await check("payment sheet");
    await page.keyboard.press("Escape");
    await page.goto(`/${groupUrl}`);
    await expect(page.getByTestId("group-name")).toHaveText("Ghosts");
    await check("group");
    for (const [path, ready] of [["wallet", "wallet"], ["identities", "identities-page"], ["settings", "settings-reduce-motion"], ["profile", "account-nickname"], ["services", "your-apps"]] as const) {
      await page.goto(`/#/${path}`);
      await expect(page.getByTestId(ready).first()).toBeVisible();
      await check(path);
      if (path === "wallet") {
        // Wallets → New: Mainnet and Testnet, each named in words ("Test money" in yellow, which a light page needs darker).
        await page.getByTestId("wallet-add").click();
        await expect(page.getByTestId("new-wallet")).toBeVisible();
        await check("new wallet");
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("new-wallet")).toHaveCount(0);
      }
    }
    expect(found).toEqual({});
  });
}

for (const [language, scheme] of [["en", "light"], ["ar", "dark"]] as const) {
  test(`the Apps screens pass axe in ${scheme}, ${language}`, { tag: ["@feature:app.accessibility", "@feature:apps.page", "@feature:apps.chat.card", "@feature:apps.view"] }, async ({ peer }) => {
    const store = await testStore();
    const [ana, bob] = await Promise.all([peer(`axe-apps-${language}-a`), peer(`axe-apps-${language}-b`)]);
    await Promise.all([serveStore(ana.context, store), serveStore(bob.context, store)]);
    await pair(ana, bob);
    const page = ana.page;
    const chatUrl = new URL(page.url()).hash;
    await Promise.all([look(page, language, scheme), look(bob.page, language, scheme)]);

    const found: Record<string, string[]> = {};
    const check = async (screen: string, on: Page = page, options?: { frames?: boolean }) => {
      const f = await findings(on, options);
      if (f.length) found[screen] = f;
    };

    // The Apps page with nothing yet, Add, the store it found, the store's listing.
    await page.goto("/#/apps");
    await expect(page.getByTestId("apps-none")).toBeVisible();
    await check("apps");
    await page.getByTestId("apps-add").click();
    await expect(page.getByTestId("apps-add-url")).toBeFocused();
    await check("add");
    await page.getByTestId("apps-add-url").fill(STORE_URL);
    await page.getByTestId("apps-add-check").click();
    await expect(page.getByTestId("apps-add-store")).toContainText(store.storeName);
    await check("add, a store");
    await page.getByTestId("apps-add-store-confirm").click();
    const listed = page.getByTestId("app-store").filter({ hasText: store.storeName });
    await listed.getByRole("button", { name: new RegExp(store.storeName) }).click();
    await expect(listed.getByTestId("app-listing-install")).toBeVisible();
    await check("apps, a store");

    // The install screen, its ⓘ open, then the app installed and the chat picker its Open shows.
    await listed.getByTestId("app-listing-install").click();
    const install = page.getByTestId("app-install");
    await expect(install.getByTestId("app-install-confirm")).toBeVisible();
    await check("install");
    await install.getByTestId("app-ip-line-info").click();
    await expect(install.getByTestId("app-ip-line-text")).toBeVisible();
    await check("install ⓘ");
    await install.getByTestId("app-install-confirm").click();
    await expect(page.getByTestId("installed-app")).toContainText(store.title);
    await check("apps, installed");
    await page.getByTestId("installed-app").getByTestId("installed-app-open").click();
    await expect(page.getByTestId("app-chat-picker")).toBeVisible();
    await check("chat picker");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("app-chat-picker")).toHaveCount(0);

    // + → Apps in the chat, the app's panel beside it, then the card it left.
    await page.goto(`/${chatUrl}`);
    await (await composerRow(page, "composer-apps")).click();
    await expect(page.getByTestId("chat-apps").getByTestId("chat-app-open")).toBeVisible();
    await check("+ → Apps");
    await page.getByTestId("chat-apps").getByTestId("chat-app-open").click();
    const app = page.getByTestId("mini-app");
    await expect(app.locator("iframe")).toBeVisible();
    // The card comes a moment after the panel, fading in, and + → Apps closes once it is sent: axe reads the chat at rest.
    await expect(chat(ana).getByTestId("app-card").getByTestId("app-card-open")).toBeVisible();
    await expect(page.getByTestId("chat-apps")).toHaveCount(0);
    await check("app panel", page, { frames: false });
    await app.getByTestId("mini-app-close").click();
    await expect(app).toBeHidden();
    await expect(chat(ana).getByTestId("app-card").getByTestId("app-card-open")).toBeVisible();
    await check("app card");

    // Bob's card, not checked yet, and the install screen it opens: sent by Ana, in none of his stores.
    const card = chat(bob).getByTestId("app-card");
    await expect(card.getByTestId("app-card-install")).toBeVisible();
    await check("contact's app card", bob.page);
    await card.getByTestId("app-card-install").click();
    await expect(bob.page.getByTestId("app-install").getByTestId("app-install-confirm")).toBeVisible();
    await check("install from a card", bob.page);

    // On a phone the panel covers the chat, a dialog; then the app's details and Uninstall, after which Add has the focus.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${chatUrl}`);
    await chat(ana).getByTestId("app-card").getByTestId("app-card-open").click();
    await expect(app).toHaveAttribute("data-place", "phone");
    await expect(app.getByTestId("mini-app-back")).toBeFocused();
    await check("app panel, phone", page, { frames: false });
    await app.getByTestId("mini-app-close").click();
    await expect(app).toBeHidden();
    await page.goto("/#/apps");
    await page.getByTestId("installed-app").getByRole("button").first().click();
    await expect(page.getByTestId("app-details")).toBeVisible();
    await check("details");
    await page.getByTestId("app-uninstall-open").click();
    await expect(page.getByTestId("app-uninstall-confirm")).toBeVisible();
    await check("uninstall");
    await page.getByTestId("app-uninstall-confirm").click();
    await expect(page.getByTestId("installed-app")).toHaveCount(0);
    await expect(page.getByTestId("apps-add")).toBeFocused();
    expect(found).toEqual({});
  });
}
