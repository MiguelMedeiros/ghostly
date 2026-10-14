import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApp } from "../../../e2e/support/desktop";
import { framesAfterSeek, playFromStore } from "../../../e2e/support/streamCheck";

/*
 * `playFromStore` (e2e/support/streamCheck.ts) with its page script run in a `node:vm` context, against a `<video>`
 * whose clock runs as a real one does and whose frame count (`getVideoPlaybackQuality().totalVideoFrames`) is each
 * test's own. On a GitHub Mac, WKWebView played a second, seeked and played on with that count at 0 all along, and
 * `desktop-macos/video-stream.spec.ts` read it as a seek that showed no frame.
 */

/** The frames counted so far, from the seconds played in all and the seconds played since the seek (null before it). */
type Count = (played: number, sinceSeek: number | null) => number;

function fakeApp(count: Count | null): DesktopApp {
  const listeners = new Map<string, (() => void)[]>();
  let from = 0, since: number | null = null, playedBefore = 0, seekedAt: number | null = null;
  const running = () => (since === null ? 0 : (performance.now() - since) / 1000);
  const video = {
    style: {}, error: null, readyState: 4, duration: 100,
    addEventListener: (type: string, listener: () => void) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
    play: async () => { since = performance.now(); },
    get currentTime() { return from + running(); },
    set currentTime(to: number) {
      playedBefore += running();
      from = to;
      since = seekedAt = performance.now();
      setTimeout(() => listeners.get("seeked")?.forEach((listener) => listener()), 100);
    },
    ...(count ? { getVideoPlaybackQuality: () => ({ totalVideoFrames: Math.floor(count(playedBefore + running(), seekedAt === null ? null : (performance.now() - seekedAt) / 1000)) }) } : {}),
    pause() {}, removeAttribute() {}, load() {}, remove() {},
  };
  const invoke = async (command: string) => (command === "file_bytes_stream_open" ? { url: "ghostly-file://localhost/token", token: "token" } : null);
  const page = createContext({
    document: { createElement: () => video, body: { append() {} }, visibilityState: "visible" },
    window: { __TAURI_INTERNALS__: { invoke } },
    performance: { now: () => performance.now() },
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
  });
  return {
    executeAsync: (script: string, ...args: unknown[]) => new Promise((done) => {
      (runInContext(`(function () { ${script} })`, page) as (...all: unknown[]) => void)(...args, done);
    }),
  } as unknown as DesktopApp;
}

async function play(count: Count | null) {
  const report = playFromStore(fakeApp(count), { space: "space", id: "id" }, 90);
  await vi.advanceTimersByTimeAsync(60_000);
  return report;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("the frame count of a video that plays, seeks and plays on", () => {
  it("counts new frames after the seek", async () => {
    const report = await play((played) => played * 30);
    expect(report.error).toBeUndefined();
    expect(report.seekedTo).toBeGreaterThanOrEqual(90);
    expect(report.playedAfterSeek).toBeGreaterThan(91);
    expect(report.framesBeforeSeek).toBeGreaterThan(0);
    expect(framesAfterSeek(report)).toBe("new frames");
  });

  it("a count that never left 0, before the seek either, says nothing of the seek", async () => {
    const report = await play(() => 0);
    expect(report.error).toBeUndefined();
    expect(report).toMatchObject({ frames: 0, framesBeforeSeek: 0, readyAfterSeek: 4, visibility: "visible" });
    expect(framesAfterSeek(report)).toBe("not counted");
  });

  it("an engine without the count says nothing of the seek", async () => {
    const report = await play(null);
    expect(report).toMatchObject({ frames: -1, framesBeforeSeek: -1 });
    expect(framesAfterSeek(report)).toBe("not counted");
  });

  it("waits for a count that starts a moment after the clock, before the seek", async () => {
    const report = await play((played) => Math.max(0, played - 1.5) * 30);
    expect(report.framesBeforeSeek).toBeGreaterThan(0);
    expect(framesAfterSeek(report)).toBe("new frames");
  });

  it("waits for the first frame counted after the seek", async () => {
    // Counted again three seconds after the seek: the clock is past 91 by then, and the count is as it was.
    const report = await play((played, sinceSeek) => (sinceSeek === null ? played : played - Math.min(sinceSeek, 3)) * 30);
    expect(framesAfterSeek(report)).toBe("new frames");
  });

  it("a seek after which no frame is counted, where frames were counted before it, fails the check", async () => {
    const report = await play((played, sinceSeek) => (played - (sinceSeek ?? 0)) * 30);
    expect(report.playedAfterSeek).toBeGreaterThan(91);
    expect(report.framesBeforeSeek).toBeGreaterThan(0);
    expect(framesAfterSeek(report)).toBe("no new frame");
  });
});
