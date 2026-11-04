import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// covers: app.attention.sounds, calls.ring-elsewhere, extension.engine

/**
 * The extension's tabs share one engine, so a call rings in each of them: each tab played the ring at once, out of step
 * with the others. One tab rings now (a Web Lock), and another takes over when that one goes.
 */
class FakeAudioContext {
  static made: FakeAudioContext[] = [];
  state: AudioContextState = "suspended";
  currentTime = 0;
  destination = {};
  /** The notes this page played: one ring is four. */
  started: number[] = [];
  constructor() { FakeAudioContext.made.push(this); }
  resume() { this.state = "running"; return Promise.resolve(); }
  suspend() { this.state = "suspended"; return Promise.resolve(); }
  decodeAudioData() { return Promise.reject(new Error("no decoder")); }
  createGain() { return { connect: (to: unknown) => to, gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} } }; }
  createOscillator() {
    const started = this.started;
    return { type: "sine", connect: (to: unknown) => to, frequency: { setValueAtTime: (hz: number) => started.push(hz) }, start() {}, stop() {} };
  }
  createBufferSource() { return { buffer: null, connect: (to: unknown) => to, start() {}, stop() {} }; }
}

/** The browser's Web Locks, exclusive: a request waits until the page before it lets go. */
function installLocks() {
  const queues = new Map<string, Promise<unknown>>();
  const locks = {
    request: (name: string, task: () => unknown) => {
      const turn = (queues.get(name) ?? Promise.resolve()).then(() => task());
      queues.set(name, turn.catch(() => {}));
      return turn;
    },
    query: async () => ({ held: [] }),
  };
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
}

type Sounds = typeof import("../../lib/sounds");
const uninstalls: (() => void)[] = [];
/** A page of the app: its own copy of the sounds, its own audio, started by a gesture (`heard`) or never. */
async function openPage(heard = true): Promise<Sounds> {
  vi.resetModules();
  const sounds = await import("../../lib/sounds");
  if (heard) uninstalls.push(sounds.installAudioGestures());
  return sounds;
}
/** A gesture: starts the audio of every page open. */
async function gesture() {
  document.dispatchEvent(new Event("pointerdown"));
  await vi.advanceTimersByTimeAsync(0);
}
const rings = (context: FakeAudioContext | undefined) => (context?.started.length ?? 0) / 4;

beforeEach(() => {
  vi.useFakeTimers();
  FakeAudioContext.made = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  installLocks();
});

afterEach(() => {
  for (const uninstall of uninstalls.splice(0)) uninstall();
  delete (navigator as { locks?: unknown }).locks;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a call ringing in two tabs", () => {
  it("rings in one of them, and in the other once that one stops", async () => {
    const [first, second] = [await openPage(), await openPage()];
    await gesture();
    const [a, b] = FakeAudioContext.made;
    const stopFirst = first.startRinging("ring");
    const stopSecond = second.startRinging("ring");
    await vi.advanceTimersByTimeAsync(3 * 3_500);
    expect(rings(a)).toBe(4);
    expect(rings(b)).toBe(0);

    // The ringing tab is closed (or its chat): the other rings on.
    stopFirst();
    await vi.advanceTimersByTimeAsync(3 * 3_500);
    expect(rings(a)).toBe(4);
    expect(rings(b)).toBe(4);
    stopSecond();
  });

  it("rings in a tab that can sound, not in one whose audio no gesture started", async () => {
    // No gesture in this tab: its audio is not started, whatever it rings is not heard.
    const silent = await openPage(false);
    const stopSilent = silent.startRinging("ring");
    await vi.advanceTimersByTimeAsync(0);
    const heard = await openPage();
    await gesture();
    const stopHeard = heard.startRinging("ring");
    await vi.advanceTimersByTimeAsync(2 * 3_500);
    expect(rings(FakeAudioContext.made[FakeAudioContext.made.length - 1])).toBe(3);
    stopSilent();
    stopHeard();
  });

  it("stops when the call ends, where the lock is granted inside request() (Node's)", async () => {
    const locks = { request: (_name: string, task: () => unknown) => Promise.resolve(task()) };
    Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
    const page = await openPage();
    await gesture();
    const stop = page.startRinging("ring");
    await vi.advanceTimersByTimeAsync(0);
    expect(rings(FakeAudioContext.made[0])).toBe(1);
    stop();
    await vi.advanceTimersByTimeAsync(3 * 3_500);
    expect(rings(FakeAudioContext.made[0])).toBe(1);
  });
});
