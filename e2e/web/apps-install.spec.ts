import { chat, expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { APP_URL, STORE_URL, serveStore, testStore } from "../support/appStore";

/*
 * The Apps page and the app card (WISP 1200 § Discovery, § Apps sent in a chat; WISP 405 § An app), on the e2e suite's
 * build (VITE_APPS_TEST). A store at a raw.githubusercontent.com URL, routed in the test: Ana adds it, installs Chess
 * from it, and opens it in her chat with Bob. Bob gets the card, which asks nothing of any host until he presses
 * "Install and open"; then the install screen, and Chess opens in the chat for him too.
 */

async function setNickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

/** The app the runner opened (in the chat's panel), closed by its header's Close: the panel hides, its frame goes. */
async function closeApp(peer: Peer): Promise<void> {
  const app = peer.page.getByTestId("mini-app");
  await expect(app).toBeVisible();
  await app.getByRole("button", { name: "Close" }).click();
  await expect(app).toBeHidden();
  await expect(app.locator("iframe")).toHaveCount(0);
}

test("install from a store, open it in a chat, and the contact installs it from the card", { tag: ["@feature:apps.page", "@feature:apps.chat.card"] }, async ({ peer }) => {
  const store = await testStore();
  const [ana, bob] = await Promise.all([peer("ana"), peer("bob")]);
  const anaAsked = await serveStore(ana.context, store);
  const bobAsked = await serveStore(bob.context, store);
  await setNickname(ana, "Ana");
  await setNickname(bob, "Bob");

  // Nothing is asked of any store before Ana adds one.
  await ana.page.getByTestId("account-apps").click();
  await expect(ana.page.getByTestId("apps-page")).toBeVisible();
  await expect(ana.page.getByTestId("apps-none")).toBeVisible();
  expect(anaAsked).toEqual([]);

  await ana.page.getByTestId("apps-add").click();
  await ana.page.getByTestId("apps-add-url").fill(STORE_URL);
  await ana.page.getByTestId("apps-add-check").click();
  await expect(ana.page.getByTestId("apps-add-store")).toContainText(store.storeName);
  await ana.page.getByTestId("apps-add-store-confirm").click();
  const listed = ana.page.getByTestId("app-store").filter({ hasText: store.storeName });
  await listed.getByRole("button", { name: new RegExp(store.storeName) }).click();
  await listed.getByTestId("app-listing-install").click();

  const screen = ana.page.getByTestId("app-install");
  await expect(screen.getByTestId("app-store-line")).toHaveText(`In ${store.storeName}`);
  await expect(screen.getByTestId("app-publisher-name")).toHaveText("Publisher");
  await expect(screen.getByTestId("app-permissions")).toContainText("Talk to the same app on your contact's side");
  // One line about who learns the address; the rest behind its ⓘ. Chromium is not WebKit: no Safari line.
  await expect(screen.getByTestId("app-ip-line")).toHaveText("Downloads from raw.githubusercontent.com, which sees your IP address.");
  await screen.getByTestId("app-ip-line-info").click();
  await expect(screen.getByTestId("app-ip-line-text")).toContainText("The app has no internet access, but its publisher may still learn your IP address");
  await expect(screen.getByTestId("app-webkit-line")).toHaveCount(0);
  await screen.getByTestId("app-install-confirm").click();
  await expect(ana.page.getByTestId("installed-app")).toContainText(store.title);

  // Bob's side asked nothing of anyone.
  expect(bobAsked).toEqual([]);

  await ana.page.goto("/#/");
  await pair(ana, bob);
  await (await composerRow(ana.page, "composer-apps")).click();
  await ana.page.getByTestId("chat-apps").getByTestId("chat-app-open").click();
  await closeApp(ana);
  const anaCard = chat(ana).getByTestId("app-card");
  await expect(anaCard).toContainText("You opened it here");
  await expect(anaCard.getByTestId("app-card-open")).toBeVisible();

  // Bob sees the card from its own data: nothing fetched until he presses Install.
  const card = chat(bob).getByTestId("app-card");
  await expect(card).toContainText(`${store.title} 1.2.0`);
  await expect(card).toContainText("Ana opened it here");
  await expect(card.getByTestId("app-card-check")).toHaveText("Not checked yet");
  expect(bobAsked).toEqual([]);

  await card.getByTestId("app-card-install").click();
  const bobScreen = bob.page.getByTestId("app-install");
  await expect(bobScreen.getByTestId("app-sent-by")).toHaveText("Sent by Ana");
  await expect(bobScreen.getByTestId("app-publisher-name")).toHaveText("Unknown publisher");
  await expect(bobScreen.getByTestId("app-store-line")).toHaveText("Not in any of your stores");
  expect(bobAsked.length).toBeGreaterThan(0);
  expect(bobAsked.every((url) => url.startsWith("https://raw.githubusercontent.com/ghostly-e2e/chess/"))).toBe(true);
  await bobScreen.getByTestId("app-install-confirm").click();
  await closeApp(bob);
  await expect(card.getByTestId("app-card-open")).toBeVisible();
  await expect(card.getByTestId("app-card-check")).toHaveText("Installed");
});

/** Ana's app card rows as her engine keeps them: how each went (`via`) and whether its card is due to go again live. */
async function appCardRows(peer: Peer): Promise<{ via?: string; cardRestore?: string; restored: boolean }[]> {
  return peer.page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("ghostly");
    request.onsuccess = () => {
      const db = request.result;
      const query = db.transaction("messages").objectStore("messages").getAll();
      query.onsuccess = () => {
        type Row = { sender: string; via?: string; cardRestore?: string; card?: { kind: string }; edit?: { restore?: boolean } };
        resolve((query.result as Row[]).filter((m) => m.sender === "me" && m.card?.kind === "app").map((m) => ({ via: m.via, cardRestore: m.cardRestore, restored: !!m.edit?.restore })));
        db.close();
      };
      query.onerror = () => reject(query.error);
    };
    request.onerror = () => reject(request.error);
  }));
}

test("an app opened while the contact's app was closed shows as a card once the chat is live again, not as text", { tag: ["@feature:apps.chat.card", "@feature:chat.status-cards.wire"] }, async ({ peer }) => {
  // The DHT floor carries the card's text alone, and an app card gets no update to carry it later: the opener's app
  // sends the card again live, as an edit of the card alone (WISP 405 § Cards that went as text).
  const store = await testStore();
  const [ana, bob] = await Promise.all([peer("ana-away"), peer("bob-away")]);
  await serveStore(ana.context, store);
  await serveStore(bob.context, store);
  await setNickname(ana, "Ana");
  await setNickname(bob, "Bob");
  await ana.page.goto("/#/apps");
  await ana.page.getByTestId("apps-add").click();
  await ana.page.getByTestId("apps-add-url").fill(APP_URL);
  await ana.page.getByTestId("apps-add-check").click();
  await ana.page.getByTestId("app-install").getByTestId("app-install-confirm").click();
  await expect(ana.page.getByTestId("installed-app")).toContainText(store.title);
  await ana.page.goto("/#/");
  await pair(ana, bob);

  // Bob's app closes; Ana's chat drops to the DHT, then she opens Chess in it.
  const returnTo = bob.page.url();
  await bob.page.goto("about:blank");
  await expect(ana.page.getByTestId("connection-options")).not.toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
  await (await composerRow(ana.page, "composer-apps")).click();
  await ana.page.getByTestId("chat-apps").getByTestId("chat-app-open").click();
  await closeApp(ana);
  await expect(chat(ana).getByTestId("app-card")).toContainText("You opened it here");
  // It went on the floor, its text alone: the card is due.
  await expect.poll(() => appCardRows(ana), { timeout: 90_000 }).toEqual([{ via: "pkarr", cardRestore: "due", restored: false }]);

  // Bob is back: the card shows once the chat is live, not its text, and with no edit mark.
  await bob.page.goto(returnTo);
  const card = chat(bob).getByTestId("app-card");
  await expect(card).toContainText(`${store.title} 1.2.0`, { timeout: 120_000 });
  await expect(card).toContainText("Ana opened it here");
  await expect(chat(bob).getByTestId("message-edited")).toHaveCount(0);
  await expect.poll(() => appCardRows(ana), { timeout: 60_000 }).toMatchObject([{ cardRestore: "sent", restored: true }]);
  // Still a card after a reload, and only one message.
  await bob.page.reload();
  await expect(chat(bob).getByTestId("app-card")).toHaveCount(1, { timeout: 60_000 });
});

test("in Safari the install screen's two ⓘ each open their own line, even when the lines sit close", { tag: ["@feature:apps.page"] }, async ({ peer }) => {
  // Safari on a Mac shows a second line under the IP line, each with its ⓘ. In Portuguese at this width the two ⓘ were
  // 20 px apart: the lower one's larger tap area lay over the upper one, so pressing the first opened the second.
  const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const store = await testStore();
  const ana = await peer("ana", { userAgent: safari });
  await serveStore(ana.context, store);
  await ana.page.evaluate(() => localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}"), language: "pt" })));
  await ana.page.goto("/#/apps");
  await ana.page.reload();
  await ana.page.getByTestId("apps-add").click();
  await ana.page.getByTestId("apps-add-url").fill(APP_URL);
  await ana.page.getByTestId("apps-add-check").click();
  const screen = ana.page.getByTestId("app-install");
  await expect(screen.getByTestId("app-webkit-line")).toBeVisible();
  // Pressed where a person aims: the middle of the ⓘ they see.
  for (const [line, other] of [["app-ip-line", "app-webkit-line"], ["app-webkit-line", "app-ip-line"]] as const) {
    const box = (await screen.getByTestId(`${line}-info`).boundingBox())!;
    await ana.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(screen.getByTestId(`${line}-text`)).toBeVisible();
    await expect(screen.getByTestId(`${other}-text`)).toHaveCount(0);
    // The screen grew and moved (it stays centred): the ⓘ is read again before it is pressed to close.
    const again = (await screen.getByTestId(`${line}-info`).boundingBox())!;
    await ana.page.mouse.click(again.x + again.width / 2, again.y + again.height / 2);
    await expect(screen.getByTestId(`${line}-text`)).toHaveCount(0);
  }
});
