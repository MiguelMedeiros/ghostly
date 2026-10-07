import { chat, expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { STORE_URL, serveStore, testStore, type TestStore } from "../support/appStore";

/*
 * Where a mini-app runs in a 1:1 chat (WISP 1200 § Per client, web), on the e2e suite's build (VITE_APPS_TEST): Ana
 * installs Chess from a store routed in the test, pairs with Bob and opens it in their chat. On a wide screen it sits
 * beside the chat, which stays usable; on a phone it covers the chat, and Back keeps it running.
 */

async function setNickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

/** Ana installs the store's Chess from the Apps page. */
async function install(peer: Peer, store: TestStore): Promise<void> {
  await peer.page.getByTestId("account-apps").click();
  await peer.page.getByTestId("apps-add").click();
  // The dialog's one field has the focus.
  await expect(peer.page.getByTestId("apps-add-url")).toBeFocused();
  await peer.page.getByTestId("apps-add-url").fill(STORE_URL);
  await peer.page.getByTestId("apps-add-check").click();
  await peer.page.getByTestId("apps-add-store-confirm").click();
  const listed = peer.page.getByTestId("app-store").filter({ hasText: store.storeName });
  await listed.getByRole("button", { name: new RegExp(store.storeName) }).click();
  await listed.getByTestId("app-listing-install").click();
  await peer.page.getByTestId("app-install").getByTestId("app-install-confirm").click();
  await expect(peer.page.getByTestId("installed-app")).toContainText(store.title);
  // Its Install is gone: the focus is on the app's Open, not lost on the page.
  await expect(peer.page.getByTestId("installed-app").getByTestId("installed-app-open")).toBeFocused();
  await peer.page.goto("/#/");
}

/** Ana and Bob, named, paired, with Chess installed on Ana's side. */
async function setUp(peer: (name: string) => Promise<Peer>): Promise<[Peer, Peer]> {
  const store = await testStore();
  const [ana, bob] = await Promise.all([peer("ana"), peer("bob")]);
  await serveStore(ana.context, store);
  await setNickname(ana, "Ana");
  await setNickname(bob, "Bob");
  await install(ana, store);
  await pair(ana, bob);
  return [ana, bob];
}

async function openChess(ana: Peer): Promise<void> {
  await (await composerRow(ana.page, "composer-apps")).click();
  await ana.page.getByTestId("chat-apps").getByTestId("chat-app-open").click();
}

/** The app's frame, by the runner's page: something to find again in it proves it never reloaded. */
function chessFrame(ana: Peer) {
  const frame = ana.page.frames().find((f) => f.url().includes("app-frame"));
  if (!frame) throw new Error("no app frame");
  return frame;
}

test("on a wide screen the app sits beside the chat, which stays usable", { tag: ["@feature:apps.view"] }, async ({ peer }) => {
  const [ana, bob] = await setUp(peer);
  await ana.page.setViewportSize({ width: 1280, height: 800 });
  await openChess(ana);

  const app = ana.page.getByTestId("mini-app");
  await expect(app).toBeVisible();
  await expect(app).toHaveAttribute("data-place", "beside");
  await expect(app.getByTestId("mini-app-title")).toHaveText("Chess");
  await expect(app.getByTestId("mini-app-with")).toHaveText("with Bob");
  // The chat's own connection control: live, as in the chat's header.
  await expect(app.getByTestId("app-connection-options")).toHaveAccessibleName(/Connected · /);
  await expect(app.getByTestId("mini-app-back")).toHaveCount(0);
  await expect(app.locator("iframe")).toBeVisible();
  await expect.poll(() => chessFrame(ana).evaluate(() => document.querySelector("h1")?.textContent)).toBe("Chess");
  await chessFrame(ana).evaluate(() => { (window as unknown as { mark: number }).mark = 7; });

  // The chat is still there, beside it, and works: Ana writes, Bob reads.
  const header = ana.page.getByTestId("chat-name");
  await expect(header).toBeVisible();
  const appBox = (await app.boundingBox())!, input = ana.page.getByPlaceholder("Message…");
  const inputBox = (await input.boundingBox())!;
  expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(appBox.x + 1);
  await input.fill("Your move");
  await input.press("Enter");
  await expect(chat(bob).getByText("Your move")).toBeVisible();

  // Full width covers the chat; back beside it, the same game.
  await app.getByTestId("mini-app-wide").click();
  await expect(app).toHaveAttribute("data-place", "wide");
  await expect(header).toBeHidden();
  await app.getByTestId("mini-app-wide").click();
  await expect(app).toHaveAttribute("data-place", "beside");
  await expect(header).toBeVisible();
  expect(await chessFrame(ana).evaluate(() => (window as unknown as { mark?: number }).mark)).toBe(7);

  await app.getByRole("button", { name: "Close" }).click();
  await expect(app).toBeHidden();
  await expect(app.locator("iframe")).toHaveCount(0);

  // Keys: opening puts the focus in the panel (not modal: no aria-modal), Escape there closes it, and the focus comes
  // back to the chat (the dialog that opened it is gone: its message field).
  await openChess(ana);
  await expect(app).toBeVisible();
  await expect(app).toBeFocused();
  await expect(app).not.toHaveAttribute("aria-modal");
  await ana.page.keyboard.press("Escape");
  await expect(app).toBeHidden();
  await expect(input).toBeFocused();
});

test("on a phone the app covers the chat, and Back keeps it running", { tag: ["@feature:apps.view"] }, async ({ peer }) => {
  const [ana] = await setUp(peer);
  await ana.page.setViewportSize({ width: 375, height: 812 });
  await openChess(ana);

  const app = ana.page.getByTestId("mini-app");
  await expect(app).toBeVisible();
  await expect(app).toHaveAttribute("data-place", "phone");
  const box = (await app.boundingBox())!;
  expect(box.width).toBe(375);
  expect(box.height).toBe(812);
  await expect(app.getByTestId("mini-app-with")).toHaveText("with Bob");
  await expect(app.getByTestId("app-connection-options")).toHaveAccessibleName(/Connected · /);
  await expect(app.getByTestId("mini-app-wide")).toHaveCount(0);
  await expect.poll(() => chessFrame(ana).evaluate(() => document.querySelector("h1")?.textContent)).toBe("Chess");
  const frame = chessFrame(ana);
  await frame.evaluate(() => { (window as unknown as { mark: number }).mark = 7; });

  // Back: the chat, with the app one tap away, still running.
  await app.getByTestId("mini-app-back").click();
  await expect(app).toBeHidden();
  await expect(ana.page.getByPlaceholder("Message…")).toBeVisible();
  const resume = ana.page.getByTestId("mini-app-resume");
  await expect(resume).toHaveText("Back to Chess");
  await resume.click();
  await expect(app).toBeVisible();
  expect(frame.isDetached()).toBe(false);
  expect(await frame.evaluate(() => (window as unknown as { mark?: number }).mark)).toBe(7);

  // Opened again from the chat: the same game, not a new one.
  await app.getByTestId("mini-app-back").click();
  await openChess(ana);
  await expect(app).toBeVisible();
  expect(await frame.evaluate(() => (window as unknown as { mark?: number }).mark)).toBe(7);
  await expect(app.locator("iframe")).toHaveCount(1);

  // Keys: modal, Back has the focus, Tab never reaches the chat under it, Escape goes Back to "Back to Chess".
  await expect(app).toHaveAttribute("aria-modal", "true");
  await expect(app.getByTestId("mini-app-back")).toBeFocused();
  for (let i = 0; i < 8; i++) {
    await ana.page.keyboard.press("Tab");
    expect(await ana.page.evaluate(() => !document.activeElement?.closest(".chat-column"))).toBe(true);
  }
  await app.getByTestId("mini-app-back").focus();
  await ana.page.keyboard.press("Escape");
  await expect(app).toBeHidden();
  await expect(resume).toBeFocused();
  expect(await frame.evaluate(() => (window as unknown as { mark?: number }).mark)).toBe(7);
});

test("opened alone, the app is modal: Close has the focus, Escape closes it, and the focus comes back", { tag: ["@feature:apps.view"] }, async ({ peer }) => {
  const store = await testStore();
  const ana = await peer("ana");
  await serveStore(ana.context, store);
  await install(ana, store);
  // The installed app's Open, which the focus went to after Install.
  await ana.page.getByTestId("account-apps").click();
  const open = ana.page.getByTestId("installed-app").getByTestId("installed-app-open");
  await open.focus();
  await ana.page.keyboard.press("Enter");
  const app = ana.page.getByTestId("mini-app");
  await expect(app).toHaveAttribute("data-place", "alone");
  await expect(app).toHaveAttribute("aria-modal", "true");
  await expect(app.getByRole("button", { name: "Close" })).toBeFocused();
  await ana.page.keyboard.press("Escape");
  await expect(app).toHaveCount(0);
  await expect(open).toBeFocused();
});
