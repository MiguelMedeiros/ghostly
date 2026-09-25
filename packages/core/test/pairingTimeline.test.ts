import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INVITER_DIAL_GRACE_MS, PAIRING_ATTEMPT_MS, PAIRING_RETRY_MS } from "../src/ghostlink";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, invitation, invitationWhere, open, run, untilLive, useFakeWorld, type NetworkModel } from "./support/pairingWorld";

// covers: chat.paired.pair-timing, chat.paired.progress, chat.paired.pair

/**
 * How long a first pairing takes, in fake time, on a network that behaves like the desktop's (Rust
 * client, relays and DHT: see `DESKTOP_NETWORK`). The invite was made a while ago; the joiner opens the
 * chat and both sides must be live within seconds, whoever dials, on the first attempt. Fails when the
 * protocol gains a round trip, a wait, or a poll that leaves a signal sitting there.
 */

/** From the join to both sides live, on the desktop's network model. */
const LIVE_WITHIN_MS = 5_000;

beforeEach(useFakeWorld);
afterEach(closeWorld);

describe("a first pairing, at desktop pace", () => {
  // Whichever key is lower, the joiner knocks: its offer travels in the packet that says it is here.
  for (const lower of ["inviter", "joiner"] as const) for (const inviterOpen of [10_000, 90_000]) {
    it(`is live within ${LIVE_WITHIN_MS / 1000} s of the join · the ${lower}'s key is lower · the invite is ${inviterOpen / 1000} s old`, async () => {
      const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
      const made = invitationWhere(lower);
      const inviter = open(made.inviter, pkarr);
      await run(inviterOpen);
      expect(inviter.progress.map(p => p.stage)).toEqual(["waiting"]);

      const publishes = pkarr.publishes;
      const joiner = open(made.joiner, pkarr);
      const took = await untilLive(inviter, joiner, 30_000);
      expect(took, "live after the join").toBeLessThanOrEqual(LIVE_WITHIN_MS);

      const stages = (side: typeof inviter) => side.progress.map(p => p.stage);
      expect(stages(joiner)).toEqual(["resolving", "knocking", "connecting", "live"]);
      expect(stages(inviter)).toEqual(["waiting", "waiting", "answering", "connecting", "live"]);
      // Two packets from the join to the connection: the joiner's (presence and offer in one) and the inviter's answer…
      // …plus each side withdrawing its signal once the connection is open.
      expect(pkarr.publishes - publishes, "packets published from the join to live").toBeLessThanOrEqual(4);
      for (const side of [inviter, joiner]) {
        expect(side.progress.at(-1)).toMatchObject({ stage: "live", attempt: 1, peerSeen: true, transport: "webrtc/1" });
        expect(side.pinned).toHaveLength(1);
      }
    }, 30_000);
  }

  it("an inviter that sees a joiner from before this rule (no offer with its packet) offers itself after a grace", async () => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
    // The inviter's key is lower: an old joiner waits for the inviter to dial.
    const made = invitationWhere("inviter");
    const inviter = open(made.inviter, pkarr);
    await run(10_000);
    const joiner = open({ ...made.joiner, old: true }, pkarr);
    const took = await untilLive(inviter, joiner, 30_000);
    expect(took).toBeLessThanOrEqual(LIVE_WITHIN_MS + INVITER_DIAL_GRACE_MS);
    expect(inviter.progress.map(p => p.stage)).toEqual(["waiting", "waiting", "knocking", "connecting", "live"]);
  }, 30_000);

  it("polls the contact's key in the foreground while pairing, and in the background once connected", async () => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
    const made = invitationWhere("inviter");
    const inviter = open(made.inviter, pkarr);
    await run(10_000);
    const joiner = open(made.joiner, pkarr);
    await untilLive(inviter, joiner, 30_000);
    expect(pkarr.readsBackground, "no background read while pairing").toBe(0);
    const reads = pkarr.reads;
    await run(65_000);
    expect(pkarr.readsBackground, "the connected links' looks are background ones").toBeGreaterThan(0);
    expect(pkarr.reads - reads, "and few").toBeLessThanOrEqual(6);
  }, 30_000);

  it("an offer that gets no answer is given up and made again in seconds, not minutes", async () => {
    // The joiner's packets are visible, but the inviter's first offer never reaches the joiner: the
    // joiner's app is not reading (it is away) until later.
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
    const made = invitationWhere("inviter");
    const inviter = open(made.inviter, pkarr);
    await run(10_000);
    const joiner = open({ ...made.joiner, old: true }, pkarr);
    // The joiner says it is here, then goes away before its offer is out (an old app, say); the inviter
    // sees it, waits the grace for an offer, and knocks.
    await run(1_000);
    joiner.link.session.setActive(false);
    await joiner.link.stop(false);
    await run(INVITER_DIAL_GRACE_MS + 2_000);
    expect(inviter.progress.at(-1)?.stage).toBe("knocking");
    // Nothing answers: the attempt ends in PAIRING_ATTEMPT_MS, and the next one starts at once (the wait
    // between attempts counts from the last one, and that was long ago by then).
    await run(PAIRING_ATTEMPT_MS + 500);
    // Not a failure (WISP 400): back between attempts, saying why.
    expect(inviter.progress.find(p => p.stage === "failed")).toBeUndefined();
    expect(inviter.progress.find(p => p.detail?.includes("not answered"))).toMatchObject({ attempt: 1, stage: "waiting" });
    expect(inviter.progress.at(-1)).toMatchObject({ stage: "knocking", attempt: 2 });
    // The joiner is back: the second attempt goes through.
    const joinerAgain = open(made.joiner, pkarr);
    const took = await untilLive(inviter, joinerAgain, 30_000);
    expect(took).toBeLessThanOrEqual(PAIRING_RETRY_MS + LIVE_WITHIN_MS);
    expect(inviter.progress.at(-1)).toMatchObject({ stage: "live", attempt: 2 });
  }, 60_000);

  it("a publish that fails is said, and the next one that works clears it", async () => {
    const model: NetworkModel = { ...DESKTOP_NETWORK, publishFails: count => count === 1 };
    const pkarr = new MemoryPkarr(model);
    const made = invitationWhere("joiner");
    const inviter = open(made.inviter, pkarr);
    await run(1_000);
    expect(inviter.progress.at(-1)).toMatchObject({ stage: "failed", reason: "publish", retryable: true });
    await run(6_000);
    expect(inviter.progress.at(-1)?.stage).toBe("waiting");
  }, 30_000);
});

describe("a first pairing, at web pace", () => {
  it("is live within seconds on the relays' poll intervals too", async () => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
    const made = invitationWhere("joiner");
    const inviter = open(made.inviter, pkarr, { pollIntervals: RELAY_POLL_INTERVALS });
    await run(10_000);
    const joiner = open(made.joiner, pkarr, { pollIntervals: RELAY_POLL_INTERVALS });
    const took = await untilLive(inviter, joiner, 30_000);
    expect(took).toBeLessThanOrEqual(10_000);
  }, 30_000);
});

describe("a contact who chose DHT only", () => {
  // A ghostly1 code carries no delivery mode (WISP 801): the joiner learns it from the first envelope.
  it("pairs the joiner through the mailbox: its first pairing ends on the DHT, chosen, not failed on the stream nobody answers", async () => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
    const made = invitation();
    made.inviter.params = { ...made.inviter.params, deliveryMode: "dht" };
    const inviter = open(made.inviter, pkarr, { dht: true });
    const joiner = open(made.joiner, pkarr, { dht: true });
    await run(2 * PAIRING_ATTEMPT_MS);
    expect(joiner.pinned.length).toBeGreaterThan(0);
    expect(joiner.link.pairingProgress).toMatchObject({ stage: "on-dht", reason: "chosen" });
    expect(joiner.progress.map(p => p.stage)).not.toContain("failed");
    expect(inviter.link.pairingProgress).toBeUndefined();
  }, 30_000);
});
