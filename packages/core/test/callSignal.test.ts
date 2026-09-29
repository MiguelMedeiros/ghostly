import { describe, expect, it } from "vitest";
import {
  CALL_SIGNAL_MAX_AGE_MS,
  PAIRED_CALL_CANDIDATES,
  RTC_CONFIG,
  buildSdpFromSignal,
  callRtcConfig,
  extractParamsFromSdp,
  pickCallCandidates,
  parseCallSignal,
  signalHasVideo,
  type CallSignal,
} from "../src";
// covers: calls.signal

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

/**
 * Trimmed from a real macOS WKWebView offer (Ghostly Desktop, e2e/desktop-macos/): mDNS hosts, the IPv6 srflx
 * before the IPv4 one, with `raddr ::` (apps before 0.5 refused that candidate, and with it the call), and H264
 * as payload type 96 with VP8 as 106.
 */
const WKWEBVIEW_OFFER = [
  "v=0",
  "o=- 2412466377843330145 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "m=audio 16433 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 203.0.113.9",
  "a=candidate:874789337 1 udp 2113937151 1215f0e7-60fa-4931-a97f-ee4197a5aa4e.local 60419 typ host generation 0 network-cost 999",
  "a=candidate:354790382 1 udp 1677732095 2001:db8:8785:c1e7:f5d3:2b6d:efb7:c24c 55917 typ srflx raddr :: rport 0 generation 0 network-cost 999",
  "a=candidate:1731680029 1 udp 1677729535 203.0.113.9 16433 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999",
  "a=ice-ufrag:kgXv",
  "a=ice-pwd:Q2m1yU7tX8nB4vL0pR6sZ3aW",
  `a=fingerprint:sha-256 ${FINGERPRINT}`,
  "a=setup:actpass",
  "a=mid:0",
  "a=rtpmap:111 opus/48000/2",
  "a=ssrc:1645469715 cname:svyNYI+YI3b6fMz+",
  "m=video 16432 UDP/TLS/RTP/SAVPF 96 97 106 107",
  "c=IN IP4 203.0.113.9",
  "a=ice-ufrag:kgXv",
  "a=ice-pwd:Q2m1yU7tX8nB4vL0pR6sZ3aW",
  `a=fingerprint:sha-256 ${FINGERPRINT}`,
  "a=setup:actpass",
  "a=mid:1",
  "a=rtpmap:96 H264/90000",
  "a=rtpmap:97 rtx/90000",
  "a=rtpmap:106 VP8/90000",
  "a=rtpmap:107 rtx/90000",
  "a=ssrc:1458394585 cname:svyNYI+YI3b6fMz+",
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

  it("accepts a real WKWebView offer, whose first srflx is IPv6 with `raddr ::`, and leaves the related address out", () => {
    const signal = parseCallSignal(signalFrom(WKWEBVIEW_OFFER, "o"), NOW)!;
    expect(signal).not.toBeNull();
    expect(signal.c).toEqual([
      "874789337 1 udp 2113937151 1215f0e7-60fa-4931-a97f-ee4197a5aa4e.local 60419 typ host",
      // Without `raddr :: rport 0`, which apps before 0.5 refuse (and the whole signal with it).
      "354790382 1 udp 1677732095 2001:db8:8785:c1e7:f5d3:2b6d:efb7:c24c 55917 typ srflx",
    ]);
    expect(buildSdpFromSignal(signal)).toContain("a=candidate:354790382 1 udp 1677732095 2001:db8:8785:c1e7:f5d3:2b6d:efb7:c24c 55917 typ srflx\r\n");
  });

  it("carries a VP8 payload type other than 96, so the SDP rebuilt from WebKit's offer says what WebKit sends", () => {
    const signal = parseCallSignal(signalFrom(WKWEBVIEW_OFFER, "o"), NOW)!;
    // Opus is 111 as everywhere: not said.
    expect(signal).toMatchObject({ vp: 106 });
    expect(signal.ap).toBeUndefined();
    const rebuilt = buildSdpFromSignal(signal);
    const lines = rebuilt.split("\r\n");
    // Only the lines that name a payload type are read: the session id and the
    // SSRCs are random, and one of them starting with 96 is not a payload type.
    const videoMedia = lines.filter((line) => line.startsWith("m=video "));
    expect(videoMedia).toEqual(["m=video 9 UDP/TLS/RTP/SAVPF 106"]);
    const rtpmaps = lines.filter((line) => line.startsWith("a=rtpmap:"));
    expect(rtpmaps).toContain("a=rtpmap:106 VP8/90000");
    expect(rtpmaps.filter((line) => /VP8/i.test(line))).toEqual(["a=rtpmap:106 VP8/90000"]);
    expect(rtpmaps.some((line) => line.startsWith("a=rtpmap:96 "))).toBe(false);
    const feedback = lines.filter((line) => line.startsWith("a=rtcp-fb:"));
    expect(feedback).toContain("a=rtcp-fb:106 nack pli");
    expect(feedback.every((line) => line.startsWith("a=rtcp-fb:106 "))).toBe(true);
    // The answer made from it keeps 106, and says so.
    expect(extractParamsFromSdp(rebuilt).vp).toBe(106);
  });

  it("says nothing about payload types that are already the rebuilt SDP's: a Chromium signal is unchanged", () => {
    const params = extractParamsFromSdp(CHROME_OFFER);
    expect(params).not.toHaveProperty("ap");
    expect(params).not.toHaveProperty("vp");
    expect(buildSdpFromSignal(parseCallSignal(signalFrom(CHROME_OFFER, "o"), NOW)!)).toContain("\r\na=rtpmap:96 VP8/90000\r\n");
  });

  it("keeps a host candidate whose line ends at `typ host` (webrtc-rs, the Linux Desktop's calls)", () => {
    const linux = [
      "v=0", "o=- 1 2 IN IP4 0.0.0.0", "s=-", "t=0 0", "a=group:BUNDLE 0 1",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0", "a=ice-ufrag:YMMdExaxQBHqpEPs",
      "a=ice-pwd:fpzBkrMsIRuhHekXupyTDFopKaWShAFt", `a=fingerprint:sha-256 ${FINGERPRINT}`, "a=setup:actpass", "a=mid:0",
      "a=rtpmap:111 opus/48000/2", "a=ssrc:1 cname:ghostly", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:1",
      "a=rtpmap:96 VP8/90000", "a=ssrc:2 cname:ghostly",
      "a=candidate:2519499965 1 udp 2130706431 192.168.215.2 58888 typ host",
      "a=candidate:2052316515 1 udp 1694498815 203.0.113.9 51670 typ srflx raddr 192.168.215.2 rport 58888",
    ].join("\r\n") + "\r\n";
    const signal = parseCallSignal(signalFrom(linux, "o"), NOW)!;
    expect(signal.c).toEqual([
      "2519499965 1 udp 2130706431 192.168.215.2 58888 typ host",
      "2052316515 1 udp 1694498815 203.0.113.9 51670 typ srflx raddr 192.168.215.2 rport 58888",
    ]);
    expect(signal.ss).toEqual([1, 2]);
  });

  it("carries an Opus payload type other than 111 (Firefox offers it as 109)", () => {
    const firefox = FIREFOX_ANSWER.replace("m=audio 9 UDP/TLS/RTP/SAVPF 111", "m=audio 9 UDP/TLS/RTP/SAVPF 109").replace("a=mid:0", "a=mid:0\r\na=rtpmap:109 opus/48000/2");
    const signal = parseCallSignal(signalFrom(firefox, "a"), NOW)!;
    expect(signal.ap).toBe(109);
    expect(buildSdpFromSignal(signal)).toContain("\r\nm=audio 9 UDP/TLS/RTP/SAVPF 109\r\n");
  });

  it("accepts a real Firefox answer", () => {
    const signal = parseCallSignal(signalFrom(FIREFOX_ANSWER, "a"), NOW)!;
    expect(signal).not.toBeNull();
    expect(signal.s).toBe("active");
    expect(signal.m).toEqual(["a"]);
    // Firefox ends a host line at `typ host` too: its (mDNS) host candidate goes with the reflexive one.
    expect(signal.c).toEqual([
      "0 1 udp 2122252543 9a1c2f47-5d2e-4e0a-8f7b-1c2d3e4f5a6b.local 50001 typ host",
      "1 1 udp 1686052863 198.51.100.4 50001 typ srflx raddr 0.0.0.0 rport 0",
    ]);
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

/** What Chromium gathers on a Mac with a VM bridge, Wi-Fi, Tailscale and a VPN (NordVPN) as its default route. */
const MAC_WITH_VPN = [
  "550571598 1 udp 2122194687 192.168.139.3 50243 typ host generation 0 network-id 1",
  "2340100888 1 udp 2122063615 192.168.0.164 60348 typ host generation 0 network-id 5",
  "273961055 1 udp 2121998079 192.168.0.161 63386 typ host generation 0 network-id 4 network-cost 10",
  "1045614580 1 udp 2121867007 100.72.38.95 54886 typ host generation 0 network-id 6 network-cost 50",
  "3454620636 1 udp 2121801471 10.5.0.2 50574 typ host generation 0 network-id 8 network-cost 50",
  "114747471 1 udp 2122265343 fd07:b51a:cc66:0:a617:db5e:ab7:e9f1 61448 typ host generation 0 network-id 2",
  "336885833 1 udp 2121937663 2804:14c:8785:c1e7::1 51839 typ host generation 0 network-id 7",
  "1579085014 1 tcp 1518214911 192.168.139.3 9 typ host tcptype active generation 0 network-id 1",
  "4187686296 1 udp 1685593855 187.13.209.68 53505 typ srflx raddr 10.5.0.2 rport 50574 generation 0 network-id 8 network-cost 50",
  "777 1 udp 41885695 203.0.113.9 3478 typ relay raddr 187.13.209.68 rport 53505 generation 0",
  "888 1 udp 2122260223 127.0.0.1 5000 typ host generation 0",
  "999 1 udp 2122260223 169.254.1.1 5000 typ host generation 0",
];

describe("call candidates on the chat session", () => {
  it("carry every path: local networks first, then the server reflexive and relay ones, IPv6, and the VPN's last", () => {
    const picked = pickCallCandidates(MAC_WITH_VPN);
    expect(picked).toHaveLength(PAIRED_CALL_CANDIDATES);
    expect(picked.map((c) => c.split(" ")[4])).toEqual([
      "192.168.139.3", "192.168.0.164", "192.168.0.161", "187.13.209.68", "203.0.113.9", "2804:14c:8785:c1e7::1", "fd07:b51a:cc66:0:a617:db5e:ab7:e9f1", "100.72.38.95",
    ]);
    // The related address is informational: never carried.
    expect(picked.every((c) => !c.includes(" raddr "))).toBe(true);
    // Room for more: the VPN's tunnel comes last.
    expect(pickCallCandidates(MAC_WITH_VPN, 12).map((c) => c.split(" ")[4]).slice(-2)).toEqual(["100.72.38.95", "10.5.0.2"]);
    // Loopback only when asked (the CLI's tests bind to it).
    expect(pickCallCandidates(MAC_WITH_VPN, 12, { loopback: true }).map((c) => c.split(" ")[4])).toContain("127.0.0.1");
  });

  it("a signal carries them when it may, and every one survives the receiver's checks", () => {
    const sdp = [...CHROME_OFFER.split("\r\n").filter((l) => !l.startsWith("a=candidate:")), ...MAC_WITH_VPN.map((c) => `a=candidate:${c}`)].join("\r\n");
    expect(extractParamsFromSdp(sdp).c).toHaveLength(2);
    const params = extractParamsFromSdp(sdp, { maxCandidates: PAIRED_CALL_CANDIDATES });
    expect(params.c).toHaveLength(8);
    const parsed = parseCallSignal(JSON.stringify({ t: "o", ts: NOW, ...params }), NOW);
    expect(parsed?.c).toHaveLength(8);
    expect(buildSdpFromSignal(parsed!).match(/^a=candidate:/gm)?.length).toBe(16);
  });

  it("a call uses the profile's ICE servers after the apps' STUN servers", () => {
    expect(callRtcConfig()).toEqual(RTC_CONFIG);
    const config = callRtcConfig([{ urls: "turn:turn.example.org:3478, turns:turn.example.org:5349", username: "u", credential: "p" }, { urls: " " }]);
    expect(config.iceServers?.slice(RTC_CONFIG.iceServers!.length)).toEqual([{ urls: ["turn:turn.example.org:3478", "turns:turn.example.org:5349"], username: "u", credential: "p" }]);
  });
});

