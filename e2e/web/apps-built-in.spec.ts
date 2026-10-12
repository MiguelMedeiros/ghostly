import { chat, expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { serveStore } from "../support/appStore";

/*
 * The apps that come with Ghostly (WISP 1200 § Built-in apps), on the e2e suite's build: Chess, the bundle its
 * publisher signed, carried by the build. Built-in apps are off in this build unless a spec asks (the other specs
 * expect an empty Apps page), so each peer here turns them on before its page loads. Every request to the hosts apps
 * are read from is routed and counted: opening a built-in app for the first time asks none of them.
 */

/** Built-in apps on for this peer, as in a released build: set before the page loads, where the host reads it once. */
async function withBuiltIns(peer: Peer): Promise<string[]> {
  const asked = await serveStore(peer.context, { files: new Map() });
  await peer.context.addInitScript(() => { try { localStorage.setItem("ghostly-test-built-in-apps", "on"); } catch { /* opaque origin */ } });
  await peer.page.reload();
  return asked;
}

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
}

/** The bundle's own requests: none while it is read from the build. */
const bundles = (asked: string[]) => asked.filter((url) => url.split(/[?#]/)[0]!.endsWith("/app.ghostlyapp"));

test("Chess is on the Apps page of a new profile; its first open asks what it may do and downloads nothing; removed, it stays removed", { tag: ["@feature:apps.built-in"] }, async ({ peer }) => {
  const ana = await peer("ana");
  const asked = await withBuiltIns(ana);

  await ana.page.getByTestId("account-apps").click();
  const row = ana.page.getByTestId("built-in-app");
  await expect(row).toContainText("Chess");
  await expect(row.getByTestId("built-in-app-hint")).toContainText("Comes with Ghostly");
  await expect(ana.page.getByTestId("installed-app")).toHaveCount(0);
  // On a phone's width its two buttons are on the page, not past its edge.
  const wide = ana.page.viewportSize()!;
  await ana.page.setViewportSize({ width: 375, height: 700 });
  await expect(row.getByTestId("built-in-app-open")).toBeInViewport();
  await expect(row.getByTestId("built-in-app-remove")).toBeInViewport();
  expect(await ana.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await ana.page.setViewportSize(wide);

  await row.getByTestId("built-in-app-open").click();
  const screen = ana.page.getByTestId("app-install");
  await expect(screen.getByTestId("app-carried-line")).toHaveText("Comes with Ghostly. Nothing is downloaded.");
  await expect(screen.getByTestId("app-ip-line")).toHaveCount(0);
  // No store was read on this profile, and the build's own list vouches for it: no stranger's warning.
  await expect(screen.getByTestId("app-publisher-name")).toHaveText("Publisher");
  await expect(screen.getByTestId("app-store-line")).toHaveCount(0);
  await expect(screen.getByTestId("app-permissions")).toContainText("Talk to the same app on your contact's side");
  await expect(screen.getByTestId("app-permissions")).toContainText("See your name in this chat");
  await expect(screen.getByTestId("app-install-confirm")).toHaveText("Allow and open");
  // Checked and shown, from the build: no host was asked for anything.
  expect(asked).toEqual([]);

  await screen.getByTestId("app-install-confirm").click();
  await expect(ana.page.getByTestId("installed-app")).toContainText("Chess");
  await expect(row).toHaveCount(0);
  expect(bundles(asked)).toEqual([]);
  // It runs in a chat, and this profile has none: the picker says so.
  const picker = ana.page.getByTestId("app-chat-picker");
  await expect(picker).toBeVisible();
  await ana.page.keyboard.press("Escape");
  await expect(picker).toBeHidden();

  // Uninstalled by the person: not offered again, on this page or after the app starts again.
  await expect(ana.page.getByTestId("installed-app-hint")).not.toContainText("Unknown publisher");
  await ana.page.getByTestId("installed-app").getByRole("button", { name: "Chess: details" }).click();
  const details = ana.page.getByTestId("app-details");
  await expect(details.getByTestId("app-publisher-name")).toHaveText("Publisher");
  await expect(details.getByTestId("app-store-line")).toHaveText("Comes with Ghostly");
  await ana.page.getByTestId("app-uninstall-open").click();
  await ana.page.getByTestId("app-uninstall-confirm").click();
  await expect(ana.page.getByTestId("apps-none")).toBeVisible();
  await ana.page.reload();
  await expect(ana.page.getByTestId("apps-page")).toBeVisible();
  await expect(ana.page.getByTestId("apps-none")).toBeVisible();
  await expect(ana.page.getByTestId("built-in-app")).toHaveCount(0);
  expect(bundles(asked)).toEqual([]);
});

test("Remove on a built-in app never opened takes it off the list for good", { tag: ["@feature:apps.built-in"] }, async ({ peer }) => {
  const ana = await peer("ana");
  const asked = await withBuiltIns(ana);
  await ana.page.getByTestId("account-apps").click();
  await ana.page.getByTestId("built-in-app").getByRole("button", { name: "Remove Chess" }).click();
  await expect(ana.page.getByTestId("apps-none")).toBeVisible();
  await ana.page.reload();
  await expect(ana.page.getByTestId("apps-none")).toBeVisible();
  expect(asked).toEqual([]);
});

test("opened from a chat's Apps, Chess runs with the contact, whose card of it opens from their own build", { tag: ["@feature:apps.built-in", "@feature:apps.chat.card"] }, async ({ peer }) => {
  const [ana, bob] = await Promise.all([peer("ana"), peer("bob")]);
  const [anaAsked, bobAsked] = await Promise.all([withBuiltIns(ana), withBuiltIns(bob)]);
  await setNickname(ana, "Ana");
  await setNickname(bob, "Bob");
  await pair(ana, bob);

  await (await composerRow(ana.page, "composer-apps")).click();
  await ana.page.getByTestId("chat-apps").getByTestId("chat-built-in-app-open").click();
  const screen = ana.page.getByTestId("app-install");
  await expect(screen.getByTestId("app-carried-line")).toBeVisible();
  await expect(screen.getByTestId("app-install-confirm")).toHaveText("Allow and open");
  await screen.getByTestId("app-install-confirm").click();
  await closeApp(ana);
  await expect(chat(ana).getByTestId("app-card")).toContainText("You opened it here");
  expect(bundles(anaAsked)).toEqual([]);

  // Bob has the same Chess in his build: the card's version is the carried one, so nothing is fetched.
  const card = chat(bob).getByTestId("app-card");
  await expect(card).toContainText("Chess");
  await expect(card).toContainText("Ana opened it here");
  await card.getByTestId("app-card-install").click();
  const bobScreen = bob.page.getByTestId("app-install");
  await expect(bobScreen.getByTestId("app-sent-by")).toHaveText("Sent by Ana");
  await expect(bobScreen.getByTestId("app-carried-line")).toBeVisible();
  expect(bobAsked).toEqual([]);
  await bobScreen.getByTestId("app-install-confirm").click();
  await closeApp(bob);
  await expect(card.getByTestId("app-card-check")).toHaveText("Installed");
  expect(bundles(bobAsked)).toEqual([]);
});
