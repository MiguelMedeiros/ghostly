import { useEffect, type ReactNode } from "react";
import { act, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeWakeNotices as closeInBrowser } from "../../../../web/src/pwa/push";
import { Sidebar } from "../../components/Sidebar";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { groupReadAt } from "../../lib/groups";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { hashPassword } from "../../lib/settings";
import { addMessages, getUnreadCount, loadSession, saveSession } from "../../lib/storage";
import type { ChatMessage } from "../../lib/types";
import { setPushPlatform, type PushPlatform } from "../../lib/wakePush";
import { refreshWindowAway } from "../../lib/windowAway";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: settings.lock.idle, app.attention.unread, push.wake.notify

/*
 * A lock keeps the app mounted under the lock screen (LockGate), and the chat left open stays "visible" there. Its
 * read mark and its notices used to follow only the window: as soon as the locked app was in front again, the chat
 * behind the lock screen marked every message read and closed its notification and its wake-up notices ("New
 * message", "<name> is online"), while the person saw only the lock screen. Now they wait for the unlock: unlocked
 * with the chat in front, it is read and its notices go then, once.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const PASSWORD = "1234";
let hash = "";
beforeAll(async () => { hash = await hashPassword(PASSWORD); });

const PEER = "a".repeat(52);
const T = Date.now() - 60_000;
const theirs = (text: string, at: number): ChatMessage => ({ id: `peer_${text}`, sender: "peer", text, timestamp: at });

const NOTICES = ["quiet:", "wake::/chat/chat-1", "wake-online::/chat/chat-1", "wake::/chat/chat-2", "wake::/group/group-1"];

/** The installed web app's push registration for the default profile, with the notices its worker shows. */
function fakeBrowser(tags: string[]) {
  const notices = tags.map((tag) => ({ tag, closed: false }));
  const scope = new URL("/push/default/", location.origin).href;
  const registration = {
    scope,
    async getNotifications(filter?: { tag?: string }) {
      return notices.filter((notice) => !notice.closed && (!filter?.tag || notice.tag === filter.tag)).map((notice) => ({ close: () => { notice.closed = true; } }));
    },
  };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async (at: string) => (at === scope ? registration : undefined) } });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  return () => notices.filter((notice) => !notice.closed).map((notice) => notice.tag);
}

let visibility: DocumentVisibilityState = "visible";
let focused = true;
/** The window goes away (hidden, without the focus) or comes back to the front (shown, with the focus). */
const away = (gone: boolean) => act(() => {
  visibility = gone ? "hidden" : "visible";
  focused = !gone;
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event(gone ? "blur" : "focus"));
});
const moment = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });

/** The lock's controls, as the lock screen and Lock now use them. */
const held: { lock?: ReturnType<typeof useLockScreen> } = {};
const lockScreen = { lock: () => held.lock!.lock(), unlock: (password: string) => held.lock!.unlock(password) };
function Lock({ children }: { children: ReactNode }) {
  const value = useLockScreen();
  useEffect(() => { held.lock = value; });
  return <>{children}<p data-testid="locked">{String(value.isLocked)}</p></>;
}
const isLocked = () => screen.getByTestId("locked").textContent;

/** The app open and unlocked, with the lock on ("lock after 5 minutes"), and what it shows inside the lock. */
function underLock(ui: ReactNode, route?: string) {
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: hash, timeoutMinutes: 5 } }));
  handOverUnlock(activeProfileId(), hash);
  return renderApp(<LockScreenProvider><Lock>{ui}</Lock></LockScreenProvider>, { route });
}

let closeNotices: ReturnType<typeof vi.fn>;
beforeEach(() => {
  visibility = "visible";
  focused = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  refreshWindowAway();
  closeNotices = vi.fn(closeInBrowser);
  setPushPlatform({ supported: () => true, subscribe: vi.fn(), current: vi.fn(async () => null), unsubscribe: vi.fn(), syncTable: vi.fn(async () => {}), closeNotices } as unknown as PushPlatform);
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [theirs("hello", T)], createdAt: T - 1000 });
  fakeEngine.on("ensureLink", () => ({ linkId: "link-a" })).on("setActiveLink", () => undefined);
  fakeEngine.update({ links: [linkView({ id: "link-a", peerPubKeyZ32: PEER })] });
});
afterEach(() => {
  setPushPlatform(null);
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  delete (window as unknown as Record<string, unknown>).isSecureContext;
  vi.restoreAllMocks();
  refreshWindowAway();
  localStorage.clear();
  sessionStorage.clear();
});

const unread = () => getUnreadCount(loadSession("chat-1")!);
const chatClosed = () => closeNotices.mock.calls.filter(([, path]) => path === "/chat/chat-1").length;

/** Chat 1 open and read, then the window away and a message from Ana coming meanwhile: one unread. */
async function chatLeftOpen(ui: ReactNode, route?: string) {
  underLock(ui, route);
  await screen.findAllByText("hello");
  expect(unread()).toBe(0);
  away(true);
  act(() => {
    addMessages("chat-1", [theirs("while away", T + 1000)]);
    window.dispatchEvent(new Event("session-updated"));
  });
  await screen.findAllByText("while away");
  expect(unread()).toBe(1);
}

const chat = <Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />;

describe("a chat left open under the lock screen", () => {
  it("the locked app coming to the front reads nothing and closes none of the chat's notices; the unlock does, once", async () => {
    await chatLeftOpen(chat);
    const open = fakeBrowser(NOTICES);
    closeNotices.mockClear();
    act(() => lockScreen.lock());
    expect(isLocked()).toBe("true");

    const before = fakeEngine.calls.length;
    away(false);
    await moment();
    expect(unread()).toBe(1);
    expect(chatClosed()).toBe(0);
    expect(open()).toEqual(expect.arrayContaining(["wake::/chat/chat-1", "wake-online::/chat/chat-1"]));
    // Another message while the locked app is in front: unread too.
    act(() => {
      addMessages("chat-1", [theirs("while locked", T + 2000)]);
      window.dispatchEvent(new Event("session-updated"));
    });
    await moment();
    expect(unread()).toBe(2);
    expect(chatClosed()).toBe(0);
    // Nothing went to the engine for it (no receipt or mark of any kind goes to the contact from here).
    expect(fakeEngine.calls.slice(before).map((call) => call.method)).toEqual([]);

    await act(async () => { expect(await lockScreen.unlock(PASSWORD)).toBe(true); });
    expect(isLocked()).toBe("false");
    await waitFor(() => expect(unread()).toBe(0));
    await waitFor(() => expect(open()).not.toContain("wake::/chat/chat-1"));
    expect(open()).not.toContain("wake-online::/chat/chat-1");
    expect(open()).toEqual(expect.arrayContaining(["wake::/chat/chat-2", "wake::/group/group-1"]));
    expect(chatClosed()).toBe(1);
  });

  it("unlocked, the window coming to the front reads it and closes its notices, as before", async () => {
    await chatLeftOpen(chat);
    const open = fakeBrowser(NOTICES);
    closeNotices.mockClear();
    away(false);
    await waitFor(() => expect(unread()).toBe(0));
    await waitFor(() => expect(open()).toEqual(["wake::/chat/chat-2", "wake::/group/group-1"]));
    expect(chatClosed()).toBe(1);
  });

  it("unlocked while the window is away: still unread until it comes to the front", async () => {
    await chatLeftOpen(chat);
    const open = fakeBrowser(NOTICES);
    act(() => lockScreen.lock());
    await act(async () => { await lockScreen.unlock(PASSWORD); });
    await moment();
    expect(unread()).toBe(1);
    expect(open()).toContain("wake::/chat/chat-1");
    away(false);
    await waitFor(() => expect(unread()).toBe(0));
  });

  it("the chat list does not mark the open chat read under the lock either", async () => {
    // The list alone, on the chat's address: it reads the chat on screen as the chat does.
    await chatLeftOpen(<UpdateProvider><Sidebar /></UpdateProvider>, "/chat/chat-1");
    act(() => lockScreen.lock());
    away(false);
    act(() => { window.dispatchEvent(new Event("session-updated")); });
    await moment();
    expect(unread()).toBe(1);
    await act(async () => { await lockScreen.unlock(PASSWORD); });
    await waitFor(() => expect(unread()).toBe(0));
  });
});

describe("a group left open under the lock screen", () => {
  it("the locked app coming to the front leaves it unread with its notice; the unlock reads it and closes it, once", async () => {
    fakeEngine.on("groupMessages", () => []);
    fakeEngine.update({ groups: [groupView({ status: "active", epoch: 1, lastMessageAt: T, lastPeerMessageAt: T })] });
    away(true);
    underLock(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, "/group/group-1");
    const open = fakeBrowser(NOTICES);
    await moment();
    expect(groupReadAt("group-1")).toBe(0);
    act(() => lockScreen.lock());
    closeNotices.mockClear();

    away(false);
    await moment();
    expect(groupReadAt("group-1")).toBe(0);
    expect(open()).toContain("wake::/group/group-1");
    expect(closeNotices.mock.calls.filter(([, path]) => path === "/group/group-1")).toHaveLength(0);

    await act(async () => { await lockScreen.unlock(PASSWORD); });
    await waitFor(() => expect(groupReadAt("group-1")).toBeGreaterThanOrEqual(T));
    await waitFor(() => expect(open()).not.toContain("wake::/group/group-1"));
    expect(closeNotices.mock.calls.filter(([, path]) => path === "/group/group-1")).toHaveLength(1);
  });

  it("unlocked, the window coming to the front reads it, as before", async () => {
    fakeEngine.on("groupMessages", () => []);
    fakeEngine.update({ groups: [groupView({ status: "active", epoch: 1, lastMessageAt: T, lastPeerMessageAt: T })] });
    away(true);
    underLock(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, "/group/group-1");
    const open = fakeBrowser(NOTICES);
    await moment();
    expect(groupReadAt("group-1")).toBe(0);
    away(false);
    await waitFor(() => expect(groupReadAt("group-1")).toBeGreaterThanOrEqual(T));
    await waitFor(() => expect(open()).not.toContain("wake::/group/group-1"));
  });
});
