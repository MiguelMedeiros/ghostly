import { act, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JumpToLatest } from "../../components/chat/JumpToLatest";
import { useMemo } from "react";
import { forgetChatScroll, leftOn, useChatScroll, type ScrollRow } from "../../hooks/useChatScroll";
import { MAX_ROWS, OPEN_ROWS, PAGE_ROWS, revealMessage, useRowWindow } from "../../hooks/useRowWindow";
import { jumpToMessage } from "../../lib/replies";
import { renderApp } from "../render";

// covers: chat.scroll

/**
 * happy-dom has no layout, so the list gets one here: a 300 px tall view over rows 50 px tall each (or what `heights`
 * says), stacked in order. Setting `scrollTop` clamps and fires `scroll`, as a browser does.
 */
const VIEW = 300;
/** The list's height now: shorter when something under it (the composer) grows. */
let view = VIEW;
const ROW = 50;
const heights = new Map<string, number>();
/** Rows still in their entry animation, and how far down it draws them for now (a transform: the layout does not move). */
const entering = new Map<string, number>();
const positions = new WeakMap<Element, number>();
const isList = (el: Element) => el instanceof HTMLElement && el.dataset.testid === "list";
const rowsIn = (el: Element) => [...el.querySelectorAll<HTMLElement>("[data-message-id]")];
const heightOf = (row: HTMLElement) => heights.get(row.dataset.messageId!) ?? ROW;
const contentHeight = (el: Element) => rowsIn(el).reduce((sum, row) => sum + heightOf(row), 0);
const maxTop = (el: Element) => Math.max(0, contentHeight(el) - view);

function inherited(name: string): PropertyDescriptor {
  for (let proto: object | null = Element.prototype; proto; proto = Object.getPrototypeOf(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (d) return d;
  }
  throw new Error(name);
}

let observed: ResizeObserverCallback[] = [];
/** A picture or a video changed a row's height: what the ResizeObserver would say. */
const resized = () => act(() => { for (const callback of observed) callback([], {} as ResizeObserver); });

beforeAll(() => {
  const top = inherited("scrollTop");
  const rect = Element.prototype.getBoundingClientRect;
  Object.defineProperties(HTMLElement.prototype, {
    scrollHeight: { configurable: true, get(this: HTMLElement) { return isList(this) ? Math.max(view, contentHeight(this)) : 0; } },
    clientHeight: { configurable: true, get(this: HTMLElement) { return isList(this) ? view : 0; } },
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) { return isList(this) ? positions.get(this) ?? 0 : top.get!.call(this); },
      set(this: HTMLElement, value: number) {
        if (!isList(this)) { top.set!.call(this, value); return; }
        const next = Math.min(maxTop(this), Math.max(0, value));
        if (next === (positions.get(this) ?? 0)) return;
        positions.set(this, next);
        this.dispatchEvent(new Event("scroll"));
      },
    },
    scrollTo: { configurable: true, value(this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; } },
    getBoundingClientRect: {
      configurable: true,
      value(this: HTMLElement) {
        if (isList(this)) return new DOMRect(0, 0, 400, view);
        const list = this.closest<HTMLElement>("[data-testid='list']");
        if (!list || !this.dataset.messageId) return rect.call(this);
        let y = -list.scrollTop;
        for (const row of rowsIn(list)) {
          if (row === this) return new DOMRect(0, y + (entering.get(row.dataset.messageId!) ?? 0), 400, heightOf(row));
          y += heightOf(row);
        }
        return rect.call(this);
      },
    },
    getAnimations: {
      configurable: true,
      value(this: HTMLElement) {
        const id = this.dataset.messageId;
        return id && entering.has(id) ? [{ finish: () => { entering.delete(id); } }] : [];
      },
    },
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { observed.push(callback); }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterAll(() => {
  for (const name of ["scrollHeight", "clientHeight", "scrollTop", "scrollTo", "getBoundingClientRect", "getAnimations"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  vi.unstubAllGlobals();
});

beforeEach(() => { heights.clear(); entering.clear(); observed = []; view = VIEW; forgetChatScroll(); });

function Timeline({ rows, chat = "chat-1" }: { rows: ScrollRow[]; chat?: string }) {
  const jump = useChatScroll({ rows, chat });
  return (
    <div>
      <div ref={jump.listRef} data-testid="list">
        <div ref={jump.columnRef}>{rows.map(row => <div key={row.id} data-message-id={row.id}>{row.id}</div>)}</div>
      </div>
      <JumpToLatest count={jump.count} far={jump.far} onJump={jump.toNew} />
      <textarea data-testid="composer" />
    </div>
  );
}

const theirs = (from: number, n: number): ScrollRow[] => Array.from({ length: n }, (_, i) => ({ id: `peer_${from + i}`, mine: false }));
const list = () => screen.getByTestId("list");
const pill = () => screen.queryByTestId("jump-latest");
/** The user scrolls the list to `top`. */
const scrollTo = (top: number) => act(() => { list().scrollTop = top; });
const topOf = (id: string) => list().querySelector<HTMLElement>(`[data-message-id="${id}"]`)!.getBoundingClientRect().top;

describe("the chat timeline's scrolling", () => {
  it("opens at the bottom, and at the bottom a new message keeps it there", () => {
    const rows = theirs(0, 10);
    const { rerender } = renderApp(<Timeline rows={rows} />);
    expect(list().scrollTop).toBe(200);
    rerender(<Timeline rows={[...rows, ...theirs(10, 1)]} />);
    expect(list().scrollTop).toBe(250);
    expect(pill()).toBeNull();
  });

  it("scrolled up, a new message leaves the view where it was and the pill counts it", () => {
    const rows = theirs(0, 10);
    const { rerender } = renderApp(<Timeline rows={rows} />);
    scrollTo(60);
    const before = topOf("peer_2");
    rerender(<Timeline rows={[...rows, ...theirs(10, 3)]} />);
    expect(list().scrollTop).toBe(60);
    expect(topOf("peer_2")).toBe(before);
    expect(pill()).toHaveAttribute("data-count", "3");
    expect(pill()).toHaveAccessibleName("3 new messages, scroll to bottom");
    expect(screen.getByTestId("jump-latest-label")).toHaveTextContent("3 new");
  });

  it("scrolled up, older history coming in above is not new, and the view stays on its message", () => {
    const rows = theirs(100, 10);
    const { rerender } = renderApp(<Timeline rows={rows} />);
    scrollTo(60);
    const before = topOf("peer_102");
    rerender(<Timeline rows={[...theirs(0, 100), ...rows, ...theirs(110, 1)]} />);
    resized();
    expect(topOf("peer_102")).toBe(before);
    expect(pill()).toHaveAttribute("data-count", "1");
  });

  it("scrolled up, a late catch-up of older messages (a group syncing after a reconnect) is not new and leaves the pill's target", async () => {
    const rows = theirs(0, 10);
    const { rerender, user } = renderApp(<Timeline rows={rows} />);
    scrollTo(0);
    const newer = theirs(10, 20);
    rerender(<Timeline rows={[...rows, ...newer]} />);
    expect(pill()).toHaveAttribute("data-count", "20");
    // Older than the last message seen: each goes in its place by time, not at the end.
    const late = [...rows.slice(0, 4), { id: "late_1", mine: false }, ...rows.slice(4), { id: "late_2", mine: false }, ...newer];
    rerender(<Timeline rows={late} />);
    expect(pill()).toHaveAttribute("data-count", "20");
    // A newer one still counts.
    rerender(<Timeline rows={[...late, ...theirs(30, 1)]} />);
    expect(pill()).toHaveAttribute("data-count", "21");
    // The pill still goes to the first new message, not to a late old one.
    await user.click(pill()!);
    expect(topOf("peer_10")).toBe(8);
  });

  it("one new message is said in the singular", () => {
    const rows = theirs(0, 10);
    const { rerender } = renderApp(<Timeline rows={rows} />);
    scrollTo(0);
    rerender(<Timeline rows={[...rows, ...theirs(10, 1)]} />);
    expect(pill()).toHaveAccessibleName("1 new message, scroll to bottom");
  });

  it("the pill goes down to the new messages and clears", async () => {
    const rows = theirs(0, 10);
    const { rerender, user } = renderApp(<Timeline rows={rows} />);
    scrollTo(0);
    rerender(<Timeline rows={[...rows, ...theirs(10, 3)]} />);
    await user.click(pill()!);
    expect(list().scrollTop).toBe(350);
    expect(pill()).toBeNull();
  });

  it("with more new than a screen, the pill stops at the first new one", async () => {
    const rows = theirs(0, 10);
    const { rerender, user } = renderApp(<Timeline rows={rows} />);
    scrollTo(0);
    rerender(<Timeline rows={[...rows, ...theirs(10, 20)]} />);
    expect(pill()).toHaveAttribute("data-count", "20");
    await user.click(pill()!);
    // peer_10 starts at 500, a little below the top of the view.
    expect(list().scrollTop).toBe(492);
    expect(topOf("peer_10")).toBe(8);
    // Nothing counted any more; still far from the bottom, so the plain ↓ stays.
    expect(pill()).toHaveAttribute("data-count", "0");
    expect(pill()).toHaveAccessibleName("Scroll to bottom");
  });

  it("reaching the bottom by hand clears the count", () => {
    const rows = theirs(0, 10);
    const { rerender } = renderApp(<Timeline rows={rows} />);
    scrollTo(0);
    rerender(<Timeline rows={[...rows, ...theirs(10, 2)]} />);
    expect(pill()).toHaveAttribute("data-count", "2");
    scrollTo(10_000);
    expect(pill()).toBeNull();
  });

  it("what I send goes to the bottom, wherever I was", () => {
    const rows = theirs(0, 10);
    const { rerender } = renderApp(<Timeline rows={rows} />);
    scrollTo(0);
    rerender(<Timeline rows={[...rows, ...theirs(10, 1)]} />);
    rerender(<Timeline rows={[...rows, ...theirs(10, 1), { id: "me_1", mine: true }]} />);
    expect(list().scrollTop).toBe(300);
    expect(pill()).toBeNull();
  });

  it("a reaction or an edit (the same ids) is not new and moves nothing", () => {
    const rows = theirs(0, 10);
    const { rerender } = renderApp(<Timeline rows={rows} />);
    scrollTo(40);
    rerender(<Timeline rows={rows.map(row => ({ ...row }))} />);
    expect(list().scrollTop).toBe(40);
    expect(pill()).toBeNull();
  });

  it("a picture loading above keeps the message in view where it was; one below moves nothing", () => {
    const rows = theirs(0, 20);
    renderApp(<Timeline rows={rows} />);
    scrollTo(120);
    // peer_2 is the first row still in view, 20 px above its top edge.
    expect(topOf("peer_2")).toBe(-20);
    heights.set("peer_0", 250);
    resized();
    expect(topOf("peer_2")).toBe(-20);
    expect(list().scrollTop).toBe(320);
    heights.set("peer_15", 400);
    resized();
    expect(list().scrollTop).toBe(320);
    expect(topOf("peer_2")).toBe(-20);
  });

  it("at the bottom, a picture that loads keeps the view at the bottom", () => {
    renderApp(<Timeline rows={theirs(0, 10)} />);
    heights.set("peer_9", 300);
    resized();
    expect(list().scrollTop).toBe(450);
  });

  it("opening, pictures that load before the first scroll event still leave it at the last message", () => {
    renderApp(<Timeline rows={theirs(0, 10)} />);
    expect(list().scrollTop).toBe(200);
    // A browser fires the open's own scroll event a frame later; by then pictures have loaded and the list is taller.
    heights.set("peer_7", 200);
    heights.set("peer_9", 300);
    act(() => { fireEvent.scroll(list()); });
    resized();
    expect(list().scrollTop).toBe(600);
    expect(pill()).toBeNull();
  });

  it("at the bottom, content that grows keeps it there until a hand scrolls up", () => {
    renderApp(<Timeline rows={theirs(0, 10)} />);
    heights.set("peer_9", 300);
    act(() => { fireEvent.scroll(list()); });
    resized();
    expect(list().scrollTop).toBe(450);
    scrollTo(100);
    heights.set("peer_8", 200);
    act(() => { fireEvent.scroll(list()); });
    resized();
    expect(list().scrollTop).toBe(100);
  });

  it("just opened, content growing again and again (pictures, previews, a voice bubble) keeps the last message in view", () => {
    renderApp(<Timeline rows={theirs(0, 20)} />);
    expect(list().scrollTop).toBe(700);
    for (const [id, height] of [["peer_19", 180], ["peer_12", 240], ["peer_18", 90], ["peer_3", 400]] as const) {
      heights.set(id, height);
      resized();
      expect(list().scrollTop).toBe(list().scrollHeight - VIEW);
    }
    expect(pill()).toBeNull();
  });

  it("at the bottom, the list getting shorter (the composer growing with a draft) keeps the last message in view", () => {
    renderApp(<Timeline rows={theirs(0, 10)} />);
    expect(list().scrollTop).toBe(200);
    view = 220;
    resized();
    expect(list().scrollTop).toBe(280);
    expect(list().scrollHeight - list().scrollTop - list().clientHeight).toBe(0);
  });

  it("at the bottom, a phone turned on its side (the list much shorter, the browser moving the view first) stays at the bottom", () => {
    renderApp(<Timeline rows={theirs(0, 10)} />);
    expect(list().scrollTop).toBe(200);
    // The scroll event comes before the ResizeObserver's: the browser kept the view's top about where it was.
    act(() => { view = 120; list().scrollTop = 190; });
    expect(list().scrollTop).toBe(380);
    resized();
    expect(list().scrollTop).toBe(380);
    expect(pill()).toBeNull();
  });

  it("a tap on the list just before the phone turns (Play on a video) is not a hand scrolling it", () => {
    renderApp(<Timeline rows={theirs(0, 10)} />);
    fireEvent.pointerDown(list());
    fireEvent.pointerUp(window);
    act(() => { view = 120; list().scrollTop = 190; });
    expect(list().scrollTop).toBe(380);
  });

  it("the list resizing under a finger held on it: the view stays where the hand put it", () => {
    renderApp(<Timeline rows={theirs(0, 10)} />);
    fireEvent.pointerDown(list());
    act(() => { view = 120; list().scrollTop = 150; });
    fireEvent.pointerUp(window);
    expect(list().scrollTop).toBe(150);
  });

  it("scrolled up, the list resizing keeps the message it shows in place", () => {
    renderApp(<Timeline rows={theirs(0, 10)} />);
    scrollTo(60);
    const before = topOf("peer_1");
    act(() => { view = 120; list().scrollTop = 70; });
    expect(topOf("peer_1")).toBe(before);
  });

  it("at the bottom, the browser pulling the view a little up with no hand on it goes back to the bottom", () => {
    renderApp(<Timeline rows={theirs(0, 10)} />);
    expect(list().scrollTop).toBe(200);
    // The composer sizes itself to its text: for an instant the list is 66 px taller, and the browser clamps the view to
    // it. The list is its old height again by the time anything looks, so nothing reports a new size.
    act(() => { list().scrollTop = 134; });
    expect(list().scrollTop).toBe(200);
    expect(pill()).toBeNull();
  });

  it("at the bottom, a hand's small scroll up stays where the hand put it", () => {
    renderApp(<Timeline rows={theirs(0, 10)} />);
    fireEvent.wheel(list());
    act(() => { list().scrollTop = 140; });
    expect(list().scrollTop).toBe(140);
    // A press on the list (dragging its scrollbar) is a hand too.
    fireEvent.pointerDown(list());
    act(() => { list().scrollTop = 150; });
    fireEvent.pointerUp(window);
    expect(list().scrollTop).toBe(150);
  });

  it("scrolled up by hand, content growing above and below keeps the message it shows in place", () => {
    renderApp(<Timeline rows={theirs(0, 20)} />);
    fireEvent.wheel(list());
    scrollTo(300);
    const before = topOf("peer_7");
    heights.set("peer_2", 300);
    heights.set("peer_19", 300);
    resized();
    expect(topOf("peer_7")).toBe(before);
    expect(list().scrollTop).toBe(550);
  });

  it("far from the bottom with nothing new, a plain ↓ shows; near it, nothing", async () => {
    const { user } = renderApp(<Timeline rows={theirs(0, 30)} />);
    expect(pill()).toBeNull();
    scrollTo(100);
    expect(pill()).toHaveAttribute("data-count", "0");
    expect(pill()).toHaveAccessibleName("Scroll to bottom");
    await user.click(pill()!);
    expect(list().scrollTop).toBe(1200);
    expect(pill()).toBeNull();
  });

  it("on the way down after ↓, a new message or a picture loading does not leave the view halfway", async () => {
    const rows = theirs(0, 30);
    const { rerender, user } = renderApp(<Timeline rows={rows} />);
    scrollTo(0);
    // A smooth scroll still under way: it has only got halfway when the rest happens.
    const halfway = vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (this: HTMLElement, options?: ScrollToOptions | number) {
      this.scrollTop = ((options as ScrollToOptions).top ?? 0) / 2;
    });
    await user.click(pill()!);
    halfway.mockRestore();
    expect(list().scrollTop).toBeLessThan(1200);
    rerender(<Timeline rows={[...rows, ...theirs(30, 1)]} />);
    expect(list().scrollTop).toBe(1250);
    expect(pill()).toBeNull();
  });

  it("scrolling by hand on the way down stops it there", async () => {
    const rows = theirs(0, 30);
    const { rerender, user } = renderApp(<Timeline rows={rows} />);
    scrollTo(0);
    const halfway = vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (this: HTMLElement, options?: ScrollToOptions | number) {
      this.scrollTop = ((options as ScrollToOptions).top ?? 0) / 2;
    });
    await user.click(pill()!);
    halfway.mockRestore();
    fireEvent.wheel(list());
    scrollTo(400);
    rerender(<Timeline rows={[...rows, ...theirs(30, 1)]} />);
    expect(list().scrollTop).toBe(400);
    expect(pill()).toHaveAttribute("data-count", "1");
  });

  it("End or Ctrl/Cmd+↓ jumps to the bottom, but not from a text field", () => {
    renderApp(<Timeline rows={theirs(0, 30)} />);
    scrollTo(0);
    fireEvent.keyDown(screen.getByTestId("composer"), { key: "End" });
    expect(list().scrollTop).toBe(0);
    fireEvent.keyDown(document.body, { key: "End" });
    expect(list().scrollTop).toBe(1200);
    scrollTo(0);
    fireEvent.keyDown(document.body, { key: "ArrowDown", metaKey: true });
    expect(list().scrollTop).toBe(1200);
    scrollTo(0);
    fireEvent.keyDown(document.body, { key: "ArrowDown", ctrlKey: true });
    expect(list().scrollTop).toBe(1200);
  });

  it("a jump to a message (a quote's, a search's) from the bottom lands on it, not back at the bottom", () => {
    const { rerender } = renderApp(<Timeline rows={theirs(0, 40)} />);
    expect(list().scrollTop).toBe(1700);
    // A smooth scroll, a frame at a time, a picture laying out on the way; anyone else setting the scroll cancels it.
    let frames: number[] = [];
    const into = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => { frames = [1690, 1600, 900, 125]; });
    act(() => { jumpToMessage("peer_5", list()); });
    let at = list().scrollTop;
    for (const frame of frames) {
      if (list().scrollTop !== at) break;
      scrollTo(frame);
      at = frame;
      resized();
    }
    into.mockRestore();
    // In the middle of the view: (300 - 50) / 2.
    expect(topOf("peer_5")).toBe(125);
    // It stays there: the contact's next message is counted, not followed.
    rerender(<Timeline rows={[...theirs(0, 40), ...theirs(40, 1)]} />);
    expect(topOf("peer_5")).toBe(125);
    expect(pill()).toHaveAttribute("data-count", "1");
  });

  it("the pill is a button reached with Tab", async () => {
    const rows = theirs(0, 10);
    const { rerender, user } = renderApp(<Timeline rows={rows} />);
    scrollTo(0);
    rerender(<Timeline rows={[...rows, ...theirs(10, 3)]} />);
    await user.tab();
    expect(pill()).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(list().scrollTop).toBe(350);
  });

  it("another chat opens at its bottom with nothing counted", () => {
    const rows = theirs(0, 10);
    const { rerender } = renderApp(<Timeline rows={rows} />);
    scrollTo(0);
    rerender(<Timeline rows={[...rows, ...theirs(10, 3)]} />);
    expect(pill()).toHaveAttribute("data-count", "3");
    rerender(<Timeline chat="chat-2" rows={theirs(100, 12)} />);
    expect(list().scrollTop).toBe(300);
    expect(pill()).toBeNull();
  });

  it("a chat left scrolled up opens again on the same message, even with pictures loading above it", () => {
    const rows = theirs(0, 20);
    const { rerender, unmount } = renderApp(<Timeline rows={rows} />);
    scrollTo(130);
    expect(topOf("peer_2")).toBe(-30);
    // Another chat, then back: the same component, or a new one (the chat screen mounts again).
    rerender(<Timeline chat="chat-2" rows={theirs(100, 12)} />);
    expect(list().scrollTop).toBe(300);
    rerender(<Timeline rows={[...rows, ...theirs(20, 2)]} />);
    expect(topOf("peer_2")).toBe(-30);
    expect(pill()).toHaveAttribute("data-count", "0");
    unmount();
    renderApp(<Timeline rows={[...rows, ...theirs(20, 2)]} />);
    expect(topOf("peer_2")).toBe(-30);
    heights.set("peer_0", 250);
    act(() => { fireEvent.scroll(list()); });
    resized();
    expect(topOf("peer_2")).toBe(-30);
  });

  it("a chat left scrolled up opens exactly on its message while its bubbles still play their entry animation", () => {
    const rows = theirs(0, 20);
    const { unmount } = renderApp(<Timeline rows={rows} />);
    scrollTo(130);
    expect(topOf("peer_2")).toBe(-30);
    unmount();
    // Opened again seconds after a message came: each bubble starts its entry drawn 13 px down.
    for (const row of rows) entering.set(row.id, 13);
    renderApp(<Timeline rows={rows} />);
    entering.clear();
    expect(Math.abs(topOf("peer_2") + 30)).toBeLessThanOrEqual(1);
    expect(list().scrollTop).toBe(130);
  });

  it("a chat left at its bottom opens at its bottom, with what came meanwhile", () => {
    const rows = theirs(0, 20);
    const { rerender } = renderApp(<Timeline rows={rows} />);
    rerender(<Timeline chat="chat-2" rows={theirs(100, 12)} />);
    rerender(<Timeline rows={[...rows, ...theirs(20, 5)]} />);
    expect(list().scrollTop).toBe(950);
    expect(pill()).toBeNull();
  });

  it("the message a chat was left on is gone: it opens at its bottom", () => {
    const rows = theirs(0, 20);
    const { rerender } = renderApp(<Timeline rows={rows} />);
    scrollTo(130);
    rerender(<Timeline chat="chat-2" rows={theirs(100, 12)} />);
    rerender(<Timeline rows={rows.slice(3)} />);
    expect(list().scrollTop).toBe(550);
  });

  it("a list taken off screen (a chat kept for a call) keeps its place", () => {
    renderApp(<Timeline rows={theirs(0, 20)} />);
    scrollTo(130);
    // display: none, as a browser does it: no size, and the scroll position back at 0.
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(0);
    scrollTo(0);
    resized();
    height.mockRestore();
    resized();
    expect(topOf("peer_2")).toBe(-30);
    expect(list().scrollTop).toBe(130);
  });
});

/**
 * Where a chat was left, when the rows it opens with are not its own yet. The group page stays mounted from one group to
 * the next, so for one render the next group opens on the last one's rows; a history can also come in two goes.
 */
describe("a chat opened again before its rows are there", () => {
  const mine = (from: number, n: number): ScrollRow[] => Array.from({ length: n }, (_, i) => ({ id: `me_${from + i}`, mine: true }));

  it("opened on the last chat's rows first, it still goes back on the message it was left on", () => {
    const one = theirs(0, 20), two = mine(100, 12);
    const { rerender } = renderApp(<Timeline chat="g1" rows={one} />);
    scrollTo(130);
    expect(topOf("peer_2")).toBe(-30);
    // To g2: one render still with g1's rows, then g2's own.
    rerender(<Timeline chat="g2" rows={one} />);
    rerender(<Timeline chat="g2" rows={two} />);
    expect(list().scrollTop).toBe(300);
    // Back to g1, the same way.
    rerender(<Timeline chat="g1" rows={two} />);
    rerender(<Timeline chat="g1" rows={one} />);
    expect(topOf("peer_2")).toBe(-30);
    expect(list().scrollTop).toBe(130);
    // Nothing counted: its rows were there before it was left.
    expect(pill()).toHaveAttribute("data-count", "0");
  });

  it("an empty list in between is not a hand scrolling", () => {
    const one = theirs(0, 20);
    const { rerender } = renderApp(<Timeline chat="g1" rows={one} />);
    scrollTo(130);
    rerender(<Timeline chat="g2" rows={one} />);
    rerender(<Timeline chat="g2" rows={[]} />);
    rerender(<Timeline chat="g2" rows={theirs(100, 12)} />);
    rerender(<Timeline chat="g1" rows={theirs(100, 12)} />);
    rerender(<Timeline chat="g1" rows={[]} />);
    act(() => { fireEvent.scroll(list()); });
    rerender(<Timeline chat="g1" rows={one} />);
    expect(topOf("peer_2")).toBe(-30);
  });

  it("a history that comes in two goes: the first part opens at its bottom, the whole one on the message", () => {
    const all = theirs(0, 40);
    renderApp(<Timeline chat="g1" rows={all} />).unmount();
    // The first render opened at the bottom; the hand scrolls up before the chat is left.
    const first = renderApp(<Timeline chat="g1" rows={all} />);
    scrollTo(130);
    first.unmount();
    const { rerender } = renderApp(<Timeline chat="g1" rows={all.slice(30)} />);
    expect(list().scrollTop).toBe(200);
    // The open's own scroll event, a frame late: nothing moved, so not a hand.
    act(() => { fireEvent.scroll(list()); });
    rerender(<Timeline chat="g1" rows={all} />);
    expect(topOf("peer_2")).toBe(-30);
    expect(pill()).toHaveAttribute("data-count", "0");
  });

  it("a hand that scrolls before the rows come keeps its own place", () => {
    const one = theirs(0, 20), two = theirs(100, 12);
    const { rerender } = renderApp(<Timeline chat="g1" rows={one} />);
    scrollTo(130);
    rerender(<Timeline chat="g2" rows={two} />);
    rerender(<Timeline chat="g1" rows={two} />);
    scrollTo(50);
    rerender(<Timeline chat="g1" rows={one} />);
    expect(list().scrollTop).toBe(50);
  });

  it("left again before its rows came, it is still remembered where it was first left", () => {
    const one = theirs(0, 20), two = theirs(100, 12);
    const { rerender } = renderApp(<Timeline chat="g1" rows={one} />);
    scrollTo(130);
    rerender(<Timeline chat="g2" rows={two} />);
    // Quickly: g1 opens on g2's rows, and is left for g2 before its own come.
    rerender(<Timeline chat="g1" rows={two} />);
    rerender(<Timeline chat="g2" rows={two} />);
    rerender(<Timeline chat="g1" rows={two} />);
    rerender(<Timeline chat="g1" rows={one} />);
    expect(topOf("peer_2")).toBe(-30);
  });

  it("what I send while it waits goes to the bottom, and the old place is let go", () => {
    const one = theirs(0, 20), two = theirs(100, 12);
    const { rerender } = renderApp(<Timeline chat="g1" rows={one} />);
    scrollTo(130);
    rerender(<Timeline chat="g2" rows={two} />);
    rerender(<Timeline chat="g1" rows={two} />);
    rerender(<Timeline chat="g1" rows={[...two, { id: "me_sent", mine: true }]} />);
    rerender(<Timeline chat="g1" rows={[...one, { id: "me_sent", mine: true }]} />);
    expect(list().scrollTop).toBe(list().scrollHeight - VIEW);
  });

  it("a chat left at its bottom opens at its bottom even when its first rows are another chat's", () => {
    const one = theirs(0, 20), two = theirs(100, 12);
    const { rerender } = renderApp(<Timeline chat="g1" rows={one} />);
    rerender(<Timeline chat="g2" rows={two} />);
    rerender(<Timeline chat="g1" rows={two} />);
    rerender(<Timeline chat="g1" rows={[...one, ...theirs(20, 3)]} />);
    expect(list().scrollTop).toBe(23 * ROW - VIEW);
    expect(pill()).toBeNull();
  });
});

/** A timeline with a window of its rows in the page (useRowWindow), as Chat.tsx and GroupChat.tsx draw one. */
function WindowTimeline({ rows, chat = "chat-1" }: { rows: ScrollRow[]; chat?: string }) {
  const ids = useMemo(() => rows.map(row => row.id), [rows]);
  const win = useRowWindow(ids, chat, { opensOn: leftOn(chat) });
  // A new list when the window moves, as the pages give it (see Chat.tsx).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(() => [...rows], [rows, win.from, win.to]);
  const jump = useChatScroll({ rows: all, chat, window: win });
  return (
    <div>
      <div ref={jump.listRef} data-testid="list">
        <div ref={jump.columnRef}>{rows.slice(win.from, win.to).map(row => <div key={row.id} data-message-id={row.id}>{row.id}</div>)}</div>
      </div>
      <JumpToLatest count={jump.count} far={jump.far} onJump={jump.toNew} />
    </div>
  );
}

describe("a long timeline's window of rows", () => {
  const long = theirs(0, 1_000);
  const inPage = () => rowsIn(list()).length;
  /** The row at the top of the view. */
  const atTop = () => rowsIn(list()).find(row => row.getBoundingClientRect().bottom > 0)!.dataset.messageId!;
  /** The user scrolls up near the top of the rows in the page, again and again. */
  const upTimes = (n: number) => { for (let i = 0; i < n; i++) scrollTo(ROW); };

  it("opens on its last rows at the bottom, and scrolled near the top takes older ones in above without moving the view", () => {
    renderApp(<WindowTimeline rows={long} />);
    expect(inPage()).toBe(OPEN_ROWS);
    expect(list().scrollTop).toBe(OPEN_ROWS * ROW - VIEW);
    scrollTo(4 * ROW);
    const row = atTop();
    const was = topOf(row);
    // Older rows came in above; the row at the top of the view is where it was.
    expect(inPage()).toBe(OPEN_ROWS + PAGE_ROWS);
    expect(rowsIn(list())[0].dataset.messageId).toBe(`peer_${1_000 - OPEN_ROWS - PAGE_ROWS}`);
    expect(topOf(row)).toBe(was);
    expect(pill()).toHaveAttribute("data-count", "0");
  });

  it("never holds more than its most rows: far up, the last ones leave the page and new messages are counted, not drawn", () => {
    const { rerender } = renderApp(<WindowTimeline rows={long} />);
    upTimes(4);
    expect(inPage()).toBe(MAX_ROWS);
    const row = atTop();
    const was = topOf(row);
    rerender(<WindowTimeline rows={[...long, ...theirs(1_000, 2)]} />);
    expect(topOf(row)).toBe(was);
    expect(list().querySelector("[data-message-id=peer_1001]")).toBeNull();
    expect(pill()).toHaveAttribute("data-count", "2");
    // The pill: the first new one comes into the page with the last rows, and the view goes to it.
    fireEvent.click(pill()!);
    expect(list().querySelector("[data-message-id=peer_1000]")).not.toBeNull();
    expect(inPage()).toBeLessThanOrEqual(MAX_ROWS);
  });

  it("going down from up the history takes newer rows in below and lets the top ones go, the view on its row", () => {
    renderApp(<WindowTimeline rows={long} />);
    upTimes(4);
    const firstBefore = rowsIn(list())[0].dataset.messageId;
    // Near the bottom of the rows in the page.
    scrollTo(MAX_ROWS * ROW - VIEW - ROW);
    const row = atTop();
    const was = topOf(row);
    expect(rowsIn(list())[0].dataset.messageId).not.toBe(firstBefore);
    expect(inPage()).toBeLessThanOrEqual(MAX_ROWS);
    expect(topOf(row)).toBe(was);
  });

  it("↓ from up the history brings the last rows back and lands at the bottom", () => {
    renderApp(<WindowTimeline rows={long} />);
    upTimes(4);
    expect(pill()).not.toBeNull();
    fireEvent.click(pill()!);
    expect(rowsIn(list()).at(-1)!.dataset.messageId).toBe("peer_999");
    expect(inPage()).toBe(OPEN_ROWS);
    expect(list().scrollTop).toBe(OPEN_ROWS * ROW - VIEW);
  });

  it("what I send from up the history brings the last rows back, at the bottom", () => {
    const { rerender } = renderApp(<WindowTimeline rows={long} />);
    upTimes(4);
    rerender(<WindowTimeline rows={[...long, { id: "me_1", mine: true }]} />);
    expect(rowsIn(list()).at(-1)!.dataset.messageId).toBe("me_1");
    expect(list().scrollTop).toBe(list().scrollHeight - VIEW);
    expect(pill()).toBeNull();
  });

  it("a jump to a row not in the page brings the rows around it in and lands on it", () => {
    renderApp(<WindowTimeline rows={long} />);
    expect(list().querySelector("[data-message-id=peer_12]")).toBeNull();
    act(() => { expect(jumpToMessage("peer_12") || (revealMessage("peer_12") && jumpToMessage("peer_12"))).toBe(true); });
    expect(list().querySelector("[data-message-id=peer_12]")).toHaveAttribute("data-reply-flash");
    expect(inPage()).toBeLessThanOrEqual(MAX_ROWS);
    // Up the history now: the view is not at the bottom, and a ↓ takes it back there.
    expect(pill()).not.toBeNull();
  });

  it("left scrolled up far in the history, it opens on that message again", () => {
    const { unmount } = renderApp(<WindowTimeline rows={long} />);
    upTimes(4);
    const row = atTop();
    const was = topOf(row);
    unmount();
    renderApp(<WindowTimeline rows={long} />);
    expect(topOf(row)).toBe(was);
  });
});
