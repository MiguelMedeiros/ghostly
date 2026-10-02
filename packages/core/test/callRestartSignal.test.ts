import { describe, expect, it } from "vitest";
import { buildSdpFromSignal, parseCallSignal, sdpHasCandidates, waitForIceGathering } from "../src";
import { PairedCalls, parsePairedCallFrame, PAIRED_CALL_FRAME } from "../src/pairedCalls";

// covers: calls.reconnect

/**
 * The signals of a call that reconnects (WISP 601, "Reconnecting"): `x` on an offer or an answer says the side
 * restarts ICE; `r` is the restart offer; its answer names it with `re`.
 */

const NOW = 1_760_000_000_000;
const ice = { ts: NOW, u: "x9Kq", p: "Q2m1yU7tX8nB4vL0pR6sZ3aW", f: "ab".repeat(32), m: ["a", "v"], ss: [11, 22] };
const parse = (signal: Record<string, unknown>) => parseCallSignal(JSON.stringify(signal), NOW);

describe("the restart signals", () => {
  it("an offer and an answer may say the side restarts ICE; any other value says nothing", () => {
    expect(parse({ ...ice, t: "o", s: "actpass", x: 1 })?.x).toBe(1);
    expect(parse({ ...ice, t: "a", s: "active", x: 1 })?.x).toBe(1);
    expect(parse({ ...ice, t: "o", s: "actpass" })?.x).toBeUndefined();
    for (const x of [0, 2, true, "1", null]) {
      const parsed = parse({ ...ice, t: "o", s: "actpass", x });
      expect(parsed).not.toBeNull();
      expect(parsed?.x).toBeUndefined();
    }
  });

  it("a restart offer is validated as an offer is", () => {
    expect(parse({ ...ice, t: "r", s: "actpass", x: 1 })).toMatchObject({ t: "r", u: "x9Kq", f: "ab".repeat(32), x: 1 });
    expect(parse({ ...ice, t: "r", s: "actpass", u: "no\r\na=x" })).toBeNull();
    expect(parse({ t: "r", ts: NOW })).toBeNull();
    expect(parse({ ...ice, t: "r", s: "actpass", ts: NOW - 121_000 })).toBeNull();
  });

  it("only an answer names a restart offer", () => {
    expect(parse({ ...ice, t: "a", s: "active", re: NOW - 5 })?.re).toBe(NOW - 5);
    expect(parse({ ...ice, t: "a", s: "active" })?.re).toBeUndefined();
    expect(parse({ ...ice, t: "o", s: "actpass", re: NOW })).toBeNull();
    expect(parse({ ...ice, t: "r", s: "actpass", re: NOW })).toBeNull();
    expect(parse({ ...ice, t: "a", s: "active", re: "1" })).toBeNull();
    expect(parse({ ...ice, t: "a", s: "active", re: Infinity })).toBeNull();
  });

  it("rebuilds every description of one connection as the same session, a restart a version later", () => {
    const origin = (signal: Record<string, unknown>) => /^o=- (\d+) (\d+) /m.exec(buildSdpFromSignal(parse(signal)!))!.slice(1).map(Number);
    const [session, version] = origin({ ...ice, t: "o", s: "actpass" });
    expect(origin({ ...ice, t: "o", s: "actpass" })).toEqual([session, version]);
    const [again, later] = origin({ ...ice, t: "r", s: "actpass", u: "new1", p: "N2m1yU7tX8nB4vL0pR6sZ3aW" });
    expect(again).toBe(session);
    expect(later).toBeGreaterThan(version);
    const [answered, answerVersion] = origin({ ...ice, t: "a", s: "active", re: NOW });
    expect(answered).toBe(session);
    expect(answerVersion).toBeGreaterThan(version);
    // Another connection (another fingerprint) is another session.
    expect(origin({ ...ice, t: "o", s: "actpass", f: "cd".repeat(32) })[0]).not.toBe(session);
    // The restart offer carries its own ICE credentials, and the sections of the first.
    const sdp = buildSdpFromSignal(parse({ ...ice, t: "r", s: "actpass", u: "new1", p: "N2m1yU7tX8nB4vL0pR6sZ3aW" })!);
    expect(sdp).toContain("a=ice-ufrag:new1");
    expect(sdp).toContain("a=ssrc:11 ");
    expect(sdp.match(/^m=/gm)).toHaveLength(2);
  });
});

describe("the chat session carries them", () => {
  it("a restart offer travels as any signal, and is sent again on the next session while fresh", () => {
    let now = NOW;
    const calls = new PairedCalls(() => now);
    const offer = JSON.stringify({ ...ice, t: "r", s: "actpass", x: 1 });
    // Handed on with when it was heard here, as every signal on a session is.
    expect(parsePairedCallFrame({ t: PAIRED_CALL_FRAME, s: offer }, NOW)).toBe(JSON.stringify({ ...JSON.parse(offer), at: NOW }));
    expect(calls.set(offer)).toEqual({ t: PAIRED_CALL_FRAME, s: offer });
    // The session was down when it was made (the network changed): it goes on the next one.
    now += 20_000;
    expect(calls.pending()).toEqual({ t: PAIRED_CALL_FRAME, s: offer });
  });

  it("a call whose last signal is a restart offer is on, however long ago, and is hung up when the app leaves", () => {
    let now = NOW;
    const calls = new PairedCalls(() => now);
    calls.set(JSON.stringify({ ...ice, t: "r", s: "actpass" }));
    now += 600_000;
    expect(calls.on).toBe(true);
    expect(JSON.parse(calls.hangUp()!.s)).toMatchObject({ t: "h" });
    expect(calls.on).toBe(false);

    const heard = new PairedCalls(() => now);
    heard.heard(JSON.stringify({ ...ice, t: "r", s: "actpass" }));
    now += 600_000;
    expect(heard.on).toBe(true);
  });
});

describe("waiting for a restart's candidates", () => {
  /** A connection that gathered before: "complete" is the last round's. */
  function gatheredBefore(sdp: string) {
    const target = new EventTarget();
    return Object.assign(target, {
      iceGatheringState: "complete" as RTCIceGatheringState,
      localDescription: { type: "offer", sdp } as RTCSessionDescriptionInit,
      getConfiguration: () => ({ iceServers: [] }),
    });
  }
  const NONE = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=ice-ufrag:new1\r\n";
  const SOME = `${NONE}a=candidate:1 1 udp 2122260223 192.0.2.1 54400 typ host\r\n`;

  it("does not take the last round's `complete` for this one's", async () => {
    const pc = gatheredBefore(NONE);
    let done = false;
    void waitForIceGathering(pc as unknown as RTCPeerConnection, 2000, { fresh: true }).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    // This round gathers, then completes with a candidate in the description.
    pc.iceGatheringState = "gathering";
    pc.dispatchEvent(new Event("icegatheringstatechange"));
    pc.localDescription = { type: "offer", sdp: SOME };
    pc.iceGatheringState = "complete";
    pc.dispatchEvent(new Event("icegatheringstatechange"));
    await Promise.resolve();
    expect(done).toBe(true);
    expect(sdpHasCandidates(pc.localDescription.sdp)).toBe(true);
  });

  it("resolves at once when the description already has this round's candidates, as before when not asked", async () => {
    await waitForIceGathering(gatheredBefore(SOME) as unknown as RTCPeerConnection, 2000, { fresh: true });
    await waitForIceGathering(gatheredBefore(NONE) as unknown as RTCPeerConnection, 2000);
  });
});
