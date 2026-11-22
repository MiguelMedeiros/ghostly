import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { forgetGroupLocal } from "../../lib/groups";
import { showPrivateNotification } from "../../lib/notifications";
import { loadSession, saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Chat } from "../../pages/Chat";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.attention.notifications, chats.list.delete

/*
 * Chrome keeps the extension's notifications in the system's list past the page that showed them, and the worker shows
 * some with no tab open: which chat each opens is kept in session storage (`notice:<id>`). A chat deleted, or a group
 * left, takes its own away, as a deleted profile's go: a click on one opened the gone chat's address, which lands on the
 * chat list with nothing said.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const PEER = "peer".padEnd(52, "p");
const chat = (id: string, nick: string): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: id.padEnd(52, "k"), encKeyB64: "enc", nick, messages: [], createdAt: Date.now() });

/** The extension's page, with notifications allowed; `session` is its session storage. */
function extension() {
  const session = new Map<string, string>();
  const notifications = { create: vi.fn(async (id: string) => id), clear: vi.fn(async (_id: string) => true) };
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { id: "ext", getURL: (path: string) => `chrome-extension://ext/${path}` },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
    storage: { session: {
      get: async () => Object.fromEntries(session),
      set: async (items: Record<string, string>) => { for (const [k, v] of Object.entries(items)) session.set(k, v); },
      remove: async (key: string) => { session.delete(key); },
    } },
    notifications,
  };
  return { session, notifications, cleared: () => notifications.clear.mock.calls.map(([id]) => id).sort() };
}
afterEach(() => { delete (globalThis as { chrome?: unknown }).chrome; });

describe("the extension's notifications of a chat that is gone", () => {
  it("Delete chat in the chat: its notifications go, the worker's and this page's; another chat's stay", async () => {
    saveSession({ ...chat("chat-a", "Ana"), peerPubKeyB64: PEER });
    const { user, engine } = renderApp(<Chat sessionId="chat-a" visible onCallChange={() => {}} callLayer={null} />);
    engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    await user.click(await screen.findByTestId("chat-options"));
    await user.click(within(screen.getByTestId("chat-options-menu")).getByText("Delete chat"));

    const { session, notifications, cleared } = extension();
    session.set("notice:worker-a", "chat-a");
    session.set("notice:worker-b", "chat-b");
    await showPrivateNotification("message:chat-a:1", "New message", "chat-a", true);
    const shown = notifications.create.mock.calls[0]![0];

    await user.click(within(screen.getByRole("dialog", { name: "Delete chat?" })).getByRole("button", { name: "Delete chat" }));
    expect(loadSession("chat-a")).toBeNull();
    await waitFor(() => expect([...session.keys()]).toEqual(["notice:worker-b"]));
    expect(cleared()).toEqual([shown, "worker-a"].sort());
  });

  it("Delete chat from the chat list: its notifications go", async () => {
    saveSession(chat("a", "Ana"));
    saveSession(chat("b", "Bo"));
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const row = screen.getAllByTestId("chat-row").find(r => within(r).getByTestId("chat-row-name").textContent === "Ana")!;
    await user.click(within(row).getByRole("button", { name: "Delete chat" }));

    const { session, cleared } = extension();
    session.set("notice:worker-a", "a");
    session.set("notice:worker-b", "b");
    await user.click(within(screen.getByRole("dialog", { name: "Delete chat?" })).getByRole("button", { name: "Delete chat" }));
    expect(loadSession("a")).toBeNull();
    await waitFor(() => expect([...session.keys()]).toEqual(["notice:worker-b"]));
    expect(cleared()).toEqual(["worker-a"]);
  });

  it("a group left or deleted here: its notifications go, another group's stay", async () => {
    const { session, cleared } = extension();
    session.set("notice:worker-1", "group:g1");
    session.set("notice:worker-2", "group:g2");
    forgetGroupLocal("g1");
    await waitFor(() => expect([...session.keys()]).toEqual(["notice:worker-2"]));
    expect(cleared()).toEqual(["worker-1"]);
  });
});
