import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { setLinkTraceSink } from "../src/linkTrace";
import { RelayTransport } from "../src/relay";

// covers: core.relay-client

/**
 * The link trace's line for a read the budget held back (`read.held`). The Desktop app's log takes every trace line (its
 * sink is always on) and rotates at 2 MiB: a ~1 KB line at each held read pushed the pairing traces out of it. One relay
 * with one request a minute, kept in memory; fake time.
 */

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { setLinkTraceSink(null); vi.useRealTimers(); });

function relay() {
  const fetchFn = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const transport = new RelayTransport({ relays: ["https://a.test"], log: () => {}, fetch: fetchFn, requestsPerMinute: 1, freshReadMs: 0 });
  const lines: Record<string, unknown>[] = [];
  setLinkTraceSink((line) => { const l = JSON.parse(line); if (l.step === "read.held") lines.push(l); });
  const filler = createIdentity().pubKeyZ32;
  /** The relay's one request of the minute, spent on a key nobody watches. */
  const spend = () => transport.resolve(filler);
  const read = (key: string) => transport.resolve(key).catch(() => {});
  return { lines, spend, read };
}

describe("relay transport: the trace of a read the budget held back", () => {
  it("traces a held key again once HELD_TRACE_MS went, with the holds it left out", async () => {
    const { lines, spend, read } = relay();
    const key = createIdentity().pubKeyZ32, me = key.slice(0, 6);
    await spend();
    await vi.advanceTimersByTimeAsync(1);
    const first = Date.now();
    await read(key);
    expect(lines).toMatchObject([{ me, quiet: 0, lastAt: null }]);
    for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(10_000); await read(key); }
    // The minute freed and spent again; the key, held again just short of a minute after its line, says nothing yet.
    await vi.advanceTimersByTimeAsync(first + MINUTE - 1 - Date.now());
    await spend();
    await read(key);
    expect(lines).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await read(key);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ me, quiet: 6, lastAt: first });
  });

  it("traces a held key again when the clock went back", async () => {
    const { lines, spend, read } = relay();
    const key = createIdentity().pubKeyZ32;
    await spend();
    await read(key);
    vi.setSystemTime(Date.now() - 10 * MINUTE);
    await read(key);
    expect(lines).toHaveLength(2);
  });

  it("writes at most HELD_TRACE_LINES lines a minute across keys, and the next line counts the holds left out", async () => {
    const { lines, spend, read } = relay();
    await spend();
    for (let i = 0; i < 30; i++) await read(createIdentity().pubKeyZ32);
    expect(lines).toHaveLength(20);
    expect(lines.every((l) => l.unlisted === 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(MINUTE);
    await spend();
    await read(createIdentity().pubKeyZ32);
    expect(lines).toHaveLength(21);
    expect(lines[20]).toMatchObject({ unlisted: 10 });
  });

  it("keeps tracing past READ_TURNS_KEPT keys held, a line a minute at most per key and HELD_TRACE_LINES in all", async () => {
    // 600 keys held, each read every 10 s: before, the kept entries churned and every held read was traced.
    const { lines, spend, read } = relay();
    const keys = Array.from({ length: 600 }, () => createIdentity().pubKeyZ32);
    for (let t = 0; t < 5 * MINUTE; t += 10_000) {
      if (t) await vi.advanceTimersByTimeAsync(10_000);
      if (t % MINUTE === 0) await spend();
      for (const key of keys) await read(key);
    }
    expect(lines.length).toBeLessThanOrEqual(5 * 20);
    expect(lines.length).toBeGreaterThanOrEqual(4 * 20);
    const unlisted = lines.reduce((n, l) => n + (l.unlisted as number) + (l.quiet as number), 0);
    expect(unlisted).toBeGreaterThan(1_000);
  });
});
