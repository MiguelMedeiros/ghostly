import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// covers: app.attention.sounds

/**
 * A newcomer's first keystroke (the name step) unlocks audio. It used to fetch and decode every bundled sound too, call
 * rings and money sounds included: 27 files and several MiB of decoded buffers before there is any chat. Now the gesture
 * warms only what a chat plays first, and every other sound is fetched the first time it plays.
 */
class FakeAudioContext {
  state: AudioContextState = "suspended";
  currentTime = 0;
  destination = {};
  resume() { this.state = "running"; return Promise.resolve(); }
  suspend() { this.state = "suspended"; return Promise.resolve(); }
  decodeAudioData() { return Promise.resolve({ duration: 0.2 }); }
  createGain() { return { connect: (to: unknown) => to, gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
  createOscillator() { return { type: "sine", connect: (to: unknown) => to, frequency: { setValueAtTime() {} }, start() {}, stop() {} }; }
  createBufferSource() { return { buffer: null, connect: (to: unknown) => to, start() {}, stop() {} }; }
}

let sounds: typeof import("../../lib/sounds");
let uninstall: () => void;
let fetched: string[];
/** The bundled sound names the page has asked for, from the fetched asset URLs. */
const names = () => fetched.map(url => /([a-z]+)[^/]*\.mp3$/.exec(url)?.[1]).sort();

beforeEach(async () => {
  vi.useFakeTimers();
  fetched = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { fetched.push(String(url)); return new Response(new ArrayBuffer(8)); }));
  vi.resetModules();
  sounds = await import("../../lib/sounds");
  uninstall = sounds.installAudioGestures();
});

afterEach(() => {
  uninstall();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the first gesture", () => {
  it("unlocks audio and fetches only the sounds a chat plays first, not the call or money sounds", async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "C" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(names()).toEqual(["message", "sent"]);
  });

  it("leaves a sound's file to its first play, and fetches it once", async () => {
    document.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(0);
    const stop = sounds.startRinging("ring");
    await vi.advanceTimersByTimeAsync(2 * 3_500);
    stop();
    expect(names()).toEqual(["message", "ring", "sent"]);
  });

  it("lets a sound coming soon be fetched ahead, once, and its play then fetches nothing; before a gesture, nothing", async () => {
    sounds.warmSound("connected");
    await vi.advanceTimersByTimeAsync(0);
    expect(names()).toEqual([]);
    document.dispatchEvent(new Event("pointerdown"));
    sounds.warmSound("connected");
    sounds.warmSound("connected");
    await vi.advanceTimersByTimeAsync(0);
    expect(names()).toEqual(["connected", "message", "sent"]);
    sounds.playSound("connected");
    await vi.advanceTimersByTimeAsync(0);
    expect(names()).toEqual(["connected", "message", "sent"]);
  });
});
