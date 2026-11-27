import { act, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallOverlay } from "../../components/CallOverlay";
import { GroupCallView, type GroupCallParticipant } from "../../components/GroupCallView";
import { useViewportHeight } from "../../hooks/useViewportHeight";
import { renderApp } from "../render";

// covers: calls.mini-window, calls.group, app.mobile-layout

/**
 * A call's small window on a phone with the keyboard up (the 1:1 call's and the group call's). It stood where it was
 * placed from the whole screen: on its side (667×375, a 200 px keyboard, 175 px left) it covered the message field's
 * end and its Send, its End call behind the keyboard; upright (375×667, a 300 px keyboard, 367 px left) it was wholly
 * behind the keyboard, Mute and End call with it. It keeps to what the keyboard leaves now, and is back in its corner
 * when the keyboard goes down. The keyboard is the app's own detector (useViewportHeight's `data-keyboard`), driven by
 * a visual viewport the test moves, as iOS moves it.
 */

/** A visual viewport the test moves, and a window whose size it sets. */
class Viewport extends EventTarget {
  width = 0;
  height = 0;
  offsetTop = 0;
}
let viewport: Viewport;
let inner = { w: 0, h: 0 };
let touch = true;
/** Where the chat's message field is drawn (`[data-composer]`): above the keyboard while it is up. */
let composer = { top: 0, bottom: 0 };
/** How many times the message field's box was read. */
let composerReads = 0;

/**
 * A ResizeObserver as a browser runs one: an element it starts observing is reported once, at the next frame
 * (`frame`), and again only when its size changes (`resized`).
 */
class FrameObserver {
  static all = new Set<FrameObserver>();
  private observed = new Set<Element>();
  private due = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) { FrameObserver.all.add(this); }
  observe(element: Element) { if (!this.observed.has(element)) { this.observed.add(element); this.due.add(element); } }
  unobserve(element: Element) { this.observed.delete(element); this.due.delete(element); }
  disconnect() { this.observed.clear(); this.due.clear(); }
  static resized(element: Element) { for (const o of FrameObserver.all) if (o.observed.has(element)) o.due.add(element); }
  static frame() {
    for (const o of [...FrameObserver.all]) {
      if (!o.due.size) continue;
      const entries = [...o.due].map((target) => ({ target }) as ResizeObserverEntry);
      o.due.clear();
      o.callback(entries, o as unknown as ResizeObserver);
    }
  }
}

const SIDE = { w: 667, h: 375, keyboard: 200, composer: { top: 109, bottom: 175 } };
const UPRIGHT = { w: 375, h: 667, keyboard: 300, composer: { top: 301, bottom: 367 } };
const HEADER = 56;

function screenIs(size: { w: number; h: number; composer: { top: number; bottom: number } }, isTouch = true) {
  inner = { w: size.w, h: size.h };
  viewport.width = size.w;
  viewport.height = size.h;
  touch = isTouch;
  composer = { top: size.h - (size.composer.bottom - size.composer.top), bottom: size.h };
}

beforeEach(() => {
  viewport = new Viewport();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => inner.w });
  Object.defineProperty(window, "innerHeight", { configurable: true, get: () => inner.h });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => (touch ? 5 : 0) });
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(pointer: coarse)" ? touch : query === "(pointer: fine)" ? !touch : false,
    media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }) as MediaQueryList);
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (!this.hasAttribute("data-composer")) return rect.call(this);
    composerReads++;
    return { x: 0, y: composer.top, left: 0, right: inner.w, top: composer.top, bottom: composer.bottom, width: inner.w, height: composer.bottom - composer.top, toJSON() {} } as DOMRect;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FrameObserver.all.clear();
  Reflect.deleteProperty(window, "visualViewport");
  Reflect.deleteProperty(window, "innerWidth");
  Reflect.deleteProperty(window, "innerHeight");
  Reflect.deleteProperty(navigator, "maxTouchPoints");
  delete document.documentElement.dataset.keyboard;
  for (const key of ["ghostly_call_window_box", "ghostly_group_call_window_box", "ghostly_call_mini", "ghostly_group_call_mini"]) localStorage.removeItem(key);
});

/** The chat as the app has it: its message field, and the app's keyboard detector. */
function Chat({ children }: { children: ReactNode }) {
  useViewportHeight();
  return <><div data-composer><textarea aria-label="Message" /></div>{children}</>;
}

const oneToOne = () => (
  <Chat>
    <CallOverlay callState="connected" localStream={null} remoteStream={null} isMuted={false} isVideoOff remoteHasVideo={false}
      callStartedAt={Date.now()} peerName="Ana" onHangUp={vi.fn()} onToggleMute={vi.fn()} onToggleVideo={vi.fn()} pinned />
  </Chat>
);

const person = (identity: string): GroupCallParticipant => ({ identity, name: identity, mic: true, camera: false, screen: false, speaking: false, tracks: {} });
const group = () => (
  <Chat>
    <GroupCallView call={{ local: person("me"), participants: [person("ana")], activeSpeaker: null }} groupName="Community"
      onToggleMic={vi.fn()} onToggleCamera={vi.fn()} onToggleScreen={vi.fn()} onLeave={vi.fn()} pinned />
  </Chat>
);

/** The window's box as drawn (its inline place and size). */
function drawn(testId: string) {
  const el = screen.getByTestId(testId);
  const [x, y, w, h] = [el.style.left, el.style.top, el.style.width, el.style.height].map((v) => parseFloat(v));
  return { x, y, w, h, top: y, bottom: y + h, left: x, right: x + w };
}

/** Opens the keyboard `height` px tall with the message field focused, as iOS does: only the visual viewport shrinks. */
async function keyboard(height: number, { page = false } = {}) {
  screen.getByRole("textbox", { name: "Message" }).focus();
  await act(async () => {
    viewport.height = inner.h - height;
    // Android's resizes-content: the page gets shorter with it.
    if (page) {
      inner = { ...inner, h: viewport.height };
      window.dispatchEvent(new Event("resize"));
    }
    composer = { top: viewport.height - 66, bottom: viewport.height };
    viewport.dispatchEvent(new Event("resize"));
  });
}

async function keyboardDown({ page = false, tall }: { page?: boolean; tall: number }) {
  const field = screen.getByRole("textbox", { name: "Message" });
  await act(async () => {
    if (page) {
      inner = { ...inner, h: tall };
      window.dispatchEvent(new Event("resize"));
    }
    viewport.height = tall;
    composer = { top: tall - 66, bottom: tall };
    viewport.dispatchEvent(new Event("resize"));
  });
  await act(async () => { field.blur(); });
}

const overlaps = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) => a.top < b.bottom && a.bottom > b.top;

describe.each([
  { what: "the 1:1 call's small window", ui: oneToOne, testId: "call-window", mute: "Mute", end: "End call" },
  { what: "the group call's small window", ui: group, testId: "group-call", mute: "Mute", end: "Leave call" },
])("$what with a phone's keyboard up", ({ ui, testId, mute, end }) => {
  it("on its side becomes a one-line bar over the chat's header, clear of the message field, Mute and End call in it", async () => {
    screenIs(SIDE);
    renderApp(ui());
    const before = drawn(testId);
    const muteButton = screen.getByRole("button", { name: mute }), endButton = screen.getByRole("button", { name: end });
    // Where it was: over the field's end once the keyboard is up (y 103-271 against the field's 109-175).
    expect(overlaps(before, SIDE.composer)).toBe(true);

    await keyboard(SIDE.keyboard);
    expect(document.documentElement.dataset.keyboard).toBe("true");
    const small = screen.getByTestId(testId);
    expect(small).toHaveAttribute("data-compact", "true");
    const bar = drawn(testId);
    // At the top of what is left, on the chat's header, and wholly in what is visible.
    expect(bar.top).toBeGreaterThanOrEqual(0);
    expect(bar.bottom).toBeLessThanOrEqual(HEADER);
    expect(bar.h).toBeGreaterThanOrEqual(44);
    expect(overlaps(bar, SIDE.composer)).toBe(false);
    expect(bar.left).toBeGreaterThanOrEqual(0);
    expect(bar.right).toBeLessThanOrEqual(SIDE.w);
    // On the side of its corner (the bottom right): the header's back button stays clear.
    expect(bar.right).toBeGreaterThan(SIDE.w / 2);
    // The same buttons, by the same names, kept for the bar (index.css hides the rest); no grips to drag it by.
    expect(screen.getByRole("button", { name: mute })).toBe(muteButton);
    expect(screen.getByRole("button", { name: end })).toBe(endButton);
    expect(muteButton).toHaveClass("call-compact-keep");
    expect(endButton).toHaveClass("call-compact-keep");
    expect(small.querySelector("[data-handle]")).toBeNull();
    expect(small.querySelector(".call-compact-name")).toHaveTextContent(testId === "call-window" ? "Ana" : "Community");
    // The person is typing: the focus stays in the field.
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();

    // Keyboard down: the small window again, where it was.
    await keyboardDown({ tall: SIDE.h });
    expect(document.documentElement.dataset.keyboard).toBe("false");
    expect(screen.getByTestId(testId)).not.toHaveAttribute("data-compact");
    expect(drawn(testId)).toEqual(before);
    expect(screen.getByTestId(testId).querySelectorAll("[data-handle]")).toHaveLength(4);
  });

  it("upright moves above the message field, on its side, and is back in its corner after", async () => {
    screenIs(UPRIGHT);
    renderApp(ui());
    const before = drawn(testId);
    const visible = UPRIGHT.h - UPRIGHT.keyboard;
    // Where it was: wholly behind the keyboard (y 395-563, 367 px left).
    expect(before.top).toBeGreaterThanOrEqual(visible);

    await keyboard(UPRIGHT.keyboard);
    expect(screen.getByTestId(testId)).not.toHaveAttribute("data-compact");
    const moved = drawn(testId);
    expect(moved.top).toBeGreaterThanOrEqual(HEADER);
    expect(moved.bottom).toBeLessThanOrEqual(UPRIGHT.composer.top);
    expect(overlaps(moved, UPRIGHT.composer)).toBe(false);
    // The same size, on the same side.
    expect([moved.x, moved.w, moved.h]).toEqual([before.x, before.w, before.h]);

    await keyboardDown({ tall: UPRIGHT.h });
    expect(drawn(testId)).toEqual(before);
  });
});

describe("the small window's place with the keyboard up", () => {
  it("is not saved: a window dragged to the top left corner is back there after the keyboard, on its side", async () => {
    screenIs(SIDE);
    localStorage.setItem("ghostly_call_window_box", JSON.stringify({ x: 8, y: 8, w: 264, h: 168 }));
    renderApp(oneToOne());
    await keyboard(SIDE.keyboard);
    const bar = drawn("call-window");
    // At the top left, as the window was.
    expect(bar.left).toBe(8);
    await keyboardDown({ tall: SIDE.h });
    expect(drawn("call-window")).toMatchObject({ x: 8, y: 8, w: 264, h: 168 });
    expect(JSON.parse(localStorage.getItem("ghostly_call_window_box")!)).toEqual({ x: 8, y: 8, w: 264, h: 168 });
  });

  it("is back in its corner where the keyboard makes the whole page shorter (Android's resizes-content)", async () => {
    screenIs(SIDE);
    renderApp(oneToOne());
    const before = drawn("call-window");
    await keyboard(SIDE.keyboard, { page: true });
    expect(document.documentElement.dataset.keyboard).toBe("true");
    expect(screen.getByTestId("call-window")).toHaveAttribute("data-compact", "true");
    expect(overlaps(drawn("call-window"), { top: 109, bottom: 175 })).toBe(false);
    await keyboardDown({ page: true, tall: SIDE.h });
    // It came back at the top: squeezed to 8 px with the page 175 px tall, and kept there.
    expect(drawn("call-window")).toEqual(before);
  });

  it("is unchanged on a computer: no keyboard there, a shorter window with a field focused moves nothing", async () => {
    screenIs({ w: 1280, h: 800, composer: { top: 734, bottom: 800 } }, false);
    renderApp(oneToOne());
    const before = drawn("call-window");
    await keyboard(300);
    expect(document.documentElement.dataset.keyboard).toBe("false");
    expect(screen.getByTestId("call-window")).not.toHaveAttribute("data-compact");
    expect(drawn("call-window")).toEqual(before);
  });

  it("reads the message field again as it changes, not at every frame the keyboard is up", async () => {
    vi.stubGlobal("ResizeObserver", FrameObserver);
    screenIs(UPRIGHT);
    renderApp(oneToOne());
    await keyboard(UPRIGHT.keyboard);
    await act(async () => { FrameObserver.frame(); });
    const settled = composerReads, above = drawn("call-window");
    // A second of frames with nothing changed: the field observed again at each read reported again at the next frame,
    // and was read 60 times a second (a forced layout each) for as long as the keyboard stayed up.
    await act(async () => { for (let i = 0; i < 60; i++) FrameObserver.frame(); });
    expect(composerReads - settled).toBe(0);
    expect(drawn("call-window")).toEqual(above);
    // A second line in the field: read again, and the window moves up with its top.
    composer = { ...composer, top: composer.top - 22 };
    const field = document.querySelector("[data-composer]")!;
    await act(async () => { FrameObserver.resized(field); FrameObserver.frame(); });
    expect(composerReads - settled).toBe(1);
    expect(drawn("call-window").bottom).toBeLessThanOrEqual(composer.top);
    expect(drawn("call-window").bottom).toBeLessThan(above.bottom);
  });

  it("leaves the whole-screen call as it is", async () => {
    screenIs(SIDE);
    localStorage.setItem("ghostly_call_mini", "0");
    renderApp(
      <Chat>
        <CallOverlay callState="connected" localStream={null} remoteStream={null} isMuted={false} isVideoOff remoteHasVideo={false}
          callStartedAt={Date.now()} peerName="Ana" onHangUp={vi.fn()} onToggleMute={vi.fn()} onToggleVideo={vi.fn()} />
      </Chat>,
    );
    await keyboard(SIDE.keyboard);
    const whole = screen.getByTestId("call-window");
    expect(whole).toHaveAttribute("data-mini", "false");
    expect(whole).not.toHaveAttribute("data-compact");
    expect(whole.style.top).toBe("");
  });
});

describe("the bar's look (index.css)", () => {
  const css = readFileSync(join(fileURLToPath(import.meta.url), "../../../index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("keeps only who, the clock, Mute and End call on one line, and only hides the pictures", () => {
    expect(css).toMatch(/\.call-mini\[data-compact\] \{\s*flex-direction: row;/);
    expect(css).toMatch(/\.call-mini\[data-compact\] \.call-controls > :not\(\.call-compact-keep\) \{\s*display: none;/);
    expect(css).toMatch(/\.call-mini\[data-compact\] > video,\s*\.call-mini\[data-compact\] > \.call-preview \{\s*visibility: hidden;/);
    expect(css).toMatch(/\.call-mini\[data-compact\] \.call-controls button,[^{]*\{\s*width: 44px;\s*height: 44px;/);
  });
});
