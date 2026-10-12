import { act, fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { REORDER_HOLD_MS } from "../../hooks/useRowReorder";
import { chatFolders, createFolder, setChatFolder, setFolderFolded, setOthersFolded } from "../../lib/chatFolders";
import { groupChat } from "../../lib/chatMute";
import { pinnedOrder, saveSession, setSessionPinned } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.folders

/*
 * A chat or a group is put in a folder by dragging its row onto the folder, and taken out by dragging it onto the rows
 * in no folder; "Other chats" folds like a folder. happy-dom lays nothing out, so what is under the pointer is told
 * here (`over`), as `document.elementFromPoint` would tell it in a browser.
 */

const NOW = Date.now();
const key = (c: string) => c.repeat(52);
const message = (): ChatMessage => ({ id: `m-${Math.random()}`, text: "hi", sender: "peer", timestamp: NOW });
const chat = (id: string, name: string, over: Partial<ChatSession> = {}): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages: [], createdAt: NOW, nick: name, nickSource: "profile", ...over });
function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }
const list = () => renderApp(<UpdateProvider><Sidebar /><Routes><Route path="*" element={<Where />} /></Routes></UpdateProvider>);

const section = (name: string) => screen.getAllByTestId("chat-folder-section").find(s => within(s).getByTestId("chat-folder-name").textContent === name)!;
const loose = () => screen.getByTestId("chat-folder-loose");
const names = (root: HTMLElement) => within(root).queryAllByTestId("chat-row-name").map(n => n.textContent);
const rowOf = (name: string) => screen.getAllByTestId("chat-row").find(r => within(r).getByTestId("chat-row-name").textContent === name)!;
const pointer = (type: "mouse" | "touch", y: number) => ({ pointerId: 1, pointerType: type, isPrimary: true, button: 0, clientX: 40, clientY: y });
const folderOf = (chatId: string) => (JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.endsWith("chat_folders"))!) ?? "{}") as { chats?: Record<string, string> }).chats?.[chatId];

/** What the pointer is over, as the browser would say it. */
let over: Element | null = null;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  over = null;
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => over });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ top: 0, bottom: 66, left: 0, right: 300, width: 300, height: 66, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); delete (document as { elementFromPoint?: unknown }).elementFromPoint; });

/** Alice in "Agents"; "Personal" empty; Bob, Carol and the group Machines in no folder. */
function seed() {
  saveSession(chat("a", "Alice", { lastSyncAt: NOW }));
  saveSession(chat("b", "Bob", { lastSyncAt: NOW - 1000 }));
  saveSession(chat("c", "Carol", { lastSyncAt: NOW - 2000, messages: [message()] }));
  fakeEngine.update({ groups: [groupView({ id: "g", name: "Machines" })] });
  const agents = createFolder("Agents")!, personal = createFolder("Personal")!;
  setChatFolder("a", agents.id);
  return { agents, personal };
}

describe("dragging a chat onto a folder", () => {
  it("a mouse drags a chat in no folder onto a folder: the folder is marked while the row is over it, the drop puts it there, and no chat opens", async () => {
    const { agents, personal } = seed();
    list();
    const bob = rowOf("Bob");
    expect(bob).toHaveAttribute("data-drag-id", "b");
    fireEvent.pointerDown(bob, pointer("mouse", 100));
    // Over its own part of the list: nowhere else to go yet.
    over = loose();
    fireEvent.pointerMove(window, pointer("mouse", 140));
    expect(bob).toHaveAttribute("data-dragging", "true");
    expect(bob.style.transform).toBe("translateY(40px)");
    expect(section("Personal")).not.toHaveAttribute("data-drop-over");
    expect(loose()).not.toHaveAttribute("data-drop-over");

    over = within(section("Personal")).getByTestId("chat-folder-empty");
    fireEvent.pointerMove(window, pointer("mouse", 20));
    expect(section("Personal")).toHaveAttribute("data-drop-over", "true");
    expect(section("Agents")).not.toHaveAttribute("data-drop-over");
    // It follows the pointer anywhere in the list, not only among its neighbours.
    expect(bob.style.transform).toBe("translateY(-80px)");

    // Onto another folder's header on the way: that one is marked instead.
    over = within(section("Agents")).getByTestId("chat-folder-toggle");
    fireEvent.pointerMove(window, pointer("mouse", 10));
    expect(section("Agents")).toHaveAttribute("data-drop-over", "true");
    expect(section("Personal")).not.toHaveAttribute("data-drop-over");

    fireEvent.pointerUp(window, pointer("mouse", 10));
    fireEvent.click(bob);
    expect(screen.getByTestId("where")).toHaveTextContent("/");
    expect(folderOf("b")).toBe(agents.id);
    await vi.waitFor(() => expect(names(section("Agents"))).toEqual(["Alice", "Bob"]));
    expect(names(loose())).toEqual(["Machines", "Carol"]);
    expect(section("Agents")).not.toHaveAttribute("data-drop-over");
    expect(rowOf("Bob").style.transform).toBe("");
    expect(rowOf("Bob").style.pointerEvents).toBe("");
    expect(personal.id).not.toBe(agents.id);
  });

  it("dropped on the rows in no folder, a filed chat comes out; the heading shows while it is in the hand even with nothing there yet", async () => {
    const { agents } = seed();
    for (const id of ["b", "c", groupChat("g")]) setChatFolder(id, agents.id);
    list();
    expect(screen.queryByTestId("chat-folder-others")).not.toBeInTheDocument();
    const carol = rowOf("Carol");
    fireEvent.pointerDown(carol, pointer("mouse", 100));
    over = section("Agents");
    fireEvent.pointerMove(window, pointer("mouse", 160));
    expect(screen.getByTestId("chat-folder-others")).toBeInTheDocument();
    expect(loose()).not.toHaveAttribute("data-drop-over");
    over = screen.getByTestId("chat-folder-others");
    fireEvent.pointerMove(window, pointer("mouse", 400));
    expect(loose()).toHaveAttribute("data-drop-over", "true");
    fireEvent.pointerUp(window, pointer("mouse", 400));
    expect(folderOf("c")).toBeUndefined();
    await vi.waitFor(() => expect(names(loose())).toEqual(["Carol"]));
    expect(names(section("Agents"))).toEqual(["Machines", "Alice", "Bob"]);
  });

  it("a group is dragged the same way, and a folded folder takes the drop on its header", async () => {
    const { agents } = seed();
    setFolderFolded(agents.id, true);
    list();
    const group = screen.getByTestId("group-row-drag");
    expect(group).toHaveAttribute("data-drag-id", groupChat("g"));
    fireEvent.pointerDown(group, pointer("mouse", 100));
    over = within(section("Agents")).getByTestId("chat-folder-toggle");
    fireEvent.pointerMove(window, pointer("mouse", 10));
    expect(group).toHaveAttribute("data-dragging", "true");
    expect(section("Agents")).toHaveAttribute("data-drop-over", "true");
    fireEvent.pointerUp(window, pointer("mouse", 10));
    expect(folderOf(groupChat("g"))).toBe(agents.id);
    await vi.waitFor(() => expect(names(loose())).toEqual(["Bob", "Carol"]));
  });

  it("let go over its own part, over nothing, or after Escape, it stays where it was", () => {
    const { agents } = seed();
    list();
    const alice = rowOf("Alice");
    fireEvent.pointerDown(alice, pointer("mouse", 100));
    over = section("Agents");
    fireEvent.pointerMove(window, pointer("mouse", 130));
    fireEvent.pointerUp(window, pointer("mouse", 130));
    expect(folderOf("a")).toBe(agents.id);

    fireEvent.pointerDown(alice, pointer("mouse", 100));
    over = null;
    fireEvent.pointerMove(window, pointer("mouse", 900));
    fireEvent.pointerUp(window, pointer("mouse", 900));
    expect(folderOf("a")).toBe(agents.id);

    fireEvent.pointerDown(alice, pointer("mouse", 100));
    over = screen.getByTestId("chat-folder-others");
    fireEvent.pointerMove(window, pointer("mouse", 300));
    expect(loose()).toHaveAttribute("data-drop-over", "true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(loose()).not.toHaveAttribute("data-drop-over");
    fireEvent.pointerUp(window, pointer("mouse", 300));
    expect(folderOf("a")).toBe(agents.id);
    expect(alice.style.transform).toBe("");
  });

  it("a finger holds the row first; a swipe before that scrolls the list and moves nothing", async () => {
    const { personal } = seed();
    list();
    const bob = rowOf("Bob");
    fireEvent.pointerDown(bob, pointer("touch", 100));
    over = section("Personal");
    fireEvent.pointerMove(window, pointer("touch", 40));
    fireEvent.pointerUp(window, pointer("touch", 40));
    expect(bob).not.toHaveAttribute("data-dragging");
    expect(folderOf("b")).toBeUndefined();

    fireEvent.pointerDown(bob, pointer("touch", 100));
    await act(() => vi.advanceTimersByTimeAsync(REORDER_HOLD_MS + 10));
    expect(bob).toHaveAttribute("data-dragging", "true");
    fireEvent.pointerMove(window, pointer("touch", 30));
    expect(section("Personal")).toHaveAttribute("data-drop-over", "true");
    fireEvent.pointerUp(window, pointer("touch", 30));
    expect(folderOf("b")).toBe(personal.id);
  });

  it("a pinned chat is still put in order among the pinned ones over its own rows, and goes into a folder when dropped on one", async () => {
    const { agents } = seed();
    setSessionPinned("c", true);
    setSessionPinned("b", true);
    list();
    expect(pinnedOrder()).toEqual(["b", "c"]);
    const bob = rowOf("Bob");
    expect(bob).toHaveAttribute("data-reorder-id", "b");
    fireEvent.pointerDown(bob, pointer("mouse", 100));
    over = section("Agents");
    fireEvent.pointerMove(window, pointer("mouse", 10));
    expect(section("Agents")).toHaveAttribute("data-drop-over", "true");
    expect(screen.queryByTestId("chat-row-drop")).not.toBeInTheDocument();
    fireEvent.pointerUp(window, pointer("mouse", 10));
    expect(folderOf("b")).toBe(agents.id);
    expect(pinnedOrder()).toEqual(["b", "c"]);
  });

  it("with no folder, or in a search, no row is dragged anywhere", async () => {
    saveSession(chat("a", "Alice", { lastSyncAt: NOW }));
    saveSession(chat("b", "Bob", { lastSyncAt: NOW - 1000 }));
    const { user, unmount } = list();
    expect(rowOf("Alice")).not.toHaveAttribute("data-drag-id");
    expect(loose()).not.toHaveAttribute("data-folder-drop");
    unmount();
    createFolder("Agents");
    list();
    expect(rowOf("Alice")).toHaveAttribute("data-drag-id", "a");
    expect(loose()).toHaveAttribute("data-folder-drop", "");
    await user.type(screen.getByPlaceholderText("Search chats..."), "a");
    expect(rowOf("Alice")).not.toHaveAttribute("data-drag-id");
  });
});

describe("Other chats folds like a folder", () => {
  const toggle = () => screen.getByTestId("chat-folder-others-toggle");

  it("its heading folds the rows in no folder to a count of what is unread there, unfolds them again, and remembers it", async () => {
    seed();
    const { user, unmount } = list();
    expect(toggle()).toHaveTextContent("Other chats");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(toggle()).toHaveAttribute("aria-controls", "chat-folder-others-rows");
    expect(screen.queryByTestId("chat-folder-others-unread")).not.toBeInTheDocument();
    expect(names(loose())).toEqual(["Machines", "Bob", "Carol"]);

    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).not.toHaveAttribute("aria-controls");
    expect(names(loose())).toEqual([]);
    // Carol's one message, which its row no longer shows.
    const unread = screen.getByTestId("chat-folder-others-unread");
    expect(unread).toHaveTextContent("1");
    expect(unread).toHaveAccessibleName("1 unread in Other chats");
    // The folders are as they were.
    expect(names(section("Agents"))).toEqual(["Alice"]);
    unmount();

    list();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(names(loose())).toEqual([]);
    await user.click(toggle());
    expect(names(loose())).toEqual(["Machines", "Bob", "Carol"]);
    expect(screen.queryByTestId("chat-folder-others-unread")).not.toBeInTheDocument();
  });

  it("folded, it still takes a row dropped on it; a search shows every chat; and with the last folder gone the list is whole again", async () => {
    const { agents, personal } = seed();
    setOthersFolded(true);
    const { user } = list();
    const alice = rowOf("Alice");
    fireEvent.pointerDown(alice, pointer("mouse", 100));
    over = toggle();
    fireEvent.pointerMove(window, pointer("mouse", 300));
    expect(loose()).toHaveAttribute("data-drop-over", "true");
    fireEvent.pointerUp(window, pointer("mouse", 300));
    expect(folderOf("a")).toBeUndefined();

    await act(() => vi.advanceTimersByTimeAsync(150));
    await user.type(screen.getByPlaceholderText("Search chats..."), "o");
    expect(names(screen.getByTestId("sidebar"))).toEqual(expect.arrayContaining(["Bob", "Carol"]));
    await user.clear(screen.getByPlaceholderText("Search chats..."));
    expect(names(loose())).toEqual([]);

    // No folder, no heading: nothing stays folded away with nothing to unfold it.
    const { deleteFolder } = await import("../../lib/chatFolders");
    act(() => { deleteFolder(agents.id); deleteFolder(personal.id); });
    expect(chatFolders()).toEqual([]);
    expect(screen.queryByTestId("chat-folder-others")).not.toBeInTheDocument();
    expect(names(loose())).toEqual(["Machines", "Alice", "Bob", "Carol"]);
  });
});
