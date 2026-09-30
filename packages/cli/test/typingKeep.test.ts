import { afterEach, describe, expect, it, vi } from "vitest";
import { TYPING_TIMEOUT_MS, TypingSender, typingActivity } from "@ghostly/core";
import type { ApiContext } from "../src/api";
import { keepTyping } from "../src/typing";
// covers: headless.typing

/**
 * `typing --for` against the engine's own `TypingSender`: each ask reaches it a few milliseconds after its tick, as on
 * a daemon with other work, so the tick that lands at the refresh can find it a millisecond short and be skipped.
 */
function fakeEngine() {
  let now = 0, seed = 7;
  const sender = new TypingSender(() => now);
  const sent: number[] = [];
  const node = {
    setTyping: ({ typing, kind, status }: { typing: boolean; kind?: string; status?: string }) => {
      // The ask runs 0 to 19 ms after its tick.
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      now = Date.now() + (seed % 20);
      const frame = typing ? sender.typing(typingActivity(kind, status)) : sender.stopped();
      if (frame?.s === "start") sent.push(now);
    },
  };
  const ctx = { runtime: { server: { node } }, hub: { onEvent: () => () => {} }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node, sent };
}

describe("typing --for", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("says start again well inside the contact's 6 s, whichever tick the engine skips", async () => {
    vi.useFakeTimers();
    const { ctx, node, sent } = fakeEngine();
    node.setTyping({ typing: true, kind: "thinking", status: "Working" });
    const kept = keepTyping(ctx, { linkId: "chat-one" }, 120_000, { kind: "thinking", status: "Working" });
    await vi.advanceTimersByTimeAsync(120_000);
    await kept;
    const gaps = sent.slice(1).map((at, i) => at - sent[i]);
    expect(gaps.length).toBeGreaterThan(30);
    // At most a refresh and one tick: 2.5 s left for a slow link or a busy contact before its timeout.
    expect(Math.max(...gaps)).toBeLessThanOrEqual(TYPING_TIMEOUT_MS - 2_400);
  });
});
