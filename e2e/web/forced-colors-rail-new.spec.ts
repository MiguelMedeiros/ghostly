import { expect, test } from "../support/fixtures";
import { keepsAnEdge } from "../support/forcedColors";

/**
 * The folded chat list's New in forced colors (Windows Contrast themes): it is drawn by the accent square inside the
 * rail's button alone, which forced colors replace with the page's colour. That square keeps an edge there, so it reads
 * as a button and not as a loose icon, and shows none in normal colours.
 */
test("forced colors keep an edge on the rail's New", { tag: ["@feature:app.accessibility", "@feature:chats.list.rail"] }, async ({ peer }) => {
  const { page } = await peer("person");
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });

  await page.getByTestId("chat-list-toggle").click();
  const actions = page.getByTestId("chat-rail-actions");
  await expect(actions).toBeVisible();
  await keepsAnEdge(page, actions.getByTestId("sidebar-new-chat").locator("span").first(), "the rail's New");
});
