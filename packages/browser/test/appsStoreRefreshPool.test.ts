import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { boundedAppFetch } from "../src/engine/appFetch";
import { STORES } from "../src/shared/idb";
import { FakeNet, apps, emptyProfile, rows, signer, storeFiles } from "./appsSupport";
import type { Apps } from "../src/engine/apps";
// covers: apps.engine.stores

/*
 * Every update check (each Apps page visit) reads the person's stores first. Read one after the other, 10 stores took
 * 10 round trips before any app was checked, and a store whose own URL is behind the copy the person took read that
 * copy only after its own read: 2 round trips each. A few stores at a time now, the copy beside the own URL, and what
 * each read brings is taken in the stores' order, as before.
 */

const DELAY_MS = 100;
const COUNT = 10;
const liveUrl = (i: number) => `https://raw.githubusercontent.com/ghostly/store${i}/HEAD/ghostly-store.json`;
const pinnedUrl = (i: number) => `https://cdn.jsdelivr.net/gh/ghostly/store${i}@${"0".repeat(40)}/ghostly-store.json`;
const by = (i: number) => signer(`store ${i}`);

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});

/** An engine whose every request waits `delayOf(url)` ms (0 until set), counting the requests in flight. */
function slowEngine() {
  const state = { delayOf: (_url: string) => 0, inFlight: 0, most: 0 };
  const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
    state.inFlight++;
    state.most = Math.max(state.most, state.inFlight);
    try {
      const ms = state.delayOf(String(input));
      if (ms) await new Promise((r) => setTimeout(r, ms));
      return await net.fetch(input, init);
    } finally { state.inFlight--; }
  }) as typeof fetch;
  return { store: apps(net, { fetch: boundedAppFetch({ fetcher: slow }) }), state };
}

/** Store `i` added from its live URL. */
async function addLive(store: Apps, i: number, sequence = 1): Promise<void> {
  await net.putStore(await storeFiles({ sequence, by: by(i), name: `Store ${i}` }), liveUrl(i));
  await store.addStore({ url: liveUrl(i) });
}

/** Store `i` added at a commit (5), then updated from its live URL (6): its own URL is behind that copy. */
async function addBehind(store: Apps, i: number): Promise<void> {
  await net.putStore(await storeFiles({ sequence: 5, by: by(i), name: `Store ${i}` }), pinnedUrl(i));
  await store.addStore({ url: pinnedUrl(i) });
  await net.putStore(await storeFiles({ sequence: 6, by: by(i), name: `Store ${i}` }), liveUrl(i));
  await store.previewStore({ url: liveUrl(i) });
  await store.addStore({ url: liveUrl(i) });
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await run();
  return { value, ms: performance.now() - start };
}

describe("refreshing many stores", () => {
  it("reads a few stores at a time: 10 unchanged stores take about 3 round trips, not 10", async () => {
    const { store, state } = slowEngine();
    for (let i = 0; i < COUNT; i++) await addLive(store, i);
    await store.refreshStores();
    state.delayOf = () => DELAY_MS;
    state.most = 0;
    net.requests.length = 0;
    const { value, ms } = await timed(() => store.refreshStores());
    expect(net.requests, "each store's index and .sig, once").toHaveLength(2 * COUNT);
    expect(state.most, "stores read side by side").toBeGreaterThanOrEqual(6);
    expect(state.most, "a few at a time: 4 stores, 2 requests each").toBeLessThanOrEqual(8);
    expect(ms, "ceil(10 / 4) = 3 round trips").toBeLessThan(5 * DELAY_MS);
    expect(ms).toBeGreaterThanOrEqual(3 * DELAY_MS - 5);
    expect(value.map((s) => s.key), "the stores' order").toEqual((await store.listStores()).map((s) => s.key));
    expect(value.every((s) => s.problem === undefined)).toBe(true);
  });

  it("a store behind the copy the person took reads that copy beside its own URL: one round trip", async () => {
    const { store, state } = slowEngine();
    await addBehind(store, 0);
    // Its own URL seen behind once (until then the copy is read only once the own URL showed it).
    await store.refreshStores();
    state.delayOf = () => DELAY_MS;
    state.most = 0;
    const { value: [read], ms } = await timed(() => store.refreshStores());
    expect(read).toMatchObject({ url: pinnedUrl(0), sequence: 6 });
    expect(read!.problem).toBeUndefined();
    expect(state.most, "its own index and .sig, and the copy's, at once").toBe(4);
    expect(ms, "one round trip").toBeLessThan(1.7 * DELAY_MS);
  });

  it("10 stores behind their copies take about 3 round trips, not 20", async () => {
    const { store, state } = slowEngine();
    for (let i = 0; i < COUNT; i++) await addBehind(store, i);
    await store.refreshStores();
    state.delayOf = () => DELAY_MS;
    state.most = 0;
    const { value, ms } = await timed(() => store.refreshStores());
    expect(value.every((s) => s.sequence === 6 && s.problem === undefined)).toBe(true);
    expect(state.most).toBeLessThanOrEqual(16);
    expect(ms).toBeLessThan(5 * DELAY_MS);
  });

  /*
   * A mixed set, refreshed with the later stores answering first: the summaries and the records written are the ones
   * the stores read one after the other gave (this test passes unchanged on that version too).
   */
  async function mixed(order: "first-first" | "last-first") {
    const { store, state } = slowEngine();
    // 0 unchanged, 1 changed, 2 failing, 3 equivocating, 4 behind its copy, 5 own URL caught up with its copy,
    // 6 own URL not answering but its copy does, 7 rolled back, 8 behind with the copy gone too.
    for (const i of [0, 1, 2, 3, 7]) await addLive(store, i, 3);
    for (const i of [4, 5, 6, 8]) await addBehind(store, i);
    await store.refreshStores();
    await net.putStore(await storeFiles({ sequence: 4, by: by(1), name: "Store 1 v4" }), liveUrl(1));
    net.files.delete(liveUrl(2));
    await net.putStore(await storeFiles({ sequence: 3, by: by(3), name: "Store 3 other" }), liveUrl(3));
    await net.putStore(await storeFiles({ sequence: 6, by: by(5), name: "Store 5" }), pinnedUrl(5));
    net.files.delete(pinnedUrl(6));
    await net.putStore(await storeFiles({ sequence: 2, by: by(7), name: "Store 7" }), liveUrl(7));
    net.files.delete(liveUrl(8));
    const rank = (url: string) => Number(/store(\d)/.exec(url)?.[1] ?? 0);
    state.delayOf = (url) => order === "first-first" ? 5 + 2 * rank(url) : 5 + 2 * (9 - rank(url));
    const first = await store.refreshStores();
    // Once more: what the first refresh kept (behind reads, a copy URL dropped) gives the same second refresh.
    const second = await store.refreshStores();
    const records = (await rows(STORES.appStores) as { key: string; url: string; copyUrl?: string }[]).sort((a, b) => a.key.localeCompare(b.key));
    return { first, second, records, order: (await store.listStores()).map((s) => s.key) };
  }

  it("a mixed set gives the same summaries and records, in the stores' order, whichever store answers first", async () => {
    const a = await mixed("first-first");
    expect(a.first.map((s) => s.key), "the stores' order").toEqual(a.order);
    expect([...a.first].sort((x, y) => x.name!.localeCompare(y.name!)).map((s) => [s.name, s.sequence, s.url, s.problem ?? null, s.equivocation?.sequence ?? null])).toEqual([
      ["Store 0", 3, liveUrl(0), null, null],
      ["Store 1 v4", 4, liveUrl(1), null, null],
      ["Store 2", 3, liveUrl(2), "status", null],
      ["Store 3", 3, liveUrl(3), "equivocation", 3],
      ["Store 4", 6, pinnedUrl(4), null, null],
      ["Store 5", 6, pinnedUrl(5), null, null],
      ["Store 6", 6, pinnedUrl(6), null, null],
      ["Store 7", 3, liveUrl(7), "rollback", null],
      ["Store 8", 6, pinnedUrl(8), "rollback", null],
    ]);
    const copyUrls = a.records.filter((r) => r.copyUrl).map((r) => r.url).sort();
    expect(copyUrls, "store 5's own URL holds the index: its copy is not read any more").toEqual([pinnedUrl(4), pinnedUrl(6), pinnedUrl(8)].sort());
    await emptyProfile();
    net = new FakeNet();
    const b = await mixed("last-first");
    expect(b.first).toEqual(a.first);
    expect(b.second).toEqual(a.second);
    expect(b.records).toEqual(a.records);
  });
});
