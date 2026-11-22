import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryBudgetError, RelayTransport, emptyIdentityLedger, identityStatement, newIdentityBinding, type IdentityLedger, type ReceivedIdentity } from "@ghostly/core";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import { IdentityProofs } from "../src/engine/identities";
import { fakeKey, fakeKeySubject } from "../src/proofs/testing";
// covers: proofs.revoke

/**
 * The 12 h revocation lookup read every contact proof back to back through the relays' background share (44 reads a
 * minute over the three default relays): past the 44th, each read was refused by the budget, counted as a failed lookup,
 * and the whole lookup ran again from the first chat. With 100 contacts x 5 proofs, 146 of 500 were ever read in 12 h.
 */

const HOUR = 60 * 60_000;

function contacts(count: number, perContact: number) {
  const now = Math.floor(Date.now() / 1000);
  const ledgers = new Map<string, IdentityLedger>();
  const proofs = new Map<string, string>();
  for (let c = 0; c < count; c++) {
    const received: ReceivedIdentity[] = [];
    for (let p = 0; p < perContact; p++) {
      const { binding, seed } = newIdentityBinding({ provider: fakeKey.id, subject: fakeKeySubject(), validitySeconds: 30 * 86_400 });
      seed.fill(0);
      const id = identityStatement(binding).id;
      proofs.set(binding.key, id);
      received.push({ id, binding, evidence: null, verified: { subject: binding.subject, source: "test" }, presenter: "p", audience: "a", context: "c",
        verifiedAt: now, checkedAt: now, status: "verified" });
    }
    ledgers.set(`chat-${c}`, { ...emptyIdentityLedger(), received });
  }
  return { ledgers, proofs };
}

afterEach(() => { vi.useRealTimers(); });

describe("the 12 h revocation lookup reads at the relays' background pace", () => {
  it("100 contacts x 5 proofs: every proof is read once within the 12 h, at about one GET each, never the whole share at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await transact([STORES.settings], stores => { stores[STORES.settings].delete("identityRevocationsCheckedAt"); });
    const { ledgers, proofs } = contacts(100, 5);
    const gets: number[] = [];
    // Every relay answers "no record" after 150 ms.
    const fetch = (async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") gets.push(Date.now());
      await new Promise(resolve => setTimeout(resolve, 150));
      return new Response(null, { status: 404 });
    }) as typeof globalThis.fetch;
    const transport = new RelayTransport({ fetch, log: () => {} });
    const read = new Map<string, number>();
    const engine = new IdentityProofs({
      ledger: id => ledgers.get(id),
      updateLedger: async (id, change) => { const next = change(structuredClone(ledgers.get(id)!)); ledgers.set(id, next); return next; },
      channel: () => undefined,
      keys: () => ({}),
      linkIds: () => [...ledgers.keys()],
      online: () => true,
      emit: () => {},
      publish: async () => {},
      resolve: async key => {
        const records = (await transport.resolve(key, { background: true }))?.records ?? null;
        read.set(key, (read.get(key) ?? 0) + 1);
        return records;
      },
    }, () => [fakeKey]);
    await engine.load();
    const start = Date.now();
    engine.start();
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    engine.stop();

    expect(read.size, "proofs ever looked up").toBe(proofs.size);
    expect(Math.max(...read.values()), "no proof read twice in the 12 h").toBe(1);
    expect(gets.length, "about one relay GET per proof").toBeLessThanOrEqual(proofs.size * 1.1);
    // The first minute of the lookup leaves most of the background share to the profile's other reads.
    const firstMinute = gets.filter(at => at < start + 2 * 60_000).length;
    expect(firstMinute, "GETs in the lookup's first minute").toBeLessThanOrEqual(22);
    expect(await wrap((await store(STORES.settings, "readonly")).get("identityRevocationsCheckedAt")), "the lookup is noted as done").toBeTypeOf("number");
  }, 120_000);

  it("a read the budget held back is read again once it frees one; a retry after the relays failed goes on with the proofs not read yet", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await transact([STORES.settings], stores => { stores[STORES.settings].delete("identityRevocationsCheckedAt"); });
    const { ledgers, proofs } = contacts(4, 5);
    const order = [...proofs.keys()];
    const reads: string[] = [];
    const state = { heldOnce: new Set([order[2]]), failFrom: order[10] as string | undefined, failing: false };
    const engine = new IdentityProofs({
      ledger: id => ledgers.get(id),
      updateLedger: async (id, change) => { const next = change(structuredClone(ledgers.get(id)!)); ledgers.set(id, next); return next; },
      channel: () => undefined,
      keys: () => ({}),
      linkIds: () => [...ledgers.keys()],
      online: () => true,
      emit: () => {},
      publish: async () => {},
      resolve: async key => {
        if (state.heldOnce.delete(key)) throw new DiscoveryBudgetError(20_000);
        if (key === state.failFrom) state.failing = true;
        reads.push(key);
        if (state.failing) throw new Error("No Pkarr relay reachable");
        return null;
      },
    }, () => [fakeKey]);
    await engine.load();
    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);
    // Held back: nothing more is read until the budget frees one, then that same proof.
    await vi.advanceTimersByTimeAsync(2 * 3_000);
    expect(reads).toEqual(order.slice(0, 2));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reads).toEqual(order.slice(0, 3));
    // The relays fail from the 11th on: the lookup reads the rest, is not done, and the retry 5 min later reads only those.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(reads).toEqual(order);
    expect(await wrap((await store(STORES.settings, "readonly")).get("identityRevocationsCheckedAt"))).toBeUndefined();
    state.failing = false; state.failFrom = undefined;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(reads.slice(order.length)).toEqual(order.slice(10));
    expect(await wrap((await store(STORES.settings, "readonly")).get("identityRevocationsCheckedAt"))).toBeTypeOf("number");
    engine.stop();
  });
});
