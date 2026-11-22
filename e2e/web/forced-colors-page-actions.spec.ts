import { expect, test } from "../support/fixtures";
import { keepsAnEdge } from "../support/forcedColors";

/**
 * A page's main action in its header (PageAction: Apps' Add, Identities' and Wallets' New) in forced colors (Windows
 * Contrast themes): drawn by its accent fill alone, which forced colors replace with the page's, it read as bare text
 * beside the page's title. It keeps an edge there, as the app's own Button does, and shows none in normal colours.
 */
test("forced colors keep an edge on the page header's Add and New", { tag: ["@feature:app.accessibility", "@feature:apps.page"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await page.getByTestId("account-apps").click();
  await expect(page.getByTestId("apps-page")).toBeVisible();
  await keepsAnEdge(page, page.getByTestId("apps-add"), "the Apps page's Add");
  await page.goto("/#/identities");
  await keepsAnEdge(page, page.getByTestId("identities-new"), "the Identities page's New");
  await page.goto("/#/wallet");
  await keepsAnEdge(page, page.getByTestId("wallet-add"), "the Wallets page's New");
});
