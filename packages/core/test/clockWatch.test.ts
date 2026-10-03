import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOCK_EVIDENCE_MS, CLOCK_OFF_MS, CLOCK_PEER_READ_GAP_MS, ClockWatch } from "../src/clockWatch";
import { createIdentity } from "../src/identity";
import { createRelayPayload } from "../src/pkarr";
import { RelayTransport } from "../src/relay";
import type { ServerTime } from "../src/transport";
// covers: app.clock-off

/**
 * Whether this device's own clock seems to be off: what a relay's `Date` header and contacts' packets say against it,
 * and the rule that turns that into the note. The clock here is the fake one; `REAL` is what the rest of the world has.
 */
const REAL = 1_800_000_000_000;
const MIN = 60_000;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** A watch on a device whose clock is `off` ms from the real time (positive: ahead). */
function device(off: number) {
  vi.setSystemTime(REAL + off);
  const changes: (number | null)[] = [];
  const watch = new ClockWatch(offset => changes.push(offset));
  const real = () => Date.now() - off;
  return {
    watch, changes,
    /** A relay answers a request, its `Date` to the second, 80 ms after it went out. */
    server(name: string, theirOff = 0) { const sent = Date.now(); watch.server(name, Math.floor((real() + theirOff) / 1000) * 1000, sent, sent + 80); },
    /** A contact's packet, dated by its clock (`theirOff` from the real time), seen to come between two reads `gap` apart. */
    peer(name: string, theirOff = 0, gap = 3_000) { watch.peer(name, real() + theirOff - 1_000, Date.now() - gap, Date.now()); },
  };
}

describe("the rule: several sources, never one contact", () => {
  it.each([["two minutes ahead", 2 * MIN], ["ten minutes behind", -10 * MIN], ["an hour ahead", 60 * MIN]])("two relays that say this clock is %s are enough, and say by how much", (_, off) => {
    const d = device(off);
    d.server("https://a.test");
    expect(d.watch.offset, "one relay alone says nothing").toBeNull();
    d.server("https://b.test");
    expect(Math.abs(d.watch.offset! - off)).toBeLessThan(2_000);
    expect(Math.sign(d.watch.offset!)).toBe(Math.sign(off));
    expect(d.changes).toHaveLength(1);
    // The same relays again change nothing to tell.
    d.server("https://a.test");
    expect(d.changes).toHaveLength(1);
  });

  it("one contact never shows the note, whatever its clock says: it is as likely that contact's clock", () => {
    const d = device(0);
    d.peer("ada", 2 * MIN);
    d.peer("ada", 2 * MIN);
    expect(d.watch.offset).toBeNull();
    // Nor two, nor that contact with one relay that says this clock is right.
    d.peer("bo", 2 * MIN);
    expect(d.watch.offset).toBeNull();
    d.server("https://a.test");
    d.peer("cy", 2 * MIN);
    expect(d.watch.offset, "three contacts ahead, and a relay that says this clock is right").toBeNull();
    expect(d.changes).toEqual([]);
  });

  it("three contacts that say so the same way show it where no relay's time can be read (a browser)", () => {
    const d = device(-3 * MIN);
    d.peer("ada"); d.peer("bo");
    expect(d.watch.offset).toBeNull();
    d.peer("cy");
    expect(Math.abs(d.watch.offset! + 3 * MIN)).toBeLessThan(3_000);
    // One contact whose own clock is off the other way does not take it back; as many dissenting as agreeing does.
    d.peer("di", -3 * MIN);
    expect(d.watch.offset).not.toBeNull();
    d.peer("ed", -3 * MIN);
    expect(d.watch.offset).toBeNull();
  });

  it("one relay and one contact that agree show it; a contact that says otherwise holds it back", () => {
    const d = device(4 * MIN);
    d.server("https://a.test");
    d.peer("ada");
    expect(Math.abs(d.watch.offset! - 4 * MIN)).toBeLessThan(3_000);
    d.peer("bo", 4 * MIN);
    expect(d.watch.offset).toBeNull();
  });

  it("two relays that disagree say nothing, and a clock under a minute off is not off", () => {
    const d = device(2 * MIN);
    d.server("https://a.test");
    d.server("https://b.test", 2 * MIN);
    expect(d.watch.offset).toBeNull();
    const close = device(CLOCK_OFF_MS - 2_000);
    close.server("https://a.test"); close.server("https://b.test");
    close.peer("ada"); close.peer("bo"); close.peer("cy");
    expect(close.watch.offset).toBeNull();
  });

  it("a contact's packet says nothing when the two reads around it were far apart, or there was no read before", () => {
    const d = device(5 * MIN);
    for (const name of ["ada", "bo", "cy"]) d.peer(name, 0, CLOCK_PEER_READ_GAP_MS + 1);
    expect(d.watch.offset).toBeNull();
    for (const name of ["ada", "bo", "cy"]) d.watch.peer(name, REAL, 0, Date.now());
    expect(d.watch.offset).toBeNull();
    for (const name of ["ada", "bo", "cy"]) d.peer(name, 0, CLOCK_PEER_READ_GAP_MS);
    expect(d.watch.offset).not.toBeNull();
  });

  it("goes away by itself: when the clock is set right, and when the evidence is half an hour old", () => {
    const d = device(2 * MIN);
    d.server("https://a.test"); d.server("https://b.test");
    expect(d.watch.offset).not.toBeNull();
    // The clock is set right: the next answers say so.
    vi.setSystemTime(REAL + 10_000);
    const sent = Date.now();
    d.watch.server("https://a.test", REAL + 10_000, sent, sent + 50);
    d.watch.server("https://b.test", REAL + 10_000, sent, sent + 50);
    expect(d.watch.offset).toBeNull();
    expect(d.changes.at(-1)).toBeNull();

    const old = device(2 * MIN);
    old.server("https://a.test"); old.server("https://b.test");
    vi.advanceTimersByTime(CLOCK_EVIDENCE_MS + 2_000);
    expect(old.watch.offset).toBeNull();
    expect(old.changes).toEqual([expect.any(Number), null]);
    old.watch.close();
  });

  it("reset forgets what was heard", () => {
    const d = device(2 * MIN);
    d.server("https://a.test"); d.server("https://b.test");
    d.watch.reset();
    expect(d.watch.offset).toBeNull();
    expect(d.changes.at(-1)).toBeNull();
  });
});

describe("a relay's own time", () => {
  const key = createIdentity();
  const answer = (headers: Record<string, string>) => new Response(createRelayPayload(key, [{ label: "_ts", value: "1" }], 1000n) as BodyInit, { headers });

  it("is told with each answer whose Date header can be read, by the relay's origin and never by a key", async () => {
    vi.setSystemTime(REAL + 2 * MIN);
    const date = new Date(REAL).toUTCString();
    const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test", "https://b.test"], fetch: (async () => answer({ date })) as typeof fetch });
    const times: ServerTime[] = [];
    const off = relay.onServerTime(time => times.push(time));
    await relay.resolve(key.pubKeyZ32);
    await relay.resolve(key.pubKeyZ32);
    expect(times.map(t => t.source)).toEqual(["https://a.test", "https://b.test"]);
    expect(times[0]).toMatchObject({ date: Math.floor(REAL / 1000) * 1000, sent: REAL + 2 * MIN });
    expect(JSON.stringify(times)).not.toContain(key.pubKeyZ32);
    // Into the watch: two relays, two minutes.
    const watch = new ClockWatch();
    for (const t of times) watch.server(t.source, t.date, t.sent, t.received);
    expect(Math.abs(watch.offset! - 2 * MIN)).toBeLessThan(2_000);
    off();
    await relay.resolve(key.pubKeyZ32);
    expect(times).toHaveLength(2);
  });

  it("is not read from an answer a cache kept (its Date is when it was made), nor where the header cannot be read", async () => {
    vi.setSystemTime(REAL);
    const times: ServerTime[] = [];
    const cached = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: (async () => answer({ date: new Date(REAL - 4 * MIN).toUTCString(), age: "240" })) as typeof fetch });
    cached.onServerTime(time => times.push(time));
    await cached.resolve(key.pubKeyZ32);
    // A browser reading another origin's answer sees no Date unless the relay exposes it.
    const hidden = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: (async () => answer({})) as typeof fetch });
    hidden.onServerTime(time => times.push(time));
    await hidden.resolve(key.pubKeyZ32);
    const garbled = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: (async () => answer({ date: "yesterday" })) as typeof fetch });
    garbled.onServerTime(time => times.push(time));
    await garbled.resolve(key.pubKeyZ32);
    expect(times).toEqual([]);
  });
});
