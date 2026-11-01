import { chat, say } from "../support/fixtures";
import { expect, test } from "../support/extension";
import { pair } from "../support/paired";

/**
 * The extension's pages share one peer (its offscreen document), and a person may have two of them open: a link
 * opened in a tab of its own, a duplicated tab. Both show the chat as it is. The second tab used to show only what
 * was there when it opened: the first tab mirrored each new message into the stored chat first, so the second
 * found nothing new to add and never read the chat again.
 */
test("two tabs of the extension on one chat both show what comes in and what either sends", { tag: ["@client:extension", "@client:web", "@feature:extension.engine"] }, async ({ extensionPeer, webPeer }) => {
  const [ext, web] = await Promise.all([extensionPeer("two-tabs"), webPeer("two-tabs-contact")]);
  await pair(web, ext);
  const second = { ...ext, page: await ext.context.newPage() };
  await second.page.goto(ext.page.url());
  await expect(chat(second)).toBeVisible({ timeout: 30_000 });

  await say(web, "to both tabs");
  for (const tab of [ext, second]) await expect(chat(tab).getByText("to both tabs")).toBeVisible({ timeout: 60_000 });

  await say(second, "from the second tab");
  await expect(chat(web).getByText("from the second tab")).toBeVisible({ timeout: 60_000 });
  for (const tab of [ext, second]) await expect(chat(tab).getByText("from the second tab")).toHaveCount(1);

  await say(ext, "from the first tab");
  await expect(chat(second).getByText("from the first tab")).toHaveCount(1, { timeout: 30_000 });
});

/**
 * Clear all data in one tab starts the peer again on an empty profile. The other tab reconnected to the new peer but
 * kept the cleared chat open, and what it sent there hung as pending, reaching nobody. It starts again now, as it does
 * after a profile switch made in another tab.
 */
test("Clear all data in one tab starts the other tab again, without the cleared chat", { tag: ["@client:extension", "@client:web", "@feature:extension.engine", "@feature:app.clear-data"] }, async ({ extensionPeer, webPeer }) => {
  const [ext, web] = await Promise.all([extensionPeer("two-tabs-clear"), webPeer("two-tabs-clear-contact")]);
  await pair(web, ext);
  await say(web, "before the clear");
  const second = { ...ext, page: await ext.context.newPage() };
  await second.page.goto(ext.page.url());
  await expect(chat(second).getByText("before the clear")).toBeVisible({ timeout: 30_000 });
  // Marks the page as it is now: a page that starts again comes without it.
  await second.page.evaluate(() => Object.assign(window, { __beforeClear: true }));

  await ext.page.goto(ext.page.url().replace(/#.*$/, "#/settings"));
  await ext.page.getByTestId("clear-all-data").click();
  await ext.page.getByTestId("clear-all-data-confirm").click();
  await expect(ext.page.getByTitle("New Chat")).toBeVisible({ timeout: 60_000 });

  // The reload destroys the page under an evaluate that is still running: that one only says it has not finished yet.
  await expect.poll(() => second.page.evaluate(() => "__beforeClear" in window).catch(() => true), { timeout: 30_000 }).toBe(false);
  await expect(second.page.getByTitle("New Chat")).toBeVisible({ timeout: 60_000 });
  await expect(second.page.getByText("It's quiet here...")).toBeVisible();
  await expect(second.page.getByPlaceholder("Message…")).toHaveCount(0);
});
