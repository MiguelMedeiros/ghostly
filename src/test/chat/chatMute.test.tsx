import { act, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionEvent } from "@ghostly/browser/shared/rpc";
import type { GroupView } from "@ghostly/browser/shared/types";
import { AttentionFeedback } from "../../components/AttentionFeedback";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import {
  MUTE_SILENCES, attentionOutcome, callRings, chatOfLink, groupChat, muteEnd, muteEndText, mutedUntil, setChatMute,
} from "../../lib/chatMute";
import { loadSettings, saveSettings } from "../../lib/settings";
import { deleteSession, saveSession, setStorageProfile } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.mute

const sound = vi.hoisted(() => ({ playSound: vi.fn(() => () => {}), notice: vi.fn(async () => {}) }));
vi.mock("../../lib/sounds", () => ({ playSound: sound.playSound, startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));
vi.mock("../../lib/notifications", () => ({ showPrivateNotification: sound.notice }));

const MIN = 60_000;
const NOW = Date.now();
const key = (c: string) => c.repeat(52);
const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m-${Math.random()}`, text: "hi", sender: "peer", timestamp: NOW, ...over });
const chat = (id: string, over: Partial<ChatSession> = {}): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages: [], createdAt: NOW, ...over });
const notifications = (soundEnabled: boolean, systemEnabled: boolean) => ({ soundEnabled, systemEnabled });

afterEach(() => {
  setStorageProfile("");
  sound.playSound.mockClear();
  sound.notice.mockClear();
});

describe("a chat's mute: until when, kept on this device", () => {
  it("mutes one chat, not the others, and ends by itself at its time", () => {
    setChatMute("a", muteEnd("15m", NOW));
    expect(mutedUntil("a", NOW)).toBe(NOW + 15 * MIN);
    expect(mutedUntil("b", NOW)).toBeUndefined();
    expect(mutedUntil("a", NOW + 15 * MIN - 1)).toBe(NOW + 15 * MIN);
    expect(mutedUntil("a", NOW + 15 * MIN)).toBeUndefined();
  });

  it("offers 15 minutes, an hour, a day and no end", () => {
    expect(muteEnd("15m", NOW)).toBe(NOW + 15 * MIN);
    expect(muteEnd("1h", NOW)).toBe(NOW + 60 * MIN);
    expect(muteEnd("1d", NOW)).toBe(NOW + 24 * 60 * MIN);
    expect(muteEnd("forever", NOW)).toBe("forever");
  });

  it("is over after a restart past its end, even when the app was closed through it, and leaves nothing behind", () => {
    setChatMute("a", muteEnd("1h", NOW));
    setChatMute("b", "forever");
    // What a restart has to go on is what storage kept: read it again, an hour and a year later.
    const stored = { ...localStorage };
    localStorage.clear();
    for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v as string);
    expect(mutedUntil("a", NOW + 61 * MIN)).toBeUndefined();
    expect(localStorage.getItem("ghostly_mute_a")).toBeNull();
    expect(mutedUntil("b", NOW + 365 * 24 * 60 * MIN)).toBe("forever");
  });

  it("stays until unmuted when it has no end", () => {
    setChatMute("a", "forever");
    expect(mutedUntil("a", NOW + 10 * 365 * 24 * 60 * MIN)).toBe("forever");
    setChatMute("a", undefined);
    expect(mutedUntil("a")).toBeUndefined();
  });

  it("belongs to the profile that set it, and goes with the chat", () => {
    setStorageProfile("abcdefghij");
    setChatMute("a", "forever");
    setStorageProfile("");
    expect(mutedUntil("a")).toBeUndefined();
    setChatMute("a", "forever");
    saveSession(chat("a"));
    deleteSession("a");
    expect(mutedUntil("a")).toBeUndefined();
  });

  it("ignores what it cannot read", () => {
    localStorage.setItem("ghostly_mute_a", "soon");
    expect(mutedUntil("a")).toBeUndefined();
  });

  it("says when it ends: the time today, the weekday and time after that", () => {
    const today = new Date(2026, 8, 25, 14, 0).getTime();
    expect(muteEndText(today + 30 * MIN, "en", today)).toBe(new Date(today + 30 * MIN).toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" }));
    expect(muteEndText(today + 24 * 60 * MIN, "en", today)).toMatch(/^Sat/);
  });
});

describe("what a muted chat leaves out", () => {
  const on = notifications(true, true);

  it("leaves out a new message's sound and system notification, and nothing else", () => {
    expect(attentionOutcome("message", true, on, true)).toEqual({ sound: false, notice: false });
    expect(attentionOutcome("message", false, on, true)).toEqual({ sound: true, notice: true });
    // What I sent, and the wallet's coins and confirmations, are no chat's notifications.
    for (const type of ["sent", "coin", "confirmed"] as const) expect(attentionOutcome(type, true, on, true).sound).toBe(true);
  });

  it("never plays what the global switches keep off", () => {
    expect(attentionOutcome("message", false, notifications(false, false), true)).toEqual({ sound: false, notice: false });
    expect(attentionOutcome("message", false, notifications(false, true), true)).toEqual({ sound: false, notice: true });
    // A notification only while the app is in the background, muted or not.
    expect(attentionOutcome("message", false, on, false)).toEqual({ sound: true, notice: false });
  });

  it("leaves calls ringing", () => {
    expect(MUTE_SILENCES.call).toBe(false);
    setChatMute("a", "forever");
    expect(callRings("a")).toBe(true);
    expect(callRings("b")).toBe(true);
  });

  it("finds an event's chat: a group by its link id, a 1:1 chat through its link's contact", () => {
    saveSession(chat("a"));
    const links = [{ id: "link-a", peerPubKeyZ32: key("a") }, { id: "link-x", peerPubKeyZ32: key("x") }];
    expect(chatOfLink("group:g1", links)).toBe("group:g1");
    expect(chatOfLink("link-a", links)).toBe("a");
    expect(chatOfLink("link-x", links)).toBeUndefined();
    expect(chatOfLink("link-gone", links)).toBeUndefined();
    expect(chatOfLink(undefined, links)).toBeUndefined();
  });
});

describe("AttentionFeedback in a muted chat", () => {
  let n = 0;
  const event = (patch: Partial<AttentionEvent>): AttentionEvent => ({ id: `event-${++n}`, type: "message", at: Date.now(), ...patch });
  /** One chat ("a", on link-a) and a group, the app in the background, sounds and notifications on. */
  function setup() {
    saveSettings({ ...loadSettings(), notifications: { soundEnabled: true, systemEnabled: true } });
    saveSession(chat("a"));
    fakeEngine.update({ links: [linkView({ id: "link-a", peerPubKeyZ32: key("a") })] });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    renderApp(<AttentionFeedback />);
  }
  /** Sends `events`, then one that always plays, and waits for it: whatever the first ones did is done by then. */
  async function send(...events: AttentionEvent[]) {
    const marker = event({ type: "coin" });
    act(() => { for (const e of [...events, marker]) fakeEngine.emit({ kind: "attention", event: e }); });
    await waitFor(() => expect(sound.playSound).toHaveBeenLastCalledWith("coin"));
    return sound.playSound.mock.calls.slice(0, -1).map(([name]) => name);
  }

  it("plays and shows nothing for the muted chat's messages, and does for the others", async () => {
    setup();
    setChatMute("a", "forever");
    setChatMute(groupChat("g1"), muteEnd("1h"));
    expect(await send(event({ linkId: "link-a" }), event({ linkId: "group:g1" }))).toEqual([]);
    expect(sound.notice).not.toHaveBeenCalled();
    sound.playSound.mockClear();
    expect(await send(event({ linkId: "group:g2" }), event({ linkId: "link-a", type: "sent" }))).toEqual(["message", "sent"]);
    await waitFor(() => expect(sound.notice).toHaveBeenCalledTimes(1));
  });

  it("plays again once the mute has ended, and once unmuted", async () => {
    setup();
    // A mute that ended while nothing was running: its end is in the past.
    localStorage.setItem("ghostly_mute_a", String(Date.now() - 1));
    expect(await send(event({ linkId: "link-a" }))).toEqual(["message"]);
    setChatMute("a", "forever");
    sound.playSound.mockClear();
    expect(await send(event({ linkId: "link-a" }))).toEqual([]);
    setChatMute("a", undefined);
    sound.playSound.mockClear();
    expect(await send(event({ linkId: "link-a" }))).toEqual(["message"]);
  });

  it("plays nothing, muted or not, while sounds are off", async () => {
    setup();
    saveSettings({ ...loadSettings(), notifications: { soundEnabled: false, systemEnabled: false } });
    act(() => fakeEngine.emit({ kind: "attention", event: event({ linkId: "link-a" }) }));
    await new Promise(r => setTimeout(r, 20));
    expect(sound.playSound).not.toHaveBeenCalled();
    expect(sound.notice).not.toHaveBeenCalled();
  });
});

/** Opens /group/group-1 as the app routes it. */
function openGroup(group: GroupView, language?: "pt") {
  fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined).update({ groups: [group] });
  return renderApp(<Routes>
    <Route path="/" element={<p>Chat list</p>} />
    <Route path="/group/:groupId" element={<GroupChat />} />
  </Routes>, { route: "/group/group-1", language });
}
const activeGroup = () => groupView({ status: "active", epoch: 1, members: [{ key: key("m"), role: "member", me: true, online: true, missing: 0 }] });
const rowTexts = (menu: HTMLElement) => within(menu).getAllByRole("button").map(b => b.querySelector("[data-menu-text]")?.textContent);

describe("muting from the chat's menu", () => {
  it("⋮ → Mute notifications… → a duration: the header's bell says until when, and ⋮ unmutes", async () => {
    const { user } = openGroup(activeGroup());
    expect(screen.queryByTestId("chat-muted")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("chat-mute-open"));
    expect(screen.queryByTestId("group-options-menu")).not.toBeInTheDocument();
    const menu = screen.getByTestId("mute-menu");
    expect(menu).toHaveAccessibleName("Mute notifications");
    expect(within(menu).getByTestId("mute-menu-head")).toHaveTextContent("Messages still arrive. Calls still ring.");
    expect(rowTexts(menu)).toEqual(["15 minutes", "1 hour", "1 day", "Until I unmute"]);
    expect(within(menu).getByTestId("mute-1h")).toHaveTextContent(/Until .+/);
    expect(within(menu).getByTestId("mute-forever")).toHaveTextContent("No end time");

    const before = Date.now();
    await user.click(screen.getByTestId("mute-15m"));
    expect(screen.queryByTestId("mute-menu")).not.toBeInTheDocument();
    const until = mutedUntil(groupChat("group-1")) as number;
    expect(until - before).toBeGreaterThanOrEqual(15 * MIN);
    expect(until - before).toBeLessThan(15 * MIN + 5_000);
    const bell = screen.getByTestId("chat-muted");
    expect(bell).toHaveAccessibleName(`Notifications muted until ${muteEndText(until, "en")}`);
    expect(bell).toHaveAttribute("title", `Notifications muted until ${muteEndText(until, "en")}`);

    await user.click(screen.getByTestId("group-options"));
    const row = screen.getByTestId("chat-unmute");
    expect(row).toHaveTextContent(`Unmute notifications`);
    expect(row).toHaveTextContent(`Muted until ${muteEndText(until, "en")}`);
    await user.click(row);
    expect(screen.queryByTestId("chat-muted")).not.toBeInTheDocument();
    expect(mutedUntil(groupChat("group-1"))).toBeUndefined();
    await user.click(screen.getByTestId("group-options"));
    expect(screen.getByTestId("chat-mute-open")).toBeInTheDocument();
  });

  it("Until I unmute: the bell says muted with no end, and opens the way back", async () => {
    const { user } = openGroup(activeGroup());
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("chat-mute-open"));
    await user.click(screen.getByTestId("mute-forever"));
    const bell = screen.getByTestId("chat-muted");
    expect(bell).toHaveAccessibleName("Notifications muted");
    expect(bell).toHaveAttribute("data-muted", "forever");
    expect(bell).toHaveAttribute("aria-expanded", "false");
    await user.click(bell);
    expect(bell).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByTestId("mute-menu");
    expect(menu).toHaveAccessibleName("Muted");
    await user.click(within(menu).getByTestId("mute-off"));
    expect(screen.queryByTestId("chat-muted")).not.toBeInTheDocument();
    expect(mutedUntil(groupChat("group-1"))).toBeUndefined();
  });

  it("takes the bell away by itself when the mute ends", async () => {
    setChatMute(groupChat("group-1"), Date.now() + 150);
    openGroup(activeGroup());
    expect(screen.getByTestId("chat-muted")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("chat-muted")).not.toBeInTheDocument(), { timeout: 2_000 });
  });

  it("speaks the app's language", async () => {
    const { user } = openGroup(activeGroup(), "pt");
    await user.click(screen.getByTestId("group-options"));
    expect(screen.getByTestId("chat-mute-open")).toHaveTextContent("Silenciar notificações…");
    await user.click(screen.getByTestId("chat-mute-open"));
    expect(rowTexts(screen.getByTestId("mute-menu"))).toEqual(["15 minutos", "1 hora", "1 dia", "Até eu reativar"]);
  });
});

describe("a muted chat in the list", () => {
  const list = () => renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);

  it("keeps its unread count and its place, with a bell by the time and the count in grey", async () => {
    saveSession(chat("a", { nick: "Alice", nickSource: "profile", lastSyncAt: NOW, messages: [message(), message()] }));
    saveSession(chat("b", { nick: "Bob", nickSource: "profile", lastSyncAt: NOW - MIN, messages: [message()] }));
    setChatMute("a", "forever");
    list();
    const rows = screen.getAllByTestId("chat-row");
    expect(rows.map(r => within(r).getByTestId("chat-row-name").textContent)).toEqual(["Alice", "Bob"]);
    const [alice, bob] = rows;
    expect(alice).toHaveAttribute("data-muted", "true");
    expect(within(alice).getByTestId("chat-row-muted")).toHaveAccessibleName("Notifications muted");
    const badge = within(alice).getByTestId("chat-row-unread");
    expect(badge).toHaveTextContent("2");
    expect(badge).toHaveAttribute("data-muted", "true");
    expect(badge).toHaveClass("bg-text-secondary");
    expect(badge).not.toHaveClass("bg-accent");
    expect(within(alice).getByTestId("chat-row-time")).not.toHaveClass("text-accent");
    expect(within(bob).queryByTestId("chat-row-muted")).not.toBeInTheDocument();
    expect(within(bob).getByTestId("chat-row-unread")).toHaveClass("bg-accent");

    act(() => setChatMute("a", undefined));
    expect(within(screen.getAllByTestId("chat-row")[0]).queryByTestId("chat-row-muted")).not.toBeInTheDocument();
    expect(within(screen.getAllByTestId("chat-row")[0]).getByTestId("chat-row-unread")).toHaveClass("bg-accent");
  });

  it("marks a muted group the same way, its unread dot in grey", () => {
    setChatMute(groupChat("group-1"), muteEnd("1d"));
    fakeEngine.update({ groups: [groupView({ status: "active", lastMessageAt: NOW })] });
    list();
    const row = screen.getByTestId("group-row");
    expect(row).toHaveAttribute("data-muted", "true");
    expect(within(row).getByTestId("chat-row-muted")).toBeInTheDocument();
    expect(within(row).getByTestId("group-row-unread")).toHaveClass("bg-text-secondary");
  });
});
