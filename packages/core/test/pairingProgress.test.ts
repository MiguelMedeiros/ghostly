import { describe, expect, it } from "vitest";
import { PairingTracker, type PairingProgress } from "../src/pairingProgress";

// covers: chat.paired.progress

/** A tracker with a clock of its own, and every progress it reported. */
function tracker(role: "inviter" | "joiner") {
  const reported: PairingProgress[] = [];
  let now = 1_000;
  const t = new PairingTracker(role, 500, p => reported.push(p), () => now);
  return { t, reported, tick: (ms: number) => { now += ms; }, stages: () => reported.map(p => p.stage) };
}

describe("PairingTracker", () => {
  it("starts the inviter at publishing and the joiner at resolving, from when the invite was made or joined", () => {
    expect(tracker("inviter").t.progress).toEqual({ role: "inviter", stage: "publishing", since: 500, startedAt: 500, attempt: 1 });
    expect(tracker("joiner").t.progress).toEqual({ role: "joiner", stage: "resolving", since: 500, startedAt: 500, attempt: 1 });
  });

  it("walks the inviter through the stages when it is the one who knocks", () => {
    const { t, stages, reported, tick } = tracker("inviter");
    t.published(); tick(300); t.sawPeer(); tick(50); t.offerSent(); t.answerReceived(); t.live("webrtc/1");
    expect(stages()).toEqual(["waiting", "waiting", "knocking", "connecting", "live"]);
    // Seeing the contact is a detail of the stage, not a new stage: it keeps the moment it began.
    expect(reported[1].since).toBe(reported[0].since);
    expect(reported[1].peerSeen).toBe(true);
    expect(reported.at(-1)).toMatchObject({ stage: "live", attempt: 1, peerSeen: true, transport: "webrtc/1" });
    expect(t.done).toBe(true);
  });

  it("walks the joiner through the stages when it is the one who answers", () => {
    const { t, stages } = tracker("joiner");
    t.published(); t.sawPeer(); t.offerReceived(); t.answerSent(); t.live();
    expect(stages()).toEqual(["resolving", "answering", "connecting", "live"]);
  });

  it("counts attempts: a failed one is followed by the next, and the reason says why", () => {
    const { t, stages, reported } = tracker("inviter");
    t.published(); t.sawPeer(); t.offerSent(); t.failed("timeout", true); t.offerSent(); t.answerReceived(); t.failed("transport", true, "ICE failed"); t.offerSent(); t.answerReceived(); t.live();
    expect(stages()).toEqual(["waiting", "waiting", "knocking", "failed", "knocking", "connecting", "failed", "knocking", "connecting", "live"]);
    expect(reported.map(p => p.attempt)).toEqual([1, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
    expect(reported[3]).toMatchObject({ peerSeen: true, reason: "timeout", retryable: true });
    expect(reported[6]).toMatchObject({ reason: "transport", retryable: true, detail: "ICE failed" });
    // A detail belongs to the failure it came with, not to the stages after it.
    expect(reported[7].detail).toBeUndefined();
  });

  it("a publish that failed is a retryable failure, and the next publish clears it", () => {
    const { t, stages } = tracker("inviter");
    t.failed("publish", true); t.published();
    expect(stages()).toEqual(["failed", "waiting"]);
    const joiner = tracker("joiner");
    joiner.t.failed("publish", true); joiner.t.published();
    expect(joiner.stages()).toEqual(["failed", "resolving"]);
  });

  it("a connection that went away before the session was ready puts the side back between attempts", () => {
    const { t, stages } = tracker("joiner");
    t.offerReceived(); t.answerSent(); t.reset(); t.reset();
    expect(stages()).toEqual(["answering", "connecting", "resolving"]);
  });

  it("nothing moves it after live", () => {
    const { t, reported } = tracker("inviter");
    t.offerSent(); t.live();
    const count = reported.length;
    t.failed("transport", true); t.offerSent(); t.reset(); t.sawPeer();
    expect(reported.length).toBe(count);
    expect(t.progress.stage).toBe("live");
  });

  it("a key mismatch or a forged signal is final", () => {
    const { t, reported } = tracker("joiner");
    t.failed("key-mismatch", false);
    expect(reported.at(-1)).toMatchObject({ stage: "failed", reason: "key-mismatch", retryable: false });
  });
});
