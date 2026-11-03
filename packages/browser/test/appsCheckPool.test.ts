import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonBytes } from "@ghostly/core";
import { APP_CHECK_TIMINGS } from "../src/engine/apps";
import { boundedAppFetch } from "../src/engine/appFetch";
import { STORES } from "../src/shared/idb";
import { FakeNet, NOW_MS, apps, appRows, bundle, emptyProfile, revocation } from "./appsSupport";
// covers: apps.engine.installed

/*
 * The update check reads each installed app's publisher files (`ghostly-revoke.json`, its sources' peeks): a few apps
 * at a time, not one after the other, and an app whose record only gets a newer `checkedAt` is not written at every
 * check (the Apps page checks at each visit).
 */

const COUNT = 12;
const DELAY_MS = 20;
const urlOf = (i: number) => `https://raw.githubusercontent.com/ana/app${i}/HEAD/app.ghostlyapp`;

let net: FakeNet;
let transactions: ReturnType<typeof vi.spyOn>;
/** Read-write transactions on the installed apps' store since the last `mockClear`. */
const writes = () => transactions.mock.calls.filter(([names, mode]) => mode === "readwrite" && [names].flat().includes(STORES.apps)).length;

beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
  transactions = vi.spyOn(IDBDatabase.prototype, "transaction");
});
afterEach(() => transactions.mockRestore());

describe("the update check with many apps", () => {
  it("reads the publishers' files a few at a time, and writes no record whose only change is when it was checked", async () => {
    let now = NOW_MS;
    let inFlight = 0;
    let most = 0;
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      inFlight++;
      most = Math.max(most, inFlight);
      try { await new Promise((r) => setTimeout(r, DELAY_MS)); return await net.fetch(input, init); } finally { inFlight--; }
    }) as typeof fetch;
    const store = apps(net, { fetch: boundedAppFetch({ fetcher: slow }), now: () => now });
    const refs: string[] = [];
    for (let i = 0; i < COUNT; i++) {
      const app = await bundle({ name: `app${i}` });
      net.put(urlOf(i), app.bytes);
      await store.preview({ url: urlOf(i) });
      await store.install({ digest: app.digest, grant: ["chat"] });
      refs.push(app.ref);
    }

    most = 0;
    const first = await store.checkUpdates();
    expect(first.map((r) => r.ref), "one result per app, in the installed order").toEqual((await appRows() as { ref: string }[]).map((a) => a.ref));
    expect(first.every((r) => r.outcome === "none")).toBe(true);
    expect(most, "the publishers' files are read side by side").toBeGreaterThanOrEqual(4);
    expect(most, "a few at a time").toBeLessThanOrEqual(6);
    expect((await appRows() as { checkedAt?: number }[]).every((a) => a.checkedAt === NOW_MS), "a first check marks every app").toBe(true);

    // A visit soon after: nothing changed, nothing written.
    now += 60_000;
    transactions.mockClear();
    await store.checkUpdates();
    expect(writes()).toBe(0);

    // Once its mark is half as old as the start's freshness: written again, so a reload still skips the check at start.
    now = NOW_MS + APP_CHECK_TIMINGS.freshMs / 2;
    transactions.mockClear();
    await store.checkUpdates();
    expect(writes()).toBe(COUNT);
    expect((await appRows() as { checkedAt?: number }[]).every((a) => a.checkedAt === now)).toBe(true);

    // A revocation is written at once, whatever the mark's age, and only for the app it names.
    now += 60_000;
    net.put(urlOf(3).replace("app.ghostlyapp", "ghostly-revoke.json"), canonicalJsonBytes([await revocation(refs[3]!, [(await bundle({ name: "app3", sequence: 2 })).digest])]));
    transactions.mockClear();
    await store.checkUpdates();
    expect(writes()).toBe(1);
    const rows = await appRows() as { ref: string; revocations?: unknown[] }[];
    expect(rows.filter((a) => a.revocations?.length).map((a) => a.ref)).toEqual([refs[3]]);
  });
});
