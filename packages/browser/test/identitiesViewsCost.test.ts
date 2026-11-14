import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { emptyIdentityLedger, identityStatement, newIdentityBinding, type IdentityLedger, type SharedIdentity } from "@ghostly/core";
import { STORES, transact } from "../src/shared/idb";
import { IdentityProofs, type StoredIdentityProof } from "../src/engine/identities";
// covers: proofs.share, proofs.nostr

/**
 * Every engine state builds the profile's proofs (`views()`) and, for each chat whose contact shared a Nostr identity,
 * asks for the profile's own Nostr keys. `views()` counted each proof's chats by reading every chat's ledger once per
 * proof, and the Nostr keys were taken from `views()`: chats x proofs ledger reads per chat, so each state grew with
 * the square of the chats. Each chat's ledger is now read once per `views()`, and the own keys read no ledger.
 */
const hex = (n: number) => n.toString(16).padStart(64, "0");
const PROOFS = 5, CHATS = 10;

async function profile() {
  const proofs: StoredIdentityProof[] = Array.from({ length: PROOFS }, (_, i) => {
    const provider = i % 2 ? "fake-key" : "nostr";
    const { binding } = newIdentityBinding({ provider, subject: hex(i + 1), validitySeconds: 86_400 });
    return { binding, evidence: null, seed: {} as StoredIdentityProof["seed"], verified: { subject: hex(i + 1), source: "test" }, createdAt: i };
  });
  const ids = proofs.map(p => identityStatement(p.binding).id);
  // Chat c shares every proof; how far each got varies, and only some count as shared with the contact.
  const statuses: SharedIdentity["status"][] = ["accepted", "pending", "queued", "rejected", "withdrawal-pending", "withdrawn"];
  const ledgers = new Map<string, IdentityLedger>();
  for (let c = 0; c < CHATS; c++) {
    ledgers.set(`chat${c}`, { ...emptyIdentityLedger(), shared: ids.map((id, i) => ({ id, provider: "x", subject: "x", status: statuses[(c + i) % statuses.length], at: 1 })) });
  }
  await transact([STORES.settings], stores => { stores[STORES.settings].put(proofs, "identityProofs"); stores[STORES.settings].put([], "identityRevocations"); });
  let reads = 0;
  const engine = new IdentityProofs({
    ledger: linkId => { reads++; return ledgers.get(linkId); },
    updateLedger: async () => emptyIdentityLedger(), channel: () => undefined, keys: () => ({}),
    // One chat that is not paired: no ledger.
    linkIds: () => [...ledgers.keys(), "plain"], online: () => false, emit: () => {},
    publish: async () => {}, resolve: async () => null,
  }, () => []);
  await engine.load();
  return { engine, ids, ledgers, reads: () => reads, reset: () => { reads = 0; } };
}

it("builds the profile's proofs reading each chat's ledger once, counting the same chats as before", async () => {
  const { engine, ids, ledgers, reads, reset } = await profile();
  reset();
  const views = engine.views();
  expect(reads()).toBe(CHATS + 1);
  const counted = (id: string) => [...ledgers.values()].filter(l => l.shared.some(s => s.id === id && ["accepted", "pending", "queued"].includes(s.status))).length;
  expect(views.map(v => [v.id, v.sharedWith])).toEqual(ids.map(id => [id, counted(id)]));
  expect(views.some(v => v.sharedWith > 0 && v.sharedWith < CHATS)).toBe(true);
});

it("gives the profile's own keys of one kind without reading any chat's ledger", async () => {
  const { engine, reads, reset } = await profile();
  reset();
  expect(engine.subjects("nostr")).toEqual([hex(1), hex(3), hex(5)]);
  expect(engine.subjects("nostr")).toEqual(engine.views().filter(v => v.provider === "nostr").map(v => v.subject));
  reset();
  for (let chat = 0; chat < 100; chat++) engine.subjects("nostr");
  expect(reads()).toBe(0);
});
