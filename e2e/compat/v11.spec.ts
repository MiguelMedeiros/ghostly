import { chat, expect, openPeer, say, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { APP_URL, serveStore, testStore } from "../support/appStore";
import { installFromStore } from "../support/chessApp";

/**
 * The current app, with mini-apps on, and a real v1.1.4: the last release with no apps/1 and no `app` card kind
 * (WISP 1200 § Compatibility, WISP 405 § An app). An app card reaches 1.1.4 as its text, the bundle's URL a link on a
 * line of its own; 1.1.4 never offers apps/1, so no `paired-app` frame goes to it and the chat goes on as before.
 * The other way, + → Apps in the current app names the contact whose app can't run apps, rather than asking for
 * them both online, and opening an app with that contact still works: it waits for a contact who never comes.
 */

/** v1.1.4, beside the current app (playwright.compat.config.ts serves it). */
async function oldPeer(browser: Parameters<typeof openPeer>[0], relay: Parameters<typeof openPeer>[1], name: string): Promise<Peer> {
  const url = test.info().config.metadata.compat11URL as string;
  const peer = await openPeer(browser, relay, url, name);
  // The old app is the one we think it is.
  expect(await peer.page.evaluate(async () => (await (await fetch("/version.json")).json()) as { version: string })).toMatchObject({ version: "1.1.4" });
  return peer;
}

async function setNickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

test("an app card reaches v1.1.4 as its text with a link, apps/1 is never offered, and the chat goes on both ways", {
  tag: ["@feature:chat.compat.v11", "@feature:apps.card", "@feature:apps.chat.wire"],
}, async ({ browser, relay, peer }) => {
  const store = await testStore();
  const [nina, olga] = await Promise.all([peer("nina"), oldPeer(browser, relay, "olga")]);
  await serveStore(nina.context, store);
  // Anything 1.1.4 asks of GitHub's raw host is counted (and answered from the test, never the real one).
  const olgaAsked = await serveStore(olga.context, store);
  await setNickname(olga, "Olga");

  // Nina installs the app from her store; 1.1.4 has no Apps anywhere.
  await installFromStore(nina.page);
  await nina.page.goto("/#/");
  await pair(nina, olga);
  expect(await olga.page.getByTestId("composer-apps").count()).toBe(0);

  // + → Apps names Olga's app as the reason, not "Apps need you both online": they are, and her app can't.
  const row = await composerRow(nina.page, "composer-apps");
  await expect(row).toHaveAttribute("title", "Olga's app can't run apps yet");
  await row.click();
  const dialog = nina.page.getByTestId("chat-apps");
  await expect(dialog.getByTestId("chat-apps-waiting")).toHaveText("Olga's app can't run apps yet");

  // Opening it still works, and sends the opened card; nothing hangs: the app waits, and closes.
  await dialog.getByTestId("chat-app-open").click();
  const app = nina.page.getByTestId("mini-app");
  await expect(app).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await app.getByRole("button", { name: "Close" }).click();
  // The chat's panel stays in the page, hidden, with no frame in it (WISP 1200 § Per client, web).
  await expect(app).toBeHidden();
  await expect(app.locator("iframe")).toHaveCount(0);
  await expect(chat(nina).getByTestId("app-card")).toContainText("You opened it here");

  // 1.1.4 shows the card's text: what it is, and the bundle's URL as a link on its own line. No card is drawn.
  const text = chat(olga).getByText("🧩 Opened Chess 1.2.0 in this chat (Ghostly app)", { exact: false });
  await expect(text).toBeVisible({ timeout: 120_000 });
  const link = chat(olga).getByRole("link", { name: APP_URL });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", APP_URL);
  await expect(chat(olga).getByTestId("app-card")).toHaveCount(0);
  // Showing it asked nothing of any host.
  expect(olgaAsked).toEqual([]);

  // The chat goes on both ways after it, live.
  await say(nina, "after the app card");
  await expect(chat(olga).getByText("after the app card", { exact: true })).toBeVisible();
  await say(olga, "still here on 1.1.4");
  await expect(chat(nina).getByText("still here on 1.1.4", { exact: true })).toBeVisible();
  for (const p of [nina, olga]) await expect(p.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /);
  // apps/1 never came up: + → Apps still names Olga's app.
  await expect(await composerRow(nina.page, "composer-apps")).toHaveAttribute("title", "Olga's app can't run apps yet");
});
