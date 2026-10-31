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
 * Clear all data in one tab replaces the peer the tabs share. The tab that asked starts over; the other one used to
 * keep the deleted chat open on the new peer, and a text sent there waited forever. It starts over too now.
 */
test("clear all data in one tab of the extension starts the other tab over too", { tag: ["@client:extension", "@client:web", "@feature:extension.engine", "@feature:app.clear-data"] }, async ({ extensionPeer, webPeer }) => {
  test.slow();
  const [ext, web] = await Promise.all([extensionPeer("two-tabs-clear"), webPeer("two-tabs-clear-contact")]);
  await pair(web, ext);
  const second = { ...ext, page: await ext.context.newPage() };
  await second.page.goto(ext.page.url());
  await expect(chat(second)).toBeVisible({ timeout: 30_000 });

  await ext.page.goto(ext.page.url().replace(/#.*$/, "#/settings"));
  await ext.page.getByTestId("clear-all-data").click();
  await ext.page.getByTestId("clear-all-data-confirm").click();
  await expect(ext.page.getByTitle("New Chat")).toBeVisible({ timeout: 60_000 });

  // The second tab no longer shows the chat that is gone, nor lets anyone write in it.
  await expect(chat(second)).toBeHidden({ timeout: 30_000 });
  await expect(second.page.getByPlaceholder("Message…")).toBeHidden();
  await second.page.goto(second.page.url().replace(/#.*$/, "#/"));
  await expect(second.page.getByText("It's quiet here...")).toBeVisible({ timeout: 30_000 });
});
