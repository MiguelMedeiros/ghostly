import { chat, expect, say, test, type Peer, type PeerOptions } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * A contact's presence and status (WISP 401 § Presence and status): two paired peers on the local relay. Bob's online
 * dot reaches Alice's chat list row, her chat's header and his contact panel, with its words for a screen reader;
 * idle while his page is hidden, gone when his session ends. The status he sets in the account menu's picker (an
 * availability, an emoji, a text and an end) shows beside his name until he clears it or it ends. With Share when I'm
 * online off there is no dot, and his status still shows. Alice's Do not disturb lets a message in with no sound and
 * no notice. On a phone in Arabic the header keeps his whole name, his status text isolated in its own direction (not
 * yet on a 320 px phone: the last test, known to fail).
 */
test.describe.configure({ timeout: 4 * 60_000 });

/** What `peer` sees of its one contact: the chat list row and its dot, the header's dot and its words. */
function seen(peer: Peer) {
  const page = peer.page;
  const row = page.getByTestId("sidebar").getByTestId("chat-row").first();
  return {
    row,
    rowOpen: row.getByTestId("chat-row-open"),
    rowDot: row.getByTestId("chat-row-presence"),
    rowEmoji: row.getByTestId("chat-row-peer-status-emoji"),
    rowText: row.getByTestId("chat-row-peer-status-text"),
    headDot: page.getByTestId("chat-avatar-presence"),
    headWords: page.getByTestId("chat-presence-presence"),
    headEmoji: page.getByTestId("chat-presence-status-emoji"),
    headText: page.getByTestId("chat-presence-status-text"),
  };
}

/** Says whether the page is shown, as a browser does when its tab goes to the back or comes forward again. */
const showPage = (peer: Peer, shown: boolean) => peer.page.evaluate((shown) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (shown ? "visible" : "hidden") });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => !shown });
  document.dispatchEvent(new Event("visibilitychange"));
}, shown);

interface StatusChoice {
  availability?: "Available" | "Busy" | "Do not disturb" | "Away";
  emoji?: string;
  text?: string;
  /** An option of "Clear after", by its words. */
  end?: string;
}

/** Opens the status picker from the account menu. */
async function openPicker(peer: Peer) {
  await peer.page.getByTestId("account-profile").click();
  await peer.page.getByTestId("profile-switcher-status").click();
  const picker = peer.page.getByTestId("status-picker");
  await expect(picker).toBeVisible();
  return picker;
}

/** Picks an option of the picker's "Clear after". */
async function chooseEnd(peer: Peer, end: string) {
  await peer.page.getByTestId("status-end").click();
  await peer.page.getByTestId("status-end-list").getByRole("option", { name: end, exact: true }).click();
  await expect(peer.page.getByTestId("status-end")).toHaveAttribute("title", end);
}

/** Sets a status through the account menu's picker, as a person does. */
async function setStatus(peer: Peer, choice: StatusChoice) {
  const picker = await openPicker(peer);
  if (choice.availability) await picker.getByText(choice.availability, { exact: true }).click();
  if (choice.emoji) await picker.getByRole("button", { name: choice.emoji, exact: true }).click();
  if (choice.text !== undefined) await picker.getByLabel("Status text").fill(choice.text);
  if (choice.end) await chooseEnd(peer, choice.end);
  await picker.getByRole("button", { name: "Save", exact: true }).click();
  await expect(picker).toHaveCount(0);
}

test("a contact's online dot shows while they are here, idle while their page is hidden, and goes with their session", { tag: ["@feature:chat.status.shown", "@feature:chat.status.wire"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await pair(alice, bob);
  const at = seen(alice);

  // Live and here: a filled dot on his picture in the list and in the header, its words for a screen reader.
  await expect(at.rowDot).toHaveAttribute("data-tone", "online", { timeout: 20_000 });
  await expect(at.headDot).toHaveAttribute("data-tone", "online");
  await expect(at.headDot).toHaveAttribute("aria-hidden", "true");
  await expect(at.headWords).toHaveText("Online");
  await expect(at.rowOpen).toHaveAccessibleName(/, Online(,|$)/);
  // Nothing set: no status beside his name.
  await expect(at.rowText).toHaveCount(0);
  await expect(at.headText).toHaveCount(0);
  await alice.page.screenshot({ path: testInfo.outputPath("online.png") });

  // His tab goes to the back: idle (a ring), said in words too.
  await showPage(bob, false);
  await expect(at.rowDot).toHaveAttribute("data-tone", "idle", { timeout: 20_000 });
  await expect(at.headDot).toHaveAttribute("data-tone", "idle");
  await expect(at.headWords).toHaveText("Online, idle");
  await expect(at.rowOpen).toHaveAccessibleName(/, Online, idle(,|$)/);
  // Forward again: online.
  await showPage(bob, true);
  await expect(at.headDot).toHaveAttribute("data-tone", "online", { timeout: 20_000 });

  // He closes Ghostly: his session ends, and with it the dot and its words.
  await bob.context.close();
  await expect(at.headDot).toHaveCount(0, { timeout: 90_000 });
  await expect(at.rowDot).toHaveCount(0);
  await expect(at.headWords).toHaveCount(0);
  await expect(at.rowOpen).not.toHaveAccessibleName(/Online/);
});

test("a status set in the account menu shows beside the contact's name until it is cleared; a past end is refused, a short one runs out", { tag: ["@feature:chat.status.picker", "@feature:chat.status.shown", "@feature:chat.status.wire"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  // Alice's clock is the test's, so a status can run out there (a status past its end is none, by the reader's clock).
  await alice.page.clock.install();
  await alice.page.reload();
  await expect(alice.page.getByTitle("New Chat")).toBeVisible();
  await pair(alice, bob);
  const at = seen(alice);
  await expect(at.headDot).toHaveAttribute("data-tone", "online", { timeout: 20_000 });

  // Bob: busy, 🍕, "At lunch", for an hour.
  await setStatus(bob, { availability: "Busy", emoji: "🍕", text: "At lunch", end: "1 hour" });
  // His own menu says it.
  await bob.page.getByTestId("account-profile").click();
  await expect(bob.page.getByTestId("profile-switcher-status")).toHaveAccessibleName(/^Your status: Busy, .*🍕 .*At lunch.*, until .+\. Change status$/);
  await bob.page.keyboard.press("Escape");

  // Alice: in the row and the header, the emoji and the text, and a red dot that says busy.
  await expect(at.rowText).toHaveText("At lunch", { timeout: 20_000 });
  await expect(at.rowEmoji).toHaveText("🍕");
  await expect(at.headText).toHaveText("At lunch");
  await expect(at.headEmoji).toHaveText("🍕");
  await expect(at.rowDot).toHaveAttribute("data-tone", "busy");
  await expect(at.headDot).toHaveAttribute("data-tone", "busy");
  await expect(at.headWords).toHaveText("Online, busy");
  await expect(at.rowOpen).toHaveAccessibleName(/, Online, busy, Status: 🍕 At lunch(,|$)/);
  // The text is in its own direction, isolated from the name around it.
  await expect(at.headText).toHaveJSProperty("tagName", "BDI");
  await expect(at.headText).toHaveAttribute("dir", "auto");
  await alice.page.screenshot({ path: testInfo.outputPath("status-shown.png") });

  // His contact panel says it too.
  await alice.page.getByTestId("chat-identity-badges").click();
  const panel = alice.page.getByTestId("chat-identities");
  await expect(panel.getByTestId("chat-identities-presence-status-text")).toHaveText("At lunch");
  await expect(panel.getByTestId("chat-identities-presence-status-emoji")).toHaveText("🍕");
  await expect(panel.getByTestId("chat-identities-presence-presence")).toHaveText("Online, busy");
  await expect(panel.getByTestId("chat-identities-picture-presence")).toHaveAttribute("data-tone", "busy");
  await alice.page.screenshot({ path: testInfo.outputPath("status-panel.png") });
  await panel.getByTestId("chat-identities-close").click();
  await expect(panel).toHaveCount(0);

  // He clears it: gone at Alice, the dot back to green.
  const picker = await openPicker(bob);
  await picker.getByRole("button", { name: "Clear status", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(at.headText).toHaveCount(0, { timeout: 20_000 });
  await expect(at.rowText).toHaveCount(0);
  await expect(at.rowEmoji).toHaveCount(0);
  await expect(at.headDot).toHaveAttribute("data-tone", "online");
  await expect(at.rowOpen).not.toHaveAccessibleName(/Status:/);

  // An end in the past: refused, said, and the picker stays with nothing sent.
  const again = await openPicker(bob);
  await again.getByLabel("Status text").fill("Back in the past");
  await chooseEnd(bob, "Choose a time…");
  await again.getByLabel("Clear at").fill("2020-01-01T10:00");
  await again.getByRole("button", { name: "Save", exact: true }).click();
  await expect(again.getByRole("alert")).toHaveText("Choose a time later than now.");
  await expect(again.getByLabel("Clear at")).toHaveAttribute("aria-invalid", "true");
  await expect(again).toBeVisible();
  await again.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(again).toHaveCount(0);
  await alice.page.waitForTimeout(6_000); // past the sender's 5 s pace: anything sent would be here by now
  await expect(at.headText).toHaveCount(0);

  // The shortest end the picker offers, 30 minutes: 31 minutes on Alice's clock, it is gone there by itself.
  await setStatus(bob, { emoji: "🚗", text: "Driving", end: "30 minutes" });
  await expect(at.headText).toHaveText("Driving", { timeout: 20_000 });
  await expect(at.rowText).toHaveText("Driving");
  await alice.page.clock.fastForward("31:00");
  await expect(at.headText).toHaveCount(0, { timeout: 20_000 });
  await expect(at.rowText).toHaveCount(0);
  await expect(at.rowEmoji).toHaveCount(0);
});

test("with Share when I'm online off a contact shows no dot, and still their status", { tag: ["@feature:settings.share-presence", "@feature:chat.status.shown", "@feature:chat.status.wire"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await pair(alice, bob);
  const at = seen(alice);
  await expect(at.headDot).toHaveAttribute("data-tone", "online", { timeout: 20_000 });
  await setStatus(bob, { emoji: "🏠", text: "Working from home", end: "Today" });
  await expect(at.headText).toHaveText("Working from home", { timeout: 20_000 });

  // Bob turns it off in Settings: no dot, no words of it, at Alice; his status stays.
  await bob.page.goto("/#/settings");
  const share = bob.page.getByTestId("settings-share-presence");
  await expect(share).toHaveAttribute("aria-checked", "true");
  await share.click();
  await expect(share).toHaveAttribute("aria-checked", "false");
  await expect(at.headDot).toHaveCount(0, { timeout: 20_000 });
  await expect(at.rowDot).toHaveCount(0);
  await expect(at.headWords).toHaveCount(0);
  await expect(at.rowOpen).not.toHaveAccessibleName(/Online/);
  await expect(at.headText).toHaveText("Working from home");
  await expect(at.headEmoji).toHaveText("🏠");
  await expect(at.rowText).toHaveText("Working from home");
  await expect(at.rowOpen).toHaveAccessibleName(/Status: 🏠 Working from home/);

  // On again: the dot is back.
  await share.click();
  await expect(share).toHaveAttribute("aria-checked", "true");
  await expect(at.headDot).toHaveAttribute("data-tone", "online", { timeout: 20_000 });
});

/** A note only this sound plays (apps/ui/src/lib/sounds.ts), as e2e/web/chat-mute.spec.ts reads it. */
const MESSAGE_NOTE = 880;

/** Records this peer's sounds and notifications (stand-ins, as e2e/web/chat-mute.spec.ts), and turns notifications on. */
async function observe(peer: Peer): Promise<void> {
  await peer.context.addInitScript(() => {
    const record = (key: string, value: unknown) => {
      const list = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown[];
      list.push(value);
      localStorage.setItem(key, JSON.stringify(list));
    };
    const node = () => ({ connect: (to: unknown) => to, start() {}, stop() {} });
    class StandInAudio {
      state = "running";
      currentTime = 0;
      destination = {};
      resume() { return Promise.resolve(); }
      decodeAudioData() { return Promise.reject(new Error("stand-in")); }
      createGain() { return { ...node(), gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
      createOscillator() { return { ...node(), type: "sine", frequency: { setValueAtTime: (hz: number) => record("qa-notes", hz) } }; }
      createBufferSource() { return { ...node(), buffer: null }; }
    }
    Object.defineProperty(window, "AudioContext", { value: StandInAudio, configurable: true });
    class Notice {
      static permission = "granted";
      static async requestPermission() { return "granted"; }
      constructor(title: string) { record("qa-notices", title); }
      close() {}
      onclick: unknown;
    }
    Object.defineProperty(window, "Notification", { value: Notice, configurable: true });
    // In the background, where a notification is shown at all.
    document.hasFocus = () => false;
  });
  await peer.page.reload();
  await peer.page.getByTitle("Settings").click();
  const system = peer.page.getByRole("switch", { name: "System notifications", exact: true });
  await system.click();
  await expect(system).toBeChecked();
  // The first gesture unlocks audio, as a person's first click does.
  await peer.page.goto("/#/");
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

const heard = (peer: Peer) =>
  peer.page.evaluate((note) => (JSON.parse(localStorage.getItem("qa-notes") ?? "[]") as number[]).filter((hz) => hz === note).length, MESSAGE_NOTE);
const notices = (peer: Peer) => peer.page.evaluate(() => (JSON.parse(localStorage.getItem("qa-notices") ?? "[]") as unknown[]).length);

test("with Do not disturb a message arrives with no sound and no notice, and the contact sees the red dot", { tag: ["@feature:chat.status.picker", "@feature:chat.status.shown", "@feature:app.attention.notifications", "@feature:app.attention.sounds"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await observe(alice);
  await pair(alice, bob);

  // Before: a message is heard and notified (the stand-ins work).
  const [sounds, shown] = [await heard(alice), await notices(alice)];
  await say(bob, "before do not disturb");
  await expect(chat(alice).getByText("before do not disturb")).toBeVisible();
  await expect.poll(() => heard(alice)).toBe(sounds + 1);
  await expect.poll(() => notices(alice)).toBe(shown + 1);

  // Alice: Do not disturb, no end. The picker says what it does.
  const picker = await openPicker(alice);
  await picker.getByText("Do not disturb", { exact: true }).click();
  await expect(picker).toContainText("Messages come in without a sound or a notice. Calls still ring.");
  await chooseEnd(alice, "Don't clear");
  await picker.getByRole("button", { name: "Save", exact: true }).click();
  await expect(picker).toHaveCount(0);
  // Bob sees it: a red dot with a bar, "Do not disturb" beside her name.
  await expect(seen(bob).headDot).toHaveAttribute("data-tone", "dnd", { timeout: 20_000 });
  await expect(seen(bob).headWords).toHaveText("Online, do not disturb");
  await expect(seen(bob).headText).toHaveText("Do not disturb");

  // A message from Bob: it arrives, and nothing is heard or shown.
  await say(bob, "during do not disturb");
  await expect(chat(alice).getByText("during do not disturb")).toBeVisible();
  await alice.page.waitForTimeout(1_500); // the time a sound or notice would have taken
  expect(await heard(alice)).toBe(sounds + 1);
  expect(await notices(alice)).toBe(shown + 1);
  await alice.page.screenshot({ path: testInfo.outputPath("dnd.png") });

  // Cleared: heard and notified again.
  const off = await openPicker(alice);
  await off.getByRole("button", { name: "Clear status", exact: true }).click();
  await expect(off).toHaveCount(0);
  await expect(seen(bob).headDot).toHaveAttribute("data-tone", "online", { timeout: 20_000 });
  await say(bob, "after do not disturb");
  await expect(chat(alice).getByText("after do not disturb")).toBeVisible();
  await expect.poll(() => heard(alice)).toBe(sounds + 2);
  await expect.poll(() => notices(alice)).toBe(shown + 2);
});

/** The names e2e/web/chat-header-phone.spec.ts checks, with the narrowest phone each fits there. */
const NAMES: [string, number][] = [["Cérebro (Mac)", 320], ["Hermes (Omarchy)", 375], ["عبد الرحمن الفارسي", 375]];
const PHONES = [{ width: 402, height: 874 }, { width: 390, height: 844 }, { width: 375, height: 667 }, { width: 320, height: 568 }];

/** Alice on a phone in Arabic, with Bob busy at lunch: what her chat's header shows of him. */
async function phoneInArabic(peer: (name: string, options?: PeerOptions) => Promise<Peer>) {
  const bob = await peer("bob");
  const alice = await peer("alice", { mobile: true, viewport: { width: 390, height: 844 } });
  await pair(bob, alice);
  await setStatus(bob, { availability: "Busy", emoji: "🍕", text: "At lunch with the whole team today", end: "4 hours" });
  const page = alice.page, name = page.getByTestId("chat-name"), at = seen(alice);
  await expect(at.headEmoji).toHaveText("🍕", { timeout: 20_000 });
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language: "ar" }));
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  // A new session after the reload: Bob says his whole state again.
  await expect(at.headEmoji).toHaveText("🍕", { timeout: 90_000 });
  const rename = async (to: string) => {
    await name.click();
    const box = page.locator("input[maxlength='30']");
    await box.fill(to);
    await box.press("Enter");
    await expect(name).toHaveText(to);
  };
  /** The name against what it holds (cut with an ellipsis when `shown` < `whole`), and whether the status overlaps it. */
  const line = () => name.evaluate((el) => {
    const status = document.querySelector("[data-testid=chat-presence]")!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return { shown: el.clientWidth, whole: el.scrollWidth, overlap: box.left < status.right && status.left < box.right };
  });
  return { page, at, rename, line };
}

test("on a phone in Arabic the chat's header keeps the contact's whole name beside their status, its text isolated", { tag: ["@feature:chat.status.shown", "@feature:app.mobile-layout", "@feature:app.i18n"] }, async ({ peer }, testInfo) => {
  const { page, at, rename, line } = await phoneInArabic(peer);
  await expect(at.headWords).toHaveText("متصل، مشغول");
  await expect(at.headDot).toHaveAttribute("data-tone", "busy");
  // The text: in a <bdi dir=auto> of its own, laid out by its own letters (for a screen reader only on a phone: the emoji shows).
  await expect(at.headText).toHaveJSProperty("tagName", "BDI");
  await expect(at.headText).toHaveAttribute("dir", "auto");
  await expect(at.headText).toHaveText("At lunch with the whole team today");
  expect(await at.headText.evaluate((el) => getComputedStyle(el).direction)).toBe("ltr");

  // Each name whole beside the emoji, never under it, on each phone of 375 px and more (320 px: the next test).
  for (const [shown, narrowest] of NAMES) {
    await rename(shown);
    for (const phone of PHONES) {
      if (phone.width < Math.max(narrowest, 375)) continue;
      await page.setViewportSize(phone);
      const room = await line();
      expect(room.whole, `"${shown}" at ${phone.width}px: ${JSON.stringify(room)}`).toBeLessThanOrEqual(room.shown);
      expect(room.overlap, `"${shown}" at ${phone.width}px: ${JSON.stringify(room)}`).toBe(false);
      await expect(at.headEmoji).toBeVisible();
    }
  }
  await page.setViewportSize({ width: 375, height: 667 });
  await page.screenshot({ path: testInfo.outputPath("phone-arabic-375.png") });
});

/*
 * Known to fail: on a 320 px phone a contact's status takes the room "Cérebro (Mac)" needs (83 of its 97 px; 96 with no
 * status set, while the contact is online): the header's status (apps/ui/src/pages/Chat.tsx, the `PeerPresenceLine`
 * beside the name) does not give way before the name, as the chat list's does. Once it does, this passes: take
 * `test.fail` away.
 */
test("on a 320 px phone in Arabic a contact's status gives way before their name", { tag: ["@feature:chat.status.shown", "@feature:app.mobile-layout", "@feature:app.i18n"] }, async ({ peer }, testInfo) => {
  test.fail(true, "the header's status takes the name's room at 320 px (Chat.tsx PeerPresenceLine)");
  const { page, rename, line } = await phoneInArabic(peer);
  await rename("Cérebro (Mac)");
  await page.setViewportSize({ width: 320, height: 568 });
  await page.screenshot({ path: testInfo.outputPath("phone-arabic-320.png") });
  const room = await line();
  expect(room.whole, `"Cérebro (Mac)" at 320px: ${JSON.stringify(room)}`).toBeLessThanOrEqual(room.shown);
});
