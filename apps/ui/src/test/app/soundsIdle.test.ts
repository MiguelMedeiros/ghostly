import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// covers: app.attention.sounds

/**
 * The app's sounds share one AudioContext. A running context keeps the system's audio output open (WebKitGTK: its
 * Web Audio threads and a stream on PipeWire, about 4% CPU on a laptop with nothing playing), so between sounds it is
 * suspended, and it is resumed for the next one.
 */
class FakeAudioContext {
  static made: FakeAudioContext[] = [];
  state: AudioContextState = "suspended";
  currentTime = 0;
  destination = {};
  resumes = 0;
  suspends = 0;
  closes = 0;
  /** A resume of a context that was suspended before: what holds a WebKitGTK page for seconds. */
  resumesAfterSuspend = 0;
  started: number[] = [];
  constructor() { FakeAudioContext.made.push(this); }
  resume() { this.resumes++; if (this.suspends) this.resumesAfterSuspend++; this.state = "running"; return Promise.resolve(); }
  suspend() { this.suspends++; this.state = "suspended"; return Promise.resolve(); }
  close() { this.closes++; this.state = "closed"; return Promise.resolve(); }
  decodeAudioData() { return Promise.reject(new Error("no decoder")); }
  createGain() { return { connect: (to: unknown) => to, gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
  createOscillator() {
    const started = this.started;
    return { type: "sine", connect: (to: unknown) => to, frequency: { setValueAtTime: (hz: number) => started.push(hz) }, start() {}, stop() {} };
  }
  createBufferSource() { return { buffer: null, connect: (to: unknown) => to, start() {}, stop() {} }; }
}

let sounds: typeof import("../../lib/sounds");
let uninstall: () => void;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(async () => {
  vi.useFakeTimers();
  FakeAudioContext.made = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.resetModules();
  sounds = await import("../../lib/sounds");
  uninstall = sounds.installAudioGestures();
  // A person's first gesture unlocks audio.
  document.dispatchEvent(new Event("pointerdown"));
  await vi.advanceTimersByTimeAsync(0);
});

afterEach(() => {
  uninstall();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the sounds' audio output between sounds", () => {
  it("is let go of a few seconds after the last sound, not kept open while nothing plays", async () => {
    const context = FakeAudioContext.made[0]!;
    expect(context.state).toBe("running");
    await vi.advanceTimersByTimeAsync(sounds.SOUNDS_IDLE_MS);
    expect(context.state).toBe("suspended");
    // A sound, then quiet again: suspended once more after it.
    sounds.playSound("message");
    await flush();
    expect(context.state).toBe("running");
    await vi.advanceTimersByTimeAsync(sounds.SOUNDS_IDLE_MS + 2_000);
    expect(context.state).toBe("suspended");
  });

  it("comes back for the next sound, which then plays in full", async () => {
    const context = FakeAudioContext.made[0]!;
    await vi.advanceTimersByTimeAsync(sounds.SOUNDS_IDLE_MS);
    const resumes = context.resumes;
    sounds.playSound("message");
    await flush();
    expect(context.resumes).toBe(resumes + 1);
    expect(context.started).toEqual([880, 1046]);
  });

  it("stays open while a call rings, between its rings", async () => {
    const context = FakeAudioContext.made[0]!;
    const stop = sounds.startRinging("ring");
    await vi.advanceTimersByTimeAsync(3 * 3_500);
    expect(context.suspends).toBe(0);
    stop();
    await vi.advanceTimersByTimeAsync(sounds.SOUNDS_IDLE_MS + 2_000);
    expect(context.state).toBe("suspended");
  });

  it("plays nothing when sounds are off, and does not wake the output for it", async () => {
    const context = FakeAudioContext.made[0]!;
    await vi.advanceTimersByTimeAsync(sounds.SOUNDS_IDLE_MS);
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ notifications: { soundEnabled: false, systemEnabled: false } }));
    const resumes = context.resumes;
    sounds.playSound("message");
    await flush();
    expect(context.resumes).toBe(resumes);
    expect(context.started).toEqual([]);
    localStorage.removeItem("ghostly_app_settings");
  });
});

/**
 * The Linux Desktop (WebKitGTK) closes the output instead: there a `resume()` after a `suspend()` held the page for 5 to
 * 10 s (r11k: every new chat's first sound froze the app), while a new context starts in milliseconds.
 */
describe("the sounds' audio output where it is closed between sounds (WebKitGTK)", () => {
  beforeEach(async () => {
    uninstall();
    FakeAudioContext.made = [];
    vi.resetModules();
    sounds = await import("../../lib/sounds");
    sounds.setSoundsRelease("close");
    uninstall = sounds.installAudioGestures();
    document.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("is closed a few seconds after the last sound, never suspended", async () => {
    const first = FakeAudioContext.made[0]!;
    expect(first.state).toBe("running");
    await vi.advanceTimersByTimeAsync(sounds.SOUNDS_IDLE_MS);
    expect(first.state).toBe("closed");
    expect(first.suspends).toBe(0);
  });

  it("makes a new output for the next sound, which plays in full, and never resumes a suspended one", async () => {
    await vi.advanceTimersByTimeAsync(sounds.SOUNDS_IDLE_MS);
    for (const name of ["connected", "message"] as const) {
      sounds.playSound(name);
      await flush();
      await vi.advanceTimersByTimeAsync(sounds.SOUNDS_IDLE_MS + 2_000);
    }
    expect(FakeAudioContext.made).toHaveLength(3);
    const [, second, third] = FakeAudioContext.made;
    expect(second!.started).toEqual([587, 784, 784]);
    expect(third!.started).toEqual([880, 1046]);
    for (const context of FakeAudioContext.made) {
      expect(context.state).toBe("closed");
      expect(context.resumesAfterSuspend).toBe(0);
    }
  });

  it("is not opened again by a later click: only a sound opens it", async () => {
    await vi.advanceTimersByTimeAsync(sounds.SOUNDS_IDLE_MS);
    document.dispatchEvent(new Event("pointerdown"));
    document.dispatchEvent(new Event("keydown"));
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeAudioContext.made).toHaveLength(1);
  });

  it("stays open while a call rings, and is closed after it stops", async () => {
    await vi.advanceTimersByTimeAsync(sounds.SOUNDS_IDLE_MS);
    const stop = sounds.startRinging("ring");
    await vi.advanceTimersByTimeAsync(3 * 3_500);
    const ringing = FakeAudioContext.made[1]!;
    expect(ringing.state).toBe("running");
    expect(FakeAudioContext.made).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(sounds.SOUNDS_IDLE_MS + 2_000);
    expect(ringing.state).toBe("closed");
  });
});
