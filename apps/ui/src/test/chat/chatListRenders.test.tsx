import { act, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { markGroupRead } from "../../lib/groups";
import { saveSession } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.list.rows

/*
 * The engine sends a new state every few hundred milliseconds while nothing happens (its links poll and publish), and
 * the list reads the stored chats again every few seconds: each a new copy with the same content. A row is drawn again
 * only when what it shows changes. Counted by what each row's drawing calls: a chat's preview line, a group's unread.
 */

const counts = vi.hoisted(() => ({ preview: 0, groupUnread: 0, railPicture: 0 }));

vi.mock("../../components/Avatar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/Avatar")>();
  return { ...actual, PeerAvatar: (props: Parameters<typeof actual.PeerAvatar>[0]) => {
    if (props.testId === "chat-rail-avatar") counts.railPicture++;
    return actual.PeerAvatar(props);
  } };
});

vi.mock("../../lib/chatList", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/chatList")>();
  return { ...actual, previewText: (...args: Parameters<typeof actual.previewText>) => { counts.preview++; return actual.previewText(...args); } };
});

vi.mock("../../lib/groups", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/groups")>();
  return { ...actual, groupUnreadAt: (...args: Parameters<typeof actual.groupUnreadAt>) => { counts.groupUnread++; return actual.groupUnreadAt(...args); } };
});

const NOW = Date.now();
const key = (c: string) => c.repeat(52);
const message = (text: string): ChatMessage => ({ id: `m-${text}`, text, sender: "peer", timestamp: NOW - 60_000 });
const chat = (id: string, nick: string, text: string): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages: [message(text)], createdAt: NOW, lastSyncAt: NOW - 60_000, nick });
const groups = [
  groupView({ id: "g-1", name: "Climbing", status: "active", lastMessageAt: NOW - 60_000 }),
  groupView({ id: "g-2", name: "Chess", status: "active", lastMessageAt: NOW - 60_000 }),
];
const links = [linkView({ id: "link-a", peerPubKeyZ32: key("a") }), linkView({ id: "link-b", peerPubKeyZ32: key("b") })];

/** The engine's state again, as a copy (the worker's states come through postMessage). */
const sameStateAgain = () => act(() => { fakeEngine.setState(structuredClone(fakeEngine.state)); });
const reset = () => { counts.preview = 0; counts.groupUnread = 0; counts.railPicture = 0; };

describe("the chat list's rows on a state that changes nothing they show", () => {
  beforeEach(() => {
    saveSession(chat("a", "Alice", "see you at eight"));
    saveSession(chat("b", "Bob", "on my way"));
    fakeEngine.update({ links, groups });
  });

  it("are not drawn again, by the engine's next state or the chats read again from storage", () => {
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    expect(screen.getAllByTestId("chat-row")).toHaveLength(2);
    expect(screen.getAllByTestId("group-row")).toHaveLength(2);
    expect(counts.preview).toBeGreaterThan(0);
    expect(counts.groupUnread).toBeGreaterThan(0);
    reset();
    sameStateAgain();
    sameStateAgain();
    act(() => { window.dispatchEvent(new Event("session-updated")); });
    expect(counts).toEqual({ preview: 0, groupUnread: 0, railPicture: 0 });
  });

  it("but the one row whose content changed is", () => {
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    reset();
    act(() => { fakeEngine.update({ groups: [{ ...groups[0], lastMessageAt: NOW }, groups[1]] }); });
    expect(counts).toEqual({ preview: 0, groupUnread: 1, railPicture: 0 });
    saveSession(chat("b", "Bob", "here"));
    act(() => { window.dispatchEvent(new Event("session-updated")); });
    expect(counts.preview).toBe(1);
    const bob = screen.getAllByTestId("chat-row").find(r => within(r).getByTestId("chat-row-name").textContent === "Bob")!;
    expect(bob).toHaveTextContent("here");
  });
});

describe("the rail's places on a state that changes nothing they show", () => {
  beforeEach(() => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ chatListCollapsed: true }));
    saveSession(chat("a", "Alice", "see you at eight"));
    saveSession(chat("b", "Bob", "on my way"));
    fakeEngine.update({ links, groups });
  });

  it("are not drawn again, by the engine's next state or the chats read again from storage", () => {
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    expect(screen.getAllByTestId("chat-rail-chat")).toHaveLength(2);
    expect(counts.groupUnread).toBeGreaterThan(0);
    expect(counts.railPicture).toBeGreaterThan(0);
    reset();
    sameStateAgain();
    sameStateAgain();
    act(() => { window.dispatchEvent(new Event("session-updated")); });
    expect(counts).toEqual({ preview: 0, groupUnread: 0, railPicture: 0 });
  });

  it("but the one place whose content changed is", () => {
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    reset();
    act(() => { fakeEngine.update({ groups: [{ ...groups[0], lastMessageAt: NOW }, groups[1]] }); });
    expect(counts).toEqual({ preview: 0, groupUnread: 1, railPicture: 0 });
    reset();
    saveSession({ ...chat("b", "Bob", "here"), messages: [message("on my way"), message("here")] });
    act(() => { window.dispatchEvent(new Event("session-updated")); });
    expect(counts).toEqual({ preview: 0, groupUnread: 0, railPicture: 1 });
    expect(screen.getAllByTestId("chat-rail-chat").find(place => place.getAttribute("data-chat") === "b")).toHaveAccessibleName("Bob, 2 unread messages");
  });

  it("a group read here, with nothing else about it changed, loses its mark", () => {
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const place = () => screen.getAllByTestId("chat-rail-group").find(g => g.getAttribute("data-chat") === "group:g-1")!;
    expect(place()).toHaveAccessibleName("Climbing, unread messages");
    markGroupRead("g-1", NOW);
    sameStateAgain();
    expect(place()).toHaveAccessibleName("Climbing");
  });

  it("opens the chat of the latest draw from a place that was not drawn again", async () => {
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    sameStateAgain();
    await user.click(screen.getAllByTestId("chat-rail-chat").find(place => place.getAttribute("data-chat") === "a")!);
    expect(screen.getAllByTestId("chat-rail-chat").find(place => place.getAttribute("data-chat") === "a")).toHaveAttribute("aria-current", "page");
  });
});
