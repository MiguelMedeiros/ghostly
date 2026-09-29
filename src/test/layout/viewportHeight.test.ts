import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useViewportHeight } from "../../hooks/useViewportHeight";

// covers: app.mobile-layout

/** A visual viewport the test moves, and a window whose `innerHeight` it sets. */
class Viewport extends EventTarget {
  width = 402;
  height = 874;
  offsetTop = 0;
}
let viewport: Viewport;
let inner = 874;

function resize(height: number, innerHeight = inner, width = viewport.width) {
  viewport.height = height;
  viewport.width = width;
  inner = innerHeight;
  act(() => { viewport.dispatchEvent(new Event("resize")); });
}
const keyboard = () => document.documentElement.dataset.keyboard;
const appHeight = () => document.documentElement.style.getPropertyValue("--app-height");

beforeEach(() => {
  viewport = new Viewport();
  inner = 874;
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  Object.defineProperty(window, "innerHeight", { configurable: true, get: () => inner });
});
afterEach(() => {
  Reflect.deleteProperty(window, "visualViewport");
  Reflect.deleteProperty(window, "innerHeight");
  delete document.documentElement.dataset.keyboard;
  document.documentElement.style.removeProperty("--app-height");
});

describe("the app's height and the keyboard", () => {
  it("in Safari, where the page keeps its height under the keyboard", () => {
    renderHook(() => useViewportHeight());
    expect(appHeight()).toBe("874px");
    expect(keyboard()).toBe("false");
    resize(471);
    expect(appHeight()).toBe("471px");
    expect(keyboard()).toBe("true");
    resize(874);
    expect(appHeight()).toBe("874px");
    expect(keyboard()).toBe("false");
  });

  it("in an installed web app or on Android, where the page shrinks with the keyboard", () => {
    renderHook(() => useViewportHeight());
    resize(471, 471);
    expect(appHeight()).toBe("471px");
    expect(keyboard()).toBe("true");
    // iOS puts `innerHeight` back a moment later, with no event: the answer stays the same.
    inner = 874;
    act(() => { viewport.dispatchEvent(new Event("scroll")); });
    expect(keyboard()).toBe("true");
    resize(874, 874);
    expect(keyboard()).toBe("false");
  });

  it("a browser toolbar that slides away is not a keyboard", () => {
    renderHook(() => useViewportHeight());
    resize(800, 800);
    expect(keyboard()).toBe("false");
    resize(874, 874);
    expect(keyboard()).toBe("false");
  });

  it("starts over when the phone turns", () => {
    renderHook(() => useViewportHeight());
    // Landscape: a much shorter screen, with no keyboard.
    resize(402, 402, 874);
    expect(keyboard()).toBe("false");
    resize(180, 180, 874);
    expect(keyboard()).toBe("true");
  });
});

describe("installed", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "standalone");
    delete document.documentElement.dataset.standalone;
  });

  it("says so on the page, which then is as tall as the screen (src/index.css)", () => {
    renderHook(() => useViewportHeight());
    expect(document.documentElement.dataset.standalone).toBe("false");
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    renderHook(() => useViewportHeight());
    expect(document.documentElement.dataset.standalone).toBe("true");
  });
});
