import { expect, openProfilePage, say, test, type Peer } from "../support/fixtures";

/**
 * Mentions in a group (WISP 9xx § Mentions) between three browsers that never pair. Alice picks Bob from the
 * composer's @ list; the message names him by key. Bob and Carol both muted the group: Bob still hears the
 * mention and gets its notification (his "Still notify me when I'm mentioned" is on, the default), and his list
 * shows an @; Carol, not named, hears nothing. Once Bob turns that option off, a mention stays quiet too.
 *
 * What would be heard and shown is recorded, not played (as in chat-mute.spec.ts): a stand-in AudioContext notes
 * every tone (its decoding fails, so the app plays its synthesized fallback, whose notes name the sound), a
 * stand-in Notification keeps what it was asked to show, and the clock is Playwright's.
 */

/** The note only the message sound plays (src/lib/sounds.ts). */
const MESSAGE_NOTE = 880;

async function setName(peer: Peer, name: string): Promise<void> {
  await openProfilePage(peer.page);
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

/** Records this peer's sounds and notifications, puts its clock under the test's hand, and turns notifications on. */
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
  await peer.page.clock.install();
  await peer.page.reload();
  await peer.page.getByTitle("Settings").click();
  const system = peer.page.getByRole("switch", { name: "System notifications", exact: true });
  await system.click();
  await expect(system).toBeChecked();
  // The first gesture unlocks audio, as a person's first click does.
  await peer.page.goto("/#/");
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

/** How many message sounds, and notifications, this peer has had. */
const heard = (peer: Peer) =>
  peer.page.evaluate((note) => (JSON.parse(localStorage.getItem("qa-notes") ?? "[]") as number[]).filter((hz) => hz === note).length, MESSAGE_NOTE);
const notices = (peer: Peer) => peer.page.evaluate(() => (JSON.parse(localStorage.getItem("qa-notices") ?? "[]") as unknown[]).length);

const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const row = (peer: Peer) => peer.page.getByTestId("sidebar").getByTestId("group-row").first();

async function join(peer: Peer, url: string): Promise<void> {
  await peer.page.goto(url);
  await expect(groupChat(peer)).toBeVisible({ timeout: 30_000 });
  await expect(groupChat(peer)).toHaveAttribute("data-status", "active", { timeout: 180_000 });
}

/** Mutes the open group from its ⋮ menu, with no end, leaving "Still notify me when I'm mentioned" as it is. */
async function muteGroup(peer: Peer): Promise<void> {
  await peer.page.getByTestId("group-options").click();
  await peer.page.getByTestId("chat-mute-open").click();
  const menu = peer.page.getByTestId("mute-menu");
  await expect(menu.getByTestId("mute-mentions")).toHaveAttribute("aria-checked", "true");
  await menu.getByTestId("mute-forever").click();
  await expect(menu).toHaveCount(0);
}

/** Alice names Bob from the @ list and says `text` after it. */
async function mentionBob(alice: Peer, text: string): Promise<void> {
  const box = alice.page.getByPlaceholder("Message…");
  await box.click();
  await box.pressSequentially("@Bo");
  const picker = alice.page.getByTestId("mention-picker");
  await expect(picker.getByRole("option")).toHaveText([/^Bob…/]);
  await box.press("Enter");
  await expect(box).toHaveValue("@Bob ");
  await box.pressSequentially(text);
  await box.press("Enter");
  await expect(groupChat(alice).getByText(text)).toBeVisible();
}

test("three members: A mentions B, B's muted group still notifies, C's stays quiet", { tag: ["@feature:groups.mentions", "@feature:groups.mentions.notify", "@feature:groups.protocol.mentions"] }, async ({ peer }) => {
  test.setTimeout(12 * 60_000);
  const [alice, bob, carol] = await Promise.all(["alice", "bob", "carol"].map(name => peer(name)));
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob"), setName(carol, "Carol")]);
  await Promise.all([observe(bob), observe(carol)]);

  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Supper club");
  await alice.page.getByTestId("new-group-create").click();
  const share = alice.page.getByTestId("group-share-dialog");
  const url = await share.getByTestId("group-link-url").inputValue();
  await share.getByTestId("group-share-done").click();

  await join(bob, url);
  await join(carol, url);
  await expect(alice.page.getByTestId("group-members")).toContainText("3 members", { timeout: 120_000 });
  // A community member's name travels with what they say: each says hello, so the others know them by name.
  await say(bob, "hi from Bob");
  await say(carol, "hi from Carol");
  await expect(groupChat(alice).getByText("hi from Carol")).toBeVisible({ timeout: 120_000 });
  await expect(groupChat(alice).getByText("hi from Bob")).toBeVisible({ timeout: 120_000 });
  await expect(groupChat(bob).getByText("hi from Carol")).toBeVisible({ timeout: 120_000 });
  await expect(groupChat(carol).getByText("hi from Bob")).toBeVisible({ timeout: 120_000 });

  // Bob and Carol mute the group and go back to the list.
  for (const p of [bob, carol]) {
    await muteGroup(p);
    await p.page.goto("/#/");
    await expect(row(p)).toHaveAttribute("data-muted", "true");
  }
  const before = { bob: await heard(bob), bobNotices: await notices(bob), carol: await heard(carol), carolNotices: await notices(carol) };

  await mentionBob(alice, "are you coming tonight?");
  await expect(groupChat(alice).getByTestId("mention")).toHaveText("@Bob");
  await expect(groupChat(alice).getByTestId("mention")).not.toHaveAttribute("data-me");

  // Bob: heard, notified, and an @ beside the unread dot.
  await expect.poll(() => heard(bob), { timeout: 120_000 }).toBe(before.bob + 1);
  await expect.poll(() => notices(bob)).toBe(before.bobNotices + 1);
  await expect(row(bob).getByTestId("group-row-mention")).toBeVisible();
  await expect(row(bob).getByTestId("group-row-mention")).not.toHaveAttribute("data-muted");
  // Carol got the message, unread, without a sound, a notification or an @.
  await expect(row(carol).getByTestId("group-row-unread")).toBeVisible({ timeout: 120_000 });
  await expect(row(carol).getByTestId("group-row-mention")).toHaveCount(0);
  await carol.page.clock.runFor(2_000);
  expect(await heard(carol)).toBe(before.carol);
  expect(await notices(carol)).toBe(before.carolNotices);

  // In the chat: Bob's is his (stronger), Carol's is Bob's, by his name.
  await row(bob).click();
  await expect(groupChat(bob).getByTestId("mention")).toHaveText("@Bob");
  await expect(groupChat(bob).getByTestId("mention")).toHaveAttribute("data-me", "true");
  await row(carol).click();
  await expect(groupChat(carol).getByTestId("mention")).toHaveText("@Bob");
  await expect(groupChat(carol).getByTestId("mention")).not.toHaveAttribute("data-me");

  // Bob turns "Still notify me when I'm mentioned" off from the list row's bell: the next mention is quiet too.
  await bob.page.goto("/#/");
  await row(bob).hover();
  await row(bob).getByTestId("chat-row-mute").click();
  const toggle = bob.page.getByTestId("mute-menu").getByTestId("mute-mentions");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await bob.page.keyboard.press("Escape");
  const quiet = { heard: await heard(bob), notices: await notices(bob) };
  await mentionBob(alice, "last call");
  await expect(row(bob).getByTestId("group-row-mention")).toBeVisible({ timeout: 120_000 });
  await expect(row(bob).getByTestId("group-row-mention")).toHaveAttribute("data-muted", "true");
  await bob.page.clock.runFor(2_000);
  expect(await heard(bob)).toBe(quiet.heard);
  expect(await notices(bob)).toBe(quiet.notices);
});
