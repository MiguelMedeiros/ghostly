import { expect, test } from "../support/fixtures";
import { keepsAnEdge } from "../support/forcedColors";

/**
 * The first steps' main buttons in forced colors (Windows Contrast themes): the chat list's New and its ▾ (and the
 * rail's), the new chat's Copy invite under the QR, and the pages' New and Add are drawn by their accent fill alone,
 * which forced colors replace with the page's. They keep an edge there, so they read as buttons and not as loose words,
 * and show none in normal colours.
 */
test("forced colors keep an edge on the first steps' main buttons", { tag: ["@feature:app.accessibility", "@feature:chats.list.rail", "@feature:invite.copy"] }, async ({ peer }) => {
  const { page } = await peer("person");

  await keepsAnEdge(page, page.getByTestId("sidebar-new-chat"), "the chat list's New");
  await keepsAnEdge(page, page.getByTestId("sidebar-new-more"), "the chat list's ▾");

  // The list folded to a rail: its New is the accent square inside the button.
  await page.getByTestId("chat-list-toggle").click();
  await keepsAnEdge(page, page.getByTestId("chat-rail").getByTestId("sidebar-new-chat").locator("span").first(), "the rail's New");
  await page.getByTestId("chat-list-toggle").click();
  await expect(page.getByTestId("chat-list")).toBeVisible();

  await page.getByTestId("sidebar-new-chat").click();
  await keepsAnEdge(page, page.getByTestId("invite-card").getByRole("button", { name: "Copy invite" }), "the invite card's Copy invite");

  for (const [path, id, name] of [["/#/wallet", "wallet-add", "Wallets' New"], ["/#/identities", "identities-new", "Identities' New"], ["/#/apps", "apps-add", "Apps' Add"]]) {
    await page.goto(path);
    await keepsAnEdge(page, page.getByTestId(id), name);
  }
});
