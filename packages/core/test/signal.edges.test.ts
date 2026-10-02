import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildDataSdp, extractRtcParams, parseRtcSignal, type RtcSignal } from "../src/signal";

// covers: transport.webrtc

const valid: RtcSignal = { t: "o", ts: 1, u: "ufrag", p: "pwd+/=_-", f: "ab".repeat(32), s: "actpass", c: ["h,192.168.1.2,5000", "s,203.0.113.5,6000", "r,turn.example,3478"] };
const json = (patch: Record<string, unknown>) => JSON.stringify({ ...valid, ...patch });

describe("untrusted RTC signals", () => {
  it("accepts a well-formed offer and answer, keeping only known fields", () => {
    expect(parseRtcSignal(JSON.stringify(valid))).toEqual({ ...valid, o: undefined });
    expect(parseRtcSignal(json({ t: "a", o: 5, s: "active", extra: "x" }))).toEqual({ ...valid, t: "a", o: 5, s: "active" });
    expect(parseRtcSignal(json({ c: [] }))?.c).toEqual([]);
  });

  it.each([
    ["broken JSON", "{"],
    ["null", "null"],
    ["a number", "5"],
    ["an unknown type", json({ t: "x" })],
    ["a string timestamp", json({ ts: "1" })],
    ["an offer reference that is not a number", json({ o: "1" })],
    ["a missing ufrag", json({ u: undefined })],
    ["an empty ufrag", json({ u: "" })],
    ["a ufrag carrying an SDP line", json({ u: "a\r\na=candidate:evil" })],
    ["a ufrag with a space", json({ u: "a b" })],
    ["an oversized ufrag", json({ u: "a".repeat(257) })],
    ["a password carrying an SDP line", json({ p: "x\na=setup:active" })],
    ["a short fingerprint", json({ f: "ab".repeat(31) })],
    ["a fingerprint with colons", json({ f: "AB:".repeat(31) + "AB" })],
    ["an unknown setup role", json({ s: "holdconn" })],
    ["candidates that are not a list", json({ c: "h,1.2.3.4,5" })],
    ["more than eight candidates", json({ c: new Array(9).fill("h,1.2.3.4,5") })],
    ["a candidate that is not a string", json({ c: [5] })],
    ["a candidate of unknown type", json({ c: ["p,1.2.3.4,5"] })],
    ["a candidate address with a space", json({ c: ["h,1.2.3.4 typ,5"] })],
    ["a candidate address carrying an SDP line", json({ c: ["h,1.2.3.4\r\na=x,5"] })],
    ["a candidate without a port", json({ c: ["h,1.2.3.4"] })],
    ["a candidate port of six digits", json({ c: ["h,1.2.3.4,123456"] })],
    ["a candidate with an empty address", json({ c: ["h,,5"] })],
  ])("refuses %s", (_, input) => {
    expect(parseRtcSignal(input)).toBeNull();
  });

  it("refuses non-finite timestamps", () => {
    expect(parseRtcSignal(json({}).replace('"ts":1', '"ts":1e999'))).toBeNull();
  });

  it("never lets a parsed signal add lines to the SDP it builds", () => {
    fc.assert(fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), fc.string({ maxLength: 20 }), (u, p, addr) => {
      const parsed = parseRtcSignal(json({ u, p, c: [`h,${addr},1`] }));
      if (!parsed) return;
      const lines = buildDataSdp(parsed).trimEnd().split("\r\n");
      expect(lines).toHaveLength(buildDataSdp(valid).trimEnd().split("\r\n").length - 2);
      expect(lines.every(l => !l.includes("\n") && !l.includes("\r"))).toBe(true);
    }), { numRuns: 200 });
  });
});

describe("SDP round trip", () => {
  it("extracts from the SDP it builds exactly what was signalled", () => {
    const sdp = buildDataSdp(valid);
    expect(extractRtcParams(sdp)).toEqual({ u: valid.u, p: valid.p, f: valid.f, s: valid.s, c: valid.c });
    expect(sdp).toContain(`a=fingerprint:sha-256 ${"AB:".repeat(31)}AB`);
    expect(sdp).toMatch(/a=candidate:1 1 udp \d+ 192\.168\.1\.2 5000 typ host\r\n/);
    expect(sdp).toMatch(/typ relay raddr 0\.0\.0\.0 rport 0\r\n/);
    expect(sdp.endsWith("\r\n")).toBe(true);
  });

  it("round-trips any signal that parses", () => {
    const token = fc.stringMatching(/^[A-Za-z0-9+/=_-]{1,32}$/);
    const addr = fc.stringMatching(/^[A-Za-z0-9.:-]{1,20}$/);
    const cand = fc.tuple(fc.constantFrom("h", "s", "r"), addr, fc.integer({ min: 0, max: 65535 })).map(([t, a, p]) => `${t},${a},${p}`);
    fc.assert(fc.property(token, token, fc.stringMatching(/^[0-9a-f]{64}$/), fc.constantFrom("actpass", "active", "passive"), fc.array(cand, { maxLength: 8 }),
      (u, p, f, s, c) => {
        const signal = parseRtcSignal(JSON.stringify({ t: "o", ts: 1, u, p, f, s, c }));
        expect(signal).not.toBeNull();
        const back = extractRtcParams(buildDataSdp(signal!));
        expect([back.u, back.p, back.f, back.s]).toEqual([u, p, f, s]);
      }), { numRuns: 100 });
  });
});

describe("reading a local SDP", () => {
  it("keeps the first of repeated attributes, lowercases the fingerprint and handles CRLF or LF", () => {
    const sdp = ["a=ice-ufrag:one", "a=ice-ufrag:two", "a=ice-pwd:p1", "a=ice-pwd:p2", "A=FINGERPRINT:SHA-256 AA:BB", "a=fingerprint:sha-256 CC:DD",
      "a=setup:active", "a=setup:passive"].join("\r\n");
    expect(extractRtcParams(sdp)).toEqual({ u: "one", p: "p1", f: "aabb", s: "active", c: [] });
    expect(extractRtcParams(sdp.replace(/\r\n/g, "\n")).u).toBe("one");
  });

  it("keeps UDP component-1 candidates, at most two host, two reflexive and one relay, without duplicates", () => {
    const c = (type: string, addr: string, port = 1, comp = "1", proto = "udp") => `a=candidate:x ${comp} ${proto} 1 ${addr} ${port} typ ${type}`;
    const sdp = [
      c("host", "10.0.0.1"), c("host", "10.0.0.1"), c("host", "10.0.0.2"), c("host", "10.0.0.3"),
      c("srflx", "1.1.1.1"), c("srflx", "1.1.1.2"), c("srflx", "1.1.1.3"),
      c("relay", "2.2.2.2"), c("relay", "2.2.2.3"),
      c("prflx", "3.3.3.3"), c("host", "4.4.4.4", 1, "2"), c("host", "5.5.5.5", 1, "1", "tcp"), "a=candidate:short line",
      c("host", "6.6.6.6", 1, "1", "UDP"),
    ].join("\r\n");
    expect(extractRtcParams(sdp).c).toEqual(["h,10.0.0.1,1", "h,10.0.0.2,1", "s,1.1.1.1,1", "s,1.1.1.2,1", "r,2.2.2.2,1"]);
  });

  it("of many host candidates, carries those a reflexive candidate was gathered from, a VPN's last; the browser's order when nothing tells", () => {
    const host = (addr: string, port: number, extra = "") => `a=candidate:1 1 udp 2122260223 ${addr} ${port} typ host generation 0 network-id 1${extra}`;
    const srflx = (addr: string, port: number, base: string, rport: number, extra = "") => `a=candidate:2 1 udp 1686052607 ${addr} ${port} typ srflx raddr ${base} rport ${rport} generation 0 network-id 1${extra}`;
    // A Mac as Chromium lists it once the page may use the microphone: two VM bridges, Ethernet, Wi-Fi, Tailscale, a VPN.
    const mac = [host("192.168.139.3", 5001), host("192.168.186.3", 5002), host("192.168.0.20", 5003), host("192.168.0.21", 5004, " network-cost 10"),
      host("100.72.38.95", 5005, " network-cost 50"), host("10.5.0.2", 5006, " network-cost 50")];
    // Ethernet and Wi-Fi reach the STUN server, and so does the VPN: the two that are not costly go out, never the bridges.
    const reflexive = [srflx("203.0.113.7", 6003, "192.168.0.20", 5003), srflx("203.0.113.7", 6004, "192.168.0.21", 5004, " network-cost 10"), srflx("198.51.100.9", 6006, "10.5.0.2", 5006, " network-cost 50")];
    expect(extractRtcParams([...mac, ...reflexive].join("\r\n")).c).toEqual(["h,192.168.0.20,5003", "h,192.168.0.21,5004", "s,203.0.113.7,6003", "s,203.0.113.7,6004"]);
    // Only the VPN has a way out: a tunnel's address goes after every other, way out or not.
    expect(extractRtcParams([...mac, reflexive[2]].join("\r\n")).c).toEqual(["h,192.168.139.3,5001", "h,192.168.186.3,5002", "s,198.51.100.9,6006"]);
    expect(extractRtcParams([mac[4], mac[5], reflexive[2]].join("\r\n")).c).toEqual(["h,100.72.38.95,5005", "h,10.5.0.2,5006", "s,198.51.100.9,6006"]);
    // One interface with a way out: it, and the first of the rest.
    expect(extractRtcParams([...mac, reflexive[1]].join("\r\n")).c).toEqual(["h,192.168.139.3,5001", "h,192.168.0.21,5004", "s,203.0.113.7,6004"]);
    // No reflexive candidate (no STUN answer), or one that hides where it came from: the browser's order, costly ones last.
    expect(extractRtcParams(mac.join("\r\n")).c).toEqual(["h,192.168.139.3,5001", "h,192.168.186.3,5002"]);
    expect(extractRtcParams([host("100.72.38.95", 5005, " network-cost 50"), ...mac.slice(0, 4), srflx("203.0.113.7", 6003, "0.0.0.0", 0)].join("\r\n")).c)
      .toEqual(["h,192.168.139.3,5001", "h,192.168.186.3,5002", "s,203.0.113.7,6003"]);
    // A host name (mDNS) is a host candidate like another.
    expect(extractRtcParams([host("3f2b0c1e-7a55-4d3c-9c1a-2f6f0f1f2a3b.local", 5001), srflx("203.0.113.7", 6003, "0.0.0.0", 0)].join("\r\n")).c)
      .toEqual(["h,3f2b0c1e-7a55-4d3c-9c1a-2f6f0f1f2a3b.local,5001", "s,203.0.113.7,6003"]);
  });

  it("returns empty fields for an SDP without them", () => {
    expect(extractRtcParams("")).toEqual({ u: "", p: "", f: "", s: "", c: [] });
  });
});
