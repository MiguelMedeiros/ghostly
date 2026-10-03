import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { CommunitySession, createIdentity, identityFromSeedB64, type CommunityFrame, type CommunityIncomingMessage, type CommunityState, type PaymentReview } from "@ghostly/core";
import {
  COUNTER_RAISE_KEY, FLOOR_CLOCK_START_MS, GROUP_ADMIN_OFF_KEY, MAX_COUNTER_FLOOR, PENDING_RAISE_KEY, RAISE_STRIDE,
  applyCounterRaise, nextCounterFloor, pendingRaise, raisedIntent, raisedLink, type CounterRaise, type GroupAdminOff,
} from "../src/devices/raise";
import { PaymentCoordinator, type SavedIntent } from "../src/engine/paymentAdapters/coordinator";
import type { StoredLink } from "../src/shared/types";
// covers: devices.raised-counters, devices.takeover

/*
 * WISP 06 § Raised counters, as the engine makes them before it starts a copy from older state (a forced takeover, a
 * restored backup): exactly the listed counters, once, with a floor for the groups that tells two copies of one backup
 * apart; unfinished payments looked up only, signed ones parked; the on-chain wallet scanning again; admin work off.
 */

const S = RAISE_STRIDE;
const at = (iso: string) => Date.parse(iso);

describe("the floor", () => {
  it("rises along one line of copies whatever the clock says, and starts above the seconds since 2026", () => {
    const t = at("2026-10-03T12:00:00Z");
    const first = nextCounterFloor(0, 1, t);
    expect(first).toBe(Math.floor((t - FLOOR_CLOCK_START_MS) / 1000));
    // A clock a year behind: the floor still rises, by the stride.
    expect(nextCounterFloor(first, 2, t - 365 * 86_400_000)).toBe(first + S);
    // The WISP's rule is kept as a lower bound: takeovers times the stride.
    expect(nextCounterFloor(0, 40, FLOOR_CLOCK_START_MS)).toBe(40 * S);
    // Never above 2^32 less room for 2^24 frames: the community beacon packs the counter in 32 bits.
    expect(nextCounterFloor(MAX_COUNTER_FLOOR, 1, t)).toBe(MAX_COUNTER_FLOOR);
    // A clock past 2100 is not believed: the stride alone counts.
    expect(nextCounterFloor(5, 1, at("2160-01-01T00:00:00Z"))).toBe(5 + S);
  });

  it("two copies of one backup started an hour apart get floors an hour of seconds apart", () => {
    const t = at("2026-10-03T12:00:00Z");
    expect(nextCounterFloor(0, 1, t + 3_600_000) - nextCounterFloor(0, 1, t)).toBe(3600);
  });
});

const link = (patch: Partial<StoredLink> = {}): StoredLink => ({
  id: "chat", createdAt: 1, profile: "paired-chat/1",
  dhtDeliveryState: { sequence: 41, peerSequence: 17, reactionsTaken: 9 },
  capsState: { rev: 3, digest: "d", publishedAt: 123, sealedFor: "k" },
  hold: { enabled: true, outSeq: 12, inSeq: 30, peerAck: 11, pointerRev: 8, peerPointerRev: 6, outbox: [], refused: 0 },
  reactionsOut: [{ id: "m", e: "👍", n: 1_700_000_000_000 }],
  pin: { id: "m", n: 1_700_000_000_000 } as unknown as StoredLink["pin"],
  ...patch,
} as StoredLink);

describe("the counters of a chat", () => {
  it("raises exactly the mailbox sequence, the capability revision, the hold sequence and the hold pointer", () => {
    const raised = raisedLink(link(), 30_000_000);
    expect(raised.dhtDeliveryState).toEqual({ sequence: 30_000_000, peerSequence: 17, reactionsTaken: 9 });
    // `publishedAt` goes: a raised revision with unchanged content would otherwise never be published.
    expect(raised.capsState).toEqual({ rev: 30_000_000, digest: "d", sealedFor: "k" });
    expect(raised.hold).toMatchObject({ outSeq: 30_000_000, pointerRev: 30_000_000, inSeq: 30, peerAck: 11, peerPointerRev: 6 });
    // Not raised: reactions, pins, incoming marks.
    expect(raised.reactionsOut).toEqual(link().reactionsOut);
    expect(raised.pin).toEqual(link().pin);
  });

  it("goes up by the stride where the counter is already above the floor", () => {
    const raised = raisedLink(link({ dhtDeliveryState: { sequence: 50_000_000, peerSequence: 0 } }), 30_000_000);
    expect(raised.dhtDeliveryState!.sequence).toBe(50_000_000 + S);
  });

  it("gives a paired chat that never published its counters at the floor, and leaves a group's edge alone", () => {
    const bare = link({ dhtDeliveryState: undefined, capsState: undefined, hold: undefined });
    expect(raisedLink(bare, 7_000_000)).toMatchObject({ dhtDeliveryState: { sequence: 7_000_000, peerSequence: 0 }, capsState: { rev: 7_000_000 } });
    const edge = { id: "edge", createdAt: 1, group: "g", profile: "paired-chat/1" } as unknown as StoredLink;
    expect(raisedLink(edge, 7_000_000)).toEqual(edge);
  });
});

const review = (method: PaymentReview["method"], state: PaymentReview["state"]): PaymentReview => ({
  id: `${method}-${state}`, method, network: "testnet", provider: "p", asset: method === "usdt" ? "TEST-USDT" : "BTC", unit: method === "usdt" ? "token-base" : "sat",
  address: "a", expiresAt: 9e15, payee: "x", amount: 10, fee: 1, feeCap: 2, createdAt: 1, state,
} as PaymentReview);

describe("payments of a copy from older state", () => {
  it("an attempt that may hold signed bytes is parked; any other unfinished one becomes unknown; a finished one is left", () => {
    expect(raisedIntent({ review: review("usdt", "submitted"), prepared: { signed: "x" } }).review).toMatchObject({ state: "unknown", parked: true });
    expect(raisedIntent({ review: review("bitcoin", "unknown"), prepared: {} }).review).toMatchObject({ state: "unknown", parked: true });
    expect(raisedIntent({ review: review("arkade", "submitted"), prepared: {} }).review.parked).toBe(true);
    // A review not approved yet is parked too: an on-chain review holds a signed transaction from the moment it is made.
    expect(raisedIntent({ review: review("bitcoin", "pending"), prepared: { signed: "00" } }).review).toMatchObject({ state: "unknown", parked: true });
    expect(raisedIntent({ review: review("usdt", "pending"), prepared: {} }).review).toMatchObject({ state: "unknown", parked: true });
    expect(raisedIntent({ review: review("bark", "submitted"), prepared: {} }).review.parked).toBe(true);
    expect(raisedIntent({ review: review("cashu", "submitted"), prepared: {} }).review).toMatchObject({ state: "unknown" });
    expect(raisedIntent({ review: review("cashu", "submitted"), prepared: {} }).review.parked).toBeUndefined();
    const settled = { review: review("usdt", "settled"), prepared: {} };
    expect(raisedIntent(settled)).toBe(settled);
  });

  it("a pending on-chain review, signed when it was made and never approved, is never broadcast after a takeover", async () => {
    const saved: SavedIntent = raisedIntent({ review: review("bitcoin", "pending"), prepared: { txid: "t", signed: "0200" } });
    const reconcile = vi.fn(async () => ({ settled: true }));
    const execute = vi.fn(async () => ({ settled: true }));
    const repository = { get: async () => saved, put: async () => {}, list: async () => [saved], claim: async () => saved, cancel: async () => saved };
    const coordinator = new PaymentCoordinator(repository, [{ method: "bitcoin", prepare: vi.fn(), execute, reconcile } as never]);
    // What the engine's poll does every 10 seconds for an `unknown` attempt, and what Approve would do.
    expect(await coordinator.reconcile(saved.review.id)).toMatchObject({ state: "unknown", parked: true });
    await expect(coordinator.approve(saved.review.id)).rejects.toThrow();
    expect(reconcile).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("a parked attempt is never reconciled: the adapter that would broadcast its saved bytes is not called", async () => {
    const saved: SavedIntent = raisedIntent({ review: review("usdt", "submitted"), prepared: { signed: "bytes", hash: "0x" } });
    const reconcile = vi.fn(async () => ({ settled: true }));
    const repository = { get: async () => saved, put: async () => {}, list: async () => [saved], claim: async () => saved, cancel: async () => saved };
    const coordinator = new PaymentCoordinator(repository, [{ method: "usdt", prepare: vi.fn(), execute: vi.fn(), reconcile } as never]);
    const after = await coordinator.reconcile(saved.review.id);
    expect(reconcile).not.toHaveBeenCalled();
    expect(after).toMatchObject({ state: "unknown", parked: true });
  });
});

/** A profile database with the stores a raise touches. */
async function profileDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("links", { keyPath: "id" });
      db.createObjectStore("settings");
      db.createObjectStore("paymentIntents", { keyPath: "review.id" });
      db.createObjectStore("groups", { keyPath: "id" });
      db.createObjectStore("proofs", { keyPath: "secret" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
const put = (db: IDBDatabase, store: string, value: unknown, key?: IDBValidKey) => new Promise<void>((resolve, reject) => {
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value, key);
  tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
});
const get = <T>(db: IDBDatabase, store: string, key: IDBValidKey) => new Promise<T>((resolve, reject) => {
  const request = db.transaction(store).objectStore(store).get(key);
  request.onsuccess = () => resolve(request.result as T); request.onerror = () => reject(request.error);
});

describe("the raise in the profile's database", () => {
  it("is made once in one transaction: chats, payments, the on-chain wallet, admin work off, the floor; a second pass with the same id changes nothing", async () => {
    const db = await profileDb("raise-once");
    await put(db, "links", link());
    await put(db, "paymentIntents", { review: review("usdt", "submitted"), prepared: { signed: "x" } });
    await put(db, "settings", { changeset: "{}", reserved: [{ txid: "t", outpoints: ["o"], at: 1 }], scanned: true }, "bdkWallet-1");
    await put(db, "settings", { theme: "dark" }, "settings");
    await put(db, "groups", { id: "group-a" });
    await put(db, "groups", { id: "group-b" });
    await put(db, "proofs", { secret: "free", mint: "https://mint.test", amount: 8 });
    await put(db, "proofs", { secret: "held", mint: "https://mint.test", amount: 2, reserved: true });
    const t = at("2026-10-03T12:00:00Z");
    const pending = pendingRaise("restore", 0, t);
    await put(db, "settings", pending, PENDING_RAISE_KEY);
    const first = await applyCounterRaise(db, pending);
    const floor = Math.floor((t - FLOOR_CLOCK_START_MS) / 1000);
    expect(first).toEqual({ floor, links: 1, parked: 1, groups: 2, done: "now" });
    expect((await get<StoredLink>(db, "links", "chat")).dhtDeliveryState!.sequence).toBe(floor);
    expect(await get(db, "settings", "bdkWallet-1")).toEqual({ changeset: "{}", reserved: [], scanned: false });
    expect(await get(db, "settings", "settings")).toEqual({ theme: "dark" });
    // Free ecash of the copy is checked at its mint before it counts; ecash a payment holds is left to that payment.
    expect(await get(db, "proofs", "free")).toEqual({ secret: "free", mint: "https://mint.test", amount: 8, unchecked: true });
    expect(await get(db, "proofs", "held")).toEqual({ secret: "held", mint: "https://mint.test", amount: 2, reserved: true });
    expect(await get<GroupAdminOff>(db, "settings", GROUP_ADMIN_OFF_KEY)).toEqual({ at: t, groups: ["group-a", "group-b"] });
    expect(await get<CounterRaise>(db, "settings", COUNTER_RAISE_KEY)).toEqual({ id: pending.id, floor, at: t, why: "restore" });
    expect(await get(db, "settings", PENDING_RAISE_KEY)).toBeUndefined();
    // A crash after the transaction and before the note was taken off: the same raise again changes nothing.
    const again = await applyCounterRaise(db, pending);
    expect(again.done).toBe("before");
    expect((await get<StoredLink>(db, "links", "chat")).dhtDeliveryState!.sequence).toBe(floor);
    // The next takeover on this line rises above it, by the stride at least.
    const next = await applyCounterRaise(db, pendingRaise("takeover", 1, t - 86_400_000));
    expect(next.floor).toBe(floor + S);
    expect((await get<StoredLink>(db, "links", "chat")).dhtDeliveryState!.sequence).toBe(floor + S);
    db.close();
  });

  it("two copies of one backup, each raised when it starts, both send in a community (even at once) and nothing is dropped", async () => {
    // A community of an admin and a member; the member's state is backed up after it sent once.
    const pending: Promise<unknown>[] = [];
    const received: CommunityIncomingMessage[] = [];
    const sessions: CommunitySession[] = [];
    const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
    const hooks = (self: () => CommunitySession, floor: () => number, take?: (m: CommunityIncomingMessage) => void) => ({
      save: async (_s: CommunityState) => {},
      // To every other session, another copy of the same profile included: what a hub does.
      broadcast: (frame: CommunityFrame) => { for (const t of sessions) if (t !== self()) pending.push(t.handle(self().myKey, structuredClone(frame))); },
      direct: (to: string, frame: CommunityFrame) => { for (const t of sessions) if (t.myKey === to && t !== self()) pending.push(t.handle(self().myKey, structuredClone(frame))); },
      addressed: (to: string, frame: CommunityFrame) => { for (const t of sessions) if (t.myKey === to && t !== self()) pending.push(t.handle(self().myKey, structuredClone(frame))); },
      message: (m: CommunityIncomingMessage) => { take?.(m); },
      changed: () => {},
      seqFloor: floor,
    });
    let admin: CommunitySession = null as unknown as CommunitySession;
    admin = new CommunitySession(CommunitySession.create("Ghosts"), hooks(() => admin, () => 0, (m) => received.push(m)));
    sessions.push(admin);
    const seed = createIdentity().seedB64;
    const frames = await admin.admit(identityFromSeedB64(seed).pubKeyZ32);
    await settle();
    const joined = CommunitySession.join({ g: admin.id, host: admin.entryKey }, structuredClone(frames.slice(0, -1)), structuredClone(frames[frames.length - 1]), seed);
    if ("error" in joined) throw new Error(joined.error);
    const copyOf = (floor: number) => {
      let s: CommunitySession = null as unknown as CommunitySession;
      s = new CommunitySession(structuredClone(joined.state), hooks(() => s, () => floor));
      sessions.push(s);
      return s;
    };
    const say = async (s: CommunitySession, text: string) => { const r = await s.sendText(text, "b"); if ("error" in r) throw new Error(r.error); await settle(); };
    const original = copyOf(0);
    await say(original, "original");
    // Each copy's floor is the one its raise computes when it starts, from the same backup (floor 0, no takeover).
    const t = at("2026-10-03T12:00:00Z");
    const first = copyOf(nextCounterFloor(0, 0, t));
    await say(first, "first copy 1"); await say(first, "first copy 2");
    const second = copyOf(nextCounterFloor(0, 0, t + 3_600_000));
    await say(second, "second copy");
    await say(first, "first copy 3");
    expect(received.map((m) => m.text)).toEqual(["original", "first copy 1", "first copy 2", "second copy", "first copy 3"]);
  });
});
