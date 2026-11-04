import type { Page } from "@playwright/test";
import { expect, guardArchive, openProfilePage, test } from "../support/fixtures";
import { choose } from "../support/select";

/**
 * Holds the entry's own file until a language's file has been asked for (or for 10 s); `true` once the page has
 * loaded if that file was asked for before the entry's arrived.
 */
async function askedBeforeTheEntry(page: Page, language: string): Promise<() => boolean | undefined> {
  let askedForLanguage!: () => void;
  const languageAsked = new Promise<void>((resolve) => { askedForLanguage = resolve; });
  const file = new RegExp(`/assets/${language}-[\\w-]+\\.js$`);
  page.on("request", (request) => { if (file.test(new URL(request.url()).pathname)) askedForLanguage(); });
  let beforeTheEntry: boolean | undefined;
  await page.route(/\/assets\/main-[\w-]+\.js$/, async (route) => {
    beforeTheEntry = await Promise.race([languageAsked.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000))]);
    await route.continue();
  });
  return () => beforeTheEntry;
}

/**
 * A first visit in a language other than English (issue agents#2325): the language file is asked for beside the
 * app's entry, by the boot guard (apps/web/public/boot-guard.js) from the names the build puts in the page
 * (apps/web/localePreload.ts). Left to `loadLocale` in main.tsx, it was asked for only once the whole entry had
 * downloaded and run, one more round trip before anything was drawn.
 */
test("a first visit in Arabic asks for its language file while the entry is still on its way", { tag: ["@feature:app.i18n"] }, async ({ browser, relay, baseURL }) => {
  const context = await browser.newContext({ baseURL, locale: "ar-EG" });
  await guardArchive(context);
  await relay.attach(context);
  await context.addInitScript(() => localStorage.setItem("ghostly-test-iroh", "off"));
  const page = await context.newPage();

  // The entry's own file is held until the language file has been asked for (or for 10 s): the app cannot have run.
  const beforeTheEntry = await askedBeforeTheEntry(page, "ar");

  await page.goto("/");
  await expect(page.getByTestId("sidebar")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  expect(beforeTheEntry(), "the Arabic file was asked for before the entry's file arrived").toBe(true);
  await context.close();
});

// The language is the profile's the page starts as (agents#2498): not the first profile's, which reads in English here.
test("a second profile in Portuguese asks for its own language file early, not the first profile's", { tag: ["@feature:app.i18n", "@feature:profiles.switch"] }, async ({ peer }) => {
  const { page } = await peer("language-profile");
  await openProfilePage(page);
  await page.getByTestId("profile-new").click();
  await page.getByTestId("profile-new-name").fill("Trabalho");
  await page.getByTestId("profile-create").click();
  await expect(page.getByTestId("profile-name")).toHaveValue("Trabalho", { timeout: 30_000 });
  await page.goto("/#/settings");
  await choose(page.getByTestId("settings-language"), "pt");
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");

  const beforeTheEntry = await askedBeforeTheEntry(page, "pt");
  await page.reload();
  await expect(page.getByTestId("sidebar")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  expect(beforeTheEntry(), "the Portuguese file was asked for before the entry's file arrived").toBe(true);
});
