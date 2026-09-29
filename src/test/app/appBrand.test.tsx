import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppBrand } from "../../components/AppBrand";
import { BRAND_MOTION_KEY, resetBrandLaunch } from "../../lib/brandMotion";
import { renderApp } from "../render";

// covers: app.home, wallet.mode

const brand = () => screen.getByTestId("app-brand");
const playing = () => [brand().getAttribute("data-motion"), brand().getAttribute("data-on")];
const open = () => renderApp(<AppBrand onHome={() => {}} />);
const hover = (pointerType = "mouse") => fireEvent.pointerOver(brand(), { pointerType });

describe("the logo at the top of the chat list", () => {
  beforeEach(() => { resetBrandLaunch(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("is the ghost and GHOSTLY, one link home, with no Testnet badge and no way to the wallets", () => {
    open();
    expect(screen.getByRole("link", { name: "Go home" })).toHaveTextContent("GHOSTLY");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByTestId("testnet-badge")).not.toBeInTheDocument();
    expect(brand()).not.toHaveTextContent(/testnet/i);
  });

  it("plays one motion when the app opens, then rests; the next open plays the other one", () => {
    const first = open();
    expect(playing()).toEqual(["breathe", "open"]);
    act(() => { vi.advanceTimersByTime(900); });
    expect(playing()).toEqual([null, null]);
    first.unmount();

    resetBrandLaunch(); // the app opens again: the turn was kept
    const second = open();
    expect(playing()).toEqual(["sway", "open"]);
    second.unmount();

    resetBrandLaunch();
    open();
    expect(playing()).toEqual(["breathe", "open"]);
    expect(localStorage.getItem(BRAND_MOTION_KEY)).toBe("breathe");
  });

  it("moves the ghost, each letter and the eyes when the app opens, at once; on hover only the ghost and its eyes", () => {
    const animate = vi.spyOn(Element.prototype, "animate");
    const moved = () => animate.mock.contexts.map((el) => (el as Element).getAttribute("class")?.match(/app-brand-\w+/)?.[0]);
    open();
    expect(moved()).toEqual(["app-brand-ghost", ...Array(7).fill("app-brand-letter"), "app-brand-eyes"]);
    expect(playing(), "nothing to wait for before it plays").toEqual(["breathe", "open"]);
    expect(animate.mock.results.some((r) => (r.value as Animation).playState === "paused"), "no animation held").toBe(false);
    act(() => { vi.advanceTimersByTime(900); });
    animate.mockClear();
    hover();
    expect(playing()).toEqual(["sway", "hover"]);
    expect(moved()).toEqual(["app-brand-ghost", "app-brand-eyes"]);
    expect(animate.mock.calls[0][0]).toEqual([{ transform: "rotate(0deg)" }, { transform: "rotate(-3deg)" }, { transform: "rotate(0deg)" }]);
  });

  it("does not play the opening again when the list mounts again in the same launch", () => {
    open().unmount();
    open();
    expect(playing()).toEqual([null, null]);
  });

  it("on hover plays the other motion, never the same twice in a row, and not over one still playing", () => {
    open();
    hover();
    expect(playing(), "the opening is still playing").toEqual(["breathe", "open"]);
    act(() => { vi.advanceTimersByTime(900); });

    hover();
    expect(playing()).toEqual(["sway", "hover"]);
    act(() => { vi.advanceTimersByTime(720); });
    expect(playing()).toEqual([null, null]);

    hover();
    expect(playing()).toEqual(["breathe", "hover"]);
    act(() => { vi.advanceTimersByTime(420); });
    expect(playing()).toEqual([null, null]);
  });

  it("a touch is a tap, not a hover: it plays nothing", () => {
    open();
    act(() => { vi.advanceTimersByTime(900); });
    hover("touch");
    expect(playing()).toEqual([null, null]);
  });

  it("stays still with the app's Reduce motion: no opening, no hover, and the turn is not used up", () => {
    const animate = vi.spyOn(Element.prototype, "animate");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ reduceMotion: true }));
    open();
    expect(playing()).toEqual([null, null]);
    hover();
    expect(playing()).toEqual([null, null]);
    expect(animate).not.toHaveBeenCalled();
    expect(localStorage.getItem(BRAND_MOTION_KEY)).toBeNull();
  });

  it("stays still when the system asks for reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query === "(prefers-reduced-motion: reduce)", media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }));
    open();
    expect(playing()).toEqual([null, null]);
    hover();
    expect(playing()).toEqual([null, null]);
  });
});
