import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeNet, apps, bundle, emptyProfile } from "./appsSupport";
// covers: apps.engine.installed

/*
 * One app's part of the update check that throws (a bundle write refused on a full disk, an IndexedDB error) does not
 * end the check while the other apps are still being checked: a check started right after would run beside them.
 */

const COUNT = 12;
const DELAY_MS = 50;
const urlOf = (i: number) => `https://raw.githubusercontent.com/ana/app${i}/HEAD/app.ghostlyapp`;

beforeEach(emptyProfile);

describe("an update check where one app fails", () => {
  it("checks the other apps and ends only once they are done, so the next check never runs beside it", async () => {
    const net = new FakeNet();
    const store = apps(net);
    for (let i = 0; i < COUNT; i++) {
      const app = await bundle({ name: `app${i}` });
      net.put(urlOf(i), app.bytes);
      await store.preview({ url: urlOf(i) });
      await store.install({ digest: app.digest, grant: ["chat"] });
    }

    const target = store as unknown as { checkApp: (...args: unknown[]) => Promise<unknown> };
    const checkApp = target.checkApp.bind(store);
    let calls = 0;
    let inFlight = 0;
    let most = 0;
    let failed = false;
    const spy = vi.spyOn(target, "checkApp").mockImplementation(async (...args) => {
      calls++;
      inFlight++;
      most = Math.max(most, inFlight);
      try {
        if (!failed) { failed = true; throw new Error("QuotaExceededError"); }
        await new Promise((r) => setTimeout(r, DELAY_MS));
        return await checkApp(...args);
      } finally { inFlight--; }
    });

    const first = await store.checkUpdates().catch(() => null);
    const second = await store.checkUpdates();
    spy.mockRestore();

    expect(most, "never more apps at once than one check's pool").toBeLessThanOrEqual(6);
    expect(calls).toBe(2 * COUNT);
    expect(first?.length, "the app that failed is left out, the others are checked").toBe(COUNT - 1);
    expect(second).toHaveLength(COUNT);
  });
});
