import { chat, expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { STORE_URL, serveStore, testStore } from "../support/appStore";

/*
 * The Apps page and the app card (WISP 1200 § Discovery, § Apps sent in a chat; WISP 405 § An app), on the e2e suite's
 * build (VITE_APPS_TEST). A store at a raw.githubusercontent.com URL, routed in the test: Ana adds it, installs Chess
 * from it, and opens it in her chat with Bob. Bob gets the card, which asks nothing of any host until he presses
 * "Install to play"; then the install screen, and Chess opens in the chat for him too.
 */

async function setNickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

/** The app the runner opened (full screen over the page), closed by its own bar's Close. */
async function closeApp(peer: Peer): Promise<void> {
  const app = peer.page.getByTestId("mini-app");
  await expect(app).toBeVisible();
  await app.getByRole("button", { name: "Close" }).click();
  await expect(app).toHaveCount(0);
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
  await expect(anaCard.getByTestId("app-card-play")).toBeVisible();

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
  await expect(card.getByTestId("app-card-play")).toBeVisible();
  await expect(card.getByTestId("app-card-check")).toHaveText("Installed");
});
