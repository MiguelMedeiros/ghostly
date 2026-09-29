import { describe, expect, it } from "vitest";
import { emptyIdentityLedger, type IdentityLedger, type PairingProgress, type ReceivedIdentity } from "@ghostly/core";
import { groupCue, identityCues, knockCue, paymentCue, transportCue, transportMark } from "../src/engine/cues";
import { QUIET_DROP_MS, TransportLog, type TransportSnapshot } from "../src/engine/transportLog";
// covers: app.attention.cues

const SINCE = 1_000;
const payment = (over: Partial<Parameters<typeof paymentCue>[0]>) => ({ id: "p1", kind: "payment", direction: "out", state: "pending", createdAt: SINCE + 1, ...over });

describe("payment cues", () => {
  it("a request that came in, while pending, once per request", () => {
    expect(paymentCue(payment({ kind: "request", direction: "in" }), SINCE)).toEqual({ cue: "request", key: "p1" });
    // Mine, or already answered: nothing.
    expect(paymentCue(payment({ kind: "request", direction: "out" }), SINCE)).toBeUndefined();
    expect(paymentCue(payment({ kind: "request", direction: "in", state: "settled" }), SINCE)).toBeUndefined();
  });

  it("a payment of mine that failed, or came back refused; not one still on its way or settled", () => {
    expect(paymentCue(payment({ state: "failed" }), SINCE)).toEqual({ cue: "failed", key: "p1" });
    expect(paymentCue(payment({ state: "reclaimed", error: "The payment was refused" }), SINCE)).toEqual({ cue: "failed", key: "p1" });
    expect(paymentCue(payment({ state: "reclaimed" }), SINCE)).toBeUndefined();
    expect(paymentCue(payment({ state: "pending" }), SINCE)).toBeUndefined();
    expect(paymentCue(payment({ state: "settled" }), SINCE)).toBeUndefined();
    // A request the contact closed is not my failure.
    expect(paymentCue(payment({ kind: "payment", direction: "in", state: "failed", closed: true }), SINCE)).toBeUndefined();
  });

  it("nothing from before this engine started (a reload shows old records again)", () => {
    expect(paymentCue(payment({ kind: "request", direction: "in", createdAt: SINCE - 1 }), SINCE)).toBeUndefined();
    expect(paymentCue(payment({ state: "failed", createdAt: SINCE - 1 }), SINCE)).toBeUndefined();
  });
});

const received = (id: string, over: Partial<ReceivedIdentity> = {}): ReceivedIdentity =>
  ({ id, binding: {} as ReceivedIdentity["binding"], evidence: null, verified: {} as ReceivedIdentity["verified"], presenter: "a", audience: "b", context: "c", verifiedAt: 5, checkedAt: 5, status: "verified", ...over });
const ledger = (list: ReceivedIdentity[], timeline?: object[]): IdentityLedger => ({ ...emptyIdentityLedger(), received: list, ...(timeline ? { timeline } : {}) });

describe("identity cues", () => {
  it("a proof the contact shared arrives: shared; the same ledger again: nothing", () => {
    const after = ledger([received("x")]);
    expect(identityCues(ledger([]), after)).toEqual([{ cue: "shared", key: "x:5" }]);
    expect(identityCues(after, after)).toEqual([]);
  });

  it("one of theirs back to verified after a re-check: checked; turning unconfirmed: nothing", () => {
    const unconfirmed = ledger([received("x", { status: "unconfirmed", checkedAt: 6 })]);
    expect(identityCues(ledger([received("x")]), unconfirmed)).toEqual([]);
    expect(identityCues(unconfirmed, ledger([received("x", { checkedAt: 7 })]))).toEqual([{ cue: "checked", key: "x:7" }]);
  });

  it("with a share timeline: shared as it starts verifying, checked once verified, never for my own shares", () => {
    const verifying = { id: "theirs:x:0", side: "theirs", kind: "shared", state: "verifying" };
    const mine = { id: "mine:y:0", side: "mine", kind: "shared", state: "verifying" };
    const start = ledger([], [mine, verifying]);
    expect(identityCues(ledger([], []), start)).toEqual([{ cue: "shared", key: "theirs:x:0" }]);
    const done = ledger([received("x")], [{ ...mine, state: "verified" }, { ...verifying, state: "verified" }]);
    expect(identityCues(start, done)).toEqual([{ cue: "checked", key: "theirs:x:0" }]);
    expect(identityCues(done, done)).toEqual([]);
  });
});

const live = (transport: TransportSnapshot["transport"], extra: Partial<TransportSnapshot> = {}): TransportSnapshot => ({ live: true, transport, text: "stream", dhtOnly: false, ...extra });
const down = (): TransportSnapshot => ({ live: false, text: "unavailable", dhtOnly: false });
/** What `observeTransport` does: marks the log, observes, asks for a cue. */
const step = (log: TransportLog, snapshot: TransportSnapshot, at: number) => {
  const mark = transportMark(log.entries, log.history);
  log.observe(snapshot, at);
  return transportCue(mark, log.entries, log.history)?.cue;
};

describe("transport cues", () => {
  it("a live switch to another transport; nothing for the first connection or staying put", () => {
    const log = new TransportLog();
    expect(step(log, live("webrtc/1"), 0)).toBeUndefined();
    expect(step(log, live("webrtc/1"), 1_000)).toBeUndefined();
    expect(step(log, live("iroh/1"), 2_000)).toBe("switched");
    expect(step(log, live("iroh/1"), 3_000)).toBeUndefined();
  });

  it("back after an outage longer than the quiet drop; silent on the drop and on a short one", () => {
    const log = new TransportLog();
    step(log, live("iroh/1"), 0);
    expect(step(log, down(), 1_000)).toBeUndefined();
    expect(step(log, live("iroh/1"), 2_000)).toBeUndefined();
    expect(step(log, down(), 3_000)).toBeUndefined();
    expect(step(log, live("iroh/1"), 3_000 + QUIET_DROP_MS + 1)).toBe("back");
  });

  it("never for this app starting again on another transport, nor a short drop that came back elsewhere", () => {
    const first = new TransportLog();
    step(first, live("iroh/1"), 0);
    const restarted = new TransportLog(first.entries, first.history);
    expect(step(restarted, live("hyperdht/1"), 60_000)).toBeUndefined();
    expect(restarted.entries.at(-1)).toMatchObject({ kind: "switched" });
    const log = new TransportLog();
    step(log, live("webrtc/1"), 0);
    step(log, down(), 10);
    expect(step(log, live("iroh/1"), 20)).toBeUndefined();
  });
});

const progress = (over: Partial<PairingProgress>): PairingProgress => ({ role: "inviter", stage: "waiting", since: 0, startedAt: 0, attempt: 1, ...over });

describe("knock", () => {
  it("once, as the contact comes with my invite", () => {
    expect(knockCue(progress({}), progress({ peerSeen: true }))).toBe(true);
    expect(knockCue(progress({}), progress({ stage: "answering" }))).toBe(true);
    expect(knockCue(progress({ peerSeen: true }), progress({ peerSeen: true, stage: "connecting" }))).toBe(false);
    expect(knockCue(progress({}), progress({}))).toBe(false);
  });

  it("not for the one who joined, nor when a pairing is first seen already under way", () => {
    expect(knockCue(progress({ role: "joiner", stage: "knocking" }), progress({ role: "joiner", stage: "connecting" }))).toBe(false);
    expect(knockCue(undefined, progress({ peerSeen: true }))).toBe(false);
  });
});

describe("group cue", () => {
  it("my own group made or joined; not someone else joining, nor a message", () => {
    expect(groupCue({ event: "created" })).toBe("group");
    expect(groupCue({ event: "joined" })).toBe("group");
    expect(groupCue({ event: "joined", member: "k" })).toBeUndefined();
    expect(groupCue({})).toBeUndefined();
  });
});
