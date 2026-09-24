import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  buildSdpFromSignal,
  compressSdp,
  decompressSdp,
  parseCallSignal,
  signalHasVideo,
  waitForIceGathering,
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

  it("keeps raddr/rport only as a pair and drops every other extension", () => {
    expect(withCandidate(`${HOST} raddr 0.0.0.0`)?.c).toEqual([HOST]);
    expect(withCandidate(`${HOST} rport 9`)?.c).toEqual([HOST]);
    expect(withCandidate(`${HOST} network-id 1 ufrag abcd raddr 0.0.0.0 rport 9`)?.c).toEqual([`${HOST} raddr 0.0.0.0 rport 9`]);
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
});
