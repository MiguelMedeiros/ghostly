import { afterEach, describe, expect, it, vi } from "vitest";
import { pacer, yieldThread } from "../src/appBundle";
// covers: apps.bundle, apps.store

describe("letting the thread go", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("never takes scheduler.yield: in Chromium its turn outranks the page's timers, port messages and IndexedDB answers", async () => {
    const yields = vi.fn(async () => {});
    vi.stubGlobal("scheduler", { yield: yields });
    const posts = vi.spyOn(MessagePort.prototype, "postMessage");
    await yieldThread();
    expect(yields).not.toHaveBeenCalled();
    expect(posts).toHaveBeenCalledTimes(1);
  });

  it("is a message to itself, never a timer the browser clamps to 4 ms", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    let after = false;
    const done = yieldThread().then(() => { after = true; });
    // Not before the thread was let go.
    await Promise.resolve();
    expect(after).toBe(false);
    await done;
    expect(timers).not.toHaveBeenCalled();
    // Each turn is short: 200 of them in well under the 800 ms clamped timers would take.
    const start = performance.now();
    for (let i = 0; i < 200; i++) await yieldThread();
    expect(performance.now() - start).toBeLessThan(400);
  });

  it("a pacer lets it go once its slice of work has run, and answers at once before", async () => {
    const yields = vi.spyOn(MessagePort.prototype, "postMessage");
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const pause = pacer(10);
    clock = 9;
    expect(pause()).toBeUndefined();
    clock = 10;
    await pause();
    expect(yields).toHaveBeenCalledTimes(1);
    // The slice starts again after the pause.
    clock = 19;
    expect(pause()).toBeUndefined();
    clock = 20;
    await pause();
    expect(yields).toHaveBeenCalledTimes(2);
  });
});
