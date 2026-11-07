import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { emptyIdentityLedger, type IdentityLedger } from "@ghostly/core";
import { IdentityProofs } from "../src/engine/identities";
import { fakeKey } from "../src/proofs/testing";
// covers: proofs.recheck, proofs.revoke

/**
 * The hourly republish and the 15-minute re-check each pushed their next timer on `timers` and never took the fired one
 * off: a daemon held 5 more timer handles an hour for as long as it ran (123 after a day).
 */

const HOUR = 60 * 60_000;

afterEach(() => { vi.useRealTimers(); });

it("holds only the timers still pending, however long it runs, and stop leaves none", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const ledgers = new Map<string, IdentityLedger>([["chat-0", emptyIdentityLedger()]]);
  const engine = new IdentityProofs({
    ledger: id => ledgers.get(id),
    updateLedger: async (id, change) => { const next = change(structuredClone(ledgers.get(id)!)); ledgers.set(id, next); return next; },
    channel: () => undefined,
    keys: () => ({}),
    linkIds: () => [...ledgers.keys()],
    online: () => true,
    emit: () => {},
    publish: async () => {},
    resolve: async () => null,
  }, () => [fakeKey]);
  await engine.load();
  engine.start();
  const timers = () => (engine as unknown as { timers: unknown[] }).timers.length;
  let at = 0;
  for (const h of [1, 2, 6, 12, 24]) {
    await vi.advanceTimersByTimeAsync((h - at) * HOUR);
    at = h;
    // The republish, the re-check and the 12 h revocation lookup: one pending timer each.
    expect(timers(), `timers after ${h} h`).toBeLessThanOrEqual(3);
  }
  engine.stop();
  expect(timers()).toBe(0);
  expect(vi.getTimerCount(), "timers pending after stop").toBe(0);
});
