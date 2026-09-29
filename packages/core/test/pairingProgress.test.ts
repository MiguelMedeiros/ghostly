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

  it("counts attempts: a stream that did not come up is no failure, the side goes back between attempts and says why", () => {
    const { t, stages, reported } = tracker("inviter");
    t.published(); t.sawPeer(); t.offerSent(); t.failed("timeout", true); t.offerSent(); t.answerReceived(); t.failed("transport", true, "ICE failed"); t.offerSent(); t.answerReceived(); t.live();
    expect(stages()).toEqual(["waiting", "waiting", "knocking", "waiting", "knocking", "connecting", "waiting", "knocking", "connecting", "live"]);
    expect(reported.map(p => p.attempt)).toEqual([1, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
    expect(reported[3]).toMatchObject({ peerSeen: true, detail: expect.stringContaining("not answered") });
    expect(reported[3].reason).toBeUndefined();
    expect(reported[6]).toMatchObject({ detail: "ICE failed" });
    // A detail belongs to the attempt it came with, not to the stages after it.
    expect(reported[7].detail).toBeUndefined();
  });

  it("pinned over the DHT, the pairing ends on-dht: attempts go on underneath, and live takes over (WISP 400)", () => {
    const { t, stages, reported } = tracker("joiner");
    t.published(); t.offerSent(); t.onDht("waiting");
    expect(t.progress.stage, "the stream attempt under way goes on: a pin a moment before it opens is no stage").toBe("knocking");
    t.failed("timeout", true);
    expect(reported.at(-1)).toMatchObject({ stage: "on-dht", reason: "transport", retryable: true });
    t.offerSent(); t.answerReceived(); t.reset();
    expect(t.progress.stage, "background attempts do not take it back to its steps").toBe("on-dht");
    t.offerSent(); t.live("iroh/1");
    expect(stages()).toEqual(["knocking", "on-dht", "live"]);
    expect(reported.at(-1)).toMatchObject({ stage: "live", transport: "iroh/1", attempt: 3 });
  });

  it("pinned over the DHT with no stream attempt under way: on the DHT at once", () => {
    const { t, reported } = tracker("inviter");
    t.published(); t.sawPeer(); t.onDht("waiting");
    expect(reported.at(-1)).toMatchObject({ stage: "on-dht", reason: "waiting", retryable: true });
  });

  it("a pin over the DHT while the stream connects ends live, through its steps", () => {
    const { t, stages } = tracker("joiner");
    t.published(); t.offerSent(); t.onDht("waiting"); t.answerReceived(); t.live("webrtc/1");
    expect(stages()).toEqual(["knocking", "connecting", "live"]);
  });

  it("only a key mismatch, a forged signal, a failed publish or being offline is failed", () => {
    const { t, reported } = tracker("inviter");
    t.onDht("no-common-transport");
    t.failed("key-mismatch", false);
    expect(reported.at(-1)).toMatchObject({ stage: "failed", reason: "key-mismatch", retryable: false });
    const chosen = tracker("joiner");
    chosen.t.onDht("chosen");
    expect(chosen.reported.at(-1)).toMatchObject({ stage: "on-dht", reason: "chosen", retryable: false });
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
