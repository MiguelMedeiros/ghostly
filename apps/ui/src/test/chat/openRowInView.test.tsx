import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.list.rows, chats.list.rail

const NOW = Date.now();
const chat = (id: string, at: number): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: id.padEnd(52, "x"), encKeyB64: "enc", messages: [], createdAt: at, nick: id });

/*
 * happy-dom lays nothing out: the list and the rail are 800 px tall at the top of the window, and each row or rail place
 * is 60 px under the one before it, as a browser draws 40 chats. `scrollIntoView` is recorded.
 */
const ROW = 60, VIEW = 800;
const scrolled = vi.fn();
const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 300, width: 300, height, x: 0, y: top, toJSON() {} }) as DOMRect;
beforeEach(() => {
  scrolled.mockClear();
  Element.prototype.scrollIntoView = function (this: Element, how?: boolean | ScrollIntoViewOptions) { scrolled(this, how); };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.matches("[data-testid=chat-list],[data-testid=chat-rail]")) return rect(0, VIEW);
    const rows = this.closest("[data-testid=chat-list],[data-testid=chat-rail]")?.querySelectorAll("[data-chat],[data-group]") ?? [];
    return rect([...rows].indexOf(this) * ROW, ROW);
  });
});
afterEach(() => { vi.restoreAllMocks(); delete (Element.prototype as Partial<Element>).scrollIntoView; });

/** 40 chats, the newest first in the list: `c1` at the top, `c40` at its foot, far out of sight. */
function fortyChats() {
  for (let i = 1; i <= 40; i++) saveSession(chat(`c${i}`, NOW - i * 60_000));
}
const sidebar = (route: string) => renderApp(<UpdateProvider><Sidebar /></UpdateProvider>, { route });
const scrolledTo = () => scrolled.mock.calls.map(([el, how]) => [(el as Element).getAttribute("data-chat") ?? `group:${(el as Element).getAttribute("data-group")}`, how]);

describe("the open chat's row after a reload", () => {
  it("is brought into view once in a long list, and the list stays where it is on later draws", async () => {
    fortyChats();
    sidebar("/chat/c36");
    await screen.findAllByTestId("chat-row");
    expect(scrolledTo()).toEqual([["c36", { block: "center" }]]);

    // The list is read again (a message, a pin), the engine's state comes: nothing moves it again.
    act(() => { window.dispatchEvent(new Event("session-updated")); });
    act(() => fakeEngine.update({ groups: [] }));
    expect(scrolled).toHaveBeenCalledTimes(1);
  });

  it("moves nothing when the open chat's row is already in sight, nor when a row in sight is clicked", async () => {
    fortyChats();
    const { user } = sidebar("/chat/c3");
    await screen.findAllByTestId("chat-row");
    await user.click(within(screen.getByTestId("chat-list")).getAllByTestId("chat-row")[5]);
    expect(scrolled).not.toHaveBeenCalled();
  });

  it("brings a group's place on the rail into view, and the list's row again when the list unfolds", async () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ chatListCollapsed: true }));
    // The groups come first in the list and on the rail: 40 of them put the 36th out of sight.
    act(() => fakeEngine.update({ groups: Array.from({ length: 40 }, (_, i) => groupView({ id: `g${i + 1}`, name: `Group ${i + 1}`, status: "active", lastMessageAt: NOW - i * 60_000 })) }));
    const { user } = sidebar("/group/g36");
    await within(screen.getByTestId("chat-rail")).findAllByTestId("chat-rail-group");
    expect(scrolledTo()).toEqual([["group:g36", { block: "center" }]]);

    await user.click(screen.getByTestId("chat-list-toggle"));
    expect(screen.getByTestId("chat-list")).toBeInTheDocument();
    expect(scrolledTo()).toEqual([["group:g36", { block: "center" }], ["group:g36", { block: "center" }]]);
  });
});
