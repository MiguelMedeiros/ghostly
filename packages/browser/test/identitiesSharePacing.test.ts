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
/** A test key under another kind's name: one a contact may not verify. */
const otherKey = { ...fakeKey, id: "fake-other" };
function pair({ bVerifies = [fakeKey] as (typeof fakeKey)[] } = {}) {
  const keys = { a: createIdentity().pubKeyZ32, b: createIdentity().pubKeyZ32 };
  const ledgers: Record<Me, IdentityLedger> = { a: emptyIdentityLedger(), b: emptyIdentityLedger() };
  const state = { connected: true, lose: (_from: Me, _frame: Record<string, unknown>) => false };
  // What each side reads from the other, as its GhostLink does.
  const reads = { a: new RateWindow(IDENTITY_FRAME_LIMIT, IDENTITY_FRAME_WINDOW_MS, () => Date.now()), b: new RateWindow(IDENTITY_FRAME_LIMIT, IDENTITY_FRAME_WINDOW_MS, () => Date.now()) };
  const dropped = { a: 0, b: 0 };
  /** Every frame each side sent, in order. */
  const sent = { a: [] as Record<string, unknown>[], b: [] as Record<string, unknown>[] };
  /** When each of those frames left (ms); the contact reads it in the same moment. */
  const sentAt = new Map<Record<string, unknown>, number>();
  /** Both sides' frames, in the order they left. */
  const wire: Record<string, unknown>[] = [];
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
        send: frame => { const f = frame as Record<string, unknown>; sent[me].push(f); wire.push(f); sentAt.set(f, Date.now()); deliver(me, f); },
      } : undefined,
      keys: () => ({ mine: keys[me], theirs: keys[them] }),
      linkIds: () => ["chat"], online: () => true, emit: vi.fn(),
      publish: async () => {}, resolve: async () => null,
    };
  };
  engines.a = new IdentityProofs(host("a"), () => [fakeKey, otherKey]);
  engines.b = new IdentityProofs(host("b"), () => bVerifies);
  const connect = () => { state.connected = true; engines.a.ready("chat"); engines.b.ready("chat"); };
  const disconnect = () => { engines.a.closed("chat"); engines.b.closed("chat"); state.connected = false; };
  return { engines, ledgers, state, dropped, sent, sentAt, wire, deliver, connect, disconnect };
}

/** `count` proofs of A, each of its own test key (a contact keeps one proof per identity); `kinds` names some of another kind. */
async function proofs(engine: IdentityProofs, count: number, kinds: Record<number, string> = {}): Promise<string[]> {
  await transact([STORES.settings], stores => {
    for (const key of ["identityProofs", "identityRevocations", "identityRevocationsCheckedAt", "identityRevocationsRound"]) stores[STORES.settings].delete(key);
  });
  await engine.load();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const seed = ed25519.utils.randomSecretKey();
    const { draftId, binding } = engine.begin({ provider: kinds[i] ?? "fake-key", subject: fakeKeySubject(seed) });
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

  it("a link that dropped with 8 challenges on the way: the reconnect asks for all 8 again, and the contact's challenges from the closed link do not hold its 8 places", async () => {
    const p = pair();
    const ids = await proofs(p.engines.a, 8);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    p.connect();
    // The contact saved and sent its 8 challenges; the link dropped before any reached the sharer.
    p.state.lose = (from, f) => from === "b" && f.t === "idp-challenge";
    for (const id of ids) await p.engines.a.share({ linkId: "chat", id });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(p.ledgers.b.challenges).toHaveLength(8);
    p.disconnect();
    p.state.lose = () => false;
    await vi.advanceTimersByTimeAsync(5_000);
    p.connect();
    const took = await until(() => p.ledgers.a.shared.every(s => s.status === "accepted"), 15 * MINUTE);
    expect(statuses(p.ledgers.a.shared)).toEqual({ accepted: 8 });
    expect(statuses(p.ledgers.b.received)).toEqual({ verified: 8 });
    // Not after the closed link's challenges ran out (5 min) and a resend came after that.
    expect(took).toBeLessThan(IDENTITY_RESEND_MS);
    expect(p.sent.a.filter(f => f.t === "idp-request"), "each asked once per connection").toHaveLength(16);
    expect(p.ledgers.b.challenges).toHaveLength(0);
    p.disconnect();
  });

  it("a share of a kind the contact does not verify is asked once a connection and holds no open place: the 8 others queued with it are verified at once", async () => {
    const p = pair({ bVerifies: [fakeKey] });
    const [unsupported, ...ids] = await proofs(p.engines.a, 9, { 0: otherKey.id });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    p.disconnect();
    // The unsupported one first, so it takes one of the 8 open places.
    for (const id of [unsupported, ...ids]) await p.engines.a.share({ linkId: "chat", id });
    p.connect();
    const accepted = () => p.ledgers.a.shared.filter(s => ids.includes(s.id) && s.status === "accepted").length;
    const took = await until(() => accepted() === 8, 5 * MINUTE);
    expect(accepted()).toBe(8);
    expect(took, "the 8th did not wait for the unsupported one's place").toBeLessThan(IDENTITY_RESEND_MS);
    // Its refusal freed its place at once: all 8 others were asked before the first of them was answered.
    const eighth = p.wire.filter(f => f.t === "idp-request" && ids.includes(f.id as string))[7];
    const firstAnswer = p.wire.find(f => f.t === "idp-result" && f.ok === true);
    expect(p.wire.indexOf(eighth), "the 8th asked before any of the others was answered").toBeLessThan(p.wire.indexOf(firstAnswer!));
    // Well past every resend of this connection.
    await vi.advanceTimersByTimeAsync(16 * IDENTITY_RESEND_MS);
    expect(p.sent.a.filter(f => f.t === "idp-request" && f.id === unsupported), "asked once, then left for the next connection").toHaveLength(1);
    expect(p.ledgers.a.shared.find(s => s.id === unsupported)?.status).toBe("queued");
    expect(statuses(p.ledgers.b.received)).toEqual({ verified: 8 });
    p.disconnect();
  });

  it("a reconnect with 16 stops and 16 new shares queued: every presentation leaves as its challenge arrives, none waits for room in the window", async () => {
    const p = pair();
    const ids = await proofs(p.engines.a, 32);
    const [old, fresh] = [ids.slice(0, 16), ids.slice(16)];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    p.connect();
    for (const id of old) await p.engines.a.share({ linkId: "chat", id });
    await until(() => p.ledgers.b.received.filter(r => r.status === "verified").length === 16, 5 * MINUTE);
    // Offline for an hour (the contact's checks of the hour went on those 16): all 16 stopped, 16 others shared.
    p.disconnect();
    await vi.advanceTimersByTimeAsync(61 * MINUTE);
    for (const id of fresh) await p.engines.a.share({ linkId: "chat", id });
    for (const id of old) await p.engines.a.withdraw({ linkId: "chat", id });
    p.connect();
    // 1 hello + 16 stops + 16 requests + 16 presentations: more than one window carries.
    await until(() => p.ledgers.a.shared.every(s => s.status === "accepted" || s.status === "withdrawn"), 10 * MINUTE);
    expect(statuses(p.ledgers.a.shared)).toEqual({ accepted: 16, withdrawn: 16 });
    // The contact keeps the 16 new ones in the places the stopped ones gave up.
    expect(statuses(p.ledgers.b.received)).toEqual({ verified: 16 });
    expect(p.ledgers.b.received.map(r => r.id).sort()).toEqual([...fresh].sort());
    // The room kept for the presentations still owed: none waited for the window behind requests and stops.
    const challengedAt = new Map(p.sent.b.filter(f => f.t === "idp-challenge").map(f => [f.nonce, p.sentAt.get(f)!]));
    const waits = p.sent.a.filter(f => f.t === "idp-present").map(f => p.sentAt.get(f)! - challengedAt.get(f.nonce)!);
    expect(waits).toHaveLength(32);
    expect(Math.max(...waits)).toBeLessThanOrEqual(2_000);
    expect(p.dropped).toEqual({ a: 0, b: 0 });
    p.disconnect();
  });

  it("the engine stopped: no request or stop is sent again after it", async () => {
    const p = pair();
    const [id, other] = await proofs(p.engines.a, 2);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    p.connect();
    await p.engines.a.share({ linkId: "chat", id });
    await until(() => p.ledgers.b.received[0]?.status === "verified", MINUTE);
    // Neither is answered: both wait to be sent again.
    p.state.lose = from => from === "a";
    await p.engines.a.share({ linkId: "chat", id: other });
    await p.engines.a.withdraw({ linkId: "chat", id });
    const again = () => p.sent.a.filter(f => f.t === "idp-request" || f.t === "idp-withdraw").length;
    const before = again();
    p.engines.a.stop();
    p.engines.b.stop();
    expect(vi.getTimerCount(), "no timer outlives the engines").toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(again()).toBe(before);
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
