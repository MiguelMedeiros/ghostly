import { describe, expect, it } from "vitest";
import { CallAudio, type RtpTrack } from "../src/calls/audio";
import { callIceServers, loadCallStack, type CallStack } from "../src/calls/media";
import { bytesToMs, frameBytes, PARTIAL_WAIT_MS, PlaybackQueue, type CallRate } from "../src/calls/pcm";
import { isRtcp, parseRtp, ReorderBuffer, RtpWriter, sequenceDelta, TICKS_PER_FRAME, type RtpPacket } from "../src/calls/rtp";
import { dominantHz, level, tone } from "./support/tone";
// covers: headless.calls

describe("the playback queue (program to call)", () => {
  it("gives 20 ms frames in order, then silence", () => {
    const q = new PlaybackQueue(48000);
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
    expect(callIceServers()).toEqual(["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]);
    expect(callIceServers([
      { urls: "turn:turn.example.org:3478 turn:turn.example.org:443?transport=tcp", username: "u", credential: "p" },
      { urls: "turns:relay.example.org", username: "u", credential: "p" },
      { urls: "stun:stun.example.org" },
      { urls: "https://not-ice" },
    ]).slice(2)).toEqual([
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
