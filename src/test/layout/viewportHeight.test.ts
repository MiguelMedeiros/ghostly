import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("a hardware keyboard's shortcut bar counts while a field has the focus", () => {
    renderHook(() => useViewportHeight());
    const field = document.body.appendChild(document.createElement("textarea"));
    try {
      // An iPhone on its side: the bar leaves 334 of 402px, less than a keyboard takes.
      resize(402, 402, 874);
      act(() => field.focus());
      resize(334, 402, 874);
      expect(appHeight()).toBe("334px");
      expect(keyboard()).toBe("true");
      // The field loses the focus and the bar goes.
      act(() => field.blur());
      resize(402, 402, 874);
      expect(keyboard()).toBe("false");
      // Without a field, a gap that small is a toolbar sliding away.
      resize(334, 402, 874);
      expect(keyboard()).toBe("false");
    } finally {
      field.remove();
    }
  });

  it("keeps the shortcut bar once the phone turns, while iOS reports the whole height again", () => {
    renderHook(() => useViewportHeight());
    const field = document.body.appendChild(document.createElement("textarea"));
    try {
      act(() => field.focus());
      resize(806);
      expect(appHeight()).toBe("806px");
      // On its side: iOS reports the whole screen, the bar still over the field.
      resize(402, 402, 874);
      expect(appHeight()).toBe("334px");
      expect(keyboard()).toBe("true");
      // And upright again.
      resize(806, 874, 402);
      resize(874, 874, 402);
      expect(appHeight()).toBe("806px");
      // Done: the field loses the focus, the bar goes, and nothing resizes.
      act(() => field.blur());
      expect(appHeight()).toBe("874px");
      expect(keyboard()).toBe("false");
      // A new focus with nothing covered and no turn is not a bar.
      act(() => field.focus());
      expect(appHeight()).toBe("874px");
      expect(keyboard()).toBe("false");
    } finally {
      field.remove();
    }
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

describe("the focused field and the keyboard", () => {
  /** A text field at `top`..`top + 40` in the page, focused, whose scrolling the test watches. */
  function field(top: number) {
    const input = document.body.appendChild(document.createElement("input"));
    input.getBoundingClientRect = () => ({ top, bottom: top + 40, left: 0, right: 300, width: 300, height: 40, x: 0, y: top, toJSON() {} });
    input.scrollIntoView = vi.fn();
    input.focus();
    return input;
  }
  const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  afterEach(() => { document.body.innerHTML = ""; });

  it("brings a field the keyboard came up over into what is left", async () => {
    renderHook(() => useViewportHeight());
    const low = field(675);
    resize(471);
    await frame();
    expect(low.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });

  it("leaves a field already in view where it is", async () => {
    renderHook(() => useViewportHeight());
    const high = field(132);
    resize(471);
    await frame();
    expect(high.scrollIntoView).not.toHaveBeenCalled();
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
