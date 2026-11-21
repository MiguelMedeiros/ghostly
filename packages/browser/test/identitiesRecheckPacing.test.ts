import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { emptyIdentityLedger, identityStatement, newIdentityBinding, type IdentityLedger, type ReceivedIdentity } from "@ghostly/core";
import { IdentityProofs } from "../src/engine/identities";
import { fakeKey, fakeKeySubject } from "../src/proofs/testing";
// covers: proofs.recheck

/**
 * The automatic re-check keeps up with every contact's proof: each is checked again about a day after its last check,
 * however many contacts there are, and the provider calls stay spread out.
 */

const DAY_S = 86_400;

afterEach(() => { vi.useRealTimers(); });

it.each([300, 1_000])("%i contacts with 3 proofs each: every proof is checked again within about a day, a few calls a minute at most", async contacts => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const start = Math.floor(Date.now() / 1000);
  const ledgers = new Map<string, IdentityLedger>();
  let i = 0;
  for (let c = 0; c < contacts; c++) {
    const received: ReceivedIdentity[] = [];
    for (let p = 0; p < 3; p++, i++) {
      const { binding, seed } = newIdentityBinding({ provider: fakeKey.id, subject: fakeKeySubject(), validitySeconds: 30 * DAY_S });
      seed.fill(0);
      // Last checked at times spread over the last day, as they are once the re-check has been running a while.
      const checkedAt = start - Math.floor(((i * 7919) % (contacts * 3)) * DAY_S / (contacts * 3));
      received.push({ id: identityStatement(binding).id, binding, evidence: null, verified: { subject: binding.subject, source: "test" }, presenter: "p", audience: "a",
        context: "c", verifiedAt: checkedAt, checkedAt, status: "verified" });
    }
    ledgers.set(`chat-${c}`, { ...emptyIdentityLedger(), received });
  }
  const calls: number[] = [];
  const engine = new IdentityProofs({
    ledger: id => ledgers.get(id),
    // Each check writes its outcome once: no revocation is found, so nothing else writes.
    updateLedger: async (id, change) => { calls.push(Date.now()); const next = change(structuredClone(ledgers.get(id)!)); ledgers.set(id, next); return next; },
    channel: () => undefined,
    keys: () => ({}),
    linkIds: () => [...ledgers.keys()],
    online: () => true,
    emit: () => {},
    publish: async () => {},
    resolve: async () => null,
  }, () => [{ ...fakeKey, recheck: { afterSeconds: 3600 } }]);
  await engine.load();
  engine.start();
  await vi.advanceTimersByTimeAsync(3 * DAY_S * 1000);
  engine.stop();

  const end = Math.floor(Date.now() / 1000);
  const ages = [...ledgers.values()].flatMap(l => l.received.map(r => end - r.checkedAt));
  expect(Math.max(...ages) / DAY_S, "the longest since a proof's last check, in days").toBeLessThanOrEqual(1.1);
  expect(calls.length / 3, "checks a day").toBeGreaterThanOrEqual(contacts * 3 * 0.95);
  // Not a burst: at most a few checks in any minute.
  const perMinute = new Map<number, number>();
  for (const at of calls) perMinute.set(Math.floor(at / 60_000), (perMinute.get(Math.floor(at / 60_000)) ?? 0) + 1);
  expect(Math.max(...perMinute.values()), "checks in a minute").toBeLessThanOrEqual(15);
}, 120_000);
