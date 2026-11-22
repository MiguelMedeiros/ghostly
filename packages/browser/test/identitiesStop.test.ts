import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { emptyIdentityLedger, identityStatement, newIdentityBinding, type IdentityLedger, type ReceivedIdentity } from "@ghostly/core";
import { IdentityProofs } from "../src/engine/identities";
import { fakeKey, fakeKeySubject } from "../src/proofs/testing";
// covers: proofs.recheck, proofs.revoke

/**
 * The background work (the hourly republish, the automatic re-check) planned its next round when the last one ended. A
 * stop while one was under way cleared the timers first, and the round then planned the next after it: a stopped
 * engine (a device another replaced, Clear all data) went on reading the contacts' records every 15 minutes.
 */

const HOUR = 60 * 60_000;

afterEach(() => { vi.useRealTimers(); });

it("nothing is read after stop, when a re-check was under way at the stop", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86_400;
  const received: ReceivedIdentity[] = [];
  for (let p = 0; p < 3; p++) {
    const { binding, seed } = newIdentityBinding({ provider: fakeKey.id, subject: fakeKeySubject(), validitySeconds: 30 * 86_400 });
    seed.fill(0);
    received.push({ id: identityStatement(binding).id, binding, evidence: null, verified: { subject: binding.subject, source: "test" }, presenter: "p", audience: "a",
      context: "c", verifiedAt: twoDaysAgo, checkedAt: twoDaysAgo, status: "verified" });
  }
  const ledgers = new Map<string, IdentityLedger>([["chat-0", { ...emptyIdentityLedger(), received }]]);
  let reads = 0;
  const engine = new IdentityProofs({
    ledger: id => ledgers.get(id),
    updateLedger: async (id, change) => { const next = change(structuredClone(ledgers.get(id)!)); ledgers.set(id, next); return next; },
    channel: () => undefined,
    keys: () => ({}),
    linkIds: () => [...ledgers.keys()],
    online: () => true,
    emit: () => {},
    publish: async () => {},
    // Every relay answers "no record" after 5 s.
    resolve: async () => { reads++; await new Promise(resolve => setTimeout(resolve, 5_000)); return null; },
  }, () => [{ ...fakeKey, recheck: { afterSeconds: 3600 } }]);
  await engine.load();
  engine.start();
  // The first automatic re-check starts at 3 min: stopped while its first read is under way.
  await vi.advanceTimersByTimeAsync(3 * 60_000 + 1_000);
  const atStop = reads;
  engine.stop();
  await vi.advanceTimersByTimeAsync(48 * HOUR);
  expect(reads, "reads after the stop").toBe(atStop);
});
