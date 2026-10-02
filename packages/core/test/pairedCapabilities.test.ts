import { describe, expect, it } from "vitest";
import {
  CALLS_CAPABILITY,
  SERVICES_CAPABILITY,
  SESSION_CAPABILITIES_FRAME,
  SessionCapabilities,
  parseSessionCapabilities,
  sessionCapabilitiesFrame,
  type SessionCapability,
} from "../src/pairedCapabilities";
import { MAX_PAIRED_CALL_SIGNAL, PAIRED_CALL_FRAME, PairedCalls, parsePairedCallFrame } from "../src/pairedCalls";
import { CALL_SIGNAL_MAX_AGE_MS } from "../src/callSignal";
// covers: calls.paired.negotiate, services.paired.negotiate, calls.signal

describe("paired-capabilities negotiation", () => {
  it("says what this side offers, once each", () => {
    expect(sessionCapabilitiesFrame([CALLS_CAPABILITY, SERVICES_CAPABILITY, CALLS_CAPABILITY]))
      .toEqual({ t: SESSION_CAPABILITIES_FRAME, c: ["calls/1", "services/1"] });
    expect(sessionCapabilitiesFrame([])).toEqual({ t: "paired-capabilities", c: [] });
  });

  it("parses a list, keeps identifiers it does not know, and refuses malformed ones", () => {
    expect(parseSessionCapabilities({ c: ["calls/1", "video-4k/9"] })).toEqual(new Set(["calls/1", "video-4k/9"]));
    expect(parseSessionCapabilities({ c: [] })).toEqual(new Set());
    for (const c of [undefined, "calls/1", [1], ["Calls/1"], ["calls 1"], ["x".repeat(41)], Array(33).fill("a"), [null]]) {
      expect(parseSessionCapabilities({ c }), JSON.stringify(c)).toBeNull();
    }
  });

  it("agrees only on what both sides offer, and only once the peer said so", () => {
    const offered: SessionCapability[] = [CALLS_CAPABILITY, SERVICES_CAPABILITY];
    const caps = new SessionCapabilities(() => offered);
    expect(caps.announcement()).toEqual({ t: "paired-capabilities", c: ["calls/1", "services/1"] });
    expect(caps.peerAnnounced).toBe(false);
    expect(caps.agreed(CALLS_CAPABILITY)).toBe(false);

    expect(caps.receive({ c: ["calls/1"] })).toEqual([CALLS_CAPABILITY]);
    expect(caps.peerAnnounced).toBe(true);
    expect(caps.agreed(CALLS_CAPABILITY)).toBe(true);
    expect(caps.agreed(SERVICES_CAPABILITY)).toBe(false);

    // The latest word wins: services on, calls off.
    expect(caps.receive({ c: ["services/1"] })).toEqual([CALLS_CAPABILITY, SERVICES_CAPABILITY]);
    expect(caps.agreed(CALLS_CAPABILITY)).toBe(false);
    expect(caps.agreed(SERVICES_CAPABILITY)).toBe(true);

    // A malformed frame says nothing: what the peer said before stands.
    expect(caps.receive({ c: "calls/1" })).toBeNull();
    expect(caps.agreed(SERVICES_CAPABILITY)).toBe(true);

    caps.reset();
    expect(caps.peerAnnounced).toBe(false);
    expect(caps.agreed(SERVICES_CAPABILITY)).toBe(false);
  });

  it("does not agree on what this side does not offer, whatever the peer says", () => {
    const caps = new SessionCapabilities(() => [SERVICES_CAPABILITY]);
    expect(caps.receive({ c: ["calls/1", "services/1"] })).toEqual([SERVICES_CAPABILITY]);
    expect(caps.peerOffers(CALLS_CAPABILITY)).toBe(true);
    expect(caps.offers(CALLS_CAPABILITY)).toBe(false);
    expect(caps.agreed(CALLS_CAPABILITY)).toBe(false);
  });
});

describe("paired-call frames", () => {
  const offer = (ts: number) => JSON.stringify({ t: "o", ts, u: "abcd", p: "p".repeat(22), f: "a".repeat(64), s: "actpass", m: ["a", "v"], c: [], v: 0 });

  it("carries a fresh, well-formed signal and nothing else", () => {
    const now = 1_000_000;
    // The signal as sent, with when it was heard here: now, on a live session.
    const heard = (signal: string) => JSON.stringify({ ...JSON.parse(signal), at: now });
    expect(parsePairedCallFrame({ t: PAIRED_CALL_FRAME, s: offer(now) }, now)).toBe(heard(offer(now)));
    expect(parsePairedCallFrame({ s: JSON.stringify({ t: "h", ts: now }) }, now)).toBe(heard(JSON.stringify({ t: "h", ts: now })));
    // Its own time is its sender's clock, minutes from this one or not: a frame on a live session is heard now.
    expect(parsePairedCallFrame({ s: offer(now - CALL_SIGNAL_MAX_AGE_MS - 1) }, now)).toBe(heard(offer(now - CALL_SIGNAL_MAX_AGE_MS - 1)));
    expect(parsePairedCallFrame({ s: offer(now + 60 * 60_000) }, now)).toBe(heard(offer(now + 60 * 60_000)));
    // What it says of when it was heard is not its to say.
    expect(parsePairedCallFrame({ s: JSON.stringify({ ...JSON.parse(offer(now)), at: 1 }) }, now)).toBe(heard(offer(now)));
    expect(parsePairedCallFrame({ s: JSON.stringify({ t: "o", ts: now, u: "a\r\nb" }) }, now), "SDP injection").toBeNull();
    expect(parsePairedCallFrame({ s: 42 }, now)).toBeNull();
    expect(parsePairedCallFrame({ s: " ".repeat(MAX_PAIRED_CALL_SIGNAL + 1) }, now)).toBeNull();
  });

  it("keeps the latest signal for the next session while it is fresh, and forgets a cleared one", () => {
    let now = 5_000;
    const calls = new PairedCalls(() => now);
    expect(calls.pending()).toBeNull();
    expect(calls.set("offer")).toEqual({ t: "paired-call", s: "offer" });
    expect(calls.set("hang-up")).toEqual({ t: "paired-call", s: "hang-up" });
    now += 1_000;
    expect(calls.pending()).toEqual({ t: "paired-call", s: "hang-up" });
    now += CALL_SIGNAL_MAX_AGE_MS;
    expect(calls.pending(), "too old to act on").toBeNull();

    calls.set("offer");
    expect(calls.set(null)).toBeNull();
    expect(calls.pending()).toBeNull();
    expect(() => calls.set("x".repeat(MAX_PAIRED_CALL_SIGNAL + 1))).toThrow(/too large/);
  });

  it("an app going away hangs up the call it placed or answered, however long ago, and nothing else", () => {
    let now = 10_000;
    const calls = new PairedCalls(() => now);
    expect(calls.hangUp(), "no call").toBeNull();

    calls.set(JSON.stringify({ t: "o", ts: 9_000 }));
    now += 10 * CALL_SIGNAL_MAX_AGE_MS;
    const frame = calls.hangUp();
    expect(frame?.t).toBe(PAIRED_CALL_FRAME);
    expect(JSON.parse(frame!.s)).toEqual({ t: "h", ts: now });
    // Said once: it is now the latest signal, and not an offer to hang up again.
    expect(calls.hangUp()).toBeNull();

    // An answer, with its time ahead of this clock: the hang-up still comes after it.
    calls.set(JSON.stringify({ t: "a", ts: now + 5 }));
    expect(JSON.parse(calls.hangUp()!.s)).toEqual({ t: "h", ts: now + 6 });

    // A picture changed mid-call: the call is on.
    calls.set(JSON.stringify({ t: "v", ts: now + 10 }));
    expect(JSON.parse(calls.hangUp()!.s)).toEqual({ t: "h", ts: now + 11 });

    // Cleared after a hang-up, or something that is no signal: nothing to say.
    calls.set(null);
    expect(calls.hangUp()).toBeNull();
    calls.set("not json");
    expect(calls.hangUp()).toBeNull();
  });
});
