import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity, emptyIdentityLedger, identityFromSeed, identityStatement, type IdentityDisplay, type IdentityLedger } from "@ghostly/core";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import { IdentityProofs, type IdentityLinkHost } from "../src/engine/identities";
import { fakeKey, fakeKeySign, fakeKeySubject } from "../src/proofs/testing";
import type { IdentityProofProvider } from "../src/proofs/contract";

// The proof-key seed is sealed with a 600k-iteration PBKDF2 key (identityEngine.test.ts checks that);
// here a cheap reversible seal keeps the tests fast. It still round-trips through storage.
vi.mock("../src/engine/paymentAdapters/persistence", async importOriginal => {
  const real = await importOriginal<typeof import("../src/engine/paymentAdapters/persistence")>();
  const mix = (bytes: Uint8Array, password: string) => bytes.map((b, i) => b ^ password.charCodeAt(i % password.length));
  return {
    ...real,
    sealSeed: async (seed: string, password: string) => ({ version: 1, salt: [], iv: [], ciphertext: [...mix(new TextEncoder().encode(seed), password)] }),
    unsealSeed: async (sealed: { ciphertext: number[] }, password: string) => new TextDecoder().decode(mix(new Uint8Array(sealed.ciphertext), password)),
  };
});

/**
 * Identity proofs in the engine beyond sharing (test/identityEngine.test.ts): drafts and limits, what
 * happens offline, revocations that outlive a restart and expire, rechecks, the public profile lookup,
 * and what the chat view shows once the contact's key changed.
 */

type Me = "a" | "b";
function pair() {
  const keys = { a: createIdentity().pubKeyZ32, b: createIdentity().pubKeyZ32 };
  const ledgers: Record<Me, IdentityLedger> = { a: emptyIdentityLedger(), b: emptyIdentityLedger() };
  const state = { connected: true, online: true, theirs: {} as Partial<Record<Me, string>>, providers: { a: [fakeKey], b: [fakeKey] } as Record<Me, IdentityProofProvider[]> };
  const pkarr = new Map<string, { label: string; value: string }[]>();
  const resolved: string[] = [];
  const engines = {} as Record<Me, IdentityProofs>;
  const host = (me: Me): IdentityLinkHost => {
    const them: Me = me === "a" ? "b" : "a";
    return {
      // Only "chat" is a paired chat.
      ledger: linkId => linkId === "chat" ? ledgers[me] : undefined,
      updateLedger: async (_id, change) => (ledgers[me] = change(structuredClone(ledgers[me]))),
      channel: linkId => linkId === "chat" && state.connected ? {
        scope: () => ({ subject: keys[me], audience: keys[them], context: "c".repeat(64), session: "s".repeat(64) }),
        send: frame => queueMicrotask(() => void engines[them].frame("chat", structuredClone(frame) as Record<string, unknown>)),
      } : undefined,
      keys: () => ({ mine: keys[me], theirs: state.theirs[me] ?? keys[them] }),
      linkIds: () => ["chat", "plain"], online: () => state.online, emit: vi.fn(),
      publish: async (seed, records) => { pkarr.set(identityFromSeed(seed).pubKeyZ32, records); },
      resolve: async key => { resolved.push(key); return pkarr.get(key) ?? null; },
    };
  };
  const make = (me: Me) => new IdentityProofs(host(me), () => state.providers[me]);
  engines.a = make("a"); engines.b = make("b");
  return { engines, ledgers, state, pkarr, resolved, make };
}

async function clearStorage() {
  await transact([STORES.settings], stores => { stores[STORES.settings].delete("identityProofs"); stores[STORES.settings].delete("identityRevocations"); });
}
const stored = async <T,>(key: string) => wrap<T | undefined>((await store(STORES.settings, "readonly")).get(key));

async function prove(engine: IdentityProofs, validityDays?: number) {
  const { draftId, binding } = engine.begin({ provider: "fake-key", subject: fakeKeySubject(), validityDays });
  const view = await engine.complete({ draftId, evidence: fakeKeySign(identityStatement(binding)) });
  return { id: view.id, binding };
}
/** A proves an identity and shares it with B, who verifies it. */
async function shared() {
  const p = pair();
  await clearStorage();
  await p.engines.a.load(); await p.engines.b.load();
  const proof = await prove(p.engines.a);
  await p.engines.a.share({ linkId: "chat", id: proof.id });
  await vi.waitFor(() => expect(p.ledgers.b.received.find(r => r.id === proof.id)?.status).toBe("verified"));
  return { ...p, ...proof };
}

afterEach(() => { vi.useRealTimers(); });

describe("adding a proof: drafts and limits", () => {
  it("a draft is used once, dropped when cancelled or too old, and only four wait at once", async () => {
    const { engines } = pair();
    await clearStorage(); await engines.a.load();
    const first = engines.a.begin({ provider: "fake-key", subject: fakeKeySubject() });
    for (let i = 0; i < 4; i++) engines.a.begin({ provider: "fake-key", subject: fakeKeySubject() });
    await expect(engines.a.complete({ draftId: first.draftId, evidence: fakeKeySign(identityStatement(first.binding)) })).rejects.toThrow(/started too long ago/);

    const cancelled = engines.a.begin({ provider: "fake-key", subject: fakeKeySubject() });
    engines.a.cancel({ draftId: cancelled.draftId });
    await expect(engines.a.complete({ draftId: cancelled.draftId, evidence: fakeKeySign(identityStatement(cancelled.binding)) })).rejects.toThrow(/started too long ago/);

    vi.useFakeTimers({ toFake: ["Date"] });
    const old = engines.a.begin({ provider: "fake-key", subject: fakeKeySubject() });
    vi.setSystemTime(Date.now() + 31 * 60_000);
    engines.a.begin({ provider: "fake-key", subject: fakeKeySubject() });
    await expect(engines.a.complete({ draftId: old.draftId, evidence: fakeKeySign(identityStatement(old.binding)) })).rejects.toThrow(/started too long ago/);
    expect(engines.a.views()).toEqual([]);
  });

  it("a profile holds at most 32 proofs", async () => {
    const { engines, make } = pair();
    await clearStorage(); await engines.a.load();
    await prove(engines.a);
    const one = (await stored<unknown[]>("identityProofs"))![0];
    await transact([STORES.settings], stores => { stores[STORES.settings].put(Array.from({ length: 32 }, () => one), "identityProofs"); });
    const full = make("a");
    await full.load();
    await expect(prove(full)).rejects.toThrow(/Remove an identity first/);
    expect(full.views()).toHaveLength(32);
  });
});

describe("removing a proof and its revocation", () => {
  it("a proof never shared is removed without publishing anything; an unknown id changes nothing", async () => {
    const { engines, pkarr } = pair();
    await clearStorage(); await engines.a.load();
    const { id } = await prove(engines.a);
    await engines.a.remove({ id: "f".repeat(64) });
    expect(engines.a.views()).toHaveLength(1);
    await engines.a.remove({ id });
    expect(engines.a.views()).toEqual([]);
    expect(pkarr.size).toBe(0);
    expect(await stored("identityRevocations")).toEqual([]);
  });

  it("removed offline after a restart: the revocation is published from the sealed key once online, and dropped once the proof would have expired", async () => {
    const { ledgers, state, pkarr, make, id, binding } = await shared();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // A new run: the proof key's seed is only in storage, sealed.
    const again = make("a");
    await again.load();
    state.online = false; state.connected = false;
    await again.remove({ id });
    expect(ledgers.a.shared.find(s => s.id === id)?.status).toBe("withdrawal-pending");
    expect(pkarr.size).toBe(0);
    expect(await stored<{ id: string }[]>("identityRevocations")).toEqual([expect.objectContaining({ id, key: binding.key })]);

    state.online = true;
    again.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(pkarr.get(binding.key)?.[0]).toMatchObject({ label: "_ghostly-revoked", value: expect.stringContaining(id) }));

    // Thirty-one days on (the proof lived thirty), the next republish drops it.
    pkarr.clear();
    vi.setSystemTime(Date.now() + 31 * 86_400_000);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await vi.waitFor(async () => expect(await stored("identityRevocations")).toEqual([]));
    expect(pkarr.size).toBe(0);
    again.stop();
  });

  it("revocations are looked up only online, and only for proofs still standing", async () => {
    const { engines, ledgers, state, resolved, id } = await shared();
    state.online = false;
    resolved.length = 0;
    await engines.b.checkRevocations();
    expect(resolved).toEqual([]);
    state.online = true;
    ledgers.b = { ...ledgers.b, received: ledgers.b.received.map(r => r.id === id ? { ...r, status: "withdrawn" } : r) };
    await engines.b.checkRevocations();
    expect(resolved).toEqual([]);
    ledgers.b = { ...ledgers.b, received: ledgers.b.received.map(r => r.id === id ? { ...r, status: "verified" } : r) };
    await engines.b.checkRevocations();
    expect(resolved).toHaveLength(1);
  });
});

describe("per chat", () => {
  it("shares only in paired chats and only a proof still in the profile; elsewhere withdraw and frames do nothing", async () => {
    const { engines, ledgers, id } = await shared();
    await expect(engines.a.share({ linkId: "plain", id })).rejects.toThrow(/paired chats only/);
    await expect(engines.a.share({ linkId: "chat", id: "e".repeat(64) })).rejects.toThrow(/no longer in your profile/);
    await engines.a.withdraw({ linkId: "plain", id });
    await engines.a.frame("plain", { t: "idp-withdraw", id });
    expect(engines.a.linkView("plain", true)).toBeUndefined();
    await engines.a.withdraw({ linkId: "chat", id });
    await vi.waitFor(() => expect(ledgers.a.shared.find(s => s.id === id)?.status).toBe("withdrawn"));
    expect(engines.b.linkView("chat", true)!.received[0].status).toBe("withdrawn");
    expect(engines.a.views()[0].sharedWith).toBe(0);
  });

  it("a recheck is refused offline, and a proof that no longer verifies shows unconfirmed with the reason", async () => {
    const { engines, state } = await shared();
    const id = engines.b.linkView("chat", true)!.received[0].id;
    state.online = false;
    await expect(engines.b.recheck({ linkId: "chat", id })).rejects.toThrow(/Offline/);
    state.online = true;
    state.providers.b = [{ ...fakeKey, verify: async () => { throw new Error("the key was rotated"); } } as IdentityProofProvider];
    await engines.b.recheck({ linkId: "chat", id });
    expect(engines.b.linkView("chat", true)!.received[0]).toMatchObject({ status: "unconfirmed", error: "the key was rotated" });
  });

  it("the public profile is looked up only on request, online, from a provider that has one", async () => {
    const { engines, ledgers, state } = await shared();
    const id = engines.b.linkView("chat", true)!.received[0].id;
    await expect(engines.b.lookupDisplay({ linkId: "chat", id: "0".repeat(64) })).rejects.toThrow(/No public profile for this identity/);
    await expect(engines.b.lookupDisplay({ linkId: "chat", id })).rejects.toThrow(/No public profile for this identity/);
    const found: { display?: IdentityDisplay } = {};
    const lookup = vi.fn(async () => found.display);
    state.providers.b = [{ ...fakeKey, lookupDisplay: lookup } as IdentityProofProvider];
    state.online = false;
    await expect(engines.b.lookupDisplay({ linkId: "chat", id })).rejects.toThrow(/Offline/);
    expect(lookup).not.toHaveBeenCalled();
    state.online = true;
    await expect(engines.b.lookupDisplay({ linkId: "chat", id })).rejects.toThrow(/No public profile found/);
    found.display = { name: "Alice", source: "Test directory", fetchedAt: 1 };
    await engines.b.lookupDisplay({ linkId: "chat", id });
    expect(lookup).toHaveBeenCalledWith(fakeKeySubject(), expect.anything());
    expect(ledgers.b.received[0].display).toEqual(found.display);
    expect(engines.b.linkView("chat", true)!.received[0].display).toEqual(found.display);
  });

  it("a proof received under the contact's previous key is shown as such, not verified", async () => {
    const { engines, state } = await shared();
    expect(engines.b.linkView("chat", true)!.received[0].status).toBe("verified");
    state.theirs.b = createIdentity().pubKeyZ32;
    expect(engines.b.linkView("chat", true)!.received[0].status).toBe("previous-key");
  });

  it("a recheck is due only for providers that ask for one, once their interval passed", async () => {
    const { engines, state } = await shared();
    expect(engines.b.linkView("chat", true)!.received[0].recheckDue).toBe(false);
    state.providers.b = [{ ...fakeKey, recheck: { afterSeconds: 3600 } } as IdentityProofProvider];
    expect(engines.b.linkView("chat", true)!.received[0].recheckDue).toBe(false);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    expect(engines.b.linkView("chat", true)!.received[0].recheckDue).toBe(true);
  });

  it("what the contact verifies is shown only where identities are supported, and forgotten with the chat", async () => {
    const { engines } = await shared();
    engines.b.ready("chat");
    await vi.waitFor(() => expect(engines.a.linkView("chat", true)!.contactProviders).toEqual(["fake-key"]));
    expect(engines.a.linkView("chat", false)!.contactProviders).toBeUndefined();
    engines.a.forget("chat");
    expect(engines.a.linkView("chat", true)!.contactProviders).toBeUndefined();
  });
});
