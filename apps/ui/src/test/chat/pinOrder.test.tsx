import "fake-indexeddb/auto";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { ANNOUNCE_CLEAR_MS } from "../../components/chat/MessageAnnouncer";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { dropIndex, REORDER_HOLD_MS } from "../../hooks/useRowReorder";
import { createFolder, sectionOrder, setChatFolder, setSectionOrder } from "../../lib/chatFolders";
import { pinnedOrder, saveSession, setSessionPinned } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Chat } from "../../pages/Chat";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.list.pin-order, chats.folders

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const key = (c: string) => c.repeat(52);
const NAMES: Record<string, string> = { a: "Ana", b: "Ben", c: "Cy", d: "Dee" };
const chat = (id: string, at: number): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages: [], createdAt: at, nick: NAMES[id], nickSource: "profile" });
/** Ana, Ben and Cy pinned in that order from the top; Dee, the latest, is not pinned. */
function chats() {
  ["c", "b", "a", "d"].forEach((id, i) => saveSession(chat(id, 1_700_000_000_000 + i)));
  for (const id of ["c", "b", "a"]) setSessionPinned(id, true);
}
const names = () => screen.getAllByTestId("chat-row-name").map(n => n.textContent);
const rowOf = (name: string) => screen.getAllByTestId("chat-row").find(r => within(r).getByTestId("chat-row-name").textContent === name)!;

describe("a pinned chat's place, from the keyboard in the list", () => {
  function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }
  const list = (language?: "pt") => renderApp(<UpdateProvider><Sidebar /><Routes><Route path="*" element={<Where />} /></Routes></UpdateProvider>, language ? { language } : undefined);
  const opener = (name: string) => within(rowOf(name)).getByTestId("chat-row-open");

  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it("the chat's ⋮ has no Move up or Move down: the place is the list's", async () => {
    chats();
    const utils = renderApp(<Chat sessionId="a" visible onCallChange={() => {}} callLayer={null} />);
    utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    utils.engine.update({ links: [linkView({ peerPubKeyZ32: key("a"), profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    await utils.user.click(screen.getByTestId("chat-options"));
    const menu = within(await screen.findByTestId("chat-options-menu"));
    expect(menu.getByTestId("chat-pin-toggle")).toHaveTextContent("Unpin chat");
    for (const id of ["chat-pin-up", "chat-pin-down"]) expect(menu.queryByTestId(id), id).not.toBeInTheDocument();
  });

  it("Alt+↓ and Alt+↑ on a focused pinned row move it one place, keep the focus on it, say the new place, and stop at the ends", async () => {
    chats();
    const { user } = list();
    expect(names()).toEqual(["Ana", "Ben", "Cy", "Dee"]);
    expect(opener("Ana")).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
    opener("Ana").focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(pinnedOrder()).toEqual(["b", "a", "c"]);
    await vi.waitFor(() => expect(names()).toEqual(["Ben", "Ana", "Cy", "Dee"]));
    expect(opener("Ana")).toHaveFocus();
    const said = screen.getByTestId("chat-pin-announcement");
    expect(said).toHaveAttribute("aria-live", "polite");
    expect(said).toHaveTextContent("Moved to place 2 of 3 pinned chats");
    await act(() => vi.advanceTimersByTimeAsync(ANNOUNCE_CLEAR_MS + 10));
    expect(said).toBeEmptyDOMElement();

    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await vi.waitFor(() => expect(names()).toEqual(["Ben", "Cy", "Ana", "Dee"]));
    expect(opener("Ana")).toHaveFocus();
    expect(said).toHaveTextContent("Moved to place 3 of 3 pinned chats");
    // The last pinned chat goes no further: never among the others.
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(pinnedOrder()).toEqual(["b", "c", "a"]);
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(pinnedOrder()).toEqual(["b", "a", "c"]);
    // Nothing opened on the way.
    expect(screen.getByTestId("where")).toHaveTextContent("/");
  });

  it("an arrow alone, or a chat that is not pinned, moves nothing", async () => {
    chats();
    const { user } = list();
    opener("Ana").focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Control>}{ArrowDown}{/Control}");
    expect(pinnedOrder()).toEqual(["a", "b", "c"]);
    expect(opener("Dee")).not.toHaveAttribute("aria-keyshortcuts");
    opener("Dee").focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(pinnedOrder()).toEqual(["a", "b", "c"]);
    expect(names()).toEqual(["Ana", "Ben", "Cy", "Dee"]);
  });

  it("with a folder, moves a row among its part's rows, pinned or not, and says its place among them", async () => {
    chats();
    const agents = createFolder("Agents")!;
    setChatFolder("a", agents.id);
    const { user } = list();
    expect(names()).toEqual(["Ana", "Ben", "Cy", "Dee"]);
    opener("Dee").focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await vi.waitFor(() => expect(names()).toEqual(["Ana", "Ben", "Dee", "Cy"]));
    expect(sectionOrder(undefined)).toEqual(["b", "d", "c"]);
    expect(pinnedOrder()).toEqual(["a", "b", "c"]);
    expect(opener("Dee")).toHaveFocus();
    expect(screen.getByTestId("chat-pin-announcement")).toHaveTextContent("Moved to place 2 of 3");
  });

  it("says it in the app's language", async () => {
    chats();
    const { user } = list("pt");
    opener("Ana").focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(screen.getByTestId("chat-pin-announcement")).toHaveTextContent("Movida para a posição 2 de 3 conversas fixadas");
  });
});

describe("where a dragged row lands", () => {
  const rows = [0, 66, 132].map(top => ({ top, height: 66 }));
  it("is how many of the other rows have their middle above the dragged row's", () => {
    expect(dropIndex(rows, 0, 33)).toBe(0);
    expect(dropIndex(rows, 0, 98)).toBe(0);
    expect(dropIndex(rows, 0, 100)).toBe(1);
    expect(dropIndex(rows, 0, 170)).toBe(2);
    // No further than the last row (or the first): at its middle, it has its place.
    expect(dropIndex(rows, 0, 165)).toBe(2);
    expect(dropIndex(rows, 2, 33)).toBe(0);
    expect(dropIndex(rows, 2, 98)).toBe(1);
    expect(dropIndex(rows, 2, 10)).toBe(0);
    expect(dropIndex(rows, 1, 99)).toBe(1);
  });
});

describe("dragging a pinned chat in the list", () => {
  const ROW = 66;
  function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }
  const list = () => renderApp(<UpdateProvider><Sidebar /><Routes><Route path="*" element={<Where />} /></Routes></UpdateProvider>);
  const pointer = (type: "mouse" | "touch", y: number) => ({ pointerId: 1, pointerType: type, isPrimary: true, button: 0, clientX: 40, clientY: y });
  const middle = (name: string) => names().indexOf(name) * ROW + ROW / 2;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // happy-dom lays nothing out: each row is given its place in the list, 66 px a row.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const index = this.dataset.testid === "chat-row" ? screen.getAllByTestId("chat-row").indexOf(this) : 0;
      return { top: index * ROW, bottom: (index + 1) * ROW, left: 0, right: 300, width: 300, height: ROW, x: 0, y: index * ROW, toJSON: () => ({}) } as DOMRect;
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("a mouse drags it to another place among the pinned chats: a line shows where, the drop keeps it, and no chat opens", async () => {
    chats();
    list();
    expect(names()).toEqual(["Ana", "Ben", "Cy", "Dee"]);
    const ana = rowOf("Ana");
    expect(ana).toHaveAttribute("data-reorder-id", "a");
    fireEvent.pointerDown(ana, pointer("mouse", middle("Ana")));
    // A few pixels are a click still.
    fireEvent.pointerMove(window, pointer("mouse", middle("Ana") + 3));
    expect(ana).not.toHaveAttribute("data-dragging");
    fireEvent.pointerMove(window, pointer("mouse", middle("Ana") + 70));
    expect(ana).toHaveAttribute("data-dragging", "true");
    expect(ana.style.transform).toBe("translateY(70px)");
    // Past Ben's middle: it would land between Ben and Cy.
    expect(within(rowOf("Cy")).getByTestId("chat-row-drop")).toHaveAttribute("data-edge", "before");
    expect(screen.getAllByTestId("chat-row-drop")).toHaveLength(1);
    // Far below the list: no further than the last pinned chat, and never among the others.
    fireEvent.pointerMove(window, pointer("mouse", 900));
    expect(ana.style.transform).toBe(`translateY(${2 * ROW}px)`);
    expect(within(rowOf("Cy")).getByTestId("chat-row-drop")).toHaveAttribute("data-edge", "after");
    expect(within(rowOf("Dee")).queryByTestId("chat-row-drop")).not.toBeInTheDocument();
    fireEvent.pointerUp(window, pointer("mouse", 900));
    // The click the drop ends with opens nothing.
    fireEvent.click(ana);
    expect(screen.getByTestId("where")).toHaveTextContent("/");
    expect(pinnedOrder()).toEqual(["b", "c", "a"]);
    await vi.waitFor(() => expect(names()).toEqual(["Ben", "Cy", "Ana", "Dee"]));
    expect(rowOf("Ana")).not.toHaveAttribute("data-dragging");
    expect(rowOf("Ana").style.transform).toBe("");
    expect(screen.queryByTestId("chat-row-drop")).not.toBeInTheDocument();
    // A click after that is a click again.
    await act(() => vi.advanceTimersByTimeAsync(150));
    fireEvent.click(rowOf("Ben"));
    expect(screen.getByTestId("where")).toHaveTextContent("/chat/b");
  });

  it("with a folder in the list, a part keeps the order the person drags its rows into, pinned or not, and the pins are left as they were", async () => {
    chats();
    const agents = createFolder("Agents")!;
    setChatFolder("a", agents.id);
    list();
    // Ana is alone in the folder, first in the list; Ben, Cy (pinned) and Dee (not) are in no folder, the latest first.
    expect(names()).toEqual(["Ana", "Ben", "Cy", "Dee"]);
    expect(rowOf("Ana")).not.toHaveAttribute("data-reorder-id");
    for (const name of ["Ben", "Cy", "Dee"]) expect(rowOf(name)).toHaveAttribute("data-reorder-id");
    // Dee, the last row and not pinned, goes to the top of its part.
    const dee = rowOf("Dee");
    fireEvent.pointerDown(dee, pointer("mouse", middle("Dee")));
    fireEvent.pointerMove(window, pointer("mouse", 0));
    expect(dee.style.transform).toBe(`translateY(${-2 * ROW}px)`);
    expect(within(rowOf("Ben")).getByTestId("chat-row-drop")).toHaveAttribute("data-edge", "before");
    fireEvent.pointerUp(window, pointer("mouse", 0));
    await vi.waitFor(() => expect(names()).toEqual(["Ana", "Dee", "Ben", "Cy"]));
    expect(sectionOrder(undefined)).toEqual(["d", "b", "c"]);
    expect(sectionOrder(agents.id)).toBeUndefined();
    expect(pinnedOrder()).toEqual(["a", "b", "c"]);
  });

  it("the order a part was given is kept across a restart, a row that comes in later goes on top, and the folder's menu gives the latest-first order back", async () => {
    chats();
    const agents = createFolder("Agents")!;
    for (const id of ["a", "b", "c"]) setChatFolder(id, agents.id);
    setSectionOrder(agents.id, ["c", "a", "b"]);
    const { user, unmount } = list();
    expect(names()).toEqual(["Cy", "Ana", "Ben", "Dee"]);
    unmount();
    // Dee comes into the folder: not in the order yet, so on top of the rows the person arranged.
    setChatFolder("d", agents.id);
    list();
    expect(names()).toEqual(["Dee", "Cy", "Ana", "Ben"]);
    await user.click(screen.getByTestId("chat-folder-options"));
    await user.click(await screen.findByTestId("chat-folder-by-latest"));
    expect(sectionOrder(agents.id)).toBeUndefined();
    // Pinned first, in the pins' order, then the latest: as before the person arranged anything.
    await vi.waitFor(() => expect(names()).toEqual(["Ana", "Ben", "Cy", "Dee"]));
    await user.click(screen.getByTestId("chat-folder-options"));
    expect(screen.queryByTestId("chat-folder-by-latest")).not.toBeInTheDocument();
  });

  it("drags up too, and back where it was changes nothing", async () => {
    chats();
    list();
    const cy = rowOf("Cy");
    fireEvent.pointerDown(cy, pointer("mouse", middle("Cy")));
    fireEvent.pointerMove(window, pointer("mouse", middle("Cy") - 300));
    expect(cy.style.transform).toBe(`translateY(${-2 * ROW}px)`);
    expect(within(rowOf("Ana")).getByTestId("chat-row-drop")).toHaveAttribute("data-edge", "before");
    fireEvent.pointerUp(window, pointer("mouse", 0));
    expect(pinnedOrder()).toEqual(["c", "a", "b"]);
    await vi.waitFor(() => expect(names()).toEqual(["Cy", "Ana", "Ben", "Dee"]));

    await act(() => vi.advanceTimersByTimeAsync(150));
    const ben = rowOf("Ben");
    fireEvent.pointerDown(ben, pointer("mouse", middle("Ben")));
    fireEvent.pointerMove(window, pointer("mouse", middle("Ben") - 20));
    expect(ben).toHaveAttribute("data-dragging", "true");
    expect(screen.queryByTestId("chat-row-drop")).not.toBeInTheDocument();
    fireEvent.pointerUp(window, pointer("mouse", middle("Ben") - 20));
    expect(pinnedOrder()).toEqual(["c", "a", "b"]);
  });

  it("Escape puts the row back", () => {
    chats();
    list();
    const ana = rowOf("Ana");
    fireEvent.pointerDown(ana, pointer("mouse", middle("Ana")));
    fireEvent.pointerMove(window, pointer("mouse", middle("Ana") + 100));
    expect(ana).toHaveAttribute("data-dragging", "true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(ana).not.toHaveAttribute("data-dragging");
    expect(ana.style.transform).toBe("");
    fireEvent.pointerUp(window, pointer("mouse", middle("Ana") + 100));
    expect(pinnedOrder()).toEqual(["a", "b", "c"]);
  });

  it("a finger holds the row first: a swipe before that scrolls the list, a tap opens the chat", async () => {
    chats();
    list();
    const ana = rowOf("Ana");
    // A swipe: the finger moves at once.
    fireEvent.pointerDown(ana, pointer("touch", middle("Ana")));
    fireEvent.pointerMove(window, pointer("touch", middle("Ana") + 30));
    await act(() => vi.advanceTimersByTimeAsync(REORDER_HOLD_MS + 50));
    fireEvent.pointerMove(window, pointer("touch", middle("Ana") + 100));
    expect(ana).not.toHaveAttribute("data-dragging");
    fireEvent.pointerUp(window, pointer("touch", middle("Ana") + 100));
    expect(pinnedOrder()).toEqual(["a", "b", "c"]);

    // A scroll the browser took over (pointercancel) is no hold either.
    fireEvent.pointerDown(ana, pointer("touch", middle("Ana")));
    fireEvent.pointerCancel(window, pointer("touch", middle("Ana")));
    await act(() => vi.advanceTimersByTimeAsync(REORDER_HOLD_MS + 50));
    expect(ana).not.toHaveAttribute("data-dragging");

    // Held still, then moved: the row is in the hand, and the list no longer scrolls under the finger.
    fireEvent.pointerDown(ana, pointer("touch", middle("Ana")));
    await act(() => vi.advanceTimersByTimeAsync(REORDER_HOLD_MS + 50));
    expect(ana).toHaveAttribute("data-dragging", "true");
    const scroll = new Event("touchmove", { bubbles: true, cancelable: true });
    ana.dispatchEvent(scroll);
    expect(scroll.defaultPrevented).toBe(true);
    fireEvent.pointerMove(window, pointer("touch", middle("Ana") + 70));
    expect(within(rowOf("Cy")).getByTestId("chat-row-drop")).toHaveAttribute("data-edge", "before");
    fireEvent.pointerUp(window, pointer("touch", middle("Ana") + 70));
    expect(pinnedOrder()).toEqual(["b", "a", "c"]);
    await vi.waitFor(() => expect(names()).toEqual(["Ben", "Ana", "Cy", "Dee"]));

    // A tap (down and up, no hold) opens the chat as before.
    await act(() => vi.advanceTimersByTimeAsync(150));
    const cy = rowOf("Cy");
    fireEvent.pointerDown(cy, pointer("touch", middle("Cy")));
    fireEvent.pointerUp(window, pointer("touch", middle("Cy")));
    fireEvent.click(cy);
    expect(screen.getByTestId("where")).toHaveTextContent("/chat/c");
    // So does a slow one: held until the row is in the hand, and let go where it was.
    const ben = rowOf("Ben");
    fireEvent.pointerDown(ben, pointer("touch", middle("Ben")));
    await act(() => vi.advanceTimersByTimeAsync(REORDER_HOLD_MS + 50));
    expect(ben).toHaveAttribute("data-dragging", "true");
    fireEvent.pointerUp(window, pointer("touch", middle("Ben")));
    expect(ben).not.toHaveAttribute("data-dragging");
    fireEvent.click(ben);
    expect(screen.getByTestId("where")).toHaveTextContent("/chat/b");
    expect(pinnedOrder()).toEqual(["b", "a", "c"]);
  });

  it("leaves the other rows alone: a chat that is not pinned, a row's own buttons, the only pinned chat, a search", async () => {
    chats();
    const { user, unmount } = list();
    const dee = rowOf("Dee");
    expect(dee).not.toHaveAttribute("data-reorder-id");
    fireEvent.pointerDown(dee, pointer("mouse", middle("Dee")));
    fireEvent.pointerMove(window, pointer("mouse", 10));
    fireEvent.pointerUp(window, pointer("mouse", 10));
    expect(dee).not.toHaveAttribute("data-dragging");
    expect(names()).toEqual(["Ana", "Ben", "Cy", "Dee"]);

    // A press on the row's pin button is that button's.
    const unpin = within(rowOf("Ben")).getByTestId("chat-row-pin");
    fireEvent.pointerDown(unpin, pointer("mouse", middle("Ben")));
    fireEvent.pointerMove(window, pointer("mouse", middle("Ben") + 100));
    expect(rowOf("Ben")).not.toHaveAttribute("data-dragging");
    fireEvent.pointerUp(window, pointer("mouse", middle("Ben") + 100));

    // A search shows some of the pinned chats: their places are not the list's.
    await user.type(screen.getByPlaceholderText("Search chats..."), "a");
    expect(rowOf("Ana")).not.toHaveAttribute("data-reorder-id");
    unmount();

    setSessionPinned("b", false);
    setSessionPinned("c", false);
    list();
    expect(rowOf("Ana")).not.toHaveAttribute("data-reorder-id");
  });
});
