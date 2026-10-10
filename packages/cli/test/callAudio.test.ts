import { describe, expect, it, vi } from "vitest";
import { CallAudio, type RtpTrack } from "../src/calls/audio";
import { callIceServers, loadCallStack, type CallStack } from "../src/calls/media";
import { bytesToMs, frameBytes, PARTIAL_WAIT_MS, PlaybackQueue, type CallRate } from "../src/calls/pcm";
import { isRtcp, parseRtp, ReorderBuffer, RtpWriter, sequenceDelta, TICKS_PER_FRAME, type RtpPacket } from "../src/calls/rtp";
import { dominantHz, level, tone } from "./support/tone";
// covers: headless.calls

describe("the playback queue (program to call)", () => {
  it("gives 20 ms frames in order, then silence", () => {
    // A still clock: on a busy runner PARTIAL_WAIT_MS could pass before the last next(), which then plays the padded rest.
    const q = new PlaybackQueue(48000, () => 0);
    expect(frameBytes(48000)).toBe(1920);
    expect(frameBytes(16000)).toBe(640);
    const audio = tone(440, 48000, 50);
    q.push(audio.subarray(0, 1000));
    q.push(audio.subarray(1000));
    expect(q.queuedMs).toBe(50);
    const first = q.next(), second = q.next();
    expect(first.silent).toBe(false);
    expect(Buffer.concat([first.frame, second.frame])).toEqual(audio.subarray(0, 3840));
    // 10 ms left: a partial frame waits for the rest of it.
    expect(q.next().silent).toBe(true);
    expect(q.queuedMs).toBe(10);
  });

  it("plays a partial frame padded once nothing came for a while", () => {
    let now = 0;
    const q = new PlaybackQueue(16000, () => now);
    q.push(Buffer.alloc(100, 1));
    expect(q.next().silent).toBe(true);
    now += PARTIAL_WAIT_MS;
    const { frame, silent } = q.next();
    expect(silent).toBe(false);
    expect(frame.length).toBe(640);
    expect(frame.subarray(0, 100)).toEqual(Buffer.alloc(100, 1));
    expect(frame.subarray(100)).toEqual(Buffer.alloc(540));
  });

  it("keeps an odd byte for its other half", () => {
    let now = 0;
    const q = new PlaybackQueue(16000, () => now);
    q.push(Buffer.from([1, 2, 3]));
    now += PARTIAL_WAIT_MS;
    const first = q.next();
    expect(first.frame.subarray(0, 2)).toEqual(Buffer.from([1, 2]));
    q.push(Buffer.from([4]));
    now += PARTIAL_WAIT_MS * 2;
    expect(q.next().frame.subarray(0, 2)).toEqual(Buffer.from([3, 4]));
  });

  it("flush drops everything queued and says how much", () => {
    const q = new PlaybackQueue(48000);
    q.push(tone(440, 48000, 2000));
    q.next();
    expect(q.flush()).toBe(1980);
    expect(q.queuedMs).toBe(0);
    expect(q.next().silent).toBe(true);
  });

  it("drops what goes past its cap", () => {
    const q = new PlaybackQueue(8000, Date.now, 100);
    expect(q.push(Buffer.alloc(3000))).toBe(3000 - 1600);
    expect(q.queuedMs).toBe(100);
    expect(q.dropped).toBe(1400);
    expect(bytesToMs(8000, 1600)).toBe(100);
  });
});

function packet(sequence: number, payload = [sequence & 0xff], ssrc = 7): RtpPacket {
  return { payloadType: 111, marker: false, sequence, timestamp: sequence * TICKS_PER_FRAME, ssrc, payload: Buffer.from(payload) };
}
const played = (out: ReturnType<ReorderBuffer["push"]>) => out.map((o) => ("lost" in o ? "lost" : o.payload[0]));

describe("RTP", () => {
  it("writes packets and reads them back, stepping over CSRCs, an extension and padding", () => {
    const writer = new RtpWriter(0xdeadbeef, 111);
    const a = parseRtp(writer.packet(Buffer.from([1, 2, 3]), true))!;
    const b = parseRtp(writer.packet(Buffer.from([4])))!;
    expect(a).toMatchObject({ payloadType: 111, marker: true, ssrc: 0xdeadbeef, payload: Buffer.from([1, 2, 3]) });
    expect(sequenceDelta(b.sequence, a.sequence)).toBe(1);
    expect((b.timestamp - a.timestamp) >>> 0).toBe(960);
    // V=2, P=1, X=1, CC=1; one CSRC; a one-word extension; 3 bytes of padding.
    const raw = Buffer.from([0xb1, 111, 0, 5, 0, 0, 0, 9, 0, 0, 0, 7, 1, 1, 1, 1, 0xbe, 0xde, 0, 1, 9, 9, 9, 9, 42, 43, 0, 0, 3]);
    expect(parseRtp(raw)).toMatchObject({ sequence: 5, timestamp: 9, ssrc: 7, payload: Buffer.from([42, 43]) });
    // RTCP on the muxed port (a receiver report) is not RTP.
    const rr = Buffer.from([0x80, 201, 0, 1, 0, 0, 0, 1]);
    expect(isRtcp(rr)).toBe(true);
    expect(parseRtp(rr)).toBeNull();
    expect(parseRtp(Buffer.from([0x40, 111, 0, 0]))).toBeNull();
  });

  it("puts packets back in order, gives up on a lost one, drops late ones and duplicates", () => {
    const r = new ReorderBuffer(2);
    expect(played(r.push(packet(10)))).toEqual([10]);
    expect(played(r.push(packet(12)))).toEqual([]);
    expect(played(r.push(packet(11)))).toEqual([11, 12]);
    expect(played(r.push(packet(11)))).toEqual([]);
    // 13 never comes: once two wait behind it, it is lost.
    expect(played(r.push(packet(14)))).toEqual([]);
    expect(played(r.push(packet(15)))).toEqual([]);
    expect(played(r.push(packet(16)))).toEqual(["lost", 14, 15, 16]);
    expect(played(r.push(packet(13)))).toEqual([]);
  });

  it("wraps its sequence, caps the silence of a long gap, and restarts on a new stream", () => {
    const r = new ReorderBuffer(2);
    expect(played(r.push(packet(65535)))).toEqual([255]);
    expect(played(r.push(packet(0)))).toEqual([0]);
    r.push(packet(50)); r.push(packet(51));
    expect(played(r.push(packet(52)))).toEqual(["lost", "lost", "lost", 50, 51, 52]);
    expect(played(r.push(packet(9000, [1], 8)))).toEqual([1]);
  });
});

describe("a call's ICE servers", () => {
  it("the apps' STUN servers first, then the profile's TURN and STUN servers as libdatachannel takes them", () => {
    expect(callIceServers([], {})).toEqual(["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]);
    // GHOSTLY_STUN=0 (a private network, the tests): the profile's own only.
    expect(callIceServers([{ urls: "stun:127.0.0.1:3478" }], { GHOSTLY_STUN: "0" })).toEqual(["stun:127.0.0.1:3478"]);
    expect(callIceServers([
      { urls: "turn:turn.example.org:3478 turn:turn.example.org:443?transport=tcp", username: "u", credential: "p" },
      { urls: "turns:relay.example.org", username: "u", credential: "p" },
      { urls: "stun:stun.example.org" },
      { urls: "https://not-ice" },
    ], {}).slice(2)).toEqual([
      { hostname: "turn.example.org", port: 3478, username: "u", password: "p", relayType: "TurnUdp" },
      { hostname: "turn.example.org", port: 443, username: "u", password: "p", relayType: "TurnTcp" },
      { hostname: "relay.example.org", port: 5349, username: "u", password: "p", relayType: "TurnTls" },
      "stun:stun.example.org:3478",
    ]);
  });
});

/** Two CallAudio ends joined by a fake track, with the real Opus codec. */
async function pair(rate: CallRate) {
  const stack = await loadCallStack();
  if (typeof stack === "string") throw new Error(stack);
  const heard = { a: [] as Buffer[], b: [] as Buffer[] };
  const lanes: Record<"a" | "b", ((p: Buffer) => void)[]> = { a: [], b: [] };
  const track = (me: "a" | "b", them: "a" | "b"): RtpTrack => ({ send: (p) => lanes[them].forEach((l) => l(p)), onPacket: (l) => lanes[me].push(l) });
  const make = (me: "a" | "b", them: "a" | "b", s: CallStack) => new CallAudio({ rate, payloadType: 111, ssrc: me === "a" ? 1 : 2, track: track(me, them), encoder: s.opus(rate), decoder: s.opus(rate), onFrame: (f) => heard[me].push(f) });
  return { a: make("a", "b", stack), b: make("b", "a", stack), heard };
}

/**
 * An event loop turned by hand, in libuv's order: the timers that are due when the turn starts, then what came in
 * meanwhile (the program's writes, read from its socket), then the immediates. A timer set during a turn waits for
 * the next one, as a 0 ms timer does in Node.
 */
function handLoop() {
  let time = 1_000_000;
  let timers: { at: number; run: () => void }[] = [];
  let immediates: (() => void)[] = [];
  vi.stubGlobal("setTimeout", (run: () => void, ms = 0) => { const timer = { at: time + Math.max(1, ms), run }; timers.push(timer); return timer; });
  vi.stubGlobal("clearTimeout", (timer: unknown) => { timers = timers.filter((t) => t !== timer); });
  vi.stubGlobal("setImmediate", (run: () => void) => { immediates.push(run); });
  vi.spyOn(Date, "now").mockImplementation(() => time);
  return {
    turn(ms: number, read: () => void): void {
      time += ms;
      const due = timers.filter((t) => t.at <= time).sort((x, y) => x.at - y.at);
      timers = timers.filter((t) => t.at > time);
      for (const timer of due) timer.run();
      read();
      const check = immediates;
      immediates = [];
      for (const run of check) run();
    },
    restore(): void { vi.unstubAllGlobals(); vi.restoreAllMocks(); },
  };
}

describe("a call's audio through Opus", () => {
  for (const rate of [48000, 16000] as const) {
    it(`carries a tone at ${rate} Hz in 20 ms frames, and silence when nothing is queued`, async () => {
      const { a, b, heard } = await pair(rate);
      a.queue.push(tone(440, rate, 1000));
      b.queue.push(tone(660, rate, 1000));
      for (let i = 0; i < 50; i++) { a.tick(); b.tick(); }
      expect(heard.b.length).toBe(50);
      expect(heard.b.every((f) => f.length === frameBytes(rate))).toBe(true);
      // Opus needs a few frames to settle; the rest is the tone.
      expect(dominantHz(Buffer.concat(heard.b.slice(10)), rate)).toBeCloseTo(440, -1);
      expect(dominantHz(Buffer.concat(heard.a.slice(10)), rate)).toBeCloseTo(660, -1);
      for (let i = 0; i < 25; i++) a.tick();
      expect(level(Buffer.concat(heard.b.slice(-10)))).toBeLessThan(0.01);
      a.stop(); b.stop();
    });
  }

  it("catches up after the daemon stalls, so a program writing at real time is not heard later and later", async () => {
    vi.useFakeTimers();
    try {
      const { a, b } = await pair(48000);
      const frame = tone(440, 48000, 20);
      // A program writing 20 ms every 20 ms, as a microphone does.
      const writer = setInterval(() => a.queue.push(frame), 20);
      a.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(a.queue.queuedMs).toBeLessThanOrEqual(20);
      for (const stall of [150, 300, 800]) {
        // The event loop is busy (a journal fsync, a Pkarr publish): nothing runs for a while. The program kept
        // writing meanwhile; what it wrote is read once the loop is free.
        vi.setSystemTime(Date.now() + stall);
        for (let i = 0; i < stall / 20; i++) a.queue.push(frame);
        await vi.advanceTimersByTimeAsync(500);
        expect(a.queue.queuedMs, `after a ${stall} ms stall`).toBeLessThanOrEqual(40);
      }
      // A stall past MAX_CATCH_UP_MS is not replayed as a burst of that much audio.
      const sent = a.sent;
      vi.setSystemTime(Date.now() + 5000);
      await vi.advanceTimersByTimeAsync(20);
      expect(a.sent - sent).toBeLessThanOrEqual(2);
      clearInterval(writer);
      a.stop(); b.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps up while the daemon's loop turns slower than a frame, as it does while a large file goes out", async () => {
    const { a, b } = await pair(48000);
    const loop = handLoop();
    try {
      const frame = tone(440, 48000, 20);
      // A program writing 20 ms every 20 ms: a turn of the loop reads what it wrote since the last one.
      const turns = (count: number, ms: number) => { for (let i = 0; i < count; i++) loop.turn(ms, () => { for (let w = 0; w < ms / 20; w++) a.queue.push(frame); }); };
      a.start();
      turns(50, 20);
      const sent = a.sent;
      turns(200, 40);
      expect(a.sent - sent).toBeGreaterThanOrEqual(398);
      expect(a.queue.queuedMs).toBeLessThanOrEqual(40);
      turns(50, 20);
      expect(a.queue.queuedMs).toBeLessThanOrEqual(20);
    } finally {
      a.stop(); b.stop();
      loop.restore();
    }
  });

  it("is back at real time after a stall too long to catch up, and keeps a clip that was written ahead", async () => {
    const { a, b } = await pair(48000);
    const loop = handLoop();
    try {
      const frame = tone(440, 48000, 20);
      const turns = (count: number, ms: number) => { for (let i = 0; i < count; i++) loop.turn(ms, () => { for (let w = 0; w < ms / 20; w++) a.queue.push(frame); }); };
      a.start();
      turns(50, 20);
      const sent = a.sent;
      turns(1, 2000);
      // Not replayed as two seconds of audio at once, and not left in the queue either.
      expect(a.sent - sent).toBeLessThanOrEqual(2);
      expect(a.queue.queuedMs).toBeLessThanOrEqual(20);
      // A longer one does not fit the program's socket: the rest of what it wrote comes on the next turn.
      loop.turn(3000, () => { for (let w = 0; w < 50; w++) a.queue.push(frame); });
      loop.turn(20, () => { for (let w = 0; w < 101; w++) a.queue.push(frame); });
      turns(50, 20);
      expect(a.queue.queuedMs).toBeLessThanOrEqual(40);

      // A clip written ahead (speech from a TTS) is not what the stall left behind: all of it is still played.
      a.queue.flush();
      a.queue.push(tone(440, 48000, 5000));
      for (let i = 0; i < 10; i++) loop.turn(20, () => {});
      const queued = a.queue.queuedMs;
      loop.turn(2000, () => {});
      expect(a.queue.queuedMs).toBe(queued - 20);
    } finally {
      a.stop(); b.stop();
      loop.restore();
    }
  });

  it("stops sending the program's audio the moment it is flushed", async () => {
    const { a, b, heard } = await pair(48000);
    a.queue.push(tone(440, 48000, 3000));
    for (let i = 0; i < 20; i++) a.tick();
    expect(a.queue.flush()).toBe(2600);
    for (let i = 0; i < 20; i++) a.tick();
    expect(level(Buffer.concat(heard.b.slice(-10)))).toBeLessThan(0.01);
    a.stop(); b.stop();
  });
});
