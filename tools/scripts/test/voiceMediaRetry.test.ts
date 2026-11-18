import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeState, playInPage, shouldRetry } from "../../../e2e/support/voice-media.mjs";

// covers: files.voice.play
/*
 * The macOS WKWebView voice check (tools/scripts/voice-media/check-wkwebview.mjs) plays each recording with
 * `playInPage` (e2e/support/voice-media.mjs) and plays once more, in a fresh WebView, only what `shouldRetry` picks.
 * On a busy GitHub Mac the AAC recording now and then stayed at 0.00 s for the whole 8 s while the WebM one beside
 * it played, and the job failed a whole train batch. Here `playInPage` runs against a fake `Audio` whose behaviour
 * each test sets, with fake timers for the 8 s window.
 */

type Behaviour = (audio: FakeAudio) => void;

class FakeAudio {
  static behave: Behaviour = () => {};
  static made: FakeAudio[] = [];
  muted = false;
  src = "";
  readyState = 0;
  networkState = 0;
  error: { code: number; message: string } | null = null;
  currentTime = 0;
  paused = true;
  ranges: [number, number][] = [];
  playRefusal: Error | null = null;
  private listeners = new Map<string, (() => void)[]>();
  constructor() { FakeAudio.made.push(this); }
  get buffered() {
    const ranges = this.ranges;
    return { length: ranges.length, start: (i: number) => ranges[i]![0], end: (i: number) => ranges[i]![1] };
  }
  canPlayType() { return "maybe"; }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  emit(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(); }
  play() {
    if (this.playRefusal) return Promise.reject(this.playRefusal);
    this.paused = false;
    queueMicrotask(() => FakeAudio.behave(this));
    return Promise.resolve();
  }
  pause() { this.paused = true; }
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
}

/** Loaded its metadata, then its clock never moved: what the macOS runner showed. */
const stall: Behaviour = (audio) => { audio.readyState = 1; audio.networkState = 2; };
/** The engine cannot decode it: a real codec failure. */
const decodeError: Behaviour = (audio) => {
  audio.networkState = 3;
  audio.error = { code: 4, message: "MEDIA_ERR_SRC_NOT_SUPPORTED" };
  audio.emit("error");
};
const plays: Behaviour = (audio) => {
  audio.readyState = 4;
  audio.ranges = [[0, 4.98]];
  audio.currentTime = 0.5;
  audio.emit("timeupdate");
};

type Played = { canPlay: string; played: boolean; stalled?: boolean; error?: string; state?: Record<string, unknown> };
const played = (out: unknown) => (out as Record<string, Played>)[fixture.name]!;

const fixture = { name: "macos-wkwebview.m4a", mime: "audio/mp4", base64: "AAAA" };

async function play(behave: Behaviour) {
  FakeAudio.behave = behave;
  const pending = playInPage([fixture]);
  await vi.advanceTimersByTimeAsync(8_000);
  return played(await pending);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Audio", FakeAudio);
  FakeAudio.made = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("playInPage and shouldRetry (macOS WKWebView voice check)", () => {
  it("plays a play stalled at 0 with no media error once more, and reports what the element was doing", async () => {
    const first = await play(stall);
    expect(first).toMatchObject({ played: false, stalled: true, error: "stuck at 0.00 s" });
    expect(first.state).toEqual({ readyState: 1, networkState: 2, error: null, buffered: [], currentTime: 0, paused: false });
    expect(shouldRetry(first, 1)).toBe(true);
    expect(describeState(first.state)).toBe("readyState 1, networkState 2, error none, buffered none, at 0.00 s, not paused");
  });

  it("fails a second stall: one retry, no more", async () => {
    const first = await play(stall);
    expect(shouldRetry(first, 1)).toBe(true);
    const second = await play(stall);
    expect(second).toMatchObject({ played: false, stalled: true });
    expect(shouldRetry(second, 2)).toBe(false);
    // Each try made its own element.
    expect(FakeAudio.made).toHaveLength(2);
  });

  it("passes a retry that plays", async () => {
    expect(shouldRetry(await play(stall), 1)).toBe(true);
    const second = await play(plays);
    expect(second).toEqual({ canPlay: "maybe", played: true });
    expect(shouldRetry(second, 2)).toBe(false);
  });

  it("fails a media error at once: a codec or policy failure is never retried away", async () => {
    const result = await play(decodeError);
    expect(result).toMatchObject({ played: false, error: "MediaError 4 MEDIA_ERR_SRC_NOT_SUPPORTED" });
    expect(result.stalled).toBeUndefined();
    expect(result.state).toMatchObject({ networkState: 3, error: 4 });
    expect(shouldRetry(result, 1)).toBe(false);
  });

  it("fails at once when the window ends with a media error set but no error event", async () => {
    const result = await play((audio) => { stall(audio); audio.error = { code: 3, message: "MEDIA_ERR_DECODE" }; });
    expect(result).toMatchObject({ played: false, error: "MediaError 3 MEDIA_ERR_DECODE" });
    expect(result.stalled).toBeUndefined();
    expect(shouldRetry(result, 1)).toBe(false);
  });

  it("fails a refused play() at once", async () => {
    FakeAudio.behave = () => {};
    const refused = Object.assign(new Error("not allowed"), { name: "NotAllowedError" });
    vi.stubGlobal("Audio", class extends FakeAudio { constructor() { super(); this.playRefusal = refused; } });
    const result = played(await playInPage([fixture]));
    expect(result).toMatchObject({ played: false, error: "play() NotAllowedError: not allowed" });
    expect(shouldRetry(result, 1)).toBe(false);
  });

  it("does not retry a clock that moved and then stopped short of 0.3 s", async () => {
    const result = await play((audio) => { stall(audio); audio.ranges = [[0, 4.98]]; audio.currentTime = 0.2; });
    expect(result).toMatchObject({ played: false, stalled: true, error: "stuck at 0.20 s" });
    expect(describeState(result.state)).toBe("readyState 1, networkState 2, error none, buffered 0.00-4.98, at 0.20 s, not paused");
    expect(shouldRetry(result, 1)).toBe(false);
  });

  it("does not retry a recording that played", async () => {
    const result = await play(plays);
    expect(result.state).toBeUndefined();
    expect(shouldRetry(result, 1)).toBe(false);
  });
});
