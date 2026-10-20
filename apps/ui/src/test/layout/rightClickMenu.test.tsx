import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { ChatFolderHeader } from "../../components/ChatFolderHeader";
import { guardContextMenu } from "../../lib/contextMenu";
import { servicesPlatform } from "../../lib/platform";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.menus

/**
 * A right-click on something with a ⋮ menu (a message, a folder's header) opens that same menu at the pointer, in the
 * place of the webview's own (on Linux it said Back, Forward, Stop, Reload). A field, a link and chosen text keep the
 * webview's menu, for Copy and Paste; a finger's long press stays as it was. The desktop app refuses the webview's
 * menu everywhere else.
 */

const message = (patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: "me_abc", text: "hello there", sender: "me", timestamp: 1_700_000_000_000, delivery: "delivered", ...patch });

function bubble(patch: Partial<ChatMessage> = {}) {
  return renderApp(<MessageBubble message={message(patch)} peerPubKey="peer" onDelete={() => {}} onReply={() => {}} onPin={() => {}} onSave={() => {}} />);
}

/** Whether the last right-click kept the webview's menu: read once everything under the window has heard it. */
let refused: boolean | undefined;
const note = (e: Event) => { refused = e.defaultPrevented; };
beforeEach(() => {
  refused = undefined;
  window.addEventListener("contextmenu", note);
  fakeEngine.setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peer" })] });
  vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(null);
});
afterEach(() => { window.removeEventListener("contextmenu", note); vi.restoreAllMocks(); cleanup(); });

const rows = () => within(screen.getByTestId("message-menu")).getAllByRole("button").map(b => b.textContent);

describe("a right-click on a message", () => {
  it("opens its ⋮ menu, with the same rows, the first focused, and Escape gives the focus to ⋮", async () => {
    const { user } = bubble();
    await user.click(screen.getByTestId("message-options"));
    const fromDots = rows();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("message-menu")).not.toBeInTheDocument();

    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("hello there") });
    expect(refused).toBe(true);
    expect(rows()).toEqual(fromDots);
    expect(fromDots).toEqual(["Reply", "Pin", "Save", "Details", "Delete message"]);
    expect(screen.getByTestId("message-reply")).toHaveFocus();
    expect(screen.getByTestId("message-options")).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("message-pin")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("message-menu")).not.toBeInTheDocument();
    expect(screen.getByTestId("message-options")).toHaveFocus();
  });

  it("opens at the pointer, down and towards the line's end, and follows the message as the list scrolls", async () => {
    let shift = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      // A 192 × 200 menu; the message's ⋮ at the window's right, which a menu from ⋮ would line up with.
      const box = this.dataset.testid === "message-menu" ? { left: 0, right: 192, top: 0, bottom: 200 }
        : this.querySelector(":scope > [data-testid=message-options]") ? { left: 900, right: 924, top: 300 - shift, bottom: 324 - shift }
        : { left: 0, right: 0, top: 0, bottom: 0 };
      return { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box } as DOMRect;
    });
    const { user } = bubble();
    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("hello there"), coords: { clientX: 300, clientY: 120 } });
    const menu = screen.getByTestId("message-menu");
    expect(menu).toHaveAttribute("data-menu", "popover");
    expect([menu.style.left, menu.style.top]).toEqual(["300px", "124px"]);
    shift = 50;
    fireEvent.scroll(window);
    expect(menu.style.top).toBe("74px");

    // Another right-click, elsewhere on it: the menu moves there and stays open, though the press closed the first.
    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("hello there"), coords: { clientX: 200, clientY: 60 } });
    expect(screen.getByTestId("message-menu").style.left).toBe("200px");
    // The ⋮ itself opens it at ⋮ again.
    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("message-options"));
    expect(screen.getByTestId("message-menu").style.left).toBe(`${924 - 192}px`);
  });

  it("on a link, or on text chosen before, keeps the webview's menu (Copy, Copy Link)", async () => {
    const { user } = bubble({ text: "see https://example.com/page" });
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("link") });
    expect(refused).toBe(false);
    expect(screen.queryByTestId("message-menu")).not.toBeInTheDocument();

    // A right press inside chosen text keeps it in the engines (user-event's press would let go of it).
    const text = screen.getByText(/see/);
    document.getSelection()!.selectAllChildren(text);
    fireEvent.pointerDown(text, { pointerType: "mouse", button: 2 });
    fireEvent(text, new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(refused).toBe(false);
    expect(screen.queryByTestId("message-menu")).not.toBeInTheDocument();
  });

  it("on text the press lets go of (WebKitGTK) or chooses (a word, in WKWebView), opens the message's menu", async () => {
    const { user } = bubble();
    const text = screen.getByText("hello there");
    // WebKitGTK: chosen before, let go of under the right press, so its own menu would have no Copy, only Back and Reload.
    const letGo = () => document.getSelection()!.removeAllRanges();
    document.getSelection()!.selectAllChildren(text);
    window.addEventListener("pointerdown", letGo, true);
    await user.pointer({ keys: "[MouseRight]", target: text });
    window.removeEventListener("pointerdown", letGo, true);
    expect(refused).toBe(true);
    expect(screen.getByTestId("message-menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    // WKWebView: nothing chosen before; the press chooses the word under it.
    document.getSelection()!.removeAllRanges();
    const choose = () => document.getSelection()!.selectAllChildren(text);
    window.addEventListener("pointerdown", choose, true);
    await user.pointer({ keys: "[MouseRight]", target: text });
    window.removeEventListener("pointerdown", choose, true);
    expect(refused).toBe(true);
    expect(screen.getByTestId("message-menu")).toBeInTheDocument();
  });

  it("from a finger, the long press stays as it was: no menu", () => {
    const { container } = bubble();
    const row = container.querySelector("[data-message-row]")!;
    fireEvent.pointerDown(row, { pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
    fireEvent(row, new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    expect(screen.queryByTestId("message-menu")).not.toBeInTheDocument();
  });
});

describe("a right-click on a folder's header", () => {
  it("opens its ⋮ menu", async () => {
    const { user } = renderApp(<ChatFolderHeader folder={{ id: "f1", name: "Work" }} sessions={[]} groups={[]} place={{ index: 0, count: 2 }} onToggle={() => {}} />);
    await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("chat-folder-name") });
    expect(refused).toBe(true);
    expect(within(screen.getByTestId("chat-folder-options-menu")).getAllByRole("button").map(b => b.textContent)).toEqual(["Rename folder", "Move down", "Delete folder"]);
    expect(screen.getByTestId("chat-folder-rename")).toHaveFocus();
  });
});

describe("the webview's own menu", () => {
  /** Whether a right-click on the element was refused, once the window has heard it. */
  const refusedOn = (id: string) => {
    const on = document.getElementById(id)!;
    fireEvent.pointerDown(on, { pointerType: "mouse", button: 2 });
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    fireEvent(on, menu);
    return menu.defaultPrevented;
  };
  let stop = () => {};
  afterEach(() => { stop(); document.body.innerHTML = ""; });

  it("never shows in the desktop app where the app has no menu, but on a field or a link", () => {
    stop = guardContextMenu({ suppress: true });
    document.body.innerHTML = `<p id="plain">Settings</p><input id="field"><textarea id="area"></textarea><div id="typed" contenteditable="true"></div><a id="link" href="https://example.com">x</a>`;
    expect(refusedOn("plain")).toBe(true);
    for (const id of ["field", "area", "typed", "link"]) expect(refusedOn(id), id).toBe(false);
    stop();
    expect(refusedOn("plain")).toBe(false);
  });

  it("stays in a browser where the app has no menu", () => {
    stop = guardContextMenu({ suppress: false });
    document.body.innerHTML = `<p id="plain">Settings</p>`;
    expect(refusedOn("plain")).toBe(false);
  });
});
