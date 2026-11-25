import { afterEach, describe, expect, it, vi } from "vitest";
import { rtcLogKept, rtcLogLevel, rtcLogLine, startRtcLog } from "../src/calls/rtcLog";
// covers: headless.calls

/*
 * `GHOSTLY_RTC_LOG=<level>` turns on libdatachannel's own log (a call's ICE checks, for a call that never connects).
 * Unset, the CLI is as it was: node-datachannel's logger is never set. Set, its lines go to stderr with the call's
 * secrets cut out, since they end up in logs others read (a CI job's).
 */

afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock("node-datachannel"); vi.resetModules(); });

/** A node-datachannel whose logger is a spy; it says the lines `lines` gives once set. */
function fakeLib(lines: [string, string][] = []) {
  const initLogger = vi.fn((_level: string, cb?: (level: string, message: string) => void) => { for (const [l, m] of lines) cb?.(l, m); });
  return { initLogger: initLogger as unknown as Parameters<typeof startRtcLog>[0]["initLogger"], spy: initLogger };
}

describe("GHOSTLY_RTC_LOG", () => {
  it("takes libdatachannel's levels in any case, and nothing else", () => {
    expect(rtcLogLevel("Debug")).toBe("Debug");
    expect(rtcLogLevel("verbose")).toBe("Verbose");
    expect(rtcLogLevel(" WARNING ")).toBe("Warning");
    for (const value of [undefined, "", " ", "1", "on", "loud", "Debugging"]) expect(rtcLogLevel(value)).toBeNull();
  });

  it("unset or unknown: the logger is never set and nothing is written", () => {
    const write = vi.fn();
    for (const env of [{}, { GHOSTLY_RTC_LOG: "" }, { GHOSTLY_RTC_LOG: "loud" }]) {
      const lib = fakeLib();
      expect(startRtcLog(lib, env, write)).toBe(false);
      expect(lib.spy).not.toHaveBeenCalled();
    }
    expect(write).not.toHaveBeenCalled();
  });

  it("a logger that cannot be set leaves things as they were, with no throw", () => {
    const write = vi.fn();
    const lib = { initLogger: () => { throw new Error("no logger here"); } };
    expect(startRtcLog(lib, { GHOSTLY_RTC_LOG: "Debug" }, write)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("set: each line on stderr's way at its level, a description's lines indented under it", () => {
    const out: string[] = [];
    const lib = fakeLib([
      ["Debug", "juice: Received STUN datagram from 192.168.1.20:52000"],
      ["Verbose", "Setting remote description: v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=candidate:1 1 UDP 2122317823 10.0.0.5 50000 typ host\r\n"],
    ]);
    expect(startRtcLog(lib, { GHOSTLY_RTC_LOG: "debug" }, (text) => out.push(text))).toBe(true);
    expect(lib.spy).toHaveBeenCalledWith("Debug", expect.any(Function));
    expect(out.join("")).toBe([
      "ghostly: rtc Debug: juice: Received STUN datagram from 192.168.1.20:52000",
      "ghostly: rtc Verbose: Setting remote description: v=0",
      "  o=- 1 1 IN IP4 0.0.0.0",
      "  a=candidate:1 1 UDP 2122317823 10.0.0.5 50000 typ host",
      "",
    ].join("\n"));
  });

  it("cuts ICE passwords and user fragments, user names, nonces and fingerprints; keeps addresses and what failed", () => {
    const fingerprint = Array.from({ length: 32 }, (_, i) => (i * 7 % 256).toString(16).padStart(2, "0").toUpperCase()).join(":");
    const secrets = ["Uf9q", "PwdOfTheCall0123456789ab", "Ab12", "Cd34", "turnuser", "s3cretNonce", fingerprint];
    const lines = [
      `juice: Created local description: ufrag="Uf9q", pwd="PwdOfTheCall0123456789ab"`,
      `juice: Parsed remote description: ufrag="Uf9q", pwd="PwdOfTheCall0123456789ab", candidates=2`,
      `juice: STUN integrity check failed, password="PwdOfTheCall0123456789ab"`,
      `juice: STUN local ufrag check failed, expected="Ab12", actual="Cd34"`,
      `juice: STUN username invalid, username="Ab12:Cd34"`,
      `juice: Got username: turnuser`,
      `juice: Got nonce: s3cretNonce`,
      `Setting custom ICE attributes, ufrag="Uf9q", pwd="PwdOfTheCall0123456789ab"`,
      `Issuing local description: v=0\r\na=ice-ufrag:Uf9q\r\na=ice-pwd:PwdOfTheCall0123456789ab\r\na=fingerprint:sha-256 ${fingerprint}\r\na=candidate:1 1 UDP 2122317823 192.168.1.20 52000 typ host\r\n`,
      `Valid fingerprint "${fingerprint}"`,
      `Adding remote candidate: a=candidate:842163049 1 udp 1677729535 203.0.113.9 61000 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag Uf9q network-cost 999`,
    ];
    const out = lines.map(rtcLogLine).join("\n");
    for (const secret of secrets) expect(out).not.toContain(secret);
    for (const kept of ["192.168.1.20 52000", "203.0.113.9 61000", "STUN integrity check failed", "STUN local ufrag check failed", "candidates=2", "typ srflx"]) expect(out).toContain(kept);
    expect(out).toContain("a=ice-pwd:<hidden>");
    expect(out).toContain(`pwd=<hidden>`);
    // Lines with nothing to hide stay as they are.
    for (const plain of ["juice: STUN fingerprint check succeeded", "Changed ICE state to checking", "juice: STUN entry 3: Sending request to 10.0.0.5:50000 (6 retransmissions left)"]) expect(rtcLogLine(plain)).toBe(plain);
  });

  it("at Verbose, keeps the ICE agent's checks and candidates, not the lines each datagram brings", () => {
    // Over 2,000 lines a second on a call's audio, from about 20 lines per datagram; the checks are what the log is for.
    const at = (message: string) => `rtc::impl::IceTransport::LogCallback@391: juice: ${message}`;
    for (const kept of [
      "Received STUN datagram from 10.0.0.5:50000", "STUN entry 3: Sending request to 10.0.0.5:50000 (6 retransmissions left)",
      "STUN entry 3: Failed", "Received STUN Binding success response from peer", "Sending STUN Binding response",
      "STUN local ufrag check failed, expected=\"a\", actual=\"b\"", "Got a nominated pair (controlled)", "Candidate pair check succeeded",
      "Adding remote candidate: a=candidate:1 1 UDP 2122317823 10.0.0.5 50000 typ host", "UDP socket bound to 10.0.0.9:51234",
    ]) expect(rtcLogKept("Verbose", at(kept)), kept).toBe(true);
    for (const dropped of [
      "Receiving datagram", "Received datagram, size=120", "Sending datagram, size=120", "Not a STUN message: magic number invalid",
      "Received non-STUN datagram from 10.0.0.5:50000", "STUN selected entry matching incoming address", "Received application datagram",
      "Entering poll on 2 sockets for 20 ms", "Leaving poll", "Bookkeeping...", "Writing STUN attribute type 0x0006, length=9",
    ]) expect(rtcLogKept("Verbose", at(dropped)), dropped).toBe(false);
    expect(rtcLogKept("Verbose", "rtc::impl::DtlsSrtpTransport::recvMedia@301: Incoming SRTP packet, size=120")).toBe(false);
    expect(rtcLogKept("Verbose", "rtc::IsRtcp@54: Demultiplexing RTCP and RTP with payload type, value=111")).toBe(false);
    // Below Verbose, every line.
    for (const level of ["Debug", "Info", "Warning"]) expect(rtcLogKept(level, "PeerConnectionWrapper::state@811: state() called")).toBe(true);
    const out: string[] = [];
    startRtcLog(fakeLib([["Verbose", at("Received datagram, size=120")], ["Verbose", at("Received STUN datagram from 10.0.0.5:50000")]]), { GHOSTLY_RTC_LOG: "Verbose" }, (text) => out.push(text));
    expect(out).toEqual([`ghostly: rtc Verbose: ${at("Received STUN datagram from 10.0.0.5:50000")}\n`]);
  });

  it("loading the call stack sets the logger only when GHOSTLY_RTC_LOG names a level", async () => {
    const initLogger = vi.fn();
    vi.doMock("node-datachannel", async (importOriginal) => ({ ...(await importOriginal<object>()), initLogger, default: undefined }));
    for (const [value, set] of [[undefined, false], ["nonsense", false], ["Info", true]] as const) {
      vi.resetModules();
      initLogger.mockClear();
      vi.stubEnv("GHOSTLY_RTC_LOG", value);
      const { loadCallStack } = await import("../src/calls/media");
      expect(typeof await loadCallStack()).toBe("object");
      expect(initLogger).toHaveBeenCalledTimes(set ? 1 : 0);
      if (set) expect(initLogger).toHaveBeenCalledWith("Info", expect.any(Function));
    }
  });
});
