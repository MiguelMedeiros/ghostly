import { describe, expect, it } from "vitest";
import { CHOICE_TTL_MS, FLAP_WINDOW_MS, TRANSPORT_LOG_MAX, TransportLog, type TransportSnapshot } from "../src/engine/transportLog";
// covers: transport.timeline

const live = (transport: TransportSnapshot["transport"], extra: Partial<TransportSnapshot> = {}): TransportSnapshot =>
  ({ live: true, transport, text: "stream", dhtOnly: false, ...extra });
const down = (extra: Partial<TransportSnapshot> = {}): TransportSnapshot => ({ live: false, text: "unavailable", dhtOnly: false, ...extra });
const kinds = (log: TransportLog) => log.entries.map(e => e.kind);

describe("transport log: what a change reads as", () => {
  it("says the first connection, and nothing while it stays on the same transport", () => {
    const log = new TransportLog();
    expect(log.observe(down(), 0)).toBe(false);
    expect(log.observe(live("webrtc/1"), 1_000)).toBe(true);
    expect(log.observe(live("webrtc/1"), 2_000)).toBe(false);
    expect(log.entries).toEqual([expect.objectContaining({ kind: "connected", transport: "webrtc/1", at: 1_000 })]);
  });

  it("tells a switch someone chose from one the app made", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    log.chose("you", "iroh/1", 10);
    log.observe(live("webrtc/1", { transitionTarget: "iroh/1" }), 20);
    log.observe(live("iroh/1"), 30);
    log.chose("contact", "hyperdht/1", 40);
    log.observe(live("hyperdht/1"), 50);
    // No choice points at it: the app moved on its own.
    log.observe(live("iroh/1"), 60);
    expect(log.entries.slice(1)).toEqual([
      expect.objectContaining({ kind: "switched", from: "webrtc/1", transport: "iroh/1", cause: "you" }),
      expect.objectContaining({ kind: "switched", from: "iroh/1", transport: "hyperdht/1", cause: "contact" }),
      expect.objectContaining({ kind: "switched", from: "hyperdht/1", transport: "iroh/1", cause: "automatic" }),
    ]);
  });

  it("forgets a choice that did not land in time, or landed elsewhere", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    log.chose("you", "iroh/1", 0);
    log.observe(live("iroh/1"), CHOICE_TTL_MS + 1);
    log.chose("contact", "hyperdht/1", CHOICE_TTL_MS + 2);
    log.observe(live("webrtc/1"), CHOICE_TTL_MS + 3);
    expect(log.entries.slice(1).map(e => e.cause)).toEqual(["automatic", "automatic"]);
  });

  it("says a lost link, what carries text meanwhile, and coming back", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    log.observe(down(), FLAP_WINDOW_MS);
    // The DHT path is known a moment later: the same line says so.
    expect(log.observe(down({ text: "dht" }), FLAP_WINDOW_MS + 5)).toBe(true);
    expect(log.observe(down({ text: "dht" }), FLAP_WINDOW_MS + 6)).toBe(false);
    log.observe(live("webrtc/1"), 3 * FLAP_WINDOW_MS);
    expect(log.entries).toEqual([
      expect.objectContaining({ kind: "connected" }),
      expect.objectContaining({ kind: "lost", from: "webrtc/1", fallback: "dht" }),
      expect.objectContaining({ kind: "back", transport: "webrtc/1" }),
    ]);
  });

  it("says a fallback to another transport after a drop", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    log.observe(down({ text: "hold" }), 10);
    log.observe(live("iroh/1"), 20);
    expect(log.entries.slice(1)).toEqual([
      expect.objectContaining({ kind: "lost", fallback: "hold" }),
      expect.objectContaining({ kind: "switched", from: "webrtc/1", transport: "iroh/1", cause: "dropped" }),
    ]);
  });

  it("says who turned on DHT-only", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    log.observe(down({ dhtOnly: true, text: "dht" }), 10);
    expect(log.entries[1]).toMatchObject({ kind: "lost", fallback: "dht-only", cause: "you" });
  });

  it("says a switch that failed, once, and keeps the transport it stayed on", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    log.chose("you", "iroh/1", 5);
    log.observe(live("webrtc/1", { transitionTarget: "iroh/1" }), 10);
    log.observe(live("webrtc/1", { transitionError: "Transport change failed: iroh/1 did not connect in time" }), 20);
    log.observe(live("webrtc/1", { transitionError: "Transport change failed: iroh/1 did not connect in time" }), 30);
    expect(log.entries.slice(1)).toEqual([expect.objectContaining({
      kind: "failed", target: "iroh/1", transport: "webrtc/1", reason: "Transport change failed: iroh/1 did not connect in time" })]);
    // A switch to it later is not taken for that old choice.
    log.observe(live("iroh/1"), 40);
    expect(log.entries.at(-1)).toMatchObject({ kind: "switched", cause: "automatic" });
  });

  it("says a switch that failed with no live link left", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    log.observe(down({ transitionTarget: "iroh/1" }), 10);
    log.observe(down({ transitionError: "Transport preferences do not overlap." }), 20);
    expect(kinds(log)).toEqual(["connected", "lost", "failed"]);
    expect(log.entries[2]).toMatchObject({ target: "iroh/1", transport: undefined });
  });

  it("says Connected again after a restart, not a drop", () => {
    const first = new TransportLog();
    first.observe(live("iroh/1"), 0);
    const reopened = new TransportLog(first.entries);
    expect(reopened.observe(down(), 100_000)).toBe(false);
    reopened.observe(live("iroh/1"), 101_000);
    expect(kinds(reopened)).toEqual(["connected", "connected"]);
  });

  it("puts the round trip on the line of the transport in use", () => {
    const log = new TransportLog();
    expect(log.rtt(40)).toBe(false);
    log.observe(live("webrtc/1"), 0);
    expect(log.rtt(42)).toBe(true);
    expect(log.rtt(42)).toBe(false);
    log.observe(down(), 10);
    expect(log.rtt(50)).toBe(false);
    expect(log.entries[0].rttMs).toBe(42);
  });
});

describe("transport log: flapping", () => {
  it("collapses a link that keeps dropping into one line that keeps counting", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    let t = 5 * FLAP_WINDOW_MS;
    for (let i = 0; i < 3; i++) { log.observe(down(), t += 5_000); log.observe(live("webrtc/1"), t += 5_000); }
    expect(kinds(log)).toEqual(["connected", "flapping"]);
    expect(log.entries[1]).toMatchObject({ count: 3, live: true, transport: "webrtc/1", since: 5 * FLAP_WINDOW_MS + 5_000, at: t });
    const id = log.entries[1].id;
    log.observe(down({ text: "dht" }), t += 5_000);
    expect(log.entries[1]).toMatchObject({ id, count: 3, live: false, fallback: "dht", transport: undefined });
    // Quiet for longer than the window: the next change is a line of its own again.
    log.observe(live("iroh/1"), t + FLAP_WINDOW_MS + 1);
    expect(kinds(log)).toEqual(["connected", "flapping", "switched"]);
    expect(log.entries[2]).toMatchObject({ from: "webrtc/1", transport: "iroh/1", cause: "dropped" });
  });

  it("leaves a drop now and then alone, and never folds in a chosen switch", () => {
    const log = new TransportLog();
    log.observe(live("webrtc/1"), 0);
    log.observe(down(), 10_000);
    log.observe(live("webrtc/1"), 20_000);
    log.chose("you", "iroh/1", 25_000);
    log.observe(live("iroh/1"), 30_000);
    log.observe(down(), 40_000);
    log.observe(live("iroh/1"), 2 * FLAP_WINDOW_MS);
    expect(kinds(log)).toEqual(["connected", "lost", "back", "switched", "lost", "back"]);
  });

  it("keeps the last lines only", () => {
    const log = new TransportLog();
    for (let i = 0; i < TRANSPORT_LOG_MAX + 10; i++) {
      log.chose("you", i % 2 ? "iroh/1" : "hyperdht/1", i * 1_000);
      log.observe(live(i % 2 ? "iroh/1" : "hyperdht/1"), i * 1_000);
    }
    expect(log.entries).toHaveLength(TRANSPORT_LOG_MAX);
    expect(new TransportLog([...log.entries, ...log.entries]).entries).toHaveLength(TRANSPORT_LOG_MAX);
  });
});

describe("transport log: the live transport now", () => {
  it("says since when and why, past a failed switch, and nothing while not live", () => {
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
  });
});
