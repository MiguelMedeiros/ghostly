import { expect, guardArchive, test } from "../support/fixtures";

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
  let askedForLanguage!: () => void;
  const languageAsked = new Promise<void>((resolve) => { askedForLanguage = resolve; });
  page.on("request", (request) => { if (/\/assets\/ar-[\w-]+\.js$/.test(new URL(request.url()).pathname)) askedForLanguage(); });
  let beforeTheEntry: boolean | undefined;
  await page.route(/\/assets\/main-[\w-]+\.js$/, async (route) => {
    beforeTheEntry = await Promise.race([languageAsked.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000))]);
    await route.continue();
  });

  await page.goto("/");
  await expect(page.getByTestId("sidebar")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  expect(beforeTheEntry, "the Arabic file was asked for before the entry's file arrived").toBe(true);
  await context.close();
});
