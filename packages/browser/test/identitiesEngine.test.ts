import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIdentity, DiscoveryBudgetError, emptyIdentityLedger, identityFromSeed, identityRevocationValue, identityStatement, IDENTITY_REVOCATION_LABEL, newIdentityBinding,
  type IdentityDisplay, type IdentityLedger, type VerifiedIdentity,
} from "@ghostly/core";
import { STORES, clearProfileStores, store, transact, wrap } from "../src/shared/idb";
import { IdentityProofs, type IdentityLinkHost } from "../src/engine/identities";
import { fakeKey, fakeKeySign, fakeKeySubject } from "../src/proofs/testing";
import type { IdentityProofProvider } from "../src/proofs/contract";
// covers: proofs.revoke, proofs.expiry, proofs.recheck, proofs.binding, profiles.public

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
  const state = { connected: true, online: true, theirs: {} as Partial<Record<Me, string>>, providers: { a: [fakeKey], b: [fakeKey] } as Record<Me, IdentityProofProvider[]>,
    /** Chats deleted on that side: gone from its list, with their ledger. */
    deleted: {} as Partial<Record<Me, boolean>>,
    /** Settings → Hide my IP from contacts, on that side. */
    relayOnly: {} as Partial<Record<Me, boolean>>,
    /** No Pkarr relay answers: a lookup throws. */
    relaysDown: false };
  const pkarr = new Map<string, { label: string; value: string }[]>();
  const resolved: string[] = [];
  const engines = {} as Record<Me, IdentityProofs>;
  const host = (me: Me): IdentityLinkHost => {
    const them: Me = me === "a" ? "b" : "a";
    return {
      // Only "chat" is a paired chat.
      ledger: linkId => linkId === "chat" && !state.deleted[me] ? ledgers[me] : undefined,
      updateLedger: async (_id, change) => (ledgers[me] = change(structuredClone(ledgers[me]))),
      channel: linkId => linkId === "chat" && state.connected ? {
        scope: () => ({ subject: keys[me], audience: keys[them], context: "c".repeat(64), session: "s".repeat(64) }),
        send: frame => queueMicrotask(() => void engines[them].frame("chat", structuredClone(frame) as Record<string, unknown>)),
      } : undefined,
      keys: () => ({ mine: keys[me], theirs: state.theirs[me] ?? keys[them] }),
      linkIds: () => state.deleted[me] ? ["plain"] : ["chat", "plain"], online: () => state.online, emit: vi.fn(),
      relayOnly: () => !!state.relayOnly[me],
      publish: async (seed, records) => { pkarr.set(identityFromSeed(seed).pubKeyZ32, records); },
      resolve: async key => { resolved.push(key); if (state.relaysDown) throw new Error("No relay answered"); return pkarr.get(key) ?? null; },
    };
  };
  const make = (me: Me) => new IdentityProofs(host(me), () => state.providers[me]);
  engines.a = make("a"); engines.b = make("b");
  return { engines, ledgers, state, pkarr, resolved, make };
}

async function clearStorage() {
  await transact([STORES.settings], stores => { stores[STORES.settings].delete("identityProofs"); stores[STORES.settings].delete("identityRevocations"); stores[STORES.settings].delete("identityRevocationsCheckedAt"); });
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

  /**
   * A check takes up to 30 s (a domain's DNS, a provider's server), and Identities → Add → "Close without saving?" cancels
   * the draft meanwhile: the check went on and saved the proof anyway, its proof key sealed after the cancel zeroed it.
   */
  it("a draft cancelled while its evidence is being checked saves nothing", async () => {
    const { engines, state } = pair();
    await clearStorage(); await engines.a.load();
    let checked!: () => void;
    const gate = new Promise<void>(resolve => { checked = resolve; });
    state.providers.a = [{ ...fakeKey, verify: async (statement, evidence, ctx) => { await gate; return fakeKey.verify(statement, evidence, ctx); } }];
    const { draftId, binding } = engines.a.begin({ provider: "fake-key", subject: fakeKeySubject() });
    const completing = engines.a.complete({ draftId, evidence: fakeKeySign(identityStatement(binding)) });
    await Promise.resolve();
    engines.a.cancel({ draftId });
    checked();
    await expect(completing).rejects.toThrow(/started too long ago/);
    expect(engines.a.views()).toEqual([]);
    expect(await stored("identityProofs")).toBeUndefined();
  });

  /**
   * A daemon's `identity add` (or another window's Add) still checking when "Clear all data" comes: the check went on,
   * and its save wrote every proof the cleared profile had, with its sealed key, back under `identityProofs`.
   */
  it("a proof whose check ends after Clear all data saves nothing into the cleared profile", async () => {
    const { engines, state, make } = await shared();
    let checked!: () => void;
    const gate = new Promise<void>(resolve => { checked = resolve; });
    state.providers.a = [{ ...fakeKey, verify: async (statement, evidence, ctx) => { await gate; return fakeKey.verify(statement, evidence, ctx); } }];
    const { draftId, binding } = engines.a.begin({ provider: "fake-key", subject: fakeKeySubject() });
    const completing = engines.a.complete({ draftId, evidence: fakeKeySign(identityStatement(binding)) }).then(() => "saved", () => "refused");
    await engines.a.revokeAll();
    await clearProfileStores();
    checked();
    const outcome = await completing;
    expect((await stored<{ binding: unknown }[]>("identityProofs"))?.length, "the cleared profile has no proofs").toBeUndefined();
    expect(outcome).toBe("refused");
    const next = make("a");
    await next.load();
    expect(next.views()).toEqual([]);
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

  /**
   * Each change saved the list as it stood before the one still being written: two proofs completed at once kept one,
   * and a proof removed while another completed came back, its revocation gone from the profile.
   */
  it("keeps every change made at once: two proofs completed, one removed while another completes", async () => {
    const { engines, ledgers, make } = await shared();
    const draft = () => { const { draftId, binding } = engines.a.begin({ provider: "fake-key", subject: fakeKeySubject() }); return { draftId, evidence: fakeKeySign(identityStatement(binding)) }; };
    const removed = engines.a.views()[0].id;
    expect(ledgers.a.shared.map(s => s.id)).toEqual([removed]);

    const [, added] = await Promise.all([engines.a.remove({ id: removed }), engines.a.complete(draft())]);
    const [two, three] = await Promise.all([engines.a.complete(draft()), engines.a.complete(draft())]);
    const ids = [added.id, two.id, three.id].sort();
    expect(engines.a.views().map(v => v.id).sort()).toEqual(ids);
    expect((await stored<{ binding: unknown }[]>("identityProofs"))!.map(p => identityStatement(p.binding as never).id).sort()).toEqual(ids);
    expect((await stored<{ id: string }[]>("identityRevocations"))!.map(r => r.id)).toEqual([removed]);

    const again = make("a");
    await again.load();
    expect(again.views().map(v => v.id).sort()).toEqual(ids);
  });
});

describe("removing a proof and its revocation", () => {
  it("clearing the profile's data revokes every proof ever shared, once, and none that never left the device", async () => {
    const { engines, pkarr, binding } = await shared();
    const kept = await prove(engines.a);
    pkarr.clear();
    await engines.a.revokeAll();
    expect([...pkarr.keys()], "the shared proof's key, not the other").toHaveLength(1);
    const records = [...pkarr.values()][0];
    expect(records[0].label).toBe("_ghostly-revoked");
    expect(records[0].value).toContain(`id=${identityStatement(binding).id}`);
    expect(records.some((r) => r.value.includes(kept.id))).toBe(false);
  });

  /** The chat went with its ledger, so no chat listed the proof as shared: nothing was revoked and the contact kept it verified. */
  it("a proof shared in a chat deleted since is still revoked when removed, after a restart too, and at Clear all data", async () => {
    const { engines, state, pkarr, make, id, binding } = await shared();
    state.deleted.a = true;
    engines.a.forget("chat");
    // A new run: what the proof went through is only in storage.
    const again = make("a");
    await again.load();
    await again.remove({ id });
    await vi.waitFor(() => expect(pkarr.get(binding.key)?.[0]).toMatchObject({ label: "_ghostly-revoked", value: expect.stringContaining(id) }));
    expect(await stored<{ id: string }[]>("identityRevocations")).toEqual([expect.objectContaining({ id })]);
    await engines.b.checkRevocations();
    expect(engines.b.linkView("chat", true)!.received[0].status).toBe("revoked");

    const other = await prove(again);
    state.deleted.a = false;
    await again.share({ linkId: "chat", id: other.id });
    state.deleted.a = true;
    pkarr.clear();
    await again.revokeAll();
    expect([...pkarr.keys()].sort()).toEqual([binding.key, other.binding.key].sort());
  });

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

  it("revocations are looked up only online, for proofs standing or withdrawn, never for one revoked or expired", async () => {
    const { engines, ledgers, state, resolved, id } = await shared();
    const setStatus = (status: "verified" | "withdrawn" | "revoked") =>
      (ledgers.b = { ...ledgers.b, received: ledgers.b.received.map(r => r.id === id ? { ...r, status } : r) });
    state.online = false;
    resolved.length = 0;
    await engines.b.checkRevocations();
    expect(resolved).toEqual([]);
    state.online = true;
    // Withdrawn: a removal also revokes it (WISP 300), so it is looked up too.
    setStatus("withdrawn");
    await engines.b.checkRevocations();
    expect(resolved).toHaveLength(1);
    setStatus("verified");
    await engines.b.checkRevocations();
    expect(resolved).toHaveLength(2);
    setStatus("revoked");
    await engines.b.checkRevocations();
    expect(resolved).toHaveLength(2);
    // Past its expiry its owner no longer publishes a revocation: nothing to find.
    setStatus("withdrawn");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31 * 86_400_000);
    await engines.b.checkRevocations();
    expect(resolved).toHaveLength(2);
  });

  it("the 12 h between revocation lookups is kept across a restart: a reload minutes after one reads nothing until it is due", async () => {
    const { state, resolved, make } = await shared();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    state.connected = false;
    const run = async () => { const b = make("b"); await b.load(); b.start(); return b; };
    resolved.length = 0;
    // Never checked: 60 s after the start, as before.
    const first = await run();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(resolved).toHaveLength(1));
    first.stop();

    // Reloaded five minutes later: no lookup at 60 s, nor until 12 h after the last one.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const second = await run();
    await vi.advanceTimersByTimeAsync(11 * 60 * 60_000);
    expect(resolved).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(56 * 60_000);
    await vi.waitFor(() => expect(resolved).toHaveLength(2));
    second.stop();

    // Offline at the due time looks up nothing and keeps it due: the next start checks 60 s in.
    state.online = false;
    await vi.advanceTimersByTimeAsync(13 * 60 * 60_000);
    const offline = await run();
    await vi.advanceTimersByTimeAsync(60_000);
    offline.stop();
    state.online = true;
    const third = await run();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(resolved).toHaveLength(3));
    third.stop();
  });

  /** Offline at the 60 s lookup and online right after: the next lookup came 12 h later. */
  it("a revocation lookup missed offline runs when the network comes back, not 12 h later", async () => {
    const { state, resolved, make } = await shared();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    state.connected = false; state.online = false;
    const b = make("b");
    await b.load(); b.start();
    resolved.length = 0;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(resolved).toEqual([]);
    state.online = true;
    b.networkBack();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolved).toHaveLength(1);
    expect(await stored("identityRevocationsCheckedAt")).toBeTypeOf("number");
    b.stop();
  });

  /**
   * No relay answered the lookup, yet its time was saved: once the owner removed the proof and the relays were back, the
   * contact's restarted app looked nothing up for 12 h and showed the proof verified.
   */
  it("a revocation lookup no relay answered is not noted as done: tried again soon, and at the next start", async () => {
    const { engines, state, resolved, make, id } = await shared();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    state.connected = false; state.relaysDown = true;
    const b = make("b");
    await b.load(); b.start();
    resolved.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolved).toHaveLength(1);
    expect(await stored("identityRevocationsCheckedAt"), "a failed lookup is not a lookup made").toBeUndefined();
    // Tried again within minutes, backing off while the relays stay down.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(resolved).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(resolved).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(resolved).toHaveLength(3);
    b.stop();

    // The owner removes the proof meanwhile; the relays are back, and the contact's app restarts.
    await engines.a.remove({ id });
    state.relaysDown = false;
    const again = make("b");
    await again.load(); again.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(again.linkView("chat", true)!.received[0].status).toBe("revoked"));
    expect(await stored("identityRevocationsCheckedAt")).toBeTypeOf("number");
    again.stop();
  });

  /** Removed while offline mid-run: the revocation went out only at the next hourly republish, up to an hour after the network came back. */
  it("a revocation that could not be published offline is published when the network comes back", async () => {
    const { state, pkarr, make, id, binding } = await shared();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    state.connected = false;
    const a = make("a");
    await a.load(); a.start();
    await vi.advanceTimersByTimeAsync(10_000);
    state.online = false;
    await a.remove({ id });
    expect(pkarr.get(binding.key)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    state.online = true;
    a.networkBack();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pkarr.get(binding.key)?.[0]).toMatchObject({ label: "_ghostly-revoked", value: expect.stringContaining(id) });
    a.stop();
  });

  /**
   * The relays hold a background read back past their minute's share (`DiscoveryBudgetError`, ~45 a minute on the default
   * three): with more of the contacts' proofs than that, the lookup was never noted done. Each retry (5 min, 10, 20…, at
   * every start and every time the network came back) read every proof again and was refused at the same place, so
   * the proofs past it were never looked up: 150 proofs took 709 relay reads in 12 h, and the last 61 none.
   */
  it("a revocation lookup held back by the relays' budget waits for it: every proof looked up once, and the lookup noted done", async () => {
    await clearStorage();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const ledgers = new Map<string, IdentityLedger>();
    for (let i = 0; i < 12; i++) {
      const { binding } = newIdentityBinding({ provider: "fake-key", subject: fakeKeySubject(), validitySeconds: 30 * 86_400 });
      const id = identityStatement(binding).id;
      ledgers.set(`chat${i}`, { ...emptyIdentityLedger(), received: [{ id, binding, evidence: null, verified: { provider: "fake-key", subject: binding.subject } as VerifiedIdentity,
        presenter: "p", audience: "a", context: "c".repeat(64), verifiedAt: 0, checkedAt: 0, status: "verified" }] });
    }
    // The last contact removed its proof: its key holds the revocation.
    const last = ledgers.get("chat11")!.received[0];
    const pkarr = new Map([[last.binding.key, [{ label: IDENTITY_REVOCATION_LABEL, value: identityRevocationValue(last.id, Math.floor(Date.now() / 1000)) }]]]);
    // Five background reads a minute.
    const answered: string[] = [], spent: number[] = [];
    const engine = new IdentityProofs({
      ledger: id => ledgers.get(id), updateLedger: async (id, change) => { ledgers.set(id, change(structuredClone(ledgers.get(id)!))); return ledgers.get(id)!; },
      channel: () => undefined, keys: () => ({}), linkIds: () => [...ledgers.keys()], online: () => true, emit: () => {}, publish: async () => {},
      resolve: async key => {
        const recent = spent.filter(at => Date.now() - at < 60_000);
        if (recent.length >= 5) throw new DiscoveryBudgetError(recent[0] + 60_000 - Date.now());
        spent.push(Date.now());
        answered.push(key);
        return pkarr.get(key) ?? null;
      },
    }, () => [fakeKey]);
    await engine.load(); engine.start();
    await vi.advanceTimersByTimeAsync(12 * 60 * 60_000 - 60_000);
    engine.stop();
    expect(ledgers.get("chat11")!.received[0].status, "the proof past the budget is looked up").toBe("revoked");
    expect(answered, "each proof read once in 12 h").toHaveLength(12);
    expect(new Set(answered).size).toBe(12);
    expect(await stored("identityRevocationsCheckedAt")).toBeTypeOf("number");
  });

  it("a revocation lookup still on its way when the profile's data is cleared does not note its time in the cleared profile", async () => {
    const { engines, pkarr, resolved } = await shared();
    let release: (() => void) | undefined;
    const get = pkarr.get.bind(pkarr);
    // The relays answer the lookup only once the clear is over.
    (pkarr as unknown as { get: (key: string) => unknown }).get = (key: string) => new Promise(resolve => { release = () => resolve(get(key)); });
    resolved.length = 0;
    const check = engines.b.checkRevocations();
    await vi.waitFor(() => expect(release).toBeDefined());
    await engines.b.revokeAll();
    await clearProfileStores();
    release!();
    await check;
    expect(await stored("identityRevocationsCheckedAt"), "the cleared profile has no lookup time").toBeUndefined();
  });

  it("a proof removed while the contact is live: the contact sees it withdrawn at once, then revoked, as a recheck says", async () => {
    const { engines, ledgers, resolved, id } = await shared();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    resolved.length = 0;
    await engines.a.remove({ id });
    await vi.waitFor(() => expect(engines.b.linkView("chat", true)!.received[0].status).toBe("withdrawn"));
    expect(resolved, "not looked up before the owner had time to publish").toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.waitFor(() => expect(engines.b.linkView("chat", true)!.received[0].status).toBe("revoked"));
    // Found on the first try: the later tries do not run.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(resolved).toHaveLength(1);
    // One stop line in the chat, not one for the withdrawal and another for the revocation: it now says revoked.
    expect(ledgers.b.timeline?.filter(e => e.kind === "stopped")).toEqual([expect.objectContaining({ reason: "revoked" })]);
    engines.b.stop();
  });

  it("a proof removed while the contact is still checking it: the contact keeps it withdrawn, not verified, then finds it revoked", async () => {
    const { engines, state, resolved, pkarr } = pair();
    await clearStorage();
    await engines.a.load(); await engines.b.load();
    let checking!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { checking = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    state.providers.b = [{ ...fakeKey, verify: async (statement, evidence, ctx) => { checking(); await gate; return fakeKey.verify(statement, evidence, ctx); } }];
    const { id } = await prove(engines.a);
    await engines.a.share({ linkId: "chat", id });
    await entered;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    resolved.length = 0;
    await engines.a.remove({ id });
    // The relays do not return the owner's revocation yet when the check looks it up.
    const published = [...pkarr];
    pkarr.clear();
    release();
    await vi.waitFor(() => expect(engines.b.linkView("chat", true)!.received.map(r => r.status)).toEqual(["withdrawn"]));
    for (const [key, records] of published) pkarr.set(key, records);
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.waitFor(() => expect(engines.b.linkView("chat", true)!.received[0].status).toBe("revoked"));
    expect(resolved.length, "its revocation looked up after the withdraw").toBeGreaterThan(0);
    engines.b.stop();
  });

  it("a proof only withdrawn from this chat (still in the owner's profile) stays withdrawn, after a few lookups that back off", async () => {
    const { engines, resolved, id } = await shared();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    resolved.length = 0;
    await engines.a.withdraw({ linkId: "chat", id });
    await vi.waitFor(() => expect(engines.b.linkView("chat", true)!.received[0].status).toBe("withdrawn"));
    const at: number[] = [];
    for (const step of [20_000, 60_000, 180_000, 600_000]) {
      await vi.advanceTimersByTimeAsync(step);
      at.push(resolved.length);
    }
    expect(at, "after 20 s, 1 min more, 3 min more, then none").toEqual([1, 2, 3, 3]);
    expect(engines.b.linkView("chat", true)!.received[0].status).toBe("withdrawn");
    engines.b.stop();
  });

  it("a chat whose connection drops while its withdrawal is written does not stop the removal: the contact is told on reconnect", async () => {
    const { engines, ledgers, state, pkarr, id, binding } = await shared();
    // The chat's link closes right after A's ledger write, before the withdraw frame is sent.
    let a = ledgers.a;
    Object.defineProperty(ledgers, "a", { get: () => a, set: (next: IdentityLedger) => { a = next; state.connected = false; } });
    await engines.a.remove({ id });
    expect(engines.a.views()).toEqual([]);
    expect(ledgers.a.shared.find(s => s.id === id)?.status).toBe("withdrawal-pending");
    expect(await stored<{ id: string }[]>("identityRevocations")).toEqual([expect.objectContaining({ id, key: binding.key })]);
    await vi.waitFor(() => expect(pkarr.get(binding.key)?.[0]).toMatchObject({ label: "_ghostly-revoked", value: expect.stringContaining(id) }));
    engines.a.closed("chat");
    state.connected = true;
    engines.a.ready("chat");
    await vi.waitFor(() => expect(ledgers.a.shared.find(s => s.id === id)?.status).toBe("withdrawn"));
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

  it("two proofs of the same identity shared in one chat: the profile counts only the one the contact keeps, and removing it leaves both sides with none", async () => {
    const { engines, ledgers, id: older } = await shared();
    const { id: newer } = await prove(engines.a);
    expect(engines.a.views().map(v => v.subject)).toEqual([fakeKeySubject(), fakeKeySubject()]);
    await engines.a.share({ linkId: "chat", id: newer });
    await vi.waitFor(() => expect(ledgers.a.shared.find(s => s.id === newer)?.status).toBe("accepted"));
    expect(engines.b.linkView("chat", true)!.received.map(r => r.id)).toEqual([newer]);
    const sharedWith = () => Object.fromEntries(engines.a.views().map(v => [v.id, v.sharedWith]));
    expect(sharedWith()).toEqual({ [older]: 0, [newer]: 1 });
    await engines.a.remove({ id: newer });
    await vi.waitFor(() => expect(engines.b.linkView("chat", true)!.received.map(r => `${r.id}:${r.status}`)).toEqual([`${newer}:withdrawn`]));
    expect(sharedWith()).toEqual({ [older]: 0 });
    // Shared again by hand, the older one is what the contact holds.
    await engines.a.share({ linkId: "chat", id: older });
    await vi.waitFor(() => expect(engines.b.linkView("chat", true)!.received.find(r => r.id === older)?.status).toBe("verified"));
    expect(sharedWith()).toEqual({ [older]: 1 });
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

  it("with Hide my IP on, a contact's proof is checked without contacting a server the contact chose; fixed hosts and the person's own proofs still are", async () => {
    // A provider whose check reads a file from a host, like did:web or a domain's website does from the one the evidence names.
    const reads = (host: string): IdentityProofProvider => ({ ...fakeKey,
      verify: async (statement, evidence, ctx) => { await ctx.fetch(`https://${host}/proof.json`); return fakeKey.verify(statement, evidence as never, ctx); } } as IdentityProofProvider);
    const fetched: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => { fetched.push(new URL(String(input)).host); return new Response("{}", { status: 200 }); });
    try {
      const { engines, ledgers, state } = pair();
      await clearStorage();
      await engines.a.load(); await engines.b.load();
      state.relayOnly = { a: true, b: true };
      state.providers = { a: [reads("contact.example")], b: [reads("contact.example")] };
      // The person's own proof is checked on their own server, as before.
      const own = await prove(engines.a);
      expect(fetched).toEqual(["contact.example"]);
      fetched.length = 0;
      await engines.a.share({ linkId: "chat", id: own.id });
      await vi.waitFor(() => expect(ledgers.a.shared.find(s => s.id === own.id)?.status).toBe("rejected"));
      expect(fetched).toEqual([]);
      expect(ledgers.b.received).toEqual([]);
      // The contact is not told why, only that the check could not run; this side's timeline says why.
      expect(ledgers.a.shared[0].error).toBe("Your contact's app could not check it. Try again later.");
      expect(JSON.stringify(ledgers.b.timeline)).toMatch(/Hide my IP/);

      // A fixed host (GitHub's API) is still asked, and so is the contact's server once Hide my IP is off.
      state.providers = { a: [reads("api.github.com")], b: [reads("api.github.com")] };
      await engines.a.share({ linkId: "chat", id: (await prove(engines.a)).id });
      await vi.waitFor(() => expect(ledgers.b.received).toHaveLength(1));
      expect(fetched).toContain("api.github.com");
      state.relayOnly = {};
      state.providers = { a: [reads("contact.example")], b: [reads("contact.example")] };
      await engines.b.recheck({ linkId: "chat", id: ledgers.b.received[0].id });
      expect(fetched).toContain("contact.example");
      // On again: not even a recheck the person taps reaches it.
      fetched.length = 0;
      state.relayOnly = { b: true };
      await engines.b.recheck({ linkId: "chat", id: ledgers.b.received[0].id });
      expect(fetched).toEqual([]);
      expect(engines.b.linkView("chat", true)!.received[0]).toMatchObject({ status: "unconfirmed", error: expect.stringMatching(/Hide my IP/) });
    } finally { vi.restoreAllMocks(); }
  });

  it("the hosts a contact's proof is checked on with Hide my IP on are the ones this app names", async () => {
    const { fixedIdentityHosts } = await import("../src/proofs/fixedHosts");
    expect([...fixedIdentityHosts()]).toEqual(expect.arrayContaining(["dns.quad9.net", "cloudflare-dns.com", "dns.google", "plc.directory", "pkarr.pubky.org",
      "www.googleapis.com", "api.github.com", "gitlab.com"]));
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
