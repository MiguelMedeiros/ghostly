import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  createIdentity, emptyIdentityLedger, identityStatement, IDENTITY_FRAME_LIMIT, IDENTITY_FRAME_WINDOW_MS, IDENTITY_RESEND_MS, IDENTITY_RESENDS,
  RateWindow, type IdentityLedger,
} from "@ghostly/core";
import { STORES, transact } from "../src/shared/idb";
import { IdentityProofs, type IdentityLinkHost } from "../src/engine/identities";
import { fakeKey, fakeKeySign, fakeKeySubject } from "../src/proofs/testing";
// covers: proofs.share, proofs.withdraw

// A cheap reversible seal instead of the 600k-iteration one (identityEngine.test.ts checks that): 26 proofs are made here.
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
 * The person's own shares and stops, against the contact's per-chat limits: a paired session reads at most
 * IDENTITY_FRAME_LIMIT `idp-*` frames a minute from the contact (the rest are dropped unread, GhostLink's
 * `identityReceived`) and a contact keeps at most 8 open challenges. Stopping 16 at once, or a reconnect with 10 queued,
 * used to run into them, and what was dropped was sent again only at the next reconnect.
 */

type Me = "a" | "b";
function pair() {
  const keys = { a: createIdentity().pubKeyZ32, b: createIdentity().pubKeyZ32 };
  const ledgers: Record<Me, IdentityLedger> = { a: emptyIdentityLedger(), b: emptyIdentityLedger() };
  const state = { connected: true, lose: (_from: Me, _frame: Record<string, unknown>) => false };
  // What each side reads from the other, as its GhostLink does.
  const reads = { a: new RateWindow(IDENTITY_FRAME_LIMIT, IDENTITY_FRAME_WINDOW_MS, () => Date.now()), b: new RateWindow(IDENTITY_FRAME_LIMIT, IDENTITY_FRAME_WINDOW_MS, () => Date.now()) };
  const dropped = { a: 0, b: 0 };
  /** Every frame each side sent, in order. */
  const sent = { a: [] as Record<string, unknown>[], b: [] as Record<string, unknown>[] };
  const engines = {} as Record<Me, IdentityProofs>;
  const deliver = (from: Me, frame: Record<string, unknown>) => {
    const to: Me = from === "a" ? "b" : "a";
    queueMicrotask(() => {
      if (!state.connected || state.lose(from, frame)) return;
      if (!reads[to].take()) { dropped[to]++; return; }
      void engines[to].frame("chat", structuredClone(frame));
    });
  };
  const host = (me: Me): IdentityLinkHost => {
    const them: Me = me === "a" ? "b" : "a";
    return {
      ledger: linkId => linkId === "chat" ? ledgers[me] : undefined,
      updateLedger: async (_id, change) => (ledgers[me] = change(structuredClone(ledgers[me]))),
      channel: linkId => linkId === "chat" && state.connected ? {
        scope: () => ({ subject: keys[me], audience: keys[them], context: "c".repeat(64), session: "s".repeat(64) }),
        send: frame => { const f = frame as Record<string, unknown>; sent[me].push(f); deliver(me, f); },
      } : undefined,
      keys: () => ({ mine: keys[me], theirs: keys[them] }),
      linkIds: () => ["chat"], online: () => true, emit: vi.fn(),
      publish: async () => {}, resolve: async () => null,
    };
  };
  engines.a = new IdentityProofs(host("a"), () => [fakeKey]);
  engines.b = new IdentityProofs(host("b"), () => [fakeKey]);
  const connect = () => { state.connected = true; engines.a.ready("chat"); engines.b.ready("chat"); };
  const disconnect = () => { engines.a.closed("chat"); engines.b.closed("chat"); state.connected = false; };
  return { engines, ledgers, state, dropped, sent, deliver, connect, disconnect };
}

/** `count` proofs of A, each of its own test key (a contact keeps one proof per identity). */
async function proofs(engine: IdentityProofs, count: number): Promise<string[]> {
  await transact([STORES.settings], stores => {
    for (const key of ["identityProofs", "identityRevocations", "identityRevocationsCheckedAt", "identityRevocationsRound"]) stores[STORES.settings].delete(key);
  });
  await engine.load();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const seed = ed25519.utils.randomSecretKey();
    const { draftId, binding } = engine.begin({ provider: "fake-key", subject: fakeKeySubject(seed) });
    ids.push((await engine.complete({ draftId, evidence: fakeKeySign(identityStatement(binding), seed) })).id);
  }
  return ids;
}

/** Simulated time, a second at a time, until `done` or `maxMs`; the ms it took. */
async function until(done: () => boolean, maxMs: number): Promise<number> {
  const start = Date.now();
  while (!done() && Date.now() - start < maxMs) await vi.advanceTimersByTimeAsync(1_000);
  return Date.now() - start;
}

const MINUTE = 60_000;
const statuses = (list: { status: string }[]) => list.reduce<Record<string, number>>((n, x) => ({ ...n, [x.status]: (n[x.status] ?? 0) + 1 }), {});

afterEach(() => { vi.useRealTimers(); });

describe("sharing and stopping many identities at once", () => {
  it("16 shared, then all 16 stopped at once (Share only this): all 16 end withdrawn on both sides, and the contact drops none of the frames", async () => {
    const p = pair();
    const ids = await proofs(p.engines.a, 16);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    p.connect();
    // One after another, as `identity share` x16.
    for (const id of ids) await p.engines.a.share({ linkId: "chat", id });
    await until(() => p.ledgers.b.received.filter(r => r.status === "verified").length === 16, 5 * MINUTE);
    expect(statuses(p.ledgers.b.received)).toEqual({ verified: 16 });
    // The composer's Share only this: every other shared one withdrawn at once.
    await Promise.all(ids.map(id => p.engines.a.withdraw({ linkId: "chat", id })));
    const took = await until(() => p.ledgers.a.shared.every(s => s.status === "withdrawn") && p.ledgers.b.received.every(r => r.status === "withdrawn"), 5 * MINUTE);
    expect(statuses(p.ledgers.b.received), "the contact's side").toEqual({ withdrawn: 16 });
    expect(statuses(p.ledgers.a.shared), "the sharer's side").toEqual({ withdrawn: 16 });
    expect(took).toBeLessThanOrEqual(3 * MINUTE);
    expect(p.dropped).toEqual({ a: 0, b: 0 });
  });

  it("a reconnect with 10 shares queued: all 10 verified in that same connection", async () => {
    const p = pair();
    const ids = await proofs(p.engines.a, 10);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    p.disconnect();
    for (const id of ids) await p.engines.a.share({ linkId: "chat", id });
    expect(statuses(p.ledgers.a.shared)).toEqual({ queued: 10 });
    p.connect();
    await until(() => p.ledgers.a.shared.every(s => s.status === "accepted"), 5 * MINUTE);
    expect(statuses(p.ledgers.a.shared)).toEqual({ accepted: 10 });
    expect(statuses(p.ledgers.b.received)).toEqual({ verified: 10 });
    // Never more than 8 open: each request went once, none was refused for too many challenges.
    expect(p.sent.a.filter(f => f.t === "idp-request")).toHaveLength(10);
    expect(p.dropped).toEqual({ a: 0, b: 0 });
  });

  it("a stop the contact never answered is sent again, later each time and a bounded number of times; one answered late ends withdrawn", async () => {
    const p = pair();
    const [id] = await proofs(p.engines.a, 1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    p.connect();
    await p.engines.a.share({ linkId: "chat", id });
    await until(() => p.ledgers.b.received[0]?.status === "verified", MINUTE);
    // Every withdraw is lost on the way.
    p.state.lose = (from, f) => from === "a" && f.t === "idp-withdraw";
    await p.engines.a.withdraw({ linkId: "chat", id });
    const withdraws = () => p.sent.a.filter(f => f.t === "idp-withdraw").length;
    expect(withdraws()).toBe(1);
    await vi.advanceTimersByTimeAsync(IDENTITY_RESEND_MS - 1_000);
    expect(withdraws(), "not before its time").toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(withdraws(), "after a minute").toBe(2);
    await vi.advanceTimersByTimeAsync(2 * IDENTITY_RESEND_MS - 2_000);
    expect(withdraws(), "the next after twice as long").toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(withdraws()).toBe(3);
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(withdraws(), "bounded").toBe(1 + IDENTITY_RESENDS);
    expect(p.ledgers.a.shared[0].status).toBe("withdrawal-pending");
    expect(p.ledgers.b.received[0].status).toBe("verified");
    // The next connection sends it again, and this time it arrives.
    p.disconnect();
    p.state.lose = () => false;
    p.connect();
    await until(() => p.ledgers.a.shared[0].status === "withdrawn", MINUTE);
    expect(p.ledgers.b.received[0].status).toBe("withdrawn");
    expect(p.ledgers.a.shared[0].status).toBe("withdrawn");
    p.disconnect();
  });

  it("a request whose challenge never came is asked again in the same connection", async () => {
    const p = pair();
    const [id] = await proofs(p.engines.a, 1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    p.connect();
    let lost = 0;
    p.state.lose = (from, f) => from === "a" && f.t === "idp-request" && lost++ === 0;
    await p.engines.a.share({ linkId: "chat", id });
    const took = await until(() => p.ledgers.a.shared[0]?.status === "accepted", 5 * MINUTE);
    expect(p.ledgers.b.received[0]?.status).toBe("verified");
    expect(took).toBeGreaterThanOrEqual(IDENTITY_RESEND_MS);
    expect(took).toBeLessThan(IDENTITY_RESEND_MS + 5_000);
    p.disconnect();
  });
});

describe("the contact's per-chat limits are unchanged", () => {
  it("a contact sending 100 identity frames at once is read 40 of them, and given at most 8 challenges", async () => {
    const p = pair();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    p.connect();
    const hex = (i: number) => i.toString(16).padStart(64, "0");
    // Straight onto the channel, past the sharer's pacing: what a modified app could send.
    for (let i = 0; i < 100; i++) p.deliver("a", { t: "idp-request", id: hex(i), provider: "fake-key" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(p.dropped.b).toBe(100 + 1 - IDENTITY_FRAME_LIMIT); // its hello was read too
    expect(p.ledgers.b.challenges).toHaveLength(8);
    expect(p.sent.b.filter(f => f.t === "idp-challenge")).toHaveLength(8);
    p.disconnect();
  });
});
