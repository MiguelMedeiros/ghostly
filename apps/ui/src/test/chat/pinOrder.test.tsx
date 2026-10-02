import "fake-indexeddb/auto";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { ANNOUNCE_CLEAR_MS } from "../../components/chat/MessageAnnouncer";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { dropIndex, REORDER_HOLD_MS } from "../../hooks/useRowReorder";
import { pinnedOrder, saveSession, setSessionPinned } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Chat } from "../../pages/Chat";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.list.pin-order

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

describe("a pinned chat's place, from the chat's ⋮", () => {
  function openChat(id: string) {
    const utils = renderApp(<Chat sessionId={id} visible onCallChange={() => {}} callLayer={null} />);
    utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined);
    utils.engine.update({ links: [linkView({ peerPubKeyZ32: key(id), profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    return utils;
  }
  const menu = async (user: ReturnType<typeof renderApp>["user"]) => {
    await user.click(screen.getByTestId("chat-options"));
    return within(await screen.findByTestId("chat-options-menu"));
  };

  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it("moves it down and up one place, says the new place to a screen reader, and stops at the ends", async () => {
    chats();
    expect(pinnedOrder()).toEqual(["a", "b", "c"]);
    const { user } = openChat("a");
    let rows = await menu(user);
    const up = rows.getByTestId("chat-pin-up");
    expect(up).toHaveTextContent("Move up");
    expect(up).toBeDisabled();
    expect(up).toHaveAttribute("title", "Already first");
    expect(rows.getByTestId("chat-pin-down")).toBeEnabled();
    // Right under Unpin: the place is the pin's.
    const items = [...screen.getByTestId("chat-options-menu").querySelectorAll("[data-menu-item]")].map(i => i.textContent);
    expect(items.slice(0, 3)).toEqual(["Unpin chat", "Move up", "Move down"]);

    await user.click(rows.getByTestId("chat-pin-down"));
    expect(pinnedOrder()).toEqual(["b", "a", "c"]);
    expect(screen.queryByTestId("chat-options-menu")).not.toBeInTheDocument();
    const said = screen.getByTestId("chat-pin-announcement");
    expect(said).toHaveAttribute("aria-live", "polite");
    expect(said).toHaveTextContent("Moved to place 2 of 3 pinned chats");
    await act(() => vi.advanceTimersByTimeAsync(ANNOUNCE_CLEAR_MS + 10));
    expect(said).toBeEmptyDOMElement();

    rows = await menu(user);
    expect(rows.getByTestId("chat-pin-up")).toBeEnabled();
    await user.click(rows.getByTestId("chat-pin-down"));
    expect(pinnedOrder()).toEqual(["b", "c", "a"]);
    expect(said).toHaveTextContent("Moved to place 3 of 3 pinned chats");

    rows = await menu(user);
    const down = rows.getByTestId("chat-pin-down");
    expect(down).toBeDisabled();
    expect(down).toHaveAttribute("title", "Already last");
    await user.click(rows.getByTestId("chat-pin-up"));
    expect(pinnedOrder()).toEqual(["b", "a", "c"]);
  });

  it("moves with the keys: the rows are the menu's, a disabled one is passed over", async () => {
    chats();
    const { user } = openChat("a");
    const rows = await menu(user);
    rows.getByText("Unpin chat").closest("button")!.focus();
    await user.keyboard("{ArrowDown}");
    expect(rows.getByTestId("chat-pin-down")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(pinnedOrder()).toEqual(["b", "a", "c"]);
  });

  it("offers no move to a chat that is not pinned, nor to the only pinned one", async () => {
    chats();
    const { user, unmount } = openChat("d");
    let rows = await menu(user);
    expect(rows.getByText("Pin chat")).toBeInTheDocument();
    expect(rows.queryByTestId("chat-pin-up")).not.toBeInTheDocument();
    unmount();
    setSessionPinned("b", false);
    setSessionPinned("c", false);
    const again = openChat("a");
    rows = await menu(again.user);
    expect(rows.getByText("Unpin chat")).toBeInTheDocument();
    expect(rows.queryByTestId("chat-pin-down")).not.toBeInTheDocument();
  });

  it("says it in the app's language", async () => {
    chats();
    const utils = renderApp(<Chat sessionId="a" visible onCallChange={() => {}} callLayer={null} />, { language: "pt" });
    utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined);
    utils.engine.update({ links: [linkView({ peerPubKeyZ32: key("a"), profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    const rows = await menu(utils.user);
    await utils.user.click(rows.getByText("Mover para baixo"));
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
