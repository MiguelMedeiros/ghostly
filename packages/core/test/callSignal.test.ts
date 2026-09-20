import { describe, expect, it } from "vitest";
import {
  CALL_SIGNAL_MAX_AGE_MS,
  buildSdpFromSignal,
  extractParamsFromSdp,
  parseCallSignal,
  signalHasVideo,
  type CallSignal,
} from "../src";

const NOW = 1_760_000_000_000;
const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i * 7).toString(16).padStart(2, "0").toUpperCase()).join(":");

/** Trimmed from a real Chromium offer with audio and video. */
const CHROME_OFFER = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0 1",
  "a=msid-semantic: WMS 7b0f7c3a",
  "m=audio 54400 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 203.0.113.7",
  "a=candidate:842163049 1 udp 2122260223 3f6b2a9e-1b7c-4b1d-9c3e-0d2f6f6f7a11.local 54400 typ host generation 0 network-id 1 network-cost 10",
  "a=candidate:1510613869 1 tcp 1518280447 3f6b2a9e-1b7c-4b1d-9c3e-0d2f6f6f7a11.local 9 typ host tcptype active generation 0 network-id 1",
  "a=candidate:3345412921 1 udp 1686052607 203.0.113.7 61000 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-id 1 network-cost 10",
  "a=ice-ufrag:x9Kq",
  "a=ice-pwd:Q2m1yU7tX8nB4vL0pR6sZ3aW",
  "a=ice-options:trickle",
  `a=fingerprint:sha-256 ${FINGERPRINT}`,
  "a=setup:actpass",
  "a=mid:0",
  "a=sendrecv",
  "a=rtcp-mux",
  "a=rtpmap:111 opus/48000/2",
  "a=ssrc:1001234567 cname:abc",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "c=IN IP4 0.0.0.0",
  "a=ice-ufrag:x9Kq",
  "a=ice-pwd:Q2m1yU7tX8nB4vL0pR6sZ3aW",
  `a=fingerprint:sha-256 ${FINGERPRINT}`,
  "a=setup:actpass",
  "a=mid:1",
  "a=rtpmap:96 VP8/90000",
  "a=ssrc:4294967295 cname:abc",
  "",
].join("\r\n");

/** Trimmed from a real Firefox answer, audio only. */
const FIREFOX_ANSWER = [
  "v=0",
  "o=mozilla...THIS_IS_SDPARTA-99.0 7312283940532018413 0 IN IP4 0.0.0.0",
  "s=-",
  "t=0 0",
  `a=fingerprint:sha-256 ${FINGERPRINT}`,
  "a=group:BUNDLE 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=candidate:0 1 UDP 2122252543 9a1c2f47-5d2e-4e0a-8f7b-1c2d3e4f5a6b.local 50001 typ host",
  "a=candidate:1 1 UDP 1686052863 198.51.100.4 50001 typ srflx raddr 0.0.0.0 rport 0",
  "a=ice-pwd:6b3f0c2d9e8a7b6c5d4e3f2a1b0c9d8e",
  "a=ice-ufrag:1a2b3c4d",
  "a=mid:0",
  "a=setup:active",
  "a=ssrc:271828182 cname:{f00}",
  "",
].join("\r\n");

function signalFrom(sdp: string, t: "o" | "a"): string {
  return JSON.stringify({ t, ts: NOW, ...extractParamsFromSdp(sdp) });
}

describe("call signals", () => {
  it("accepts a real Chromium offer and rebuilds the same parameters", () => {
    const json = signalFrom(CHROME_OFFER, "o");
    const signal = parseCallSignal(json, NOW)!;
    expect(signal).not.toBeNull();
    expect(signal.m).toEqual(["a", "v"]);
    expect(signal.ss).toEqual([1001234567, 4294967295]);
    expect(signal.c).toEqual([
      "842163049 1 udp 2122260223 3f6b2a9e-1b7c-4b1d-9c3e-0d2f6f6f7a11.local 54400 typ host",
      "3345412921 1 udp 1686052607 203.0.113.7 61000 typ srflx raddr 0.0.0.0 rport 0",
    ]);

    const rebuilt = buildSdpFromSignal(signal);
    for (const c of signal.c!) expect(rebuilt).toContain(`\r\na=candidate:${c}\r\n`);
    const again = extractParamsFromSdp(rebuilt);
    expect({ ...again, c: undefined }).toEqual({ u: signal.u, p: signal.p, f: signal.f, s: signal.s, m: signal.m, ss: signal.ss });
    // What our own rebuilt SDP produces validates too.
    expect(parseCallSignal(JSON.stringify({ t: "o", ts: NOW, ...again }), NOW)).not.toBeNull();
  });

  it("accepts a real Firefox answer", () => {
    const signal = parseCallSignal(signalFrom(FIREFOX_ANSWER, "a"), NOW)!;
    expect(signal).not.toBeNull();
    expect(signal.s).toBe("active");
    expect(signal.m).toEqual(["a"]);
    expect(signal.c).toEqual(["1 1 udp 1686052863 198.51.100.4 50001 typ srflx raddr 0.0.0.0 rport 0"]);
    expect(buildSdpFromSignal(signal)).toContain("a=candidate:1 1 udp 1686052863 198.51.100.4 50001 typ srflx");
  });

  it("accepts hang-ups and keeps only their type and time", () => {
    expect(parseCallSignal(JSON.stringify({ t: "h", ts: NOW, u: "x\r\n" }), NOW)).toEqual({ t: "h", ts: NOW });
  });

  it("rejects values that could inject SDP lines", () => {
    const good = JSON.parse(signalFrom(CHROME_OFFER, "o")) as CallSignal;
    const bad = (patch: Record<string, unknown>) => parseCallSignal(JSON.stringify({ ...good, ...patch }), NOW);
    expect(bad({ u: "x9Kq\r\na=setup:active" })).toBeNull();
    expect(bad({ p: "Q2m1yU7tX8nB4vL0pR6sZ3aW\r\na=ssrc:1 cname:x" })).toBeNull();
    expect(bad({ c: ["1 1 udp 1 1.2.3.4 9 typ host\r\na=fingerprint:sha-256 00"] })).toBeNull();
    expect(bad({ c: ["1 1 udp 1 1.2.3.4 9 typ host generation 0\na=x"] })).toBeNull();
    expect(bad({ c: ["1 1 udp 1 1.2.3.4\r\n 9 typ host"] })).toBeNull();
    expect(bad({ f: `${good.f}\r\na=x` })).toBeNull();
    expect(bad({ s: "actpass\r\na=x" })).toBeNull();
    expect(bad({ m: ["a", "a=x"] })).toBeNull();
  });

  it("rejects malformed fields and wrong types", () => {
    const good = JSON.parse(signalFrom(CHROME_OFFER, "o")) as CallSignal;
    const bad = (patch: Record<string, unknown>) => parseCallSignal(JSON.stringify({ ...good, ...patch }), NOW);
    expect(parseCallSignal("not json", NOW)).toBeNull();
    expect(parseCallSignal("null", NOW)).toBeNull();
    expect(parseCallSignal("[]", NOW)).toBeNull();
    expect(bad({ t: "x" })).toBeNull();
    expect(bad({ ts: "1" })).toBeNull();
    expect(bad({ u: 12345 })).toBeNull();
    expect(bad({ u: "abc" })).toBeNull();
    expect(bad({ p: "short" })).toBeNull();
    expect(bad({ f: "zz" })).toBeNull();
    expect(bad({ f: undefined })).toBeNull();
    expect(bad({ s: "holdconn" })).toBeNull();
    expect(bad({ m: "av" })).toBeNull();
    expect(bad({ m: [] })).toBeNull();
    expect(bad({ m: ["a", "v", "v"] })).toBeNull();
    expect(bad({ ss: [-1] })).toBeNull();
    expect(bad({ ss: [0x100000000] })).toBeNull();
    expect(bad({ ss: [1.5] })).toBeNull();
    expect(bad({ c: "1 1 udp 1 1.2.3.4 9 typ host" })).toBeNull();
    expect(bad({ c: [42] })).toBeNull();
    expect(bad({ c: ["1 1 udp 1 1.2.3.4 70000 typ host"] })).toBeNull();
    expect(bad({ c: ["1 1 udp 99999999999 1.2.3.4 9 typ host"] })).toBeNull();
    expect(bad({ c: ["1 1 udp 1 1.2.3.4 9 typ bogus"] })).toBeNull();
    expect(bad({ c: Array(9).fill(good.c![0]) })).toBeNull();
  });

  it("drops candidates that are not UDP", () => {
    const good = JSON.parse(signalFrom(CHROME_OFFER, "o")) as CallSignal;
    const signal = parseCallSignal(JSON.stringify({ ...good, c: ["1 1 tcp 1 1.2.3.4 9 typ host tcptype active"] }), NOW);
    expect(signal?.c).toEqual([]);
  });

  it("accepts a media state, which carries a picture and nothing else", () => {
    expect(parseCallSignal(JSON.stringify({ t: "v", ts: NOW, v: 1, k: "s" }), NOW)).toEqual({ t: "v", ts: NOW, v: 1, k: "s" });
    expect(parseCallSignal(JSON.stringify({ t: "v", ts: NOW, v: 0 }), NOW)).toEqual({ t: "v", ts: NOW, v: 0 });
    // No ICE is needed for one, and none of it is kept.
    expect(parseCallSignal(JSON.stringify({ t: "v", ts: NOW, v: 1, u: "x\r\na=setup:active" }), NOW)).toEqual({ t: "v", ts: NOW, v: 1 });
    expect(parseCallSignal(JSON.stringify({ t: "v", ts: NOW, v: 2 }), NOW)).toBeNull();
    expect(parseCallSignal(JSON.stringify({ t: "v", ts: NOW, v: "1" }), NOW)).toBeNull();
    expect(parseCallSignal(JSON.stringify({ t: "v", ts: NOW, v: 1, k: "screen" }), NOW)).toBeNull();
    expect(parseCallSignal(JSON.stringify({ t: "v", ts: NOW - CALL_SIGNAL_MAX_AGE_MS - 1, v: 1 }), NOW)).toBeNull();
  });

  it("carries the picture on an offer, and rejects a malformed one", () => {
    const good = JSON.parse(signalFrom(CHROME_OFFER, "o")) as CallSignal;
    const offer = (patch: Record<string, unknown>) => parseCallSignal(JSON.stringify({ ...good, ...patch }), NOW);
    expect(offer({ v: 0 })?.v).toBe(0);
    expect(offer({ v: 1, k: "s" })?.k).toBe("s");
    expect(offer({ v: 3 })).toBeNull();
    expect(offer({ k: "x" })).toBeNull();
  });

  it("says who is sending a picture, and reads a v1 peer without asking it", () => {
    const video = JSON.parse(signalFrom(CHROME_OFFER, "o")) as CallSignal;
    // v2 answers with `v`: the video section is always there, on or off.
    expect(signalHasVideo({ ...video, v: 0 })).toBe(false);
    expect(signalHasVideo({ ...video, v: 1 })).toBe(true);
    expect(signalHasVideo({ t: "v", ts: NOW, v: 1 })).toBe(true);
    expect(signalHasVideo({ t: "v", ts: NOW, v: 0 })).toBe(false);
    expect(signalHasVideo(null)).toBe(false);
    // A v1 peer sends no `v`: it only puts an SSRC on the video section it sends on.
    expect(signalHasVideo(video)).toBe(true);
    expect(signalHasVideo({ ...video, ss: [video.ss![0]] })).toBe(false);
    expect(signalHasVideo(parseCallSignal(signalFrom(FIREFOX_ANSWER, "a"), NOW))).toBe(false);
  });

  it("rejects signals that are too old or too far in the future", () => {
    const offer = JSON.parse(signalFrom(CHROME_OFFER, "o")) as CallSignal;
    const at = (ts: number) => JSON.stringify({ ...offer, ts });
    expect(parseCallSignal(at(NOW - CALL_SIGNAL_MAX_AGE_MS), NOW)).not.toBeNull();
    expect(parseCallSignal(at(NOW - CALL_SIGNAL_MAX_AGE_MS - 1), NOW)).toBeNull();
    expect(parseCallSignal(at(NOW + CALL_SIGNAL_MAX_AGE_MS + 1), NOW)).toBeNull();
    expect(parseCallSignal(JSON.stringify({ t: "h", ts: NOW - 10 * 60_000 }), NOW)).toBeNull();
    expect(parseCallSignal(JSON.stringify({ t: "h", ts: 1 }), NOW)).toBeNull();
  });
});
