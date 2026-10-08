import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// covers: app.attention.sounds

/**
 * Sounds never sound on top of one another (apps/ui/src/lib/soundGate.ts). The app restarts and many chats and groups
 * catch up at once, each with its message, its cues and its "connected": that is one sound, the most important.
 * What would be heard is recorded, not played: decoding fails, so each sound plays its synthesized notes, and every
 * note started and stopped is kept.
 */
class FakeAudioContext {
  static made: FakeAudioContext[] = [];
  state: AudioContextState = "running";
  currentTime = 0;
  destination = {};
  started: number[] = [];
  stopped: number[] = [];
  constructor() { FakeAudioContext.made.push(this); }
  resume() { this.state = "running"; return Promise.resolve(); }
  suspend() { this.state = "suspended"; return Promise.resolve(); }
  decodeAudioData() { return Promise.reject(new Error("no decoder")); }
  createGain() { return { connect: (to: unknown) => to, gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
  createOscillator() {
    const { started, stopped } = this;
    let hz = 0;
    let calls = 0;
    // A sound stops each note itself once, at its end; the gate stopping it early is the second call.
    return { type: "sine", connect: (to: unknown) => to, frequency: { setValueAtTime: (f: number) => { hz = f; started.push(f); } }, start() {}, stop() { if (++calls > 1) stopped.push(hz); } };
  }
  createBufferSource() { return { buffer: null, connect: (to: unknown) => to, start() {}, stop() {} }; }
}

const MESSAGE = [880, 1046];
const MENTION = [1480, 1865];
const COIN = [1319, 1976];
const RING = [784, 988, 784, 988];

let sounds: typeof import("../../lib/sounds");
let gate: typeof import("../../lib/soundGate");
let uninstall: () => void;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const context = () => FakeAudioContext.made[0]!;

beforeEach(async () => {
  vi.useFakeTimers();
  FakeAudioContext.made = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.resetModules();
  sounds = await import("../../lib/sounds");
  gate = await import("../../lib/soundGate");
  uninstall = sounds.installAudioGestures();
  document.dispatchEvent(new Event("pointerdown"));
  await vi.advanceTimersByTimeAsync(0);
});

afterEach(() => {
  uninstall();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("notification sounds that come together", () => {
  it("are one sound: several chats' messages, cues and connected within the gap", async () => {
    sounds.playSound("message");
    await flush();
    // Past the together window, so a more important one does not take over: first wins.
    for (const name of ["message", "knock", "connected"] as const) {
      await vi.advanceTimersByTimeAsync(gate.TOGETHER_MS + 10);
      sounds.playSound(name);
      await flush();
    }
    expect(context().started).toEqual(MESSAGE);
  });

  it("give way to the most important one when it arrives with them: a mention over a message", async () => {
    sounds.playSound("message");
    sounds.playSound("mention");
    await flush();
    // The message had not started yet: only the mention is heard.
    expect(context().started).toEqual(MENTION);
    sounds.playSound("message");
    await flush();
    expect(context().started).toEqual(MENTION);
  });

  it("stop the message already sounding for a payment that comes right after it, so they never overlap", async () => {
    sounds.playSound("message");
    await flush();
    await vi.advanceTimersByTimeAsync(50);
    sounds.playSound("coin");
    await flush();
    expect(context().stopped).toEqual(MESSAGE);
    expect(context().started).toEqual([...MESSAGE, ...COIN]);
  });

  it("keep the first one when the more important one is not together with it, and drop the later one, not queue it", async () => {
    sounds.playSound("message");
    await flush();
    await vi.advanceTimersByTimeAsync(gate.TOGETHER_MS);
    sounds.playSound("mention");
    await vi.advanceTimersByTimeAsync(gate.NOTICE_GAP_MS * 3);
    expect(context().started).toEqual(MESSAGE);
    expect(context().stopped).toEqual([]);
  });

  it("let the next one play once the gap is over", async () => {
    sounds.playSound("message");
    await flush();
    await vi.advanceTimersByTimeAsync(gate.NOTICE_GAP_MS - 1);
    sounds.playSound("message");
    await flush();
    expect(context().started).toEqual(MESSAGE);
    await vi.advanceTimersByTimeAsync(1);
    sounds.playSound("message");
    await flush();
    expect(context().started).toEqual([...MESSAGE, ...MESSAGE]);
  });
});

describe("a call's sounds", () => {
  it("are never dropped: a ring stops the message sounding, and nothing plays over it while it rings", async () => {
    sounds.playSound("message");
    await flush();
    const stop = sounds.startRinging("ring");
    await flush();
    expect(context().stopped).toEqual(MESSAGE);
    expect(context().started).toEqual([...MESSAGE, ...RING]);
    // A coin, a mention, a card turning over: none of them over the ring, even long after the gap.
    for (const name of ["coin", "mention", "flip"] as const) {
      await vi.advanceTimersByTimeAsync(gate.NOTICE_GAP_MS + 100);
      sounds.playSound(name);
      await flush();
    }
    // The ring goes on (one every 3.5 s).
    await vi.advanceTimersByTimeAsync(3_500);
    await flush();
    expect(context().started).toEqual([...MESSAGE, ...RING, ...RING]);
    stop();
    // The call ends: its hangup plays, even right after a ring.
    sounds.playSound("hangup");
    await flush();
    expect(context().started.slice(-2)).toEqual([440, 330]);
  });

  it("ring even when a notice has just taken the gate", async () => {
    sounds.playSound("mention");
    const stop = sounds.startRinging("ringback");
    await flush();
    expect(context().started).toEqual([440]);
    stop();
  });
});

describe("the interface's own sounds", () => {
  it("never sound on top of a notice, and a notice that comes stops them", async () => {
    sounds.playSound("message");
    await flush();
    sounds.playSound("flip");
    await flush();
    expect(context().started).toEqual(MESSAGE);
    await vi.advanceTimersByTimeAsync(gate.NOTICE_GAP_MS);
    sounds.playSound("flip");
    await flush();
    sounds.playSound("message");
    await flush();
    expect(context().stopped).toContain(2794);
    expect(context().started).toEqual([...MESSAGE, 2794, ...MESSAGE]);
  });

  it("follow one another as quickly as a person clicks, each stopping the last, and a Settings preview is one of them", async () => {
    sounds.playSound("flip");
    await flush();
    sounds.playSound("slide");
    await flush();
    sounds.playSound("knock", { kind: "interface" });
    await flush();
    sounds.playSound("knock", { kind: "interface" });
    await flush();
    expect(context().started).toEqual([2794, 2960, 392, 415, 392, 415]);
    expect(context().stopped).toEqual([2794, 2960, 392, 415]);
  });
});

describe("the gate's classes", () => {
  it("names a call's sounds, the interface's, and the rest notices; a mention and money outrank a message, a message the connection's", () => {
    expect(["ring", "ringback", "hangup"].map(n => gate.soundKind(n as never))).toEqual(["call", "call", "call"]);
    expect(["slide", "flip", "wallet", "spoiler", "deleted", "realmoney", "sent"].every(n => gate.soundKind(n as never) === "interface")).toBe(true);
    expect(["message", "mention", "coin", "connected", "knock", "group"].every(n => gate.soundKind(n as never) === "notice")).toBe(true);
    for (const high of ["mention", "coin", "testcoins", "request", "paid", "failed"] as const) expect(gate.soundPriority(high)).toBeGreaterThan(gate.soundPriority("message"));
    expect(gate.soundPriority("message")).toBeGreaterThan(gate.soundPriority("connected"));
  });
});
