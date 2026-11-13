import { expect, test } from "../support/fixtures";
import { keepsAnEdge } from "../support/forcedColors";
import { HeadlessBot } from "../support/headless";

/**
 * A community's link and its admin's asks in forced colors (Windows Contrast themes): Share and Copy under the link,
 * Turn on the link, and the confirm of New link, Turn off, Hand over admin and Remove are drawn by their fill alone,
 * which forced colors replace with the page's. There an ask's two buttons read as two words side by side, Cancel and
 * the action alike. They keep an edge there, as the device screens' main buttons do, and show none in normal colours.
 */
test("forced colors keep an edge on a community's link buttons and its admin's confirms", { tag: ["@feature:app.accessibility", "@feature:groups.link.share", "@feature:groups.link.replace", "@feature:groups.link.enable", "@feature:groups.admin-change", "@feature:groups.remove-member"] }, async ({ peer, relay }, info) => {
  test.setTimeout(6 * 60_000);
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Member");
    const admin = await peer("admin");
    const page = admin.page;
    await page.getByTestId("sidebar-new-more").click();
    await page.getByTestId("new-group").click();
    await page.getByTestId("new-group-name").fill("Ghosts");
    await page.getByTestId("new-group-create").click();

    // The new community opens on its link: Share and Copy.
    const share = page.getByTestId("group-share-dialog");
    await expect(share).toBeVisible();
    await keepsAnEdge(page, share.getByTestId("group-link-share"), "the link's Share");
    await keepsAnEdge(page, share.getByTestId("group-link-copy"), "the link's Copy");
    const link = await share.getByTestId("group-link-url").inputValue();
    await share.getByTestId("group-share-done").click();
    await bot.run("group", "join", link);

    const members = page.getByTestId("group-members-dialog");
    await page.getByTestId("group-members").click();
    await expect(members.getByTestId("group-member")).toHaveCount(2, { timeout: 120_000 });
    // New link's and Turn off's asks, then Turn on the link.
    await members.getByTestId("group-link-reset").click();
    await keepsAnEdge(page, page.getByTestId("group-link-ask-confirm"), "New link's confirm");
    await page.keyboard.press("Escape");
    await members.getByTestId("group-link-disable").click();
    await keepsAnEdge(page, page.getByTestId("group-link-ask-confirm"), "Turn off's confirm");
    await page.getByTestId("group-link-ask-confirm").click();
    await keepsAnEdge(page, members.getByTestId("group-link-enable"), "Turn on the link");
    // The member's row: Hand over admin's and Remove's asks.
    const row = members.getByTestId("group-member").filter({ hasText: "Member" });
    await row.getByTestId("group-make-admin").click();
    await keepsAnEdge(page, page.getByTestId("group-make-admin-confirm"), "Hand over admin's confirm");
    await page.keyboard.press("Escape");
    await row.getByTestId("group-remove-member").click();
    await keepsAnEdge(page, page.getByTestId("group-remove-confirm"), "Remove's confirm");
  } catch (error) {
    await bot.attachLogs(info);
    throw error;
  } finally {
    await bot.stop();
  }
});
