import type { Page } from "@playwright/test";
import { expect, openProfilePage, test } from "../support/fixtures";
import { attachMint } from "../support/mint";

/**
 * The first thing anyone sees: the app on a browser that has never run it. A component that reaches
 * the platform before the web entry has configured it ("No browser host configured") turns the
 * whole window into the error screen, and every other test opens the app the same way, so this one
 * says it plainly instead of failing somewhere else.
 */
async function openFresh(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /Ghostly UI error|No browser host configured/.test(message.text())) errors.push(message.text());
  });
  await page.goto("/");
  // Whichever comes first. A page that crashed fails with what it threw, not with a missing sidebar.
  try {
    await expect(page.getByTestId("sidebar").or(page.getByTestId("app-error")).first()).toBeVisible({ timeout: 20_000 });
  } finally {
    expect(errors).toEqual([]);
  }
  await expect(page.getByTestId("app-error")).toHaveCount(0);
  return errors;
}

for (const mobile of [false, true]) {
  test(`a fresh profile opens without the error screen, and the sidebar works${mobile ? " (phone)" : ""}`, { tag: ["@feature:app.home", "@feature:app.navigation"] }, async ({ browser, relay, baseURL }) => {
    const context = await browser.newContext({
      baseURL,
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
      ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    });
    await relay.attach(context);
    await attachMint(context);
    const page = await context.newPage();
    const errors = await openFresh(page);
    const noErrorScreen = () => expect(page.getByTestId("app-error")).toHaveCount(0);

    await expect(page.getByTitle("New Chat")).toBeVisible();
    await expect(page.getByText("It's quiet here...")).toBeVisible();
    await noErrorScreen();

    // The New split button: its menu offers a group.
    await page.getByTestId("sidebar-new-more").click();
    await expect(page.getByTestId("new-group")).toBeVisible();
    // The arrow closes it again; on a phone the menu is a sheet, and a tap on the shade over the page does.
    await (mobile ? page.getByTestId("menu-backdrop") : page.getByTestId("sidebar-new-more")).click();
    await expect(page.getByTestId("sidebar-new-menu")).toHaveCount(0);

    // Every page the sidebar leads to renders: the account bar on a wide screen, the tab bar on a phone.
    // Profile is reached through the account switcher (the web can hold several profiles), as a person does.
    const tab = (name: string) => () => page.getByTestId("mobile-tabs").getByRole("button", { name }).click();
    const bar = (id: string) => () => page.getByTestId(id).click();
    const places: [string, () => Promise<void>][] = mobile
      ? [["wallet", tab("Wallets")], ["identities", tab("Identities")], ["services", tab("Services")], ["settings", tab("Settings")]]
      : [
          ["profile", () => openProfilePage(page)],
          ["identities", bar("account-identities")], ["services", bar("account-services")], ["settings", bar("account-settings")], ["wallet", bar("wallet-chip")],
        ];
    for (const [path, open] of places) {
      await page.goto("/");
      await open();
      await expect(page).toHaveURL(new RegExp(`#/${path}$`));
      await noErrorScreen();
    }

    expect(errors).toEqual([]);
    await context.close();
  });
}
