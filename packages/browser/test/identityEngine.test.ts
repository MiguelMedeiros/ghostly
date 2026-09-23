import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from "vitest";
import { createIdentity, emptyIdentityLedger, identityStatement, type IdentityLedger } from "@ghostly/core";
import { IdentityProofs, type IdentityLinkHost } from "../src/engine/identities";
import { fakeKey, fakeKeySign, fakeKeySubject, fakeRecord } from "../src/proofs/testing";
import type { IdentityProofProvider } from "../src/proofs/contract";

/** Two engines' identity modules joined by an in-memory channel, the way two paired chats are. */
function pair() {
  const keys = { a: createIdentity().pubKeyZ32, b: createIdentity().pubKeyZ32 };
  const ledgers: Record<string, IdentityLedger> = { a: emptyIdentityLedger(), b: emptyIdentityLedger() };
  const connected = { value: true };
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
    };
  };
  const providers = () => [fakeKey, fakeRecord] as IdentityProofProvider[];
  engines.a = new IdentityProofs(host("a"), providers);
  engines.b = new IdentityProofs(host("b"), providers);
  return { engines, ledgers, connected };
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
    const restarted = new IdentityProofs({ ...({} as IdentityLinkHost), ledger: () => ledgers.a, linkIds: () => [], online: () => true, emit: vi.fn(), channel: () => undefined, keys: () => ({}), updateLedger: async () => ledgers.a });
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
});
