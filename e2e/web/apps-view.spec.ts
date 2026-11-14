import { chat, expect, test, type Peer, type PeerOptions } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { choose } from "../support/select";
import { iosKeyboard, keyboard } from "../support/keyboard";
import { closeIdentities, openIdentities } from "../support/identities";
import { STORE_URL, serveStore, testStore, type TestStore } from "../support/appStore";
import type { AppViewMode } from "@ghostly/core";

/*
 * Where a mini-app runs in a 1:1 chat (WISP 1200 § Per client, web), on the e2e suite's build (VITE_APPS_TEST): Ana
 * installs Chess from a store routed in the test, pairs with Bob and opens it in their chat. On a wide screen it sits
 * beside the chat, which stays usable; on a phone it covers the chat, and Back keeps it running. Its manifest's `view`
 * decides the rest: a chat app (the default) opens from the Apps page in a chat picked there, never alone; a full-screen
 * app opens alone there, and from a chat covers the whole chat with Back to it, never beside it.
 */

async function setNickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

/** Ana installs the store's app (Chess unless said) from the Apps page. */
async function install(peer: Peer, store: TestStore): Promise<void> {
  await peer.page.getByTestId("account-apps").click();
  await peer.page.getByTestId("apps-add").click();
  // The dialog's one field has the focus.
  await expect(peer.page.getByTestId("apps-add-url")).toBeFocused();
  await peer.page.getByTestId("apps-add-url").fill(STORE_URL);
  await peer.page.getByTestId("apps-add-check").click();
  await peer.page.getByTestId("apps-add-store-confirm").click();
  const listed = peer.page.getByTestId("app-store").filter({ hasText: store.storeName });
  await listed.getByTestId("app-listing-install").click();
  await peer.page.getByTestId("app-install").getByTestId("app-install-confirm").click();
  await expect(peer.page.getByTestId("installed-app")).toContainText(store.title);
  // Its Install is gone: the focus is on the app's Open, not lost on the page.
  await expect(peer.page.getByTestId("installed-app").getByTestId("installed-app-open")).toBeFocused();
  await peer.page.goto("/#/");
}

/** Ana and Bob, named, paired, with Chess (or a full-screen app) installed on Ana's side. */
async function setUp(peer: (name: string) => Promise<Peer>, options: { view?: AppViewMode; title?: string; tagline?: string; entry?: string } = {}): Promise<[Peer, Peer]> {
  const store = await testStore(options);
  const [ana, bob] = await Promise.all([peer("ana"), peer("bob")]);
  await serveStore(ana.context, store);
  await setNickname(ana, "Ana");
  await setNickname(bob, "Bob");
  await install(ana, store);
  await pair(ana, bob);
  return [ana, bob];
}

/** + → Apps → Open: the app installed (Chess, or the full-screen one). */
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

/**
 * The app's heading, for `expect.poll`: null until its frame is there. The panel shows before its iframe loads, and a
 * poll whose callback throws fails at once ("no app frame"), with no second try.
 */
function appHeading(ana: Peer): Promise<string | null | undefined> {
  const frame = ana.page.frames().find((f) => f.url().includes("app-frame"));
  return frame ? frame.evaluate(() => document.querySelector("h1")?.textContent).catch(() => null) : Promise.resolve(null);
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
  await expect.poll(() => appHeading(ana)).toBe("Chess");
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
  // The dialog stays until the contact was told (the app card): an Escape before that gives the focus back to its Open
  // button, and the dialog hands it to the message field as it goes (the unit test covers that wait).
  await expect(ana.page.getByTestId("chat-apps")).toHaveCount(0);
  await ana.page.keyboard.press("Escape");
  await expect(app).toBeHidden();
  await expect(input).toBeFocused();
});

test("on a laptop the contact's identities lie over the chat while an app sits beside it, and the chat keeps a phone's width", { tag: ["@feature:apps.view"] }, async ({ peer }) => {
  const [ana] = await setUp(peer);
  const page = ana.page;
  const panel = page.getByTestId("chat-identities"), backdrop = page.locator(".contact-panel-backdrop");
  const chatWidth = async () => (await page.locator(".chat-column").filter({ has: page.getByTestId("chat-name") }).boundingBox())!.width;
  for (const width of [1366, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    // Alone, the panel docks beside the chat.
    await openIdentities(ana);
    await expect(backdrop).toBeHidden();
    await expect(panel).toHaveAttribute("role", "complementary");
    await closeIdentities(ana);

    // With Chess beside the chat, both docked left it 189-232 px and its message field 29-72: the panel lies over it.
    await openChess(ana);
    const app = page.getByTestId("mini-app");
    await expect(app).toHaveAttribute("data-place", "beside");
    await openIdentities(ana);
    await expect(backdrop).toBeVisible();
    await expect(panel).toHaveAttribute("role", "dialog");
    expect(await chatWidth()).toBeGreaterThanOrEqual(320);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await app.getByRole("button", { name: "Close" }).click();
    await expect(app).toBeHidden();

    // Docked when the app opens: it goes over the chat, a dialog now, with the focus; Escape closes it, the app stays.
    await openIdentities(ana);
    await expect(panel).toHaveAttribute("role", "complementary");
    await openChess(ana);
    await expect(app).toHaveAttribute("data-place", "beside");
    await expect(backdrop).toBeVisible();
    await expect(panel).toHaveAttribute("role", "dialog");
    await expect(panel).toBeFocused();
    expect(await chatWidth()).toBeGreaterThanOrEqual(320);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(app).toBeVisible();
    await app.getByRole("button", { name: "Close" }).click();
    await expect(app).toBeHidden();
  }
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
  await expect.poll(() => appHeading(ana)).toBe("Chess");
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

test("on a phone the browser's Back with the app over the chat goes back to the chat, as the app's own Back does", { tag: ["@feature:apps.view"] }, async ({ peer }) => {
  // A phone (touch, 375 × 667 once Chess is installed and Bob paired): the browser's Back, Android's back gesture,
  // went to the chat list, and the app was still over the chat when it was opened again (agents#2449).
  const [ana] = await setUp((name) => peer(name, name === "ana" ? { mobile: true, viewport: { width: 1280, height: 800 } } : undefined));
  await ana.page.setViewportSize({ width: 375, height: 667 });
  await ana.page.goto("/#/");
  const chatList = ana.page.getByPlaceholder("Search chats...");
  await ana.page.getByTestId("chat-row").first().click();
  await expect(ana.page.getByPlaceholder("Message…")).toBeVisible();
  const inChat = ana.page.url();
  expect(inChat).toMatch(/#\/chat\//);
  await openChess(ana);
  const app = ana.page.getByTestId("mini-app");
  await expect(app).toBeVisible();
  await expect(app).toHaveAttribute("data-place", "phone");
  await expect.poll(() => appHeading(ana)).toBe("Chess");
  const frame = chessFrame(ana);
  await frame.evaluate(() => { (window as unknown as { mark: number }).mark = 7; });

  // The browser's Back: still the chat, the app hidden and one tap away, still running.
  await ana.page.goBack();
  await expect(ana.page).toHaveURL(inChat);
  await expect(app).toBeHidden();
  await expect(ana.page.getByPlaceholder("Message…")).toBeVisible();
  const resume = ana.page.getByTestId("mini-app-resume");
  await expect(resume).toHaveText("Back to Chess");
  expect(await frame.evaluate(() => (window as unknown as { mark?: number }).mark)).toBe(7);

  // "Back to Chess": the same game. The app's own Back still goes back to the chat, and the browser's Back from the chat
  // is the chat list at once (the entry the app leaves is passed over, lib/layerHistory.ts).
  await resume.click();
  await expect(app).toBeVisible();
  expect(await frame.evaluate(() => (window as unknown as { mark?: number }).mark)).toBe(7);
  await app.getByTestId("mini-app-back").click();
  await expect(app).toBeHidden();
  await expect(resume).toBeVisible();
  await expect(ana.page).toHaveURL(inChat);
  await ana.page.goBack();
  await expect(chatList).toBeVisible();
  await expect(ana.page).not.toHaveURL(/#\/chat\//);
});

for (const [language, words] of [["ar", "العودة إلى"], ["ja", "に戻る"]] as const) {
  test(`in ${language} on a phone, "Back to" a long app title shows the title's first letters and its words whole`, { tag: ["@feature:apps.view", "@feature:app.i18n"] }, async ({ peer }) => {
    // The bar was one line cut as a whole: in Arabic a Latin title lost its first letters ("achturnier… Pro"), and in
    // Japanese ("<title> に戻る") a long title pushed out the words that say what the bar does.
    const title = "Schachturnierorganisationsverwaltung Pro";
    const [ana] = await setUp(peer, { title });
    await ana.page.evaluate((language) => localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}"), language })), language);
    await ana.page.reload();
    await ana.page.setViewportSize({ width: 320, height: 640 });
    await openChess(ana);
    const app = ana.page.getByTestId("mini-app");
    await expect(app).toBeVisible();
    await app.getByTestId("mini-app-back").click();
    const resume = ana.page.getByTestId("mini-app-resume");
    await expect(resume).toBeVisible();

    // Whether `text` (from `start`, `length` characters) is drawn whole: inside every box that clips it, up to the bar.
    const whole = (text: string, start: number, length: number) => resume.evaluate((bar, [text, start, length]) => {
      const walker = document.createTreeWalker(bar, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.indexOf(text);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at + start);
        range.setEnd(node, at + start + length);
        const drawn = range.getBoundingClientRect();
        let left = drawn.left, right = drawn.right;
        for (let box = node.parentElement; box && bar.contains(box); box = box.parentElement) {
          if (getComputedStyle(box).overflowX === "visible") continue;
          const clip = box.getBoundingClientRect();
          left = Math.max(left, clip.left); right = Math.min(right, clip.right);
        }
        return right - left >= drawn.width - 1;
      }
      return null;
    }, [text, start, length] as const);
    // The title is cut, at its end: its first letter is drawn whole, its last is not. The words are drawn whole.
    expect(await whole(title, 0, 1)).toBe(true);
    expect(await whole(title, title.length - 1, 1)).toBe(false);
    expect(await whole(words, 0, words.length)).toBe(true);
  });
}

test("a chat app's Open on the Apps page asks which chat, and opens it there, never alone", { tag: ["@feature:apps.view"] }, async ({ peer }) => {
  const [ana, bob] = await setUp(peer);
  await ana.page.setViewportSize({ width: 1280, height: 800 });
  await ana.page.getByTestId("account-apps").click();
  await ana.page.getByTestId("installed-app").getByTestId("installed-app-open").click();

  // The chats it can open in: Bob's, the one paired chat.
  const picker = ana.page.getByRole("dialog", { name: "Open Chess in a chat" });
  await expect(picker).toBeVisible();
  await expect(ana.page.getByTestId("mini-app")).toHaveCount(0);
  const chats = picker.getByTestId("app-chat-picker-chat");
  await expect(chats).toHaveCount(1);
  await expect(chats).toContainText("Bob");
  await chats.click();

  // In that chat, beside it, as + → Apps opens it; Bob gets the card.
  const app = ana.page.getByTestId("mini-app");
  await expect(app).toHaveAttribute("data-place", "beside");
  await expect(app).toHaveAttribute("data-view", "chat");
  await expect(app.getByTestId("mini-app-with")).toHaveText("with Bob");
  await expect(ana.page.getByTestId("chat-name")).toBeVisible();
  await expect(chat(bob).getByTestId("app-card")).toContainText("Ana opened it here");
});

/*
 * The Apps dialogs end with their buttons, inside their 20 px padding. Their `pb-safe` (only the phone's safe area)
 * replaced the bottom one, so Close, Cancel and Install sat on the dialog's bottom edge, on a phone and a computer.
 */
test("+ → Apps, the which-chat picker and an app's screen keep their padding under their last buttons", { tag: ["@feature:apps.view", "@feature:apps.page"] }, async ({ peer }) => {
  const [ana] = await setUp(peer);
  /** From the last button's bottom to the dialog's: at least the dialog's 20 px padding (2 px before the fix). */
  const under = async (dialog: string, button: string) => {
    const box = (await ana.page.getByTestId(dialog).boundingBox())!;
    const last = (await ana.page.getByTestId(dialog).getByRole("button", { name: button, exact: true }).boundingBox())!;
    return Math.round(box.y + box.height - (last.y + last.height));
  };
  for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 700 }]) {
    await ana.page.setViewportSize(viewport);
    await (await composerRow(ana.page, "composer-apps")).click();
    expect(await under("chat-apps", "Close"), `+ → Apps at ${viewport.width} px`).toBeGreaterThanOrEqual(20);
    await ana.page.keyboard.press("Escape");
    await expect(ana.page.getByTestId("chat-apps")).toHaveCount(0);

    await ana.page.goto("/#/apps");
    await ana.page.getByTestId("installed-app").getByTestId("installed-app-open").click();
    expect(await under("app-chat-picker", "Cancel"), `the picker at ${viewport.width} px`).toBeGreaterThanOrEqual(20);
    await ana.page.keyboard.press("Escape");
    await ana.page.getByTestId("installed-app").getByRole("button", { name: /^Chess .*: details$/ }).click();
    expect(await under("app-details", "Open"), `the app's screen at ${viewport.width} px`).toBeGreaterThanOrEqual(20);
    await ana.page.keyboard.press("Escape");
    await ana.page.goto("/#/");
    await ana.page.getByTestId("chat-row").first().click();
  }
});

test("a full-screen app opens alone from the Apps page: modal, Close has the focus, Escape closes it", { tag: ["@feature:apps.view"] }, async ({ peer }) => {
  const store = await testStore({ view: "full", title: "Browser", tagline: "Look up Pkarr records" });
  const ana = await peer("ana");
  await serveStore(ana.context, store);
  await install(ana, store);
  // The installed app's Open, which the focus went to after Install.
  await ana.page.getByTestId("account-apps").click();
  const open = ana.page.getByTestId("installed-app").getByTestId("installed-app-open");
  await open.focus();
  await ana.page.keyboard.press("Enter");
  await expect(ana.page.getByTestId("app-chat-picker")).toHaveCount(0);
  const app = ana.page.getByTestId("mini-app");
  await expect(app).toHaveAttribute("data-place", "alone");
  await expect(app).toHaveAttribute("aria-modal", "true");
  await expect(app.getByTestId("mini-app-title")).toHaveText("Browser");
  const box = (await app.boundingBox())!;
  expect(box.width).toBe(ana.page.viewportSize()!.width);
  await expect(app.getByRole("button", { name: "Close" })).toBeFocused();
  await ana.page.keyboard.press("Escape");
  await expect(app).toHaveCount(0);
  await expect(open).toBeFocused();
});

/*
 * On an iPhone, iOS keeps the page's height under the keyboard (support/keyboard.ts). An app full screen, alone or in a
 * chat, stayed the whole screen tall, so the app's own field at its bottom, the one the person typed in, was under it.
 */
const IPHONE = { width: 390, height: 844 }, KEYBOARD = 336;
const NOTES_AT_BOTTOM = "<!doctype html><meta charset=utf-8><title>Notes</title><body style=margin:0>"
  + "<textarea data-testid=notes style='position:fixed;bottom:0;left:0;width:100%;height:48px;box-sizing:border-box'></textarea>";

/** Ana on an iPhone with its keyboard, the store's app installed from the Apps page (no account menu on a phone). */
async function onIphone(peer: (name: string, options?: PeerOptions) => Promise<Peer>, store: TestStore): Promise<Peer> {
  const ana = await peer("ana", { mobile: true, viewport: IPHONE });
  await serveStore(ana.context, store);
  await iosKeyboard(ana.page);
  await ana.page.goto("/#/apps");
  await ana.page.getByTestId("apps-add").click();
  await ana.page.getByTestId("apps-add-url").fill(STORE_URL);
  await ana.page.getByTestId("apps-add-check").click();
  await ana.page.getByTestId("apps-add-store-confirm").click();
  await ana.page.getByTestId("app-store").filter({ hasText: store.storeName }).getByTestId("app-listing-install").click();
  await ana.page.getByTestId("app-install").getByTestId("app-install-confirm").click();
  await expect(ana.page.getByTestId("installed-app")).toContainText(store.title);
  return ana;
}

/** Typing in the app's bottom field: above the keyboard while it is up, back at the screen's bottom once it goes. */
async function typesAboveKeyboard(ana: Peer): Promise<void> {
  const notes = ana.page.getByTestId("mini-app").frameLocator("iframe").getByTestId("notes");
  await notes.click();
  const bottom = async () => { const box = (await notes.boundingBox())!; return Math.round(box.y + box.height); };
  await keyboard(ana.page, KEYBOARD);
  await expect.poll(bottom).toBeLessThanOrEqual(IPHONE.height - KEYBOARD);
  await notes.pressSequentially("e4");
  await expect(notes).toHaveValue("e4");
  await keyboard(ana.page, 0);
  await expect.poll(bottom).toBe(IPHONE.height);
}

test("on an iPhone, a full-screen app opened alone ends where the keyboard starts: a field at its bottom stays above it", { tag: ["@feature:apps.view", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const ana = await onIphone(peer, await testStore({ view: "full", title: "Notes", tagline: "A page to write on", entry: NOTES_AT_BOTTOM }));
  await ana.page.getByTestId("installed-app").getByTestId("installed-app-open").click();
  await expect(ana.page.getByTestId("mini-app")).toHaveAttribute("data-place", "alone");
  await typesAboveKeyboard(ana);
});

test("on an iPhone, an app in a chat ends where the keyboard starts: a field at its bottom stays above it", { tag: ["@feature:apps.view", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const ana = await onIphone(peer, await testStore({ title: "Notes", tagline: "A page to write on", entry: NOTES_AT_BOTTOM }));
  const bob = await peer("bob");
  await ana.page.goto("/#/");
  await pair(ana, bob);
  await openChess(ana);
  await expect(ana.page.getByTestId("mini-app")).toHaveAttribute("data-place", "phone");
  await typesAboveKeyboard(ana);
});

test("a full-screen app opened from a chat covers the whole chat on a wide screen, with Back to it, never beside it", { tag: ["@feature:apps.view"] }, async ({ peer }) => {
  const [ana] = await setUp(peer, { view: "full", title: "Browser", tagline: "Look up Pkarr records" });
  await ana.page.setViewportSize({ width: 1280, height: 800 });
  await openChess(ana);

  const app = ana.page.getByTestId("mini-app");
  await expect(app).toHaveAttribute("data-place", "full");
  await expect(app).toHaveAttribute("data-view", "full");
  await expect(app.getByTestId("mini-app-title")).toHaveText("Browser");
  await expect(app.getByTestId("mini-app-with")).toHaveText("with Bob");
  await expect(app.getByTestId("app-connection-options")).toHaveAccessibleName(/Connected · /);
  // Never beside the chat: no Full width / Show the chat, and the chat is behind it.
  await expect(app.getByTestId("mini-app-wide")).toHaveCount(0);
  await expect(ana.page.getByTestId("chat-name")).toBeHidden();
  const pane = (await ana.page.locator(".chat-pane").filter({ has: app }).boundingBox())!, box = (await app.boundingBox())!;
  expect(Math.round(box.width)).toBe(Math.round(pane.width));
  await expect(app.getByTestId("mini-app-back")).toBeFocused();
  await expect.poll(() => appHeading(ana)).toBe("Browser");
  const frame = chessFrame(ana);
  await frame.evaluate(() => { (window as unknown as { mark: number }).mark = 7; });

  // Back: the chat, with the app one tap away and still running; Escape goes Back too.
  await app.getByTestId("mini-app-back").click();
  await expect(app).toBeHidden();
  await expect(ana.page.getByTestId("chat-name")).toBeVisible();
  const resume = ana.page.getByTestId("mini-app-resume");
  await expect(resume).toHaveText("Back to Browser");
  await resume.click();
  await expect(app).toHaveAttribute("data-place", "full");
  expect(await frame.evaluate(() => (window as unknown as { mark?: number }).mark)).toBe(7);
  await app.getByTestId("mini-app-back").focus();
  await ana.page.keyboard.press("Escape");
  await expect(app).toBeHidden();
  await expect(resume).toBeFocused();
  expect(frame.isDetached()).toBe(false);

  // Close stops it.
  await resume.click();
  await app.getByRole("button", { name: "Close" }).click();
  await expect(app).toBeHidden();
  await expect(app.locator("iframe")).toHaveCount(0);
  await expect(resume).toHaveCount(0);
});

test("a full-screen app opened from a chat on a phone covers the screen, with Back to the chat", { tag: ["@feature:apps.view"] }, async ({ peer }) => {
  const [ana] = await setUp(peer, { view: "full", title: "Browser", tagline: "Look up Pkarr records" });
  await ana.page.setViewportSize({ width: 375, height: 812 });
  await openChess(ana);

  const app = ana.page.getByTestId("mini-app");
  await expect(app).toHaveAttribute("data-place", "phone");
  await expect(app).toHaveAttribute("data-view", "full");
  const box = (await app.boundingBox())!;
  expect(box.width).toBe(375);
  expect(box.height).toBe(812);
  await expect(app.getByTestId("mini-app-with")).toHaveText("with Bob");
  await expect(app.getByTestId("mini-app-wide")).toHaveCount(0);
  await expect(app.getByTestId("mini-app-back")).toBeFocused();
  await app.getByTestId("mini-app-back").click();
  await expect(app).toBeHidden();
  await expect(ana.page.getByTestId("mini-app-resume")).toHaveText("Back to Browser");
});

/**
 * Ana with Lock after 1 minute, in a full-screen app opened alone; with `clock`, on a clock the test drives (the page's
 * and the app's frame's).
 */
async function inAppWithLock(peer: (name: string) => Promise<Peer>, entry: string, clock = true) {
  const store = await testStore({ view: "full", title: "Notes", tagline: "A page to write on", entry });
  const ana = await peer("ana");
  await serveStore(ana.context, store);
  await install(ana, store);
  // From here the test drives the clock of the page and of the app's frame: the person plays longer than the lock time.
  if (clock) {
    await ana.page.clock.install();
    await ana.page.reload();
  }
  // Lock after 1 minute.
  await ana.page.goto("/#/settings");
  await ana.page.getByRole("switch", { name: "Lock Screen" }).click();
  const passwords = ana.page.getByTestId("settings-password-form").locator("input[type=password]");
  await passwords.nth(0).fill("spooky");
  await passwords.nth(1).fill("spooky");
  await ana.page.getByRole("button", { name: "Set password" }).click();
  await expect(ana.page.getByText("Password set successfully")).toBeVisible();
  await choose(ana.page.getByTestId("settings-timeout"), "1");

  await ana.page.getByTestId("account-apps").click();
  await ana.page.getByTestId("installed-app").getByTestId("installed-app-open").click();
  const app = ana.page.getByTestId("mini-app");
  await expect(app).toHaveAttribute("data-place", "alone");
  const notes = app.frameLocator("iframe").getByTestId("notes");
  // The runner's start waits on timers of its own.
  await expect.poll(async () => { if (clock) await ana.page.clock.runFor(100); return notes.isVisible(); }).toBe(true);
  return { ana, app, notes };
}

const NOTES = "<!doctype html><meta charset=utf-8><title>Notes</title><body><textarea data-testid=notes></textarea>";

test("taps and keys in an app keep the lock away while the person plays it; left alone, it locks", { tag: ["@feature:apps.view", "@feature:settings.lock.idle"] }, async ({ peer }) => {
  const { ana, app, notes } = await inAppWithLock(peer, NOTES);

  // Two minutes of play, twice the lock time, in the app alone: the Ghostly page around it hears none of it.
  for (const move of ["e4", "Nf3", "Bc4"]) {
    await notes.click();
    await notes.pressSequentially(move);
    await ana.page.clock.runFor(40_000);
    await expect(ana.page.getByText("Ghostly is locked")).toHaveCount(0);
  }
  await expect(notes).toHaveValue("e4Nf3Bc4");

  // Left alone, the lock comes, and the app stops with it.
  await ana.page.clock.runFor(65_000);
  await expect(ana.page.getByText("Ghostly is locked")).toBeVisible();
  await expect(app).toHaveCount(0);
});

test("an app that says `activity` by itself does not keep the lock away once the person has left it", { tag: ["@feature:apps.view", "@feature:settings.lock.idle"] }, async ({ peer }) => {
  // On the real clock, a minute of it: the test's own calls into the page (the clock's runFor included) count as the
  // person's activation of it, so nothing is asked of the page while the person is away.
  test.setTimeout(240_000);
  // The app takes the runner's port from its first call (it runs in the runner's realm) and says `activity` on it every
  // 3 seconds, input or not.
  const { ana, app, notes } = await inAppWithLock(peer, `${NOTES}<script>
    const post = MessagePort.prototype.postMessage;
    let port = null;
    MessagePort.prototype.postMessage = function (...args) { port = this; return post.apply(this, args); };
    void ghostly.context().catch(() => {});
    let id = 1e6;
    setInterval(() => { if (port) post.call(port, { id: id++, type: "activity", args: [] }); }, 3000);
  </script>`, false);
  await notes.click();
  await notes.pressSequentially("e4");
  // The person walks away with the app in front, past the lock time.
  await ana.page.waitForTimeout(75_000);
  await expect(ana.page.getByText("Ghostly is locked")).toBeVisible({ timeout: 1000 });
  await expect(app).toHaveCount(0);
});

// The watchdog closed an app that held its thread; Open again is what the person has left. Offline it cannot open: the
// place says why and stays, and once it opens again in a chat the keyboard focus is still in the app's panel.
test.describe("Open again after an app stopped responding", () => {
  // Answers at first, then holds its thread past the watchdog's bound.
  const HANGS = "<!doctype html><meta charset=utf-8><title>Chess</title><body><h1>Chess</h1><script>setTimeout(() => { const end = Date.now() + 15000; while (Date.now() < end); }, 1500);</script>";

  test("in a chat: offline it says why under Open again and the panel stays; online, the focus stays in the panel", { tag: ["@feature:apps.view", "@feature:apps.takedown"] }, async ({ peer }) => {
    test.setTimeout(180_000);
    const [ana] = await setUp(peer, { entry: HANGS });
    await ana.page.setViewportSize({ width: 1280, height: 800 });
    await openChess(ana);
    const app = ana.page.getByTestId("mini-app");
    const again = app.getByTestId("mini-app-open-again");
    await expect(again).toBeVisible({ timeout: 60_000 });

    await ana.context.setOffline(true);
    await again.click();
    await expect(app.getByRole("alert")).toHaveText("You are offline.");
    await expect(app.getByTestId("mini-app-stopped")).toBeVisible();
    await expect(again).not.toHaveAttribute("aria-busy", "true");

    await ana.context.setOffline(false);
    await again.focus();
    await ana.page.keyboard.press("Enter");
    await expect(again).toHaveCount(0);
    await expect(app.getByRole("alert")).toHaveCount(0);
    expect(await app.evaluate((panel) => panel.contains(document.activeElement))).toBe(true);
  });

  test("on a phone after Back: the chat keeps the message field, and the way back says it stopped", { tag: ["@feature:apps.view", "@feature:apps.takedown"] }, async ({ peer }) => {
    test.setTimeout(180_000);
    // Hangs once Ana is back in the chat.
    const [ana] = await setUp(peer, { entry: HANGS.replace("1500", "4000") });
    await ana.page.setViewportSize({ width: 375, height: 812 });
    await openChess(ana);
    const app = ana.page.getByTestId("mini-app");
    await expect.poll(() => appHeading(ana)).toBe("Chess");
    await app.getByTestId("mini-app-back").click();
    await expect(app).toBeHidden();
    const input = ana.page.getByPlaceholder("Message…");
    await input.click();

    const resume = ana.page.getByTestId("mini-app-resume");
    await expect(resume.getByTestId("mini-app-resume-stopped")).toContainText("Stopped", { timeout: 60_000 });
    await expect(app).toBeHidden();
    await expect(input).toBeFocused();
    await ana.page.keyboard.type("Still here");
    await expect(input).toHaveValue("Still here");

    // Back to it: why it stopped, and Open again.
    await resume.click();
    await expect(app).toBeVisible();
    await expect(app.getByTestId("mini-app-stopped")).toBeVisible();
    await expect(app.getByTestId("mini-app-open-again")).toBeVisible();
  });

  test("alone: offline the layer stays and says why under Open again",{ tag: ["@feature:apps.view", "@feature:apps.takedown"] }, async ({ peer }) => {
    test.setTimeout(180_000);
    const store = await testStore({ view: "full", title: "Chess", entry: HANGS });
    const ana = await peer("ana");
    await serveStore(ana.context, store);
    await install(ana, store);
    await ana.page.getByTestId("account-apps").click();
    await ana.page.getByTestId("installed-app").getByTestId("installed-app-open").click();
    const app = ana.page.getByTestId("mini-app");
    await expect(app).toHaveAttribute("data-place", "alone");
    const again = app.getByTestId("mini-app-open-again");
    await expect(again).toBeVisible({ timeout: 60_000 });

    await ana.context.setOffline(true);
    await again.click();
    await expect(app.getByRole("alert")).toHaveText("You are offline.");
    await expect(app).toHaveAttribute("data-place", "alone");
    await expect(app.getByTestId("mini-app-stopped")).toBeVisible();

    // Online, it opens again in a layer of its own, and only one.
    await ana.context.setOffline(false);
    await again.click();
    await expect(ana.page.locator("[data-place=alone]")).toHaveCount(1);
    await expect(ana.page.getByTestId("mini-app-open-again")).toHaveCount(0);
    await expect(ana.page.getByTestId("mini-app").getByRole("alert")).toHaveCount(0);
  });
});
