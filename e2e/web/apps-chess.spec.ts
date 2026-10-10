import type { Page } from "@playwright/test";
import { chat, expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { CHESS_REPO, CHESS_STORE_URL, ChessPublisher, openPeers, openStoreInstall, STORE_NAME, chessFrame, chessStatus, installFromStore, miniApp, move, square, startGame } from "../support/chessApp";
import { CHESS, CHESS_1_0_2 } from "../support/chessFixture";

/*
 * Chess end to end (WISP 1200; WISP 405 § An app), on the e2e suite's build (VITE_APPS_TEST): the real Chess 2.3.0, its
 * pinned build (e2e/fixtures/chess, taken from its signed bundle by tools/scripts/refresh-chess-fixture.mjs), bundled
 * and signed by the headless CLI with keys made for the test, in a store the CLI signed, served at
 * raw.githubusercontent.com URLs by the test. Ana installs it from the store (the install screen asks for her name in
 * the chat) and opens it in her chat with Bob; Bob installs it from her card, which asks nothing of any host before he
 * presses "Install and open"; Ana invites, Bob accepts, they play Scholar's mate over `paired-app`, and Bob's game is
 * back after he reloads. Then what a client refuses: a tampered bundle, a lower sequence, a version a store removed
 * (stopped until "Run anyway"), a version its publisher revoked (stopped for good). And the update from Chess 1.0.2,
 * which waits until the person agrees to `name`.
 */

/** The sequence Chess 2.3.0 is published at. */
const SEQUENCE = 4;

async function setNickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

/** What the person reads about a bundle changed after it was signed. */
const TAMPERED = /^Ghostly won't install it|^Not signed correctly/;

/** Closes Chess (its header's Close, outside the frame: the chat's panel hides) and opens it again from the app card. */
async function closeAndReopen(peer: Peer): Promise<void> {
  await miniApp(peer.page).getByRole("button", { name: "Close" }).click();
  await expect(miniApp(peer.page)).toBeHidden();
  await chat(peer).getByTestId("app-card").getByTestId("app-card-open").click();
  await expect(miniApp(peer.page)).toBeVisible();
}

/** Both boards hold these pieces (square, its `data-piece`: "wp", "bn"...; "" for empty), and each side still plays its colour. */
async function boardsShow(white: Peer, black: Peer, pieces: [string, string][]): Promise<void> {
  for (const side of [white, black]) {
    await expect(chessFrame(side.page).locator(".side")).toHaveText(side === white ? "You play white" : "You play black");
    for (const [name, piece] of pieces) await expect(square(side.page, name)).toHaveAttribute("data-piece", piece);
  }
}

/** Scholar's mate: 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6?? 4. Qxf7#. */
const SCHOLARS_MATE: [string, string][] = [["e2", "e4"], ["e7", "e5"], ["f1", "c4"], ["b8", "c6"], ["d1", "h5"], ["g8", "f6"], ["h5", "f7"]];

test("two people install Chess, play Scholar's mate in their chat, and the game is back after a reload", {
  tag: ["@feature:apps.chess.web", "@feature:apps.chess", "@feature:apps.chat.card", "@feature:apps.chat.wire"],
}, async ({ peer, browserName }) => {
  test.setTimeout(6 * 60_000);
  const publisher = new ChessPublisher();
  const chess = publisher.publish({ sequence: SEQUENCE });
  publisher.signStore({ apps: [chess] });
  const [ana, bob] = await openPeers(peer, browserName, "ana", "bob");
  const [, bobAsked] = await Promise.all([publisher.serve(ana.context), publisher.serve(bob.context)]);
  await setNickname(ana, "Ana");
  await setNickname(bob, "Bob");

  // 1. Ana installs Chess from the store, whose install screen asks for her name in the chat, then opens it in her
  // chat with Bob.
  const fromStore = await openStoreInstall(ana.page);
  await expect(fromStore.getByTestId("app-permission-chat")).toBeVisible();
  await expect(fromStore.getByTestId("app-permission-name")).toHaveText("See your name in this chat");
  await fromStore.getByTestId("app-install-confirm").click();
  await expect(ana.page.getByTestId("installed-app")).toContainText(CHESS.manifest.version);
  await ana.page.goto("/#/");
  await pair(ana, bob);
  await (await composerRow(ana.page, "composer-apps")).click();
  await ana.page.getByTestId("chat-apps").getByTestId("chat-app-open").click();
  await expect(miniApp(ana.page)).toBeVisible();
  await expect(chessStatus(ana.page)).toHaveText("Waiting for your contact to open Chess");
  // Ana waits a while before Bob opens it (as in a live game: nothing starts until he does).
  await ana.page.waitForTimeout(15_000);
  await expect(chessStatus(ana.page)).toHaveText("Waiting for your contact to open Chess");

  // 2. Bob's card, drawn from its own data: not one request until he presses "Install and open".
  const card = chat(bob).getByTestId("app-card");
  await expect(card).toContainText(`Chess ${CHESS.manifest.version}`);
  await expect(card).toContainText("Ana opened it here");
  await expect(card.getByTestId("app-card-check")).toHaveText("Not checked yet");
  expect(bobAsked).toEqual([]);
  await card.getByTestId("app-card-install").click();
  const screen = bob.page.getByTestId("app-install");
  await expect(screen.getByTestId("app-sent-by")).toHaveText("Sent by Ana");
  await expect(screen.getByTestId("app-publisher-name")).toHaveText("Unknown publisher");
  await expect(screen.getByTestId("app-permission-name")).toHaveText("See your name in this chat");
  expect(bobAsked).toContain(chess.url);
  expect(bobAsked.every((url) => url.startsWith(CHESS_REPO))).toBe(true);
  await screen.getByTestId("app-install-confirm").click();
  await expect(miniApp(bob.page)).toBeVisible();

  // 3. Ana invites, Bob accepts, the toss gives each a colour, and each sees the other's name over the board; they
  // play Scholar's mate by clicking squares in their frames.
  const [white, black] = await startGame(ana, bob);
  for (const [side, own, other] of [[ana, "Ana", "Bob"], [bob, "Bob", "Ana"]] as const) {
    await expect(chessFrame(side.page).locator(".strip.top .name")).toHaveText(other);
    await expect(chessFrame(side.page).locator(".strip.bottom .name")).toHaveText(own);
  }
  for (const [i, [from, to]] of SCHOLARS_MATE.entries()) {
    const [mover, watcher] = i % 2 === 0 ? [white, black] : [black, white];
    await move(mover.page, watcher.page, from, to);
    if (i !== 3) continue;
    // After 2...Nc6, each side closes Chess and opens it again from the card: the game is kept, and goes on.
    for (const [closer, other] of [[ana, bob], [bob, ana]] as const) {
      await miniApp(closer.page).getByRole("button", { name: "Close" }).click();
      await expect(chessStatus(other.page)).toHaveText(CLOSED);
      await chat(closer).getByTestId("app-card").getByTestId("app-card-open").click();
      await boardsShow(white, black, [["e4", "wp"], ["e5", "bp"], ["c4", "wb"], ["c6", "bn"], ["e2", ""], ["e7", ""]]);
    }
  }
  await expect(chessStatus(white.page)).toHaveText("You win: checkmate");
  await expect(chessStatus(black.page)).toHaveText("You lose: checkmate");
  for (const side of [white, black]) await expect(square(side.page, "f7")).toHaveAttribute("data-piece", "wq");

  // 4. Bob reloads: Chess is closed, the chat is live again, and opening it from the card brings the game back
  // (his storage in this chat; the mid-game reload in the next test is the one that needs the catch-up).
  await bob.page.reload();
  await expect(miniApp(bob.page)).toBeHidden();
  await expect(bob.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
  await expect(card.getByTestId("app-card-check")).toHaveText("Installed");
  await expect(card.getByTestId("app-card-waiting")).toHaveCount(0);
  await card.getByTestId("app-card-open").click();
  await expect(miniApp(bob.page)).toBeVisible();
  await expect(chessStatus(bob.page)).toHaveText(bob === white ? "You win: checkmate" : "You lose: checkmate");
  await expect(chessFrame(bob.page).locator(".side")).toHaveText(bob === white ? "You play white" : "You play black");
  for (const [name, piece] of [["f7", "wq"], ["e4", "wp"], ["c4", "wb"], ["f6", "bn"]] as const) await expect(square(bob.page, name)).toHaveAttribute("data-piece", piece);
  await expect(chessStatus(ana.page)).toHaveText(ana === white ? "You win: checkmate" : "You lose: checkmate");
});

test("both have Chess: one opens it and waits, the other opens it from the card later; one invites, they play, close, reopen and reload mid-game", {
  tag: ["@feature:apps.chess.web", "@feature:apps.chess", "@feature:apps.chat.wire"],
}, async ({ peer, browserName }) => {
  test.setTimeout(6 * 60_000);
  const publisher = new ChessPublisher();
  publisher.signStore({ apps: [publisher.publish({ sequence: SEQUENCE })] });
  const [ana, bob] = await openPeers(peer, browserName, "ana", "bob");
  await Promise.all([publisher.serve(ana.context), publisher.serve(bob.context)]);
  await setNickname(ana, "Ana");
  await setNickname(bob, "Bob");
  await installFromStore(ana.page);
  await installFromStore(bob.page);
  await ana.page.goto("/#/");
  await bob.page.goto("/#/");
  await pair(ana, bob);

  // Ana opens it from + > Apps and waits; Bob, who has it, opens it from her card a while later.
  await (await composerRow(ana.page, "composer-apps")).click();
  await ana.page.getByTestId("chat-apps").getByTestId("chat-app-open").click();
  await expect(chessStatus(ana.page)).toHaveText("Waiting for your contact to open Chess");
  const card = chat(bob).getByTestId("app-card");
  await expect(card.getByTestId("app-card-check")).toHaveText("Installed");
  await ana.page.waitForTimeout(15_000);
  await card.getByTestId("app-card-open").click();
  await expect(miniApp(bob.page)).toBeVisible();

  const [white, black] = await startGame(ana, bob);
  await move(white.page, black.page, "e2", "e4");
  await move(black.page, white.page, "e7", "e5");

  // Each closes Chess and opens it again: both moves are kept, and the next one still reaches the other side.
  for (const side of [white, black]) await closeAndReopen(side);
  await boardsShow(white, black, [["e4", "wp"], ["e5", "bp"], ["e2", ""], ["e7", ""]]);
  await move(white.page, black.page, "g1", "f3");
  await boardsShow(white, black, [["f3", "wn"], ["g1", ""]]);

  // Bob reloads mid-game: the session comes back, his Chess is opened again from the card, and the game goes on both
  // ways (his saved game, Ana's open said again on the new session, and the catch-up between the two apps).
  await bob.page.reload();
  await expect(miniApp(bob.page)).toBeHidden();
  await expect(bob.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
  await expect(card.getByTestId("app-card-waiting")).toHaveCount(0);
  await card.getByTestId("app-card-open").click();
  await boardsShow(white, black, [["e4", "wp"], ["e5", "bp"], ["f3", "wn"]]);
  await move(black.page, white.page, "b8", "c6");
  await move(white.page, black.page, "f1", "c4");
  await boardsShow(white, black, [["c6", "bn"], ["c4", "wb"], ["b8", ""], ["f1", ""]]);
});

/** Two people with Chess open in their chat and a game started (one invited, the other accepted): [white, black]. */
async function playing(peer: (name: string) => Promise<Peer>, browserName: string): Promise<{ ana: Peer; bob: Peer; white: Peer; black: Peer }> {
  const publisher = new ChessPublisher();
  publisher.signStore({ apps: [publisher.publish({ sequence: SEQUENCE })] });
  const [ana, bob] = await openPeers(peer, browserName, "ana", "bob");
  await Promise.all([publisher.serve(ana.context), publisher.serve(bob.context)]);
  await installFromStore(ana.page);
  await installFromStore(bob.page);
  await ana.page.goto("/#/");
  await bob.page.goto("/#/");
  await pair(ana, bob);
  await (await composerRow(ana.page, "composer-apps")).click();
  await ana.page.getByTestId("chat-apps").getByTestId("chat-app-open").click();
  await chat(bob).getByTestId("app-card").getByTestId("app-card-open").click();
  const [white, black] = await startGame(ana, bob);
  return { ana, bob, white, black };
}

/** Every status line a side's Chess shows, read once a second until `stop`. */
function watchStatus(side: Peer): { seen: Set<string>; stop: () => Promise<void> } {
  const seen = new Set<string>();
  let on = true;
  const loop = (async () => {
    while (on) {
      const text = await chessStatus(side.page).textContent({ timeout: 5_000 }).catch(() => null);
      if (text) seen.add(text);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  })();
  return { seen, stop: async () => { on = false; await loop; } };
}

const CLOSED = "Your contact closed Chess. The game waits here.";

/**
 * The page as the browser has it with its tab in the background: `document.visibilityState` "hidden", with the
 * `visibilitychange` and `blur` a real switch sends (headless Chromium keeps every page visible, whatever is in front).
 */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((hidden) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(hidden ? "blur" : "focus"));
  }, hidden);
}

test("a tab in the background keeps Chess open: a move made meanwhile is there when it comes back", {
  tag: ["@feature:apps.chess.web", "@feature:apps.chat.wire"],
}, async ({ peer, browserName }) => {
  test.setTimeout(6 * 60_000);
  const { white, black } = await playing(peer, browserName);
  const watching = watchStatus(white);

  // Black's tab goes to the background for a minute; white moves after 20 s.
  await setHidden(black.page, true);
  await white.page.waitForTimeout(20_000);
  await move(white.page, black.page, "e2", "e4");
  await white.page.waitForTimeout(40_000);
  await setHidden(black.page, false);
  await move(black.page, white.page, "e7", "e5");
  await move(white.page, black.page, "g1", "f3");
  await watching.stop();
  expect([...watching.seen], "white never saw black's Chess close").not.toContain(CLOSED);
});

test("a page frozen for a minute (the session dropped meanwhile) catches up on the move it missed", {
  tag: ["@feature:apps.chess.web", "@feature:apps.chat.wire"],
}, async ({ peer, browserName }) => {
  test.skip(browserName !== "chromium", "freezing a page is Chromium's DevTools protocol");
  test.setTimeout(6 * 60_000);
  const { white, black } = await playing(peer, browserName);
  await move(white.page, black.page, "e2", "e4");
  await move(black.page, white.page, "e7", "e5");

  // Black's page is frozen (as a browser may freeze a tab long in the background): no script, no answer to pings.
  const cdp = await black.context.newCDPSession(black.page);
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  await white.page.waitForTimeout(5_000);
  // White moves while black is frozen, before its session is given up for dead.
  await expect(chessStatus(white.page)).toHaveText(/^Your move/);
  await square(white.page, "g1").click();
  await square(white.page, "f3").click();
  await expect(square(white.page, "f3")).toHaveAttribute("data-piece", "wn");
  await white.page.waitForTimeout(55_000);
  await cdp.send("Page.setWebLifecycleState", { state: "active" });

  // Back: the chat comes back, and the move black missed is there, by the frame or the catch-up.
  await expect(square(black.page, "f3")).toHaveAttribute("data-piece", "wn", { timeout: 120_000 });
  await move(black.page, white.page, "b8", "c6");
  await boardsShow(white, black, [["e4", "wp"], ["e5", "bp"], ["f3", "wn"], ["c6", "bn"]]);
});

test("a long game: both keep Chess open for minutes, a move every 12 s, and every move arrives", {
  tag: ["@feature:apps.chess.web", "@feature:apps.chat.wire"],
}, async ({ peer, browserName }) => {
  test.setTimeout(8 * 60_000);
  const { white, black } = await playing(peer, browserName);
  const watching = [watchStatus(white), watchStatus(black)];
  // The Italian game, both castled: 12 plies.
  const plies: [string, string][] = [["e2", "e4"], ["e7", "e5"], ["g1", "f3"], ["b8", "c6"], ["f1", "c4"], ["f8", "c5"],
    ["c2", "c3"], ["g8", "f6"], ["d2", "d3"], ["d7", "d6"], ["e1", "g1"], ["e8", "g8"]];
  for (const [i, [from, to]] of plies.entries()) {
    await white.page.waitForTimeout(12_000);
    const [mover, watcher] = i % 2 === 0 ? [white, black] : [black, white];
    await move(mover.page, watcher.page, from, to);
  }
  await boardsShow(white, black, [["g1", "wk"], ["f1", "wr"], ["g8", "bk"], ["f8", "br"]]);
  for (const w of watching) await w.stop();
  for (const w of watching) expect([...w.seen], "neither side saw the other's Chess close").not.toContain(CLOSED);
});

test("a tampered bundle is never installed", { tag: ["@feature:apps.chess.web", "@feature:apps.bundle"] }, async ({ peer, browserName }) => {
  const publisher = new ChessPublisher();
  const chess = publisher.publish({ sequence: SEQUENCE });
  publisher.signStore({ apps: [chess] });
  // One byte of Chess's own script changed after the publisher signed it.
  const tampered = chess.bytes.slice();
  tampered[tampered.length - 200] ^= 0x01;
  publisher.files.set(chess.url, tampered);
  const [ana] = await openPeers(peer, browserName, "ana");
  await publisher.serve(ana.context);

  await ana.page.goto("/#/apps");
  await ana.page.getByTestId("apps-add").click();
  await ana.page.getByTestId("apps-add-url").fill(chess.url);
  await ana.page.getByTestId("apps-add-check").click();
  const dialog = ana.page.getByTestId("apps-add-dialog");
  await expect(dialog.getByTestId("apps-add-error")).toHaveText(TAMPERED);
  await expect(ana.page.getByTestId("app-install")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // From the store's listing too, whose digest it does not match.
  await ana.page.getByTestId("apps-add").click();
  await ana.page.getByTestId("apps-add-url").fill(CHESS_STORE_URL);
  await ana.page.getByTestId("apps-add-check").click();
  await ana.page.getByTestId("apps-add-store-confirm").click();
  const listed = ana.page.getByTestId("app-store").filter({ hasText: STORE_NAME });
  await listed.getByRole("button", { name: new RegExp(STORE_NAME) }).click();
  await listed.getByTestId("app-listing-install").click();
  const screen = ana.page.getByTestId("app-install");
  await expect(screen.getByTestId("app-install-error")).toHaveText(TAMPERED);
  await expect(screen.getByTestId("app-install-confirm")).toHaveCount(0);
  await screen.getByRole("button", { name: "Cancel" }).click();
  await expect(ana.page.getByTestId("apps-none")).toBeVisible();
});

test("a lower sequence is not installed over a newer one", { tag: ["@feature:apps.chess.web", "@feature:apps.updates"] }, async ({ peer, browserName }) => {
  const publisher = new ChessPublisher();
  const older = publisher.publish({ sequence: SEQUENCE, path: "v1/app.ghostlyapp" });
  const newer = publisher.publish({ version: "2.3.1", sequence: SEQUENCE + 1, path: "v2/app.ghostlyapp" });
  publisher.signStore({ apps: [newer] });
  const [ana] = await openPeers(peer, browserName, "ana");
  await publisher.serve(ana.context);
  await installFromStore(ana.page);
  await expect(ana.page.getByTestId("installed-app")).toContainText("2.3.1");

  // The older version by its link: the install screen says why, and offers no Install.
  await ana.page.getByTestId("apps-add").click();
  await ana.page.getByTestId("apps-add-url").fill(older.url);
  await ana.page.getByTestId("apps-add-check").click();
  const screen = ana.page.getByTestId("app-install");
  await expect(screen.getByTestId("app-install-blocked")).toHaveText("You have a newer version.");
  await expect(screen.getByTestId("app-install-confirm")).toHaveCount(0);
  await screen.getByRole("button", { name: "Cancel" }).click();

  // The store going back to the older one changes nothing: the newer stays installed.
  publisher.signStore({ apps: [older] });
  await ana.page.getByTestId("app-store").filter({ hasText: STORE_NAME }).getByTestId("app-store-refresh").click();
  await ana.page.goto("/#/");
  await ana.page.goto("/#/apps");
  await expect(ana.page.getByTestId("installed-app")).toContainText("2.3.1");
  await expect(ana.page.getByTestId("installed-app-open")).toBeVisible();
});

test("Chess 1.0.2 updates to 2.3.0 only once the person agrees to share their name", { tag: ["@feature:apps.chess.web", "@feature:apps.updates", "@feature:apps.page"] }, async ({ peer, browserName }) => {
  const publisher = new ChessPublisher();
  // Chess as it was first published: it asks for `chat` alone.
  const first = publisher.publish({ build: CHESS_1_0_2, sequence: 1 });
  publisher.signStore({ apps: [first] });
  const [ana] = await openPeers(peer, browserName, "ana");
  await publisher.serve(ana.context);
  const screen = await openStoreInstall(ana.page);
  await expect(screen.getByTestId("app-permission-chat")).toBeVisible();
  await expect(screen.getByTestId("app-permission-name")).toHaveCount(0);
  await screen.getByTestId("app-install-confirm").click();
  const row = ana.page.getByTestId("installed-app");
  await expect(row).toContainText("1.0.2");

  // 2.3.0 is published over it and the store lists it. It asks for `name` too, so it waits for the person: the
  // installed Chess stays 1.0.2.
  const next = publisher.publish({ sequence: SEQUENCE });
  publisher.signStore({ apps: [next] });
  await ana.page.getByTestId("app-store").filter({ hasText: STORE_NAME }).getByTestId("app-store-refresh").click();
  await ana.page.goto("/#/");
  await ana.page.goto("/#/apps");
  await expect(row.getByTestId("installed-app-hint")).toHaveText("Update waiting for you");
  await expect(row).toContainText("1.0.2");

  // Its details say what the new version asks for on top of what was granted: `name`, and nothing else.
  await row.getByRole("button", { name: /Chess: details/ }).click();
  const details = ana.page.getByTestId("app-details");
  const update = details.getByTestId("app-update");
  await expect(update).toContainText(`Version ${CHESS.manifest.version} is ready.`);
  await expect(update.getByTestId("app-permission-name")).toHaveText("See your name in this chat");
  expect(await update.locator("[data-permission]").evaluateAll((all) => all.map((li) => (li as HTMLElement).dataset.permission))).toEqual(["name"]);

  // Agreed: 2.3.0 is the installed Chess, with `name` among what it was granted.
  await update.getByTestId("app-update-accept").click();
  await expect(row).toContainText(CHESS.manifest.version);
  await expect(row.getByTestId("installed-app-hint")).not.toHaveText("Update waiting for you");
  await expect(details.getByTestId("app-update")).toHaveCount(0);
  await expect(details.getByTestId("app-permission-name")).toBeVisible();
  await expect(details.getByTestId("app-permission-chat")).toBeVisible();
});

test("a version a store removed stays stopped until Run anyway", { tag: ["@feature:apps.chess.web", "@feature:apps.engine.installed", "@feature:apps.page"] }, async ({ peer, browserName }) => {
  const publisher = new ChessPublisher();
  // Full screen, so Run anyway opens it here, alone (Chess itself runs in a chat: the Apps page would ask which).
  const chess = publisher.publish({ sequence: SEQUENCE, view: "full" });
  publisher.signStore({ apps: [chess] });
  const [ana] = await openPeers(peer, browserName, "ana");
  await publisher.serve(ana.context);
  await installFromStore(ana.page);

  publisher.signStore({ apps: [chess], removed: [{ app: chess, reason: "Sends your moves to a server" }] });
  await ana.page.getByTestId("app-store").filter({ hasText: STORE_NAME }).getByTestId("app-store-refresh").click();
  const row = ana.page.getByTestId("installed-app");
  await expect(row.getByTestId("installed-app-hint")).toHaveText("Stopped");
  await expect(row.getByTestId("installed-app-open")).toHaveCount(0);

  await row.getByRole("button", { name: /Chess: details/ }).click();
  const details = ana.page.getByTestId("app-details");
  await expect(details.getByTestId("app-run-line")).toHaveText(`Removed by ${STORE_NAME}: Sends your moves to a server`);
  await expect(details.getByTestId("app-open")).toHaveCount(0);
  await details.getByTestId("app-keep-stopped").click();
  await expect(miniApp(ana.page)).toBeHidden();

  // Run anyway, the person's own choice: it runs.
  await row.getByRole("button", { name: /Chess: details/ }).click();
  await details.getByTestId("app-run-anyway").click();
  await expect(miniApp(ana.page)).toBeVisible();
  await expect(chessStatus(ana.page)).toHaveText("White to move");
});

test("a version its publisher revoked never runs", { tag: ["@feature:apps.chess.web", "@feature:apps.engine.installed", "@feature:apps.page"] }, async ({ peer, browserName }) => {
  const publisher = new ChessPublisher();
  const chess = publisher.publish({ sequence: SEQUENCE });
  publisher.signStore({ apps: [chess] });
  const [ana] = await openPeers(peer, browserName, "ana");
  await publisher.serve(ana.context);
  await installFromStore(ana.page);
  await expect(ana.page.getByTestId("installed-app-open")).toBeVisible();

  // The publisher revokes it beside the bundle; the next update check (opening the Apps page) reads it.
  publisher.revoke(chess, "Leaked the game to the wrong chat");
  await ana.page.goto("/#/");
  await ana.page.goto("/#/apps");
  const row = ana.page.getByTestId("installed-app");
  await expect(row.getByTestId("installed-app-hint")).toHaveText("Stopped");
  await expect(row.getByTestId("installed-app-open")).toHaveCount(0);
  await row.getByRole("button", { name: /Chess: details/ }).click();
  const details = ana.page.getByTestId("app-details");
  await expect(details.getByTestId("app-run-line")).toHaveText("Its publisher revoked this version.");
  await expect(details.getByTestId("app-open")).toHaveCount(0);
  await expect(details.getByTestId("app-run-anyway")).toHaveCount(0);
  await expect(details.getByTestId("app-keep-stopped")).toBeVisible();
});
