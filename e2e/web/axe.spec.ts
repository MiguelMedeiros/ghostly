import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { composerRow } from "../support/composer";
import { expect, test } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * The main screens pass axe-core's WCAG 2.2 A and AA rules: no serious or critical finding (contrast, names, roles),
 * in the default colour theme, light and dark, left to right and right to left. The home screen, a 1:1 chat with its
 * ⋮ menu, + menu and payment sheet, a group, the wallets and New wallet, identities, settings, profile and services.
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

/** What axe finds serious or critical on the page as it is now, one line per rule and element. */
async function findings(page: Page): Promise<string[]> {
  // Past the colour transitions and the fade-ins, so contrast is read on the colours as they end. Not past the loops:
  // those that end by themselves take half a minute or more (a "connecting" dot, a spinner), and none is text.
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === 1).map((a) => a.finished.catch(() => {})));
  });
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical")
    .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")} ${n.failureSummary?.split("\n").slice(1).join(" ").trim() ?? ""}`));
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
