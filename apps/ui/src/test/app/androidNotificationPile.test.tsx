import { act, screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { AttentionFeedback } from "../../components/AttentionFeedback";
import { MESSAGE_BURST_MS, resetCues } from "../../lib/cues";
import { clearChatNotification, showPrivateNotification } from "../../lib/notifications";
import { loadSettings, saveSettings } from "../../lib/settings";
import { saveSession } from "../../lib/storage";
import { refreshWindowAway } from "../../lib/windowAway";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.attention.notifications

/*
 * The Android app keeps one notification per chat. Each message used to post its own (its event's id as Android's tag)
 * and none was ever taken away, read or not: the tray filled, and past 50 Android shows an app's new ones no more.
 * Now a chat's messages replace one notification, under a random tag the page keeps (it never names the chat), and
 * reading the chat in the app takes it away.
 */

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (command: string, _args?: unknown): Promise<unknown> => {
    if (command === "native_notification_permission") return "granted";
    if (command === "native_private_notification") return true;
    return undefined;
  }),
  /** The app's `notification-open` listener, once the page listens. */
  opened: undefined as ((event: { payload: string }) => void) | undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  listen: async (name: string, handler: (event: { payload: string }) => void) => { if (name === "notification-open") tauri.opened = handler; return () => {}; },
  getVersion: async () => "0.4.0",
}));
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "a".repeat(52);
const posted = () => tauri.invoke.mock.calls.filter(([command]) => command === "native_private_notification").map(([, args]) => (args as { id: string }).id);
const cleared = () => tauri.invoke.mock.calls.filter(([command]) => command === "native_clear_notification").map(([, args]) => (args as { id: string }).id);
function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }

let visibility: DocumentVisibilityState = "visible";
let focused = true;
beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  refreshWindowAway();
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36");
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  saveSettings({ ...loadSettings(), notifications: { ...loadSettings().notifications, soundEnabled: false, systemEnabled: true } });
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: Date.now() - 1000 });
  fakeEngine.update({ links: [linkView({ id: "link-a", peerPubKeyZ32: PEER })] });
  tauri.invoke.mockClear();
  resetCues();
});
afterEach(() => {
  visibility = "visible";
  focused = true;
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("Android: one notification per chat", () => {
  it("30 messages over time are one notification under an opaque tag; another chat has its own; a tap opens the chat", async () => {
    visibility = "hidden";
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    renderApp(<><AttentionFeedback /><Routes><Route path="*" element={<Where />} /></Routes></>);
    // Five bursts of six, each past the last one's: a burst posts once (lib/cues.ts `firstNoticeOfBurst`), and each
    // post replaces the chat's notification.
    for (let burst = 0; burst < 5; burst++) {
      act(() => {
        for (let i = 0; i < 6; i++) fakeEngine.emit({ kind: "attention", event: { id: `message:link-a:m${burst}-${i}`, type: "message", at: now, linkId: "link-a" } });
      });
      await waitFor(() => expect(posted()).toHaveLength(burst + 1));
      now += MESSAGE_BURST_MS + 1;
    }
    act(() => fakeEngine.emit({ kind: "attention", event: { id: "message:group:g1:m1", type: "message", at: now, linkId: "group:g1" } }));
    await waitFor(() => expect(posted()).toHaveLength(6));
    const tags = [...new Set(posted())];
    expect(tags).toHaveLength(2);
    // The tag says nothing of the chat: not its session, its link or its group.
    for (const tag of tags) expect(tag).not.toMatch(/chat-1|link-a|g1|message/);
    await waitFor(() => expect(tauri.opened).toBeDefined());
    vi.spyOn(window, "focus").mockImplementation(() => {});
    act(() => tauri.opened!({ payload: tags[0]! }));
    expect(screen.getByTestId("where")).toHaveTextContent("/chat/chat-1");
  });

  it("reading the chat in the app takes its notification away; the next message posts a new one", async () => {
    await showPrivateNotification("message:link-a:m1", "New message", "chat-1", true);
    await showPrivateNotification("message:group:g1:m1", "New message", "group:g1", true);
    const [tag, group] = posted();
    // The chat is open, and the app was away when the message came: it comes back, and the chat is read.
    act(() => { visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange")); });
    renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    expect(cleared()).toEqual([]);
    act(() => { visibility = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(cleared()).toEqual([tag]));
    // Only that chat's.
    expect(cleared()).not.toContain(group);
    clearChatNotification("group:g1");
    expect(cleared()).toEqual([tag, group]);
    await showPrivateNotification("message:link-a:m2", "New message", "chat-1", true);
    expect(posted()[2]).not.toBe(tag);
    // A call's notice keeps its own, so it still comes up over the chat's.
    await showPrivateNotification("call:chat-1:1", "Incoming call", "chat-1");
    expect(posted()[3]).not.toBe(posted()[2]);
    expect(posted()[3]).not.toMatch(/chat-1|call/);
  });
});

/*
 * A Linux desktop keeps a list of notifications too. Each burst of a chat's messages used to add one, and none was
 * taken back when the chat was read in the app. The Linux app now does as the Android app.
 */
describe("Linux: one notification per chat", () => {
  it("a chat's bursts share one notification, which reading the chat takes away; on macOS each keeps its own", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15");
    const os = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await showPrivateNotification("message:link-a:m1", "New message", "chat-1", true);
    await showPrivateNotification("message:link-a:m2", "New message", "chat-1", true);
    await showPrivateNotification("message:group:g1:m1", "New message", "group:g1", true);
    const [tag, again, group] = posted();
    expect(again).toBe(tag);
    expect(group).not.toBe(tag);
    expect(tag).not.toMatch(/chat-1|link-a|message/);
    clearChatNotification("chat-1");
    expect(cleared()).toEqual([tag]);
    await showPrivateNotification("message:link-a:m3", "New message", "chat-1", true);
    expect(posted()[3]).not.toBe(tag);

    // macOS takes its own away: there a notification stays its message's, and nothing is asked to go.
    os.mockReturnValue("MacIntel");
    await showPrivateNotification("message:link-b:m1", "New message", "chat-2", true);
    await showPrivateNotification("message:link-b:m2", "New message", "chat-2", true);
    expect(posted()[5]).not.toBe(posted()[4]);
    clearChatNotification("chat-2");
    expect(cleared()).toEqual([tag]);
  });
});

/*
 * A window on screen behind another app's (a second monitor, another workspace) is told of a message, as it has no
 * focus. Its open chat is read, yet the notification used to be taken back by the very message that made it, some
 * 55 ms after it showed: nobody ever saw it. It now stays until the window has the focus with the chat open.
 */
describe("Linux: a chat open in a window without the focus", () => {
  const linux = () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15");
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  };
  const blur = (next: boolean) => act(() => { focused = !next; window.dispatchEvent(new Event(next ? "blur" : "focus")); });

  it("keeps its notification through the next messages, and takes it away when the window gets the focus", async () => {
    linux();
    blur(true);
    renderApp(<><AttentionFeedback /><Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} /></>);
    act(() => fakeEngine.emit({ kind: "attention", event: { id: "message:link-a:m1", type: "message", at: Date.now(), linkId: "link-a" } }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    // The message lands in the open chat, and another after it.
    const landed: StoredMessage[] = [];
    for (const id of ["m1", "m2"]) {
      landed.push({ linkId: "link-a", id, text: "hi", sender: "peer", timestamp: Date.now(), via: "datalink" });
      act(() => fakeEngine.messages("link-a", [...landed]));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
    }
    expect(cleared()).toEqual([]);
    blur(false);
    await waitFor(() => expect(cleared()).toEqual(posted()));
  });

  it("a group's too", async () => {
    linux();
    blur(true);
    await showPrivateNotification("message:group:group-1:m1", "New message", "group:group-1", true);
    fakeEngine.on("groupMessages", () => []);
    fakeEngine.update({ groups: [groupView({ status: "active", epoch: 1 })] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
    expect(cleared()).toEqual([]);
    blur(false);
    await waitFor(() => expect(cleared()).toEqual(posted()));
  });
});
