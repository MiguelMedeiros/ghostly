import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrollIntoViewGently } from "../../lib/motion";
import { jumpToMessage } from "../../lib/replies";

// covers: app.reduce-motion, chat.paired.pairing-progress, chat.replies

/** The system's Reduce motion, as `matchMedia` answers it. */
function systemReduces(reduce: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: reduce && query === "(prefers-reduced-motion: reduce)", media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }));
}

function element() {
  const el = document.createElement("div");
  const scrollIntoView = vi.fn();
  el.scrollIntoView = scrollIntoView;
  document.body.append(el);
  return { el, scrollIntoView };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.reduceMotion;
  document.body.replaceChildren();
});

describe("scrolls that respect Reduce motion", () => {
  it("glide by default", () => {
    systemReduces(false);
    const { el, scrollIntoView } = element();
    scrollIntoViewGently(el);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });

  it("jump when the system asks for less motion", () => {
    systemReduces(true);
    const { el, scrollIntoView } = element();
    scrollIntoViewGently(el, "nearest");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "auto" });
  });

  it("jump when the app's own Reduce motion switch is on", () => {
    systemReduces(false);
    document.documentElement.dataset.reduceMotion = "true";
    const { el, scrollIntoView } = element();
    scrollIntoViewGently(el);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
  });

  it("do nothing without an element", () => {
    expect(() => scrollIntoViewGently(null)).not.toThrow();
  });

  it("a jump to a quoted message follows the app's switch too, not only the system's", () => {
    systemReduces(false);
    document.documentElement.dataset.reduceMotion = "true";
    const { el, scrollIntoView } = element();
    el.dataset.messageId = "m1";
    expect(jumpToMessage("m1")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
  });

  it("the chat's Show pairing progress takes the gentle scroll: no smooth scroll is written in the page", () => {
    const source = readFileSync(join(fileURLToPath(import.meta.url), "../../../pages/Chat.tsx"), "utf8");
    expect(source).toMatch(/scrollIntoViewGently\(document\.getElementById\(pairingSceneId\)\)/);
    expect(source).not.toMatch(/behavior:\s*"smooth"/);
  });
});
