import { describe, expect, it, vi } from "vitest";
import { restartWhenRestored } from "../../lib/restoredPage";

/** A `pageshow` as the browser sends it: `persisted` when the page came out of the back/forward cache. */
const pageshow = (persisted: boolean) => Object.assign(new Event("pageshow"), { persisted });

describe("a page that comes back from the back/forward cache", () => {
  it("starts again: it had said goodbye and stopped its peer when it left", () => {
    const restart = vi.fn();
    const stop = restartWhenRestored(window, restart);
    try {
      window.dispatchEvent(pageshow(true));
      expect(restart).toHaveBeenCalledTimes(1);
    } finally { stop(); }
  });

  it("a page shown for the first time is left alone", () => {
    const restart = vi.fn();
    const stop = restartWhenRestored(window, restart);
    try {
      window.dispatchEvent(pageshow(false));
      expect(restart).not.toHaveBeenCalled();
    } finally { stop(); }
    window.dispatchEvent(pageshow(true));
    expect(restart).not.toHaveBeenCalled();
  });
});
