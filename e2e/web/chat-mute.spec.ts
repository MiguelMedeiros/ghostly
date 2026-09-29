import { chat, expect, say, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * Muting one chat (src/lib/chatMute.ts): its messages still arrive and count as unread, without a sound or a
 * system notification, until the mute ends by itself or is turned off. Calls still ring.
 *
 * What would be heard and shown is recorded, not played: a stand-in AudioContext notes every tone a sound starts
 * (its decoding fails, so the app plays its synthesized fallback, whose notes name the sound), and a stand-in
 * Notification keeps what it was asked to show. The muted side's clock is Playwright's, so a mute can run out.
 */

/** A note only this sound plays (src/lib/sounds.ts). */
const NOTE = { message: 880, ring: 988 } as const;

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

/** How many times this peer played the sound `note` belongs to. */
const heard = (peer: Peer, note: number) =>
  peer.page.evaluate((note) => (JSON.parse(localStorage.getItem("qa-notes") ?? "[]") as number[]).filter((hz) => hz === note).length, note);
const notices = (peer: Peer) => peer.page.evaluate(() => (JSON.parse(localStorage.getItem("qa-notices") ?? "[]") as unknown[]).length);

/** The chat's row in the list, and its bell among the row's actions (shown on hover). */
const rowOf = (peer: Peer) => peer.page.getByTestId("sidebar").getByTestId("chat-row").first();
const bellOf = (peer: Peer) => rowOf(peer).getByTestId("chat-row-mute");

/** Mutes the open chat from its ⋮ menu. */
async function mute(peer: Peer, choice: "15m" | "1h" | "1d" | "forever") {
  await peer.page.getByTestId("chat-options").click();
  await peer.page.getByTestId("chat-mute-open").click();
  await expect(peer.page.getByTestId("mute-menu")).toBeVisible();
  await peer.page.getByTestId(`mute-${choice}`).click();
  await expect(peer.page.getByTestId("mute-menu")).toHaveCount(0);
}

test("a chat muted for 15 minutes stays quiet but keeps counting, and is heard again once the mute is over", { tag: ["@feature:chats.mute", "@feature:app.attention.sounds", "@feature:app.attention.notifications"] }, async ({ peer }, testInfo) => {
  const [host, guest] = await Promise.all([peer("mute-host"), peer("mute-guest")]);
  await observe(guest);
  await pair(host, guest);

  // Not muted: a message is heard, and notified.
  const [sounds, shown] = [await heard(guest, NOTE.message), await notices(guest)];
  await say(host, "before the mute");
  await expect(chat(guest).getByText("before the mute")).toBeVisible();
  await expect.poll(() => heard(guest, NOTE.message)).toBe(sounds + 1);
  await expect.poll(() => notices(guest)).toBe(shown + 1);

  await mute(guest, "15m");
  // Nothing by the name in the header: the one such button on the page is the list row's bell, which says until when.
  await expect(guest.page.getByRole("button", { name: /^Notifications muted/ })).toHaveCount(1);
  await expect(bellOf(guest)).toHaveAccessibleName(/^Notifications muted until \d{1,2}:\d{2}/);
  await guest.page.screenshot({ path: testInfo.outputPath("muted-chat.png") });

  // Away from the chat, so its row counts what comes in.
  await guest.page.evaluate(() => { location.hash = "#/"; });
  const row = rowOf(guest);
  await expect(row).toHaveAttribute("data-muted", "true");
  await expect(row.getByTestId("chat-row-muted")).toBeVisible();
  await say(host, "while muted");
  await expect(row.getByTestId("chat-row-unread")).toHaveText("1");
  await expect(row.getByTestId("chat-row-unread")).toHaveAttribute("data-muted", "true");
  await expect(row).toContainText("while muted");
  // Arrived and counted: give a sound that should not come the time it would have taken.
  await guest.page.waitForTimeout(1_500);
  expect(await heard(guest, NOTE.message)).toBe(sounds + 1);
  expect(await notices(guest)).toBe(shown + 1);
  await guest.page.screenshot({ path: testInfo.outputPath("muted-list.png") });

  // Sixteen minutes on, the mute is over by itself: the bell is gone and the next message is heard.
  await guest.page.clock.fastForward("16:00");
  await expect(row.getByTestId("chat-row-muted")).toHaveCount(0);
  await expect(row).not.toHaveAttribute("data-muted");
  await say(host, "after the mute");
  await expect(row.getByTestId("chat-row-unread")).toHaveText("2", { timeout: 60_000 });
  await expect(row.getByTestId("chat-row-unread")).not.toHaveAttribute("data-muted");
  await expect.poll(() => heard(guest, NOTE.message)).toBe(sounds + 2);
  await expect.poll(() => notices(guest)).toBe(shown + 2);
});

test("Until I unmute: a call still rings, the mute outlasts a day, and it ends when turned off", { tag: ["@feature:chats.mute", "@feature:calls.paired"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("mute-alice"), peer("mute-bob")]);
  await observe(bob);
  await pair(alice, bob);
  const [sounds, shown] = [await heard(bob, NOTE.message), await notices(bob)];
  await mute(bob, "forever");
  const bell = bellOf(bob);
  await expect(bell).toHaveAccessibleName("Notifications muted");
  await expect(bell).toHaveAttribute("data-muted", "forever");

  // A call is not a notification: it rings in a muted chat.
  await expect(alice.page.getByTestId("call-audio")).toBeEnabled();
  await alice.page.getByTestId("call-audio").click();
  await expect(bob.page.getByText("Incoming audio call...")).toBeVisible();
  await expect.poll(() => heard(bob, NOTE.ring)).toBeGreaterThan(0);
  await bob.page.getByTitle("Decline").click();
  await expect(bob.page.getByText("Incoming audio call...")).toHaveCount(0);

  await say(alice, "muted, no end");
  await expect(chat(bob).getByText("muted, no end")).toBeVisible();
  // More than a day later it is still muted.
  await bob.page.clock.fastForward("25:00:00");
  await say(alice, "a day later");
  await expect(chat(bob).getByText("a day later")).toBeVisible({ timeout: 60_000 });
  await bob.page.waitForTimeout(1_500);
  expect(await heard(bob, NOTE.message)).toBe(sounds);
  expect(await notices(bob)).toBe(shown);
  await expect(bell).toHaveAttribute("data-muted", "forever");

  // Turned off from the list row's bell: heard again.
  await rowOf(bob).hover();
  await bell.click();
  await expect(bob.page.getByTestId("mute-menu")).toBeVisible();
  await bob.page.screenshot({ path: testInfo.outputPath("unmute-from-row.png") });
  await bob.page.getByTestId("mute-off").click();
  await expect(bell).not.toHaveAttribute("data-muted");
  await expect(rowOf(bob).getByTestId("chat-row-muted")).toHaveCount(0);
  await say(alice, "unmuted");
  await expect(chat(bob).getByText("unmuted")).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => heard(bob, NOTE.message)).toBe(sounds + 1);
  await expect.poll(() => notices(bob)).toBe(shown + 1);
});
