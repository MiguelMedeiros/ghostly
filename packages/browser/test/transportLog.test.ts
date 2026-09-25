import { describe, expect, it } from "vitest";
import { CHOICE_TTL_MS, QUIET_DROP_MS, TRANSPORT_HISTORY_MAX, TRANSPORT_LOG_MAX, TransportLog, compactTransportRows, type TransportEntry, type TransportSnapshot } from "../src/engine/transportLog";
// covers: transport.timeline

const live = (transport: TransportSnapshot["transport"], extra: Partial<TransportSnapshot> = {}): TransportSnapshot =>
  ({ live: true, transport, text: "stream", dhtOnly: false, ...extra });
const down = (extra: Partial<TransportSnapshot> = {}): TransportSnapshot => ({ live: false, text: "unavailable", dhtOnly: false, ...extra });
const kinds = (log: TransportLog) => log.entries.map(e => e.kind);
const events = (log: TransportLog) => log.history.map(e => e.kind);
const MIN = 60_000;

describe("transport log: the timeline says what matters", () => {
  it("says the first connection, and nothing while it stays on the same transport", () => {
    const log = new TransportLog();
    expect(log.observe(down(), 0)).toBe(false);
    expect(log.observe(live("webrtc/1"), 1_000)).toBe(true);
    expect(log.observe(live("webrtc/1"), 2_000)).toBe(false);
    expect(log.entries).toEqual([expect.objectContaining({ kind: "connected", transport: "webrtc/1", at: 1_000 })]);
  });

  it("adds no row when this app restarts on the same transport, one when it lands on another", () => {
    const first = new TransportLog();
    first.observe(live("iroh/1"), 0);
    let log = first;
    // The rebuild loop: the app starts again and again, every few minutes, and comes back on Iroh each time.
    for (let i = 1; i <= 10; i++) {
      log = new TransportLog(log.entries, log.history);
      log.observe(down(), i * 7 * MIN);
      log.observe(live("iroh/1"), i * 7 * MIN + 30_000);
    }
    expect(kinds(log)).toEqual(["connected"]);
    // The history has every start.
    expect(log.history.filter(e => e.kind === "live" && e.started)).toHaveLength(11);
    log = new TransportLog(log.entries, log.history);
    log.observe(live("hyperdht/1"), 100 * MIN);
    expect(log.entries.at(-1)).toMatchObject({ kind: "switched", from: "iroh/1", transport: "hyperdht/1", cause: "automatic" });
  });

  it("adds no row when the contact's app restarts: a short drop back on the same transport", () => {
    const log = new TransportLog();
    log.observe(live("hyperdht/1"), 0);
    for (let i = 1; i <= 8; i++) {
      expect(log.observe(down({ text: "dht" }), i * 7 * MIN)).toBe(true);
      log.observe(live("hyperdht/1"), i * 7 * MIN + 2 * MIN);
    }
    expect(kinds(log)).toEqual(["connected"]);
    expect(events(log).filter(k => k === "down")).toHaveLength(8);
    expect(log.history.at(-1)).toMatchObject({ kind: "live", transport: "hyperdht/1", downMs: 2 * MIN });
  });

  it("says a short drop that came back on another transport, in one row", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    log.observe(down({ text: "hold" }), 10);
    log.observe(live("iroh/1"), 20);
    expect(log.entries.slice(1)).toEqual([expect.objectContaining({ kind: "switched", from: "webrtc/1", transport: "iroh/1", cause: "dropped" })]);
  });

  it("says a long outage once, when it ends, with how long and what carried text", () => {
    const log = new TransportLog();
    log.observe(live("hyperdht/1"), 0);
    log.observe(down(), MIN);
    // The DHT path is known a moment later: the history's drop says so, and so will the row.
    expect(log.observe(down({ text: "dht" }), MIN + 5)).toBe(true);
    expect(log.observe(down({ text: "dht" }), MIN + 6)).toBe(false);
    expect(kinds(log)).toEqual(["connected"]);
    log.observe(live("hyperdht/1"), MIN + QUIET_DROP_MS + 1);
    expect(log.entries.slice(1)).toEqual([expect.objectContaining({ kind: "back", transport: "hyperdht/1", downMs: QUIET_DROP_MS + 1, fallback: "dht" })]);
    expect(log.entries[1].from).toBeUndefined();
    // On another transport: the same one row names the one that dropped.
    log.observe(down(), 20 * MIN);
    log.observe(live("iroh/1"), 30 * MIN);
    expect(log.entries[2]).toMatchObject({ kind: "back", transport: "iroh/1", from: "hyperdht/1", downMs: 10 * MIN });
  });

  it("logs every choice: a transport, the one already in use, and back to automatic", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    // Chosen and moved there: the choice's row becomes the switch.
    log.chose("you", "iroh/1", 10);
    log.observe(live("webrtc/1", { transitionTarget: "iroh/1" }), 20);
    log.observe(live("iroh/1"), 30);
    log.chose("contact", "hyperdht/1", 40);
    log.observe(live("hyperdht/1"), 50);
    // Chosen where it already is: still a row.
    log.chose("you", "hyperdht/1", 60);
    // Back to automatic, and the apps move: the same row says where it landed.
    log.chose("you", "automatic", 70);
    log.observe(live("webrtc/1"), 80);
    log.chose("contact", "automatic", 90);
    expect(log.entries.slice(1).map(e => [e.kind, e.cause, e.target ?? null, e.from ?? null, e.transport ?? null])).toEqual([
      ["switched", "you", null, "webrtc/1", "iroh/1"],
      ["switched", "contact", null, "iroh/1", "hyperdht/1"],
      ["chose", "you", "hyperdht/1", null, "hyperdht/1"],
      ["chose", "you", null, "hyperdht/1", "webrtc/1"],
      ["chose", "contact", null, null, "webrtc/1"],
    ]);
    expect(events(log).filter(k => k === "chose")).toHaveLength(5);
  });

  it("forgets a choice that did not land in time, or landed elsewhere", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    log.chose("you", "iroh/1", 0);
    log.observe(live("iroh/1"), CHOICE_TTL_MS + 1);
    log.chose("contact", "hyperdht/1", CHOICE_TTL_MS + 2);
    log.observe(live("webrtc/1"), CHOICE_TTL_MS + 3);
    expect(log.entries.slice(1).map(e => [e.kind, e.cause])).toEqual([["chose", "you"], ["switched", "automatic"], ["chose", "contact"], ["switched", "automatic"]]);
  });

  it("never credits a reconnect after a drop to someone's choice", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    // A choice still on its way when the link drops: coming back on it is the app reconnecting.
    log.chose("contact", "hyperdht/1", 10);
    log.observe(live("webrtc/1", { transitionTarget: "hyperdht/1" }), 11);
    log.observe(down(), 12);
    log.observe(live("hyperdht/1"), 13);
    // That choice was spent on the reconnect: a later live move to it is the app's.
    log.observe(live("webrtc/1"), 14);
    log.observe(live("hyperdht/1"), 15);
    expect(log.entries.slice(1).map(e => [e.kind, e.cause ?? null, e.transport ?? null])).toEqual([
      ["chose", "contact", "webrtc/1"], ["switched", "dropped", "hyperdht/1"],
      ["switched", "automatic", "webrtc/1"], ["switched", "automatic", "hyperdht/1"],
    ]);
  });

  it("says who chose DHT only, and when the chat leaves it and is live again", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    log.observe(down({ dhtOnly: true, text: "dht" }), 10);
    expect(log.entries[1]).toMatchObject({ kind: "dht-only", cause: "you", from: "webrtc/1" });
    // The contact chooses it too: its own row. Nothing more while both stay.
    log.observe(down({ dhtOnly: true, peerDhtOnly: true, text: "dht" }), 20);
    expect(log.observe(down({ dhtOnly: true, peerDhtOnly: true, text: "dht" }), 25)).toBe(false);
    expect(log.entries[2]).toMatchObject({ kind: "dht-only", cause: "contact" });
    // I leave it: still DHT only, because of the contact. The contact leaves: back to automatic, then live.
    expect(log.observe(down({ dhtOnly: false, peerDhtOnly: true, text: "dht" }), 30)).toBe(false);
    log.observe(down({ text: "unavailable" }), 40);
    expect(log.entries[3]).toMatchObject({ kind: "dht-left", transport: undefined });
    // Hours later, it is still not an outage: DHT only was the reason.
    log.observe(live("iroh/1"), 3 * 60 * MIN);
    expect(kinds(log)).toEqual(["connected", "dht-only", "dht-only", "dht-left", "back"]);
    expect(log.entries[4]).toMatchObject({ transport: "iroh/1" });
    expect(log.entries[4].downMs).toBeUndefined();
  });

  it("puts the contact's DHT-only choice in place of the drop it caused, and names a chosen transport on the way out", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    // The link drops a moment before the contact's envelope says why: no row for the drop.
    log.observe(down(), 1_000);
    log.observe(down({ peerDhtOnly: true, text: "dht" }), 2_000);
    expect(kinds(log)).toEqual(["connected", "dht-only"]);
    expect(log.entries[1]).toMatchObject({ cause: "contact", at: 2_000 });
    log.observe(live("webrtc/1", { preferred: "webrtc/1" }), 3_000);
    expect(log.entries.slice(2)).toEqual([expect.objectContaining({ kind: "dht-left", transport: "webrtc/1" }), expect.objectContaining({ kind: "back", transport: "webrtc/1" })]);
  });

  it("leaving DHT only for a transport is one row, not the choice again", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    log.observe(down({ dhtOnly: true, text: "dht" }), 10);
    log.observe(down({ preferred: "iroh/1" }), 20);
    log.chose("you", "iroh/1", 21);
    log.observe(live("iroh/1"), 30);
    expect(kinds(log)).toEqual(["connected", "dht-only", "dht-left", "back"]);
  });

  it("does not repeat a DHT-only row after a restart", () => {
    const first = new TransportLog();
    first.observe(live("webrtc/1"), 0);
    first.observe(down({ dhtOnly: true, text: "dht" }), 10);
    const reopened = new TransportLog(first.entries, first.history);
    expect(reopened.observe(down({ dhtOnly: true, text: "dht" }), 100)).toBe(false);
    expect(reopened.liveNow()).toBeUndefined();
  });

  it("says a switch that failed, once, and keeps the transport it stayed on", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    log.chose("you", "iroh/1", 5);
    log.observe(live("webrtc/1", { transitionTarget: "iroh/1" }), 10);
    log.observe(live("webrtc/1", { transitionError: "Transport change failed: iroh/1 did not connect in time" }), 20);
    log.observe(live("webrtc/1", { transitionError: "Transport change failed: iroh/1 did not connect in time" }), 30);
    expect(log.entries.slice(1)).toEqual([expect.objectContaining({ kind: "chose", target: "iroh/1" }), expect.objectContaining({
      kind: "failed", target: "iroh/1", transport: "webrtc/1", reason: "Transport change failed: iroh/1 did not connect in time" })]);
    // A switch to it later is not taken for that old choice.
    log.observe(live("iroh/1"), 40);
    expect(log.entries.at(-1)).toMatchObject({ kind: "switched", cause: "automatic" });
  });

  it("says a switch that failed with no live link left, and keeps failed attempts to the history", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    log.observe(down({ transitionTarget: "iroh/1" }), 10);
    log.observe(down({ transitionError: "Transport preferences do not overlap." }), 20);
    expect(kinds(log)).toEqual(["connected", "failed"]);
    expect(log.entries[1]).toMatchObject({ target: "iroh/1", transport: undefined });
    expect(log.observe(down({ error: "Timed out" }), 30)).toBe(true);
    expect(log.observe(down({ error: "Timed out" }), 40)).toBe(false);
    expect(kinds(log)).toEqual(["connected", "failed"]);
    expect(log.history.at(-1)).toMatchObject({ kind: "attempt", reason: "Timed out" });
  });

  it("puts the round trip on the row of the transport in use, and keeps the latest in the history", () => {
    const log = new TransportLog();
    expect(log.rtt(40)).toBe(false);
    log.observe(live("webrtc/1"), 0);
    expect(log.rtt(42)).toBe(true);
    expect(log.rtt(45)).toBe(false);
    expect(log.rtt(80)).toBe(true);
    expect(log.history.at(-1)).toMatchObject({ kind: "live", rttMs: 80 });
    log.observe(down(), 10);
    expect(log.rtt(50)).toBe(false);
    expect(log.entries[0].rttMs).toBe(42);
  });

  it("keeps the last rows and events only", () => {
    const log = new TransportLog();
    for (let i = 0; i < TRANSPORT_HISTORY_MAX + 10; i++) {
      log.chose("you", i % 2 ? "iroh/1" : "hyperdht/1", i * 1_000);
      log.observe(live(i % 2 ? "iroh/1" : "hyperdht/1"), i * 1_000);
    }
    expect(log.entries).toHaveLength(TRANSPORT_LOG_MAX);
    expect(log.history).toHaveLength(TRANSPORT_HISTORY_MAX);
    expect(new TransportLog([...log.entries, ...log.entries], log.history).entries).toHaveLength(TRANSPORT_LOG_MAX);
  });
});

describe("transport log: rows an older release stored", () => {
  let n = 0;
  const row = (kind: TransportEntry["kind"], at: number, patch: Partial<TransportEntry> = {}): TransportEntry => ({ id: `r${++n}`, kind, at, ...patch });

  it("drops the restarts and short drops that came back on the same transport, and keeps the rest", () => {
    // Miguel's chat 1: lost/back pairs a minute or two apart, and chat 2: "Connected over WebRTC" at every start.
    const rows = [
      row("connected", 0, { transport: "webrtc/1" }),
      row("connected", 12 * MIN, { transport: "webrtc/1" }),
      row("lost", 20 * MIN, { from: "webrtc/1", fallback: "dht" }), row("back", 21 * MIN, { transport: "webrtc/1" }),
      row("switched", 25 * MIN, { cause: "you", from: "webrtc/1", transport: "hyperdht/1" }),
      row("lost", 30 * MIN, { from: "hyperdht/1" }), row("back", 32 * MIN, { transport: "hyperdht/1" }),
      row("connected", 40 * MIN, { transport: "hyperdht/1" }),
      row("lost", 50 * MIN, { from: "hyperdht/1" }), row("switched", 51 * MIN, { cause: "dropped", from: "hyperdht/1", transport: "iroh/1" }),
      row("lost", 60 * MIN, { from: "iroh/1", fallback: "dht" }), row("back", 70 * MIN, { transport: "iroh/1" }),
      row("flapping", 80 * MIN, { since: 75 * MIN, count: 3, live: true, transport: "iroh/1" }),
      row("dht-only", 90 * MIN, { cause: "contact" }),
    ];
    const compact = compactTransportRows(rows);
    expect(compact.map(e => [e.kind, e.cause ?? null, e.transport ?? null, e.downMs ?? null])).toEqual([
      ["connected", null, "webrtc/1", null],
      ["switched", "you", "hyperdht/1", null],
      ["switched", "dropped", "iroh/1", null],
      ["back", null, "iroh/1", 10 * MIN],
    ].concat([["dht-only", "contact", null, null]]));
    expect(compact[3]).toMatchObject({ fallback: "dht" });
    // Today's rows stay as they are.
    expect(compactTransportRows(compact)).toEqual(compact);
  });

  it("compacts on load, keeps the old rows in the history, and says it did", () => {
    const rows = [row("connected", 0, { transport: "webrtc/1" }), row("lost", MIN, { from: "webrtc/1" }), row("back", 2 * MIN, { transport: "webrtc/1" }), row("connected", 9 * MIN, { transport: "webrtc/1" })];
    const log = new TransportLog(rows);
    expect(log.compacted).toBe(true);
    expect(kinds(log)).toEqual(["connected"]);
    expect(events(log)).toEqual(["live", "down", "live", "live"]);
    // Saved once: loading what it saved changes nothing.
    expect(new TransportLog(log.entries, log.history).compacted).toBe(false);
  });
});

describe("transport log: the live transport now", () => {
  it("says since when and why, past a failed switch and a silent reconnect, and nothing while not live", () => {
    const log = new TransportLog();
    expect(log.liveNow()).toBeUndefined();
    log.observe(live("webrtc/1"), 10);
    expect(log.liveNow()).toEqual({ since: 10, cause: undefined });
    log.chose("contact", "iroh/1", 15);
    log.observe(live("iroh/1"), 20);
    log.switchFailed("hyperdht/1", "unreachable", 30);
    expect(log.liveNow()).toEqual({ since: 20, cause: "contact" });
    log.observe(down(), 40);
    expect(log.liveNow()).toBeUndefined();
    // Back within the quiet window: no row, but live since it came back, still the contact's choice.
    log.observe(live("iroh/1"), 50);
    expect(log.liveNow()).toEqual({ since: 50, cause: "contact" });
  });
});

describe("transport log: a chosen transport not reached yet (WISP 100)", () => {
  const wait = (failures: number, extra: Partial<NonNullable<TransportSnapshot["waiting"]>> = {}): TransportSnapshot["waiting"] =>
    ({ transport: "hyperdht/1", by: "you", failures, ...extra });

  it("waits off live with Fallback off: no rows while it waits, attempts only in the history, and the choice's row becomes the switch", () => {
    const log = new TransportLog();
    log.observe(live("iroh/1"), 0);
    log.chose("you", "hyperdht/1", MIN);
    // Off Iroh to wait for HyperDHT: the header says so, the timeline adds nothing.
    log.observe(down({ text: "dht", waiting: wait(0) }), MIN + 10);
    expect(kinds(log)).toEqual(["connected", "chose"]);
    expect(log.history.at(-1)).toMatchObject({ kind: "down", from: "iroh/1", target: "hyperdht/1", text: "dht" });
    // Retried for 20 minutes: one history line per reason in a row, never a row.
    for (let i = 1; i <= 8; i++) log.observe(down({ text: "dht", waiting: wait(i, { error: "hyperdht/1 unreachable" }) }), MIN + i * 2 * MIN);
    log.observe(down({ text: "dht", waiting: wait(9, { error: "Your contact did not answer" }) }), 20 * MIN);
    expect(kinds(log)).toEqual(["connected", "chose"]);
    expect(log.history.filter(e => e.kind === "attempt").map(e => [e.target, e.reason])).toEqual([["hyperdht/1", "hyperdht/1 unreachable"], ["hyperdht/1", "Your contact did not answer"]]);
    // It lands, long after: the choice, not an outage or a drop.
    log.observe(live("hyperdht/1"), 25 * MIN);
    expect(log.entries.at(-1)).toMatchObject({ kind: "switched", cause: "you", from: "iroh/1", transport: "hyperdht/1" });
    expect(kinds(log)).toEqual(["connected", "switched"]);
    expect(log.history.at(-1)).toMatchObject({ kind: "switched", cause: "you", from: "iroh/1", transport: "hyperdht/1" });
    expect(log.liveNow()).toEqual({ since: 25 * MIN, cause: "you" });
  });

  it("stays live on a fallback: the failed switch is one row, later attempts are history, and landing is the choice's switch", () => {
    const log = new TransportLog();
    log.observe(live("iroh/1"), 0);
    log.chose("you", "hyperdht/1", MIN);
    log.observe(live("iroh/1", { waiting: wait(0) }), MIN + 10);
    log.switchFailed("hyperdht/1", "hyperdht/1 unreachable", MIN + 20);
    log.observe(live("iroh/1", { waiting: wait(1, { error: "hyperdht/1 unreachable" }) }), MIN + 30);
    for (let i = 2; i <= 5; i++) log.observe(live("iroh/1", { waiting: wait(i, { error: "hyperdht/1 unreachable" }) }), i * 3 * MIN);
    expect(kinds(log)).toEqual(["connected", "chose", "failed"]);
    log.observe(live("hyperdht/1"), 30 * MIN);
    // Well past the choice's two minutes, still its switch, not "a direct path was found".
    expect(log.entries.at(-1)).toMatchObject({ kind: "switched", cause: "you", from: "iroh/1", transport: "hyperdht/1" });
  });

  it("tells a wait given up for Automatic from a choice landing", () => {
    const log = new TransportLog();
    log.observe(live("iroh/1"), 0);
    log.chose("you", "hyperdht/1", MIN);
    log.observe(down({ text: "dht", waiting: wait(1) }), MIN + 10);
    log.chose("you", "automatic", 2 * MIN);
    log.observe(down({ text: "dht" }), 2 * MIN + 10);
    log.observe(live("iroh/1"), 2 * MIN + 20);
    // Back on Iroh within the quiet window: the choices are the rows, nothing reads as a drop.
    expect(kinds(log)).toEqual(["connected", "chose", "chose"]);
  });
});
