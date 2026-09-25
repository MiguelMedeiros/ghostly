import { expect, type Locator, type Page } from "@playwright/test";

/**
 * One row of the composer's + menu (WhatsApp's layout): `payment-button`, `composer-identities-button`,
 * `composer-file`, `composer-media` or `composer-camera`. Opens the menu when it is not open (the + waits while the
 * composer is disabled), so a spec can wait on the row (`toBeEnabled`, a title) or click it. Choosing a row closes the
 * menu; on a phone it is a sheet over a backdrop.
 */
export async function composerRow(page: Page, testId: string): Promise<Locator> {
  const menu = page.getByTestId("composer-menu");
  if (!(await menu.isVisible())) {
    await page.getByTestId("composer-more").click();
    await expect(menu).toBeVisible();
  }
  return menu.getByTestId(testId);
}

/** The composer's emoji/GIF panel, opened on one of its two segments. */
export async function openExpressions(page: Page, tab: "emoji" | "gif"): Promise<Locator> {
  const panel = page.getByTestId("expression-panel");
  if (!(await panel.isVisible())) await page.getByTestId("composer-expressions").click();
  await page.getByTestId(`expression-tab-${tab}`).click();
  await expect(panel).toHaveAttribute("data-tab", tab);
  return panel;
}
