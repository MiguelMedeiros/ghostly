import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from "vitest";
import { createIdentity, emptyIdentityLedger, identityFromSeed, identityStatement, IdentityExchange, type IdentityLedger } from "@ghostly/core";
import { STORES, store, wrap } from "../src/shared/idb";

const createIdentityFromSeed = (seed: Uint8Array) => identityFromSeed(seed).pubKeyZ32;
import { IdentityProofs, type IdentityLinkHost } from "../src/engine/identities";
import { fakeKey, fakeKeySign, fakeKeySubject, fakeRecord } from "../src/proofs/testing";
import type { IdentityProofProvider } from "../src/proofs/contract";

/** Two engines' identity modules joined by an in-memory channel, the way two paired chats are. */
function pair() {
  const keys = { a: createIdentity().pubKeyZ32, b: createIdentity().pubKeyZ32 };
  const ledgers: Record<string, IdentityLedger> = { a: emptyIdentityLedger(), b: emptyIdentityLedger() };
  const connected = { value: true };
  /** Pkarr: key → records, as a relay would keep them (the signature is the publisher's, by construction). */
  const pkarr = new Map<string, { label: string; value: string }[]>();
  const engines: Record<string, IdentityProofs> = {};
  const host = (me: "a" | "b"): IdentityLinkHost => {
    const them = me === "a" ? "b" : "a";
    return {
      ledger: () => ledgers[me],
      updateLedger: async (_id, change) => (ledgers[me] = change(structuredClone(ledgers[me]))),
      channel: () => connected.value ? {
        scope: () => ({ subject: keys[me], audience: keys[them], context: "c".repeat(64), session: "s".repeat(64) }),
        send: frame => queueMicrotask(() => void engines[them].frame("chat", structuredClone(frame) as Record<string, unknown>)),
      } : undefined,
      keys: () => ({ mine: keys[me], theirs: keys[them] }),
      linkIds: () => ["chat"], online: () => true, emit: vi.fn(),
      publish: async (seed, records) => { pkarr.set(createIdentityFromSeed(seed), records); },
      resolve: async key => pkarr.get(key) ?? null,
    };
  };
  const providers = () => [fakeKey, fakeRecord] as IdentityProofProvider[];
  engines.a = new IdentityProofs(host("a"), providers);
  engines.b = new IdentityProofs(host("b"), providers);
  return { engines, ledgers, connected, pkarr };
}

describe("identity proofs in the engine", () => {
  it("verifies before saving: a bad signature is refused and nothing is stored", async () => {
    const { engines } = pair();
    await engines.a.load();
    const { draftId, binding } = engines.a.begin({ provider: "fake-key", subject: fakeKeySubject().toUpperCase() });
    expect(binding.subject).toBe(fakeKeySubject());
    await expect(engines.a.complete({ draftId, evidence: { sig: "A".repeat(86) } })).rejects.toThrow(/Invalid test signature/);
    expect(engines.a.views()).toEqual([]);
    const view = await engines.a.complete({ draftId, evidence: fakeKeySign(identityStatement(binding)) });
    expect(view).toMatchObject({ provider: "fake-key", subject: fakeKeySubject(), sharedWith: 0, verified: { source: "Test signature (Ed25519)" } });
    expect(JSON.stringify(engines.a.views())).not.toContain("seed");
  });

  it("refuses unknown providers, bad subjects and validity beyond the provider's limit", () => {
    const { engines } = pair();
    expect(() => engines.a.begin({ provider: "nope", subject: "x" })).toThrow(/Unknown/);
    expect(() => engines.a.begin({ provider: "fake-key", subject: "not hex" })).toThrow(/hex/);
    expect(() => engines.a.begin({ provider: "fake-key", subject: fakeKeySubject(), validityDays: 366 })).toThrow(/between 1 and 365/);
  });

  it("shares with the contact, who sees it verified; removing it from the profile withdraws it, and it persists across restarts", async () => {
    const { engines, ledgers } = pair();
    await engines.a.load();
    for (const p of engines.a.views()) await engines.a.remove({ id: p.id });
    const { draftId, binding } = engines.a.begin({ provider: "fake-key", subject: fakeKeySubject() });
    const { id } = await engines.a.complete({ draftId, evidence: fakeKeySign(identityStatement(binding)) });
    await engines.a.share({ linkId: "chat", id });
    await vi.waitFor(() => expect(ledgers.a.shared[0]?.status).toBe("accepted"));
    expect(engines.a.views()[0].sharedWith).toBe(1);
    expect(engines.b.linkView("chat", true)!.received[0]).toMatchObject({ id, status: "verified", subject: fakeKeySubject(), recheckDue: false });
    const restarted = new IdentityProofs({ ...({} as IdentityLinkHost), ledger: () => ledgers.a, linkIds: () => [], online: () => true, emit: vi.fn(), channel: () => undefined, keys: () => ({}), updateLedger: async () => ledgers.a, publish: async () => {}, resolve: async () => null });
    await restarted.load();
    expect(restarted.views().map(v => v.id)).toEqual([id]);
    await engines.a.remove({ id });
    await vi.waitFor(() => expect(ledgers.a.shared[0].status).toBe("withdrawn"));
    expect(engines.b.linkView("chat", true)!.received[0].status).toBe("withdrawn");
    expect(engines.a.views()).toEqual([]);
  });

  it("refuses to share an expired proof", async () => {
    const { engines } = pair();
    await engines.a.load();
    for (const p of engines.a.views()) await engines.a.remove({ id: p.id });
    const { draftId, binding } = engines.a.begin({ provider: "fake-key", subject: fakeKeySubject(), validityDays: 1 });
    const { id } = await engines.a.complete({ draftId, evidence: fakeKeySign(identityStatement(binding)) });
    vi.useFakeTimers({ now: Date.now() + 2 * 86_400_000 });
    try { await expect(engines.a.share({ linkId: "chat", id })).rejects.toThrow(/expired/); }
    finally { vi.useRealTimers(); }
  });

  it("greets once per connection however often the channel reports ready, and again after a reconnect", async () => {
    const { engines, connected } = pair();
    const sent: string[] = [];
    const spy = vi.spyOn(IdentityExchange.prototype, "ready").mockImplementation(function () { sent.push("hello"); });
    try {
      engines.a.ready("chat"); engines.a.ready("chat"); engines.a.ready("chat");
      expect(sent).toHaveLength(1);
      engines.a.closed("chat");
      connected.value = false;
      engines.a.ready("chat");
      expect(sent).toHaveLength(1);
      connected.value = true;
      engines.a.ready("chat");
      expect(sent).toHaveLength(2);
    } finally { spy.mockRestore(); }
  });

  it("keeps proof-key seeds sealed at rest, never in plain text", async () => {
    const { engines } = pair();
    await engines.a.load();
    for (const p of engines.a.views()) await engines.a.remove({ id: p.id });
    const { draftId, binding } = engines.a.begin({ provider: "fake-key", subject: fakeKeySubject() });
    await engines.a.complete({ draftId, evidence: fakeKeySign(identityStatement(binding)) });
    const stored = await wrap<{ seed: { sealed: { ciphertext: number[] }; deviceKey: string } }[]>((await store(STORES.settings, "readonly")).get("identityProofs"));
    expect(stored.at(-1)!.seed.sealed.ciphertext.length).toBeGreaterThan(32);
    expect(stored.at(-1)!.seed.deviceKey).toMatch(/^[A-Za-z0-9+/]{40,}$/);
  });

  it("removing a shared proof publishes a revocation under its proof key; the contact finds it without reconnecting", async () => {
    const { engines, ledgers, connected, pkarr } = pair();
    await engines.a.load();
    for (const p of engines.a.views()) await engines.a.remove({ id: p.id });
    const { draftId, binding } = engines.a.begin({ provider: "fake-key", subject: fakeKeySubject() });
    const { id } = await engines.a.complete({ draftId, evidence: fakeKeySign(identityStatement(binding)) });
    await engines.a.share({ linkId: "chat", id });
    await vi.waitFor(() => expect(ledgers.b.received.find(r => r.id === id)?.status).toBe("verified"));
    connected.value = false;
    await engines.a.remove({ id });
    await vi.waitFor(() => expect(pkarr.get(binding.key)?.[0]).toMatchObject({ label: "_ghostly-revoked", value: expect.stringContaining(id) }));
    expect(ledgers.b.received.find(r => r.id === id)?.status).toBe("verified");
    await engines.b.checkRevocations();
    expect(engines.b.linkView("chat", false)!.received.find(r => r.id === id)!.status).toBe("revoked");
  });
});
