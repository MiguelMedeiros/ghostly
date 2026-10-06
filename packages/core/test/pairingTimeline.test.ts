import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INVITER_DIAL_GRACE_MS, PAIRING_ATTEMPT_MS, PAIRING_RETRY_MS } from "../src/ghostlink";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, invitation, invitationWhere, open, rtc, run, untilLive, useFakeWorld, type NetworkModel } from "./support/pairingWorld";

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
const stagesOf = (side: { progress: { stage: string }[] }) => side.progress.map(p => p.stage).filter((stage, i, all) => stage !== all[i - 1]);
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

  /**
   * Where the STUN servers never answer, an offer waited for them until its gathering gave up (5 s): One's e2e runs had
   * 13 offers of 89 at 5 s, and their pairings live 5.5 to 11 s after the join (2026-10-05). It goes after 2 s now,
   * with its host candidates (`OFFER_HOST_GATHER_MS`).
   */
  it.each(["inviter", "joiner"] as const)("an offer whose STUN servers never answer goes after 2 s · the %s's key is lower", async lower => {
    rtc.srflxAfterMs = Infinity;
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
    const made = invitationWhere(lower);
    const inviter = open(made.inviter, pkarr);
    await run(10_000);
    const joiner = open(made.joiner, pkarr);
    const took = await untilLive(inviter, joiner, 60_000);
    // Before: 6.5 s with the joiner's key lower (its offer's 5 s, then the answer), 11.9 s with the inviter's (it offered
    // too after its grace, and kept its own). After: 3.7 s either way.
    expect(took, "live after the join").toBeLessThanOrEqual(4_500);
    for (const side of [inviter, joiner]) expect(side.progress.at(-1)).toMatchObject({ stage: "live", attempt: 1 });
  }, 60_000);

  /**
   * The cost: an offer that went without its server reflexive candidate (STUN answered after 3 s) to a contact behind a
   * NAT that lets nothing through without one. The attempt fails, and the next offer waits for STUN as long as it takes.
   */
  it("an offer without its STUN candidate to a contact that needs one: the attempt fails, the next offer waits for it and connects", async () => {
    rtc.srflxAfterMs = 3_000;
    rtc.needsSrflx = true;
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
    const made = invitationWhere("joiner");
    const inviter = open(made.inviter, pkarr);
    await run(10_000);
    const joiner = open(made.joiner, pkarr);
    const took = await untilLive(inviter, joiner, 60_000);
    // Before: 4.45 s, the first offer waited the 3 s for its STUN candidate. After: the first attempt fails, the second
    // offer waits for it, live at 10.7 s.
    expect(took, "live after the join").toBeLessThanOrEqual(PAIRING_ATTEMPT_MS + PAIRING_RETRY_MS + 6_000);
    expect(joiner.progress.at(-1)).toMatchObject({ stage: "live", attempt: 2 });
  }, 60_000);

  /**
   * On the public relays a read takes 0.25 to 0.8 s (the joiner's first look at the inviter: 0.73 and 0.8 s, 2026-10-05)
   * and an offer's gathering 0.2 s and more. The joiner made its offer only once that look was done; it gathers it
   * meanwhile now, and sends it once the look finds the inviter.
   */
  it.each(["desktop", "web"] as const)("the joiner gathers its offer while it first looks for the inviter · %s pace", async pace => {
    // A STUN server that answers in 1.5 s (One's e2e runs: 9 offers of 89 between 1.3 and 3 s).
    rtc.srflxAfterMs = 1_500;
    const pkarr = new MemoryPkarr({ publishMs: 700, visibleAfterMs: 300, readMs: 750 });
    const made = invitationWhere("joiner");
    const intervals = pace === "web" ? RELAY_POLL_INTERVALS : undefined;
    const inviter = open(made.inviter, pkarr, { pollIntervals: intervals });
    await run(10_000);
    const reads = pkarr.reads, publishes = pkarr.publishes;
    const joiner = open(made.joiner, pkarr, { pollIntervals: intervals });
    const took = await untilLive(inviter, joiner, 60_000);
    // Before: 5.4 s (desktop) and 6.75 s (web), 11 and 7 reads, 5 publishes. After: 4.4 s and 4.85 s, 9 and 5 reads, 4.
    expect(took, "live after the join").toBeLessThanOrEqual(pace === "web" ? 5_500 : 5_000);
    expect(stagesOf(joiner)).toEqual(["resolving", "knocking", "connecting", "live"]);
    // No request more: the offer goes in the joiner's first packet, now that it is ready by then.
    expect(pkarr.publishes - publishes).toBeLessThanOrEqual(4);
    expect(pkarr.reads - reads).toBeLessThanOrEqual(pace === "web" ? 6 : 10);
  }, 60_000);

  it("a joiner whose first look finds no inviter drops the offer it gathered, says nothing of it, and dials once the inviter shows", async () => {
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
    const made = invitationWhere("joiner");
    const joiner = open(made.joiner, pkarr);
    await run(5_000);
    expect(joiner.link.liveAttempt, "no failed attempt").toBeUndefined();
    expect(stagesOf(joiner)).not.toContain("knocking");
    const inviter = open(made.inviter, pkarr);
    expect(await untilLive(inviter, joiner, 60_000)).toBeLessThan(Infinity);
    expect(joiner.progress.at(-1)).toMatchObject({ stage: "live", attempt: 1 });
  }, 60_000);

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
