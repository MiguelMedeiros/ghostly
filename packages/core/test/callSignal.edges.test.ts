import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  buildSdpFromSignal,
  compressSdp,
  decompressSdp,
  answersOffer,
  callSignalHeardAt,
  heardCallSignal,
  parseCallSignal,
  signalHasVideo,
  waitForIceGathering,
  sdpHasCandidates,
} from "../src";

// covers: calls.signal

const NOW = 1_760_000_000_000;
const base = { t: "o", ts: NOW, u: "x9Kq", p: "Q2m1yU7tX8nB4vL0pR6sZ3aW", f: "ab".repeat(32), s: "actpass" };
const withCandidate = (c: unknown) => parseCallSignal(JSON.stringify({ ...base, c: [c] }), NOW);
const HOST = "1 1 udp 2122260223 192.0.2.1 54400 typ host";

describe("call signal candidates: refusals", () => {
  it("refuses a candidate that is too long, too short or missing its typ keyword", () => {
    expect(withCandidate(`${HOST} ${"x".repeat(512)}`)).toBeNull();
    expect(withCandidate("1 1 udp 1 192.0.2.1 9 typ")).toBeNull();
    expect(withCandidate("1 1 udp 1 192.0.2.1 9 type host")).toBeNull();
  });

  it("refuses a bad foundation, component, transport name or address", () => {
    expect(withCandidate("f*o 1 udp 1 192.0.2.1 9 typ host")).toBeNull();
    expect(withCandidate(`${"a".repeat(33)} 1 udp 1 192.0.2.1 9 typ host`)).toBeNull();
    expect(withCandidate("1 0 udp 1 192.0.2.1 9 typ host")).toBeNull();
    expect(withCandidate("1 257 udp 1 192.0.2.1 9 typ host")).toBeNull();
    expect(withCandidate("1 x udp 1 192.0.2.1 9 typ host")).toBeNull();
    expect(withCandidate("1 1 u_p 1 192.0.2.1 9 typ host")).toBeNull();
    expect(withCandidate("1 1 udp 1 192.0.2.1/8 9 typ host")).toBeNull();
    expect(withCandidate("1 1 udp 4294967296 192.0.2.1 9 typ host")).toBeNull();
  });

  it("accepts the numeric limits exactly and normalises the transport name", () => {
    expect(withCandidate("1 256 UDP 4294967295 192.0.2.1 65535 typ relay")?.c).toEqual(["1 256 udp 4294967295 192.0.2.1 65535 typ relay"]);
  });

  it("refuses an odd number of extension tokens and malformed extension values", () => {
    expect(withCandidate(`${HOST} generation`)).toBeNull();
    expect(withCandidate(`${HOST} gen=ration 0`)).toBeNull();
    expect(withCandidate(`${HOST} raddr 1.2.3.4/8 rport 0`)).toBeNull();
    expect(withCandidate(`${HOST} raddr 0.0.0.0 rport 65536`)).toBeNull();
    expect(withCandidate(`${HOST} raddr 0.0.0.0 rport x`)).toBeNull();
  });

  it("accepts an IPv6 related address: WebKit's IPv6 srflx says `raddr ::`, and one refused candidate drops the whole call", () => {
    const srflx = "354790382 1 udp 1677732095 2001:db8:8785:c1e7:f5d3:2b6d:efb7:c24c 55917 typ srflx";
    expect(withCandidate(`${srflx} raddr :: rport 0 generation 0 network-cost 999`)?.c).toEqual([`${srflx} raddr :: rport 0`]);
    expect(withCandidate(`${srflx} raddr fe80::1 rport 9`)?.c).toEqual([`${srflx} raddr fe80::1 rport 9`]);
    // Still an address and nothing more.
    expect(withCandidate(`${srflx} raddr ::/0 rport 0`)).toBeNull();
    expect(withCandidate(`${srflx} generation :: raddr :: rport 0`)).toBeNull();
  });

  it("keeps raddr/rport only as a pair and drops every other extension", () => {
    expect(withCandidate(`${HOST} raddr 0.0.0.0`)?.c).toEqual([HOST]);
    expect(withCandidate(`${HOST} rport 9`)?.c).toEqual([HOST]);
    expect(withCandidate(`${HOST} network-id 1 ufrag abcd raddr 0.0.0.0 rport 9`)?.c).toEqual([`${HOST} raddr 0.0.0.0 rport 9`]);
  });

  it("accepts only dynamic payload types for Opus and VP8, and never the same one for both", () => {
    for (const pt of [35, 63, 96, 106, 127]) expect(parseCallSignal(JSON.stringify({ ...base, vp: pt }), NOW)?.vp).toBe(pt);
    for (const bad of [0, 34, 64, 95, 128, -1, 106.5, "106", null]) {
      expect(parseCallSignal(JSON.stringify({ ...base, vp: bad }), NOW), `vp ${bad}`).toBeNull();
      expect(parseCallSignal(JSON.stringify({ ...base, ap: bad }), NOW), `ap ${bad}`).toBeNull();
    }
    expect(parseCallSignal(JSON.stringify({ ...base, ap: 109, vp: 109 }), NOW)).toBeNull();
    expect(parseCallSignal(JSON.stringify({ ...base, ap: 109, vp: 106 }), NOW)).toMatchObject({ ap: 109, vp: 106 });
  });

  it("refuses an SSRC list that is not a short list", () => {
    expect(parseCallSignal(JSON.stringify({ ...base, ss: "1" }), NOW)).toBeNull();
    expect(parseCallSignal(JSON.stringify({ ...base, ss: [1, 2, 3] }), NOW)).toBeNull();
    expect(parseCallSignal(JSON.stringify({ ...base, ss: [0, 0xffffffff] }), NOW)?.ss).toEqual([0, 0xffffffff]);
  });

  it("refuses a non-finite timestamp", () => {
    expect(parseCallSignal('{"t":"h","ts":1e999}', NOW)).toBeNull();
  });
});

describe("a signal's time and this device's clock", () => {
  const MAX = 120_000;
  const answer = (over: Record<string, unknown> = {}) => JSON.stringify({ ...base, t: "a", s: "active", ...over });

  it.each([["two minutes ahead", MAX + 500], ["an hour ahead", 60 * 60_000], ["two minutes behind", -MAX - 500], ["an hour behind", -60 * 60_000]])("a signal the engine heard come is as old as that, whatever its sender's clock (%s) dated it", (_, skew) => {
    const theirs = JSON.stringify({ ...base, ts: NOW + skew });
    // By its own time alone, as one found in a record: refused, as before.
    expect(parseCallSignal(theirs, NOW)).toBeNull();
    const heard = parseCallSignal(heardCallSignal(theirs, NOW - 1_000), NOW);
    expect(heard).toMatchObject({ t: "o", ts: NOW + skew, at: NOW - 1_000 });
    expect(callSignalHeardAt(heard!)).toBe(NOW - 1_000);
    // It goes stale two minutes after it was heard, as any offer does.
    expect(parseCallSignal(heardCallSignal(theirs, NOW - MAX - 1), NOW)).toBeNull();
    expect(parseCallSignal(heardCallSignal(theirs, NOW - MAX), NOW)).not.toBeNull();
  });

  it("when it was heard is the engine's to say: what a contact put there is dropped", () => {
    const forged = JSON.stringify({ ...base, ts: NOW - 60 * 60_000, at: NOW });
    expect(JSON.parse(heardCallSignal(forged))).not.toHaveProperty("at");
    expect(parseCallSignal(heardCallSignal(forged), NOW)).toBeNull();
    expect(JSON.parse(heardCallSignal(forged, NOW - 5))).toMatchObject({ ts: NOW - 60 * 60_000, at: NOW - 5 });
    // Not a signal: handed on as it is, for the parser to refuse.
    expect(heardCallSignal("{", NOW)).toBe("{");
    expect(heardCallSignal("[1]", NOW)).toBe("[1]");
    expect(parseCallSignal(JSON.stringify({ ...base, at: "now" }), NOW)).not.toHaveProperty("at");
  });

  it("an answer that names its offer is for that offer and no other, whatever the two clocks say", () => {
    const offerTs = NOW - 5_000;
    // The callee's clock is two minutes behind: by its time alone the answer is "from before the offer".
    const behind = parseCallSignal(heardCallSignal(answer({ ts: offerTs - MAX, o: offerTs }), NOW), NOW)!;
    expect(behind).toMatchObject({ t: "a", o: offerTs });
    expect(answersOffer(behind, offerTs)).toBe(true);
    // An answer to another offer (an earlier call, sent again on a new session): never this one's, however new it reads.
    const other = parseCallSignal(heardCallSignal(answer({ ts: NOW + 1, o: offerTs - 60_000 }), NOW), NOW)!;
    expect(answersOffer(other, offerTs)).toBe(false);
  });

  it("an answer that names no offer (an app up to 1.0.2) is taken when it came after this side offered", () => {
    const offerTs = NOW - 5_000;
    const heard = parseCallSignal(heardCallSignal(answer({ ts: offerTs - 60_000 }), NOW), NOW)!;
    expect(heard).not.toHaveProperty("o");
    expect(answersOffer(heard, offerTs)).toBe(true);
    // Heard before the offer went out, or with nothing to say when (a record): by its own time, as before.
    expect(answersOffer(parseCallSignal(heardCallSignal(answer({ ts: offerTs - 60_000 }), offerTs - 1), NOW)!, offerTs)).toBe(false);
    expect(answersOffer(parseCallSignal(answer({ ts: offerTs - 60_000 }), NOW)!, offerTs)).toBe(false);
    expect(answersOffer(parseCallSignal(answer({ ts: offerTs + 1 }), NOW)!, offerTs)).toBe(true);
  });

  it("refuses an offer name that is not a number, and keeps one only on an answer", () => {
    expect(parseCallSignal(answer({ o: "1" }), NOW)).toBeNull();
    expect(parseCallSignal(answer({ o: null }), NOW)).toBeNull();
    expect(parseCallSignal(JSON.stringify({ ...base, o: NOW }), NOW)).not.toHaveProperty("o");
  });
});

describe("rebuilding an SDP", () => {
  it("defaults to one audio section without candidates, and says there is no picture", () => {
    const signal = parseCallSignal(JSON.stringify(base), NOW)!;
    const sdp = buildSdpFromSignal({ ...signal, c: undefined });
    expect(sdp.match(/^m=/gm)).toEqual(["m="]);
    expect(sdp).toContain("m=audio");
    expect(sdp).not.toContain("a=candidate:");
    expect(sdp).toMatch(/a=ssrc:\d+ cname:pkarr/);
    expect(signalHasVideo(signal)).toBe(false);
    expect(signalHasVideo({ ...signal, m: ["a", "v"] })).toBe(false);
  });

  it("puts candidates in the video section too, when video is the only section", () => {
    const signal = parseCallSignal(JSON.stringify({ ...base, m: ["v"], c: [HOST] }), NOW)!;
    const sdp = buildSdpFromSignal({ ...signal, ss: undefined });
    expect(sdp).toContain("m=video");
    expect(sdp).not.toContain("m=audio");
    expect(sdp).toContain(`a=candidate:${HOST}\r\n`);
    expect(buildSdpFromSignal({ ...signal, c: undefined })).not.toContain("a=candidate:");
  });

  it("only ever emits the lines it builds itself, whatever a peer sent", () => {
    const token = fc.string({ maxLength: 40 });
    const candidate = fc.oneof(fc.constant(HOST), fc.string({ maxLength: 80 }),
      fc.array(fc.constantFrom("1", "udp", "tcp", "typ", "host", "srflx", "raddr", "rport", "0.0.0.0", "9", "\r\n", "a=x"), { minLength: 6, maxLength: 12 }).map(p => p.join(" ")));
    const raw = fc.record({
      t: fc.constantFrom("o", "a", "h", "v", "x"), ts: fc.constant(NOW),
      u: fc.oneof(fc.constant(base.u), token), p: fc.oneof(fc.constant(base.p), token),
      f: fc.oneof(fc.constant(base.f), token), s: fc.constantFrom("actpass", "active", "passive", "x\r\na=y"),
      m: fc.option(fc.array(fc.constantFrom("a", "v", "x"), { maxLength: 3 }), { nil: undefined }),
      c: fc.option(fc.array(candidate, { maxLength: 9 }), { nil: undefined }),
      ss: fc.option(fc.array(fc.oneof(fc.nat(), fc.double()), { maxLength: 3 }), { nil: undefined }),
    }, { requiredKeys: ["t", "ts"] });
    fc.assert(fc.property(raw, value => {
      const signal = parseCallSignal(JSON.stringify(value), NOW);
      if (!signal || signal.t === "h" || signal.t === "v") return;
      const sdp = buildSdpFromSignal(signal);
      // Line breaks only where the builder puts them: every line is one of its own shapes.
      for (const line of sdp.split("\r\n").filter(Boolean)) expect(line).toMatch(/^[vostcma]=/);
      expect(sdp.split("\r\n").filter(l => l.startsWith("a=setup:")).every(l => /^a=setup:(actpass|active|passive)$/.test(l))).toBe(true);
      for (const c of signal.c ?? []) expect(c).toMatch(/^[A-Za-z0-9+/]{1,32} \d+ udp \d+ [A-Za-z0-9.:-]+ \d+ typ (host|srflx|prflx|relay)( raddr [A-Za-z0-9.:-]+ rport \d+)?$/);
    }), { numRuns: 200 });
  });

  it("never throws on arbitrary input", () => {
    fc.assert(fc.property(fc.string({ maxLength: 300 }), text => { parseCallSignal(text, NOW); }), { numRuns: 200 });
    fc.assert(fc.property(fc.jsonValue(), value => { parseCallSignal(JSON.stringify(value), NOW); }), { numRuns: 200 });
  });

  it("round-trips an SDP through its compressed form", () => {
    fc.assert(fc.property(fc.string({ unit: fc.integer({ min: 0x20, max: 0x7e }).map(n => String.fromCharCode(n)), maxLength: 200 }), sdp => {
      expect(decompressSdp(compressSdp(sdp))).toBe(sdp);
    }), { numRuns: 100 });
  });
});

describe("waiting for ICE gathering", () => {
  afterEach(() => vi.useRealTimers());
  class FakePeer extends EventTarget {
    iceGatheringState: RTCIceGatheringState = "gathering";
    constructor(private readonly servers?: RTCIceServer[]) { super(); }
    getConfiguration(): RTCConfiguration { return { iceServers: this.servers }; }
    candidate(line: string | null) {
      this.dispatchEvent(Object.assign(new Event("icecandidate"), { candidate: line === null ? null : { candidate: line } }));
    }
    complete() { this.iceGatheringState = "complete"; this.dispatchEvent(new Event("icegatheringstatechange")); }
  }
  const pending = async (promise: Promise<void>) => {
    let done = false; void promise.then(() => { done = true; });
    await Promise.resolve(); await Promise.resolve();
    return () => done;
  };

  it("resolves at once when gathering already completed", async () => {
    const pc = new FakePeer(); pc.iceGatheringState = "complete";
    await waitForIceGathering(pc as unknown as RTCPeerConnection);
  });

  it("resolves when gathering completes, and stops listening afterwards", async () => {
    vi.useFakeTimers();
    const pc = new FakePeer([{ urls: "stun:stun.example" }]);
    const remove = vi.spyOn(pc, "removeEventListener");
    const done = await pending(waitForIceGathering(pc as unknown as RTCPeerConnection));
    pc.iceGatheringState = "new"; pc.dispatchEvent(new Event("icegatheringstatechange"));
    await vi.advanceTimersByTimeAsync(0); expect(done()).toBe(false);
    pc.complete(); await vi.advanceTimersByTimeAsync(0);
    expect(done()).toBe(true);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("settles shortly after the server-reflexive candidate without TURN, ignoring host ones", async () => {
    vi.useFakeTimers();
    const pc = new FakePeer();
    const done = await pending(waitForIceGathering(pc as unknown as RTCPeerConnection));
    pc.candidate(null);
    pc.candidate("candidate:1 1 udp 1 192.0.2.1 9 typ host");
    await vi.advanceTimersByTimeAsync(1000); expect(done()).toBe(false);
    pc.candidate("candidate:2 1 udp 1 203.0.113.1 9 typ srflx raddr 0.0.0.0 rport 0");
    pc.candidate("candidate:3 1 udp 1 203.0.113.2 9 typ srflx raddr 0.0.0.0 rport 0");
    await vi.advanceTimersByTimeAsync(399); expect(done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(done()).toBe(true);
  });

  it("waits for a relay candidate when TURN is configured", async () => {
    vi.useFakeTimers();
    const pc = new FakePeer([{ urls: ["stun:stun.example", "turn:turn.example"] }]);
    const done = await pending(waitForIceGathering(pc as unknown as RTCPeerConnection));
    pc.candidate("candidate:2 1 udp 1 203.0.113.1 9 typ srflx raddr 0.0.0.0 rport 0");
    await vi.advanceTimersByTimeAsync(1000); expect(done()).toBe(false);
    pc.candidate("candidate:4 1 udp 1 203.0.113.9 9 typ relay raddr 0.0.0.0 rport 0");
    await vi.advanceTimersByTimeAsync(400); expect(done()).toBe(true);
  });

  it("gives up after the timeout, 10 s by default", async () => {
    vi.useFakeTimers();
    const pc = new FakePeer();
    const done = await pending(waitForIceGathering(pc as unknown as RTCPeerConnection));
    await vi.advanceTimersByTimeAsync(9_999); expect(done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(done()).toBe(true);
    const short = await pending(waitForIceGathering(new FakePeer() as unknown as RTCPeerConnection, 50));
    await vi.advanceTimersByTimeAsync(50); expect(short()).toBe(true);
  });

  it("with stallMs, gives up early when not a single candidate showed up", async () => {
    vi.useFakeTimers();
    const pc = new FakePeer();
    const done = await pending(waitForIceGathering(pc as unknown as RTCPeerConnection, 10_000, { stallMs: 3000 }));
    pc.candidate(null);
    await vi.advanceTimersByTimeAsync(2999); expect(done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(done()).toBe(true);
  });

  it("with stallMs, keeps waiting for the reflexive candidate once a host one came", async () => {
    vi.useFakeTimers();
    const pc = new FakePeer();
    const done = await pending(waitForIceGathering(pc as unknown as RTCPeerConnection, 10_000, { stallMs: 3000 }));
    pc.candidate("candidate:1 1 udp 1 192.0.2.1 9 typ host");
    await vi.advanceTimersByTimeAsync(9_999); expect(done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(done()).toBe(true);
  });

  it("with stallMs, a local description that already has candidates is not a stall", async () => {
    vi.useFakeTimers();
    const pc = Object.assign(new FakePeer(), { localDescription: { type: "offer", sdp: "v=0\r\na=candidate:1 1 udp 1 192.0.2.1 9 typ host\r\n" } });
    const done = await pending(waitForIceGathering(pc as unknown as RTCPeerConnection, 10_000, { stallMs: 3000 }));
    await vi.advanceTimersByTimeAsync(3000); expect(done()).toBe(false);
  });

  it("tells a description with candidates from one without", () => {
    expect(sdpHasCandidates("v=0\r\na=candidate:1 1 udp 1 192.0.2.1 9 typ host\r\n")).toBe(true);
    expect(sdpHasCandidates("v=0\r\na=ice-ufrag:abcd\r\n")).toBe(false);
    expect(sdpHasCandidates(undefined)).toBe(false);
  });
});
