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
  started: number[] = [];
  constructor() { FakeAudioContext.made.push(this); }
  resume() { this.resumes++; this.state = "running"; return Promise.resolve(); }
  suspend() { this.suspends++; this.state = "suspended"; return Promise.resolve(); }
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
