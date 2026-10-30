import { describe, expect, it } from "vitest";
import { RTC_CONFIG, callRtcConfig, contactRtcConfig, extractParamsFromSdp, extractRtcParams, keepsToRelays, parseCallSignal, pickCallCandidates, PAIRED_CALL_CANDIDATES } from "../src";
// covers: settings.network.relay-only

const NOW = 1_760_000_000_000;
const TURN = { urls: "turn:turn.example.org:3478, stun:turn.example.org:3478", username: "u", credential: "p" };

/** What a connection gathers with STUN and a TURN server: host, server reflexive and relay candidates, each naming this device in `raddr`. */
const GATHERED = [
  "1 1 udp 2122260223 192.168.1.20 50000 typ host generation 0",
  "2 1 udp 2122194687 2001:db8::20 50001 typ host generation 0",
  "3 1 udp 1686052607 203.0.113.7 50000 typ srflx raddr 192.168.1.20 rport 50000 generation 0",
  "4 1 udp 41885439 198.51.100.9 60000 typ relay raddr 203.0.113.7 rport 50000 generation 0",
  "5 1 udp 41819903 198.51.100.9 60002 typ relay raddr 2001:db8::20 rport 50001 generation 0",
  "6 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active generation 0",
];
const SDP = [
  "v=0", "m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=ice-ufrag:YMMd", "a=ice-pwd:fpzBkrMsIRuhHekXupyTDFopKaWShAFt",
  `a=fingerprint:sha-256 ${Array.from({ length: 32 }, () => "AB").join(":")}`, "a=setup:actpass",
  ...GATHERED.map((c) => `a=candidate:${c}`),
].join("\r\n") + "\r\n";

const relayOnlyLine = (c: string) => / typ relay( |$)/.test(c) && !/ r(addr|port) /.test(` ${c} `);

describe("Hide my IP from contacts (relay only)", () => {
  it("a call's connection keeps to the profile's TURN server: relay policy, no STUN server of the apps' or the profile's", () => {
    const config = callRtcConfig([TURN, { urls: "stun:stun.example.org" }], { relayOnly: true });
    expect(config.iceTransportPolicy).toBe("relay");
    expect(config.iceServers).toEqual([{ urls: ["turn:turn.example.org:3478"], username: "u", credential: "p" }]);
    expect(JSON.stringify(config)).not.toContain("stun:");
    // Off: as before, the apps' STUN servers first.
    expect(callRtcConfig([TURN]).iceServers?.slice(0, RTC_CONFIG.iceServers!.length)).toEqual(RTC_CONFIG.iceServers);
    expect(callRtcConfig([TURN]).iceTransportPolicy).toBeUndefined();
  });

  it("with no usable TURN server it has no server at all: the connection finds no candidate, it never goes direct", () => {
    for (const servers of [[], [{ urls: "turn:turn.example.org:3478", username: "u" }], [{ urls: "stun:stun.example.org" }]]) {
      const config = callRtcConfig(servers, { relayOnly: true });
      expect(config.iceServers).toEqual([]);
      expect(config.iceTransportPolicy).toBe("relay");
    }
  });

  it("a chat's data link and a group's edge take the same rules, without a call's candidate pool; off, the configuration they had", () => {
    expect(contactRtcConfig({ iceServers: [TURN], relayOnly: true })).toEqual({ iceServers: [{ urls: ["turn:turn.example.org:3478"], username: "u", credential: "p" }], iceTransportPolicy: "relay" });
    expect(contactRtcConfig({ iceServers: [TURN] })).toEqual({ iceServers: [...RTC_CONFIG.iceServers!, { urls: ["turn:turn.example.org:3478", "stun:turn.example.org:3478"], username: "u", credential: "p" }] });
    expect(contactRtcConfig({})).toEqual({ iceServers: RTC_CONFIG.iceServers });
  });

  it("a connection says whether it keeps to relays", () => {
    expect(keepsToRelays({ getConfiguration: () => contactRtcConfig({ iceServers: [TURN], relayOnly: true }) })).toBe(true);
    expect(keepsToRelays({ getConfiguration: () => contactRtcConfig({ iceServers: [TURN] }) })).toBe(false);
    expect(keepsToRelays(null)).toBe(false);
  });

  it("a call's signal carries relay candidates only, without their related address: on the session and in a compatibility chat's `_call`", () => {
    const paired = extractParamsFromSdp(SDP, { maxCandidates: PAIRED_CALL_CANDIDATES, relayOnly: true }).c!;
    expect(paired).toEqual(["4 1 udp 41885439 198.51.100.9 60000 typ relay generation 0", "5 1 udp 41819903 198.51.100.9 60002 typ relay generation 0"]);
    // A `_call` record's two slots go to the relay candidates, not a host and a server reflexive one.
    const record = extractParamsFromSdp(SDP, { relayOnly: true }).c!;
    expect(record).toEqual(paired);
    for (const c of [...paired, ...record]) expect(relayOnlyLine(c)).toBe(true);
    expect(pickCallCandidates(GATHERED, PAIRED_CALL_CANDIDATES, { relayOnly: true, loopback: true }).every(relayOnlyLine)).toBe(true);
    // The receiver takes them as any signal (no wire change).
    expect(parseCallSignal(JSON.stringify({ t: "o", ts: NOW, ...extractParamsFromSdp(SDP, { relayOnly: true }) }), NOW)?.c).toEqual([
      "4 1 udp 41885439 198.51.100.9 60000 typ relay", "5 1 udp 41819903 198.51.100.9 60002 typ relay",
    ]);
    // Off: the host and the server reflexive one, as before.
    expect(extractParamsFromSdp(SDP).c!.map((c) => / typ (\S+)/.exec(c)?.[1])).toEqual(["host", "srflx"]);
  });

  it("a chat's data link signal carries its relay candidate only", () => {
    expect(extractRtcParams(SDP, { relayOnly: true }).c).toEqual(["r,198.51.100.9,60000"]);
    expect(extractRtcParams(SDP).c).toEqual(["h,192.168.1.20,50000", "h,2001:db8::20,50001", "s,203.0.113.7,50000", "r,198.51.100.9,60000"]);
  });
});
