import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskBackoff } from "../src/engine/askBackoff";
import { FedimintWallet } from "../src/engine/paymentAdapters/fedimintWallet";
import type { FedimintSdk } from "../src/engine/paymentAdapters/fedimintSdk";
import { STORES, openDb, store, transact, wrap } from "../src/shared/idb";
import { FakeFedimintSdk, type FakeFederation } from "./helpers/fakeFedimint";
// covers: wallet.fedimint.backup, app.idle

/*
 * A federation restored with its profile whose guardians do not answer is joined again, recovering, on its saved
 * database. That try came back every 30 s for as long as the app ran. It now waits twice as long after each failure,
 * up to 5 minutes, per federation; opening it, the app coming back (`wake`) and a start (`ensureReady`) go back to
 * 30 s. Every try is still a recovery join on the saved database, and a database is removed only after `exists`
 * said it is not there.
 */

let fake: FakeFedimintSdk;
let federation: FakeFederation;
/** Every join the wallet asked for, at the (fake) time it asked. */
let joins: { at: number; database: string; recover: boolean; invite: string }[];
/** Every `exists` look, at its time. */
let looks: { at: number; database: string }[];
/** Invites whose guardians do not answer: a join makes its database, then fails (as the real client does). */
let down: Set<string>;

const restoredDb = (i: number) => `ghostly-fedimint-restored-${i}.db`;
const events = () => ({ changed: vi.fn(), received: vi.fn() });

function sdk(): () => Promise<FedimintSdk> {
  const base = fake.sdk();
  return async () => {
    const s = await base();
    return {
      ...s,
      exists: (database) => { looks.push({ at: Date.now(), database }); return s.exists(database); },
      join: async (p) => {
        joins.push({ at: Date.now(), database: p.database, recover: !!p.recover, invite: p.invite });
        if (down.has(p.invite)) { fake.halfMade.add(p.database); throw new Error("guardians did not answer"); }
        return s.join(p);
      },
    };
  };
}

/**
 * A wallet that joined `federations` and holds `sats` in each, started again with the recording SDK. `restored`: its
 * records came with a profile backup and the clients' databases did not (each under a new name, not on this device).
 */
async function walletOf(federations: FakeFederation[], { restored = true, sats = 1_500 } = {}) {
  const first = new FedimintWallet("testnet", events(), fake.sdk());
  await first.start();
  for (const f of federations) { await first.join(f.invite); const { invoice } = await first.createInvoice(f.id, sats); f.payInvoice(invoice); }
  await first.stop();
  if (restored) {
    const stored = await wrap<{ federations: { database: string }[] }>((await store(STORES.settings, "readonly")).get("fedimintWallet-testnet"));
    await transact([STORES.settings], (s) => { s[STORES.settings].put({ ...stored, federations: stored.federations.map((f, i) => ({ ...f, database: restoredDb(i) })) }, "fedimintWallet-testnet"); });
  }
  const w = new FedimintWallet("testnet", events(), sdk());
  await w.start();
  // From here the clock is the test's: only timers, so IndexedDB and WebCrypto still run.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  return w;
}

const turn = () => new Promise((resolve) => setImmediate(resolve));
/** Real turns of the event loop until `done` (a try unseals the mnemonic with WebCrypto, which no fake clock runs). */
async function until(done: () => boolean, ms = 10_000) {
  const end = performance.now() + ms;
  while (!done()) { if (performance.now() > end) throw new Error("timed out waiting"); await turn(); }
}
/** The wallet's next retry runs, and its try ends: failed (its next retry set) or every federation open. */
async function nextTry(w: FedimintWallet) {
  await vi.advanceTimersToNextTimerAsync();
  await until(() => vi.getTimerCount() > 0 || w.view.federations.every((f) => f.status === "ready"));
}
const secondsBetween = (times: number[]) => times.slice(1).map((t, i) => (t - times[i]) / 1000);

beforeEach(async () => {
  fake = new FakeFedimintSdk();
  federation = fake.federation({ name: "Regtest federation" });
  joins = []; looks = []; down = new Set();
  await openDb();
  await transact([STORES.settings, STORES.intents, STORES.payments], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); s[STORES.payments].clear(); });
});
afterEach(() => { vi.useRealTimers(); });

describe("a restored Fedimint federation whose guardians do not answer", () => {
  it("is joined again after 30 s, then twice as late each time, up to every 5 minutes, and stays an error meanwhile", async () => {
    const w = await walletOf([federation]);
    down.add(federation.invite);
    await w.ensureReady();
    for (let i = 0; i < 6; i++) await nextTry(w);
    expect(secondsBetween(joins.map((j) => j.at))).toEqual([30, 60, 120, 240, 300, 300]);
    // What it shows meanwhile: the reason, and no balance read (a 0 there would say nothing).
    expect(w.view.federations[0]).toMatchObject({ status: "error", error: "guardians did not answer", balance: 0 });
    expect(w.view.federations[0].read).toBeUndefined();
    // Every try is a recovery join on the saved database, never a fresh one; what each failed join made goes with it.
    expect(joins.every((j) => j.recover && j.database === restoredDb(0))).toBe(true);
    expect(fake.removed).toEqual(Array(7).fill(restoredDb(0)));

    down.clear();
    await nextTry(w);
    expect(joins.at(-1)!.at - joins.at(-2)!.at).toBe(300_000);
    await w.refresh();
    expect(w.view.federations[0]).toMatchObject({ status: "ready", balance: 1_500 });
    expect(vi.getTimerCount(), "nothing left to try").toBe(0);
    expect(federation.joined.get([...federation.joined.keys()][0]), "joined fresh once when it was funded, then recovered once").toBe(2);
    // Open, its wait is forgotten: a later failure would wait 30 s again, not 5 minutes. (Nothing closes an open
    // federation but a stop or a removal, which forget every wait anyway, so this reads the pace itself.)
    expect((w as unknown as { retries: AskBackoff }).retries.missed(federation.id, Date.now())).toBe(30_000);
    await w.stop();
  });

  it("keeps a wait of its own: another federation that answers again opens, this one keeps waiting longer", async () => {
    const other = fake.federation({ name: "Other federation" });
    const w = await walletOf([federation, other]);
    down.add(federation.invite); down.add(other.invite);
    const start = Date.now();
    await w.ensureReady();
    await nextTry(w); await nextTry(w);
    down.delete(other.invite);
    await nextTry(w); await nextTry(w);
    const at = (f: FakeFederation) => joins.filter((j) => j.invite === f.invite).map((j) => (j.at - start) / 1000);
    expect(at(federation)).toEqual([0, 30, 90, 210, 450]);
    expect(at(other)).toEqual([0, 30, 90, 210]);
    expect(w.view.federations.map((f) => f.status)).toEqual(["error", "ready"]);
    await w.stop();
  });

  it("is tried at once when the app comes back or starts the wallets again, and its wait starts again at 30 s", async () => {
    const w = await walletOf([federation]);
    down.add(federation.invite);
    await w.ensureReady();
    await nextTry(w); await nextTry(w);
    // Waiting 120 s now: the app comes back to the front.
    const back = Date.now();
    w.wake();
    await until(() => joins.length === 4 && vi.getTimerCount() > 0);
    expect(joins[3].at).toBe(back);
    await nextTry(w);
    expect(joins[4].at - joins[3].at).toBe(30_000);
    await nextTry(w);
    // Two starts at once: one retry is left waiting, not two.
    await Promise.all([w.ensureReady(), w.ensureReady()]);
    expect(joins.at(-1)!.at).toBe(Date.now());
    expect(vi.getTimerCount()).toBe(1);
    await nextTry(w);
    expect(joins.at(-1)!.at - joins.at(-2)!.at).toBe(30_000);

    down.clear();
    w.wake();
    await until(() => w.view.federations[0].status === "ready");
    // Open: the app coming back tries nothing.
    const tried = joins.length;
    w.wake();
    for (let i = 0; i < 20; i++) await turn();
    expect(joins.length).toBe(tried);
    await w.stop();
  });

  it("leaves no retry once the wallet is removed: nothing is joined after", async () => {
    const w = await walletOf([federation]);
    down.add(federation.invite);
    await w.ensureReady();
    await nextTry(w);
    expect(vi.getTimerCount()).toBe(1);
    await w.remove();
    expect(vi.getTimerCount()).toBe(0);
    const tried = joins.length;
    await vi.advanceTimersByTimeAsync(3_600_000);
    w.wake();
    for (let i = 0; i < 20; i++) await turn();
    expect(joins.length).toBe(tried);
  });

  it("leaves no retry when it is removed while a try is in flight", async () => {
    const w = await walletOf([federation]);
    let release = () => {};
    fake.joinHold = new Promise<void>((resolve) => { release = resolve; });
    fake.failJoins = 1;
    const first = w.ensureReady();
    await until(() => fake.halfMade.has(restoredDb(0)));
    // The try the removal cuts short ends while the wallet still has its federation: no retry is left behind.
    await w.remove();
    await first;
    release();
    // The removal's own, then the given-up join's when it fails.
    await until(() => fake.removed.length === 2);
    expect(vi.getTimerCount()).toBe(0);
    const tried = joins.length;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(joins.length).toBe(tried);
  });

  it("leaves no retry once the profile closes (the wallet stops)", async () => {
    down.add(federation.invite);
    const stopped = await walletOf([federation]);
    await stopped.ensureReady();
    expect(vi.getTimerCount()).toBe(1);
    await stopped.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("whose saved database cannot be looked at is neither joined over nor removed while it waits, and opens once it can", async () => {
    const w = await walletOf([federation], { restored: false });
    fake.existsFails = 3;
    const start = Date.now();
    await w.ensureReady();
    await nextTry(w); await nextTry(w); await nextTry(w);
    expect(looks.map((l) => (l.at - start) / 1000)).toEqual([0, 30, 90, 210]);
    expect(joins).toEqual([]);
    expect(fake.removed).toEqual([]);
    await w.refresh();
    expect(w.view.federations[0]).toMatchObject({ status: "ready", balance: 1_500 });
    await w.stop();
  });

  it("a try waiting on a recovery join the mode gate gave up on ends at the next cut, looks at nothing, and is tried again later", async () => {
    const w = await walletOf([federation]);
    let release = () => {};
    fake.joinHold = new Promise<void>((resolve) => { release = resolve; });
    fake.failJoins = 1;
    const first = w.ensureReady();
    await until(() => fake.halfMade.has(restoredDb(0)));
    w.cutShort();
    await first;
    w.resume();
    const looked = looks.length;
    let ended = false;
    void w.ensureReady().then(() => { ended = true; });
    for (let i = 0; i < 20; i++) await turn();
    expect(ended, "it waits for the given-up join").toBe(false);
    // The app moves away again: the wait ends with it, not only when the join does.
    w.cutShort();
    await until(() => ended, 2_000);
    w.resume();
    expect(looks.length, "no look while that join runs").toBe(looked);
    expect(fake.removed).toEqual([]);
    expect(vi.getTimerCount(), "tried again later").toBe(1);
    release();
    await until(() => fake.removed.includes(restoredDb(0)));
    await nextTry(w);
    await w.refresh();
    expect(w.view.federations[0]).toMatchObject({ status: "ready", balance: 1_500 });
    expect(joins.every((j) => j.recover && j.database === restoredDb(0))).toBe(true);
    await w.stop();
  });
});
