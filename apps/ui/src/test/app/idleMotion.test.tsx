import { act, render, renderHook, screen } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PairingGlyph } from "../../components/pairing/PairingGlyph";
import { MOTION_REST_MS, refreshWindowAway, useMotionRest, useWindowAway, watchWindowAway } from "../../lib/windowAway";

// covers: app.idle, chat.paired.pairing-progress

const SRC = join(fileURLToPath(import.meta.url), "../../..");
const stylesheets = (dir = SRC): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? (entry.name === "test" ? [] : stylesheets(join(dir, entry.name))) : entry.name.endsWith(".css") ? [join(dir, entry.name)] : []);
/** Every `selector { declarations }` of a stylesheet, comments out, at any depth (a rule inside @media is one too). */
const rules = (css: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));

let focused = true, hidden = false;
function setWindow(next: { focused?: boolean; hidden?: boolean }) {
  focused = next.focused ?? focused; hidden = next.hidden ?? hidden;
  act(() => { window.dispatchEvent(new Event(focused ? "focus" : "blur")); document.dispatchEvent(new Event("visibilitychange")); });
}

beforeEach(() => {
  focused = true; hidden = false;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
  watchWindowAway();
  refreshWindowAway();
});
afterEach(() => { vi.useRealTimers(); });

describe("the stylesheets", () => {
  const index = readFileSync(join(SRC, "index.css"), "utf8");
  const away = rules(index).filter(rule => rule.selector.includes(":root[data-away]")).map(rule => rule.selector).join(" ");

  it("the ghost of the empty chat list and the syncing mark say boo a few times, then rest", () => {
    const boo = rules(index).find(rule => rule.selector === ".animate-ghost-boo")!;
    expect(boo.body).toMatch(/animation: ghost-boo 1s ease-in-out 3;/);
    // Where it rests is where the motion starts and ends: nothing jumps when it stops.
    expect(boo.body).toMatch(/opacity: 0\.35;/);
    expect(index).toMatch(/@keyframes ghost-boo \{\s*0%, 100% \{[^}]*opacity: 0\.35;/);
  });

  it("Tailwind's spinner and pulse end by themselves", () => {
    expect(index).toMatch(/--animate-spin: spin 1s linear 120;/);
    expect(index).toMatch(/--animate-pulse: pulse 2s cubic-bezier\(0\.4, 0, 0\.6, 1\) 15;/);
  });

  it("every loop holds still while the window is away", () => {
    expect(away).toMatch(/animate-spin/);
    expect(away).toMatch(/animate-pulse[,)]/);
    const loops = stylesheets().flatMap(file => rules(readFileSync(file, "utf8")).filter(rule => /\binfinite\b/.test(rule.body)).map(rule => ({ file, ...rule })));
    expect(loops.length).toBeGreaterThan(10);
    const missing = loops.filter(({ selector }) => {
      // The pairing scene pauses as a whole (PairingScene.tsx sets data-paused while the window is away).
      if (/^\.ps\b/.test(selector)) return false;
      // What moves: the selector's last class, with what follows it (`.typing-dots > span`, `.new-wallet-shimmer::after`).
      const subject = selector.split(",")[0].match(/\.[\w-]+(?:\[[^\]]*\])?(?:\s*>\s*\w+|::\w+)?$/)?.[0] ?? selector;
      return !away.includes(subject);
    });
    expect(missing.map(({ file, selector }) => `${file.slice(SRC.length + 1)}: ${selector}`)).toEqual([]);
  });

  it("the scene and the glyph have a still picture for a stage that has lasted", () => {
    const css = readFileSync(join(SRC, "components/pairing/pairing-scene.css"), "utf8");
    expect(css).toMatch(/\.ps\[data-still\] \* \{ animation: none !important; \}/);
    expect(css).toMatch(/\.pg\[data-still\] \.pi-packet \{ animation: none !important;/);
  });

  it("the new wallet's light runs with a transform, not with left", () => {
    const css = readFileSync(join(SRC, "components/wallet/new-wallet.css"), "utf8");
    expect(css).toMatch(/@keyframes new-wallet-run\{from\{transform:translateX\(-100%\)\}to\{transform:translateX\(250%\)\}\}/);
  });
});

describe("the window away", () => {
  it("marks <html> while the window is hidden or not the focused one, and unmarks it when it is back", () => {
    expect(document.documentElement).not.toHaveAttribute("data-away");
    setWindow({ focused: false });
    expect(document.documentElement).toHaveAttribute("data-away");
    setWindow({ focused: true });
    expect(document.documentElement).not.toHaveAttribute("data-away");
    setWindow({ hidden: true });
    expect(document.documentElement).toHaveAttribute("data-away");
    setWindow({ hidden: false });
    expect(document.documentElement).not.toHaveAttribute("data-away");
  });

  it("tells components", () => {
    const { result } = renderHook(() => useWindowAway());
    expect(result.current).toBe(false);
    setWindow({ focused: false });
    expect(result.current).toBe(true);
    setWindow({ focused: true });
    expect(result.current).toBe(false);
  });
});

describe("motion that rests", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it("rests once a state has lasted, and moves again with a new state", () => {
    const { result, rerender } = renderHook(({ state }) => useMotionRest(state), { initialProps: { state: "waiting" } });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(MOTION_REST_MS - 1); });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(true);
    rerender({ state: "knocking" });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(MOTION_REST_MS); });
    expect(result.current).toBe(true);
  });

  it("moves again when the window comes back, and counts no time while it is away", () => {
    const { result } = renderHook(() => useMotionRest("waiting"));
    act(() => { vi.advanceTimersByTime(MOTION_REST_MS); });
    expect(result.current).toBe(true);
    setWindow({ focused: false });
    expect(result.current).toBe(true);
    setWindow({ focused: true });
    expect(result.current).toBe(false);
    setWindow({ focused: false });
    act(() => { vi.advanceTimersByTime(MOTION_REST_MS * 3); });
    expect(result.current).toBe(false);
    setWindow({ focused: true });
    act(() => { vi.advanceTimersByTime(MOTION_REST_MS); });
    expect(result.current).toBe(true);
  });

  it("the pairing glyph's packet rests after a minute in one stage", () => {
    const { rerender } = render(<PairingGlyph stage="waiting" direction="out" size={18} />);
    const glyph = () => screen.getByTestId("pairing-glyph");
    expect(glyph()).not.toHaveAttribute("data-still");
    act(() => { vi.advanceTimersByTime(MOTION_REST_MS); });
    expect(glyph()).toHaveAttribute("data-still");
    rerender(<PairingGlyph stage="knocking" direction="out" size={18} />);
    expect(glyph()).not.toHaveAttribute("data-still");
  });
});
