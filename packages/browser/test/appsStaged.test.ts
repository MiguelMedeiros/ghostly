import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Apps } from "../src/engine/apps";
import { BUNDLE_URL, FakeNet, NOW_MS, PINNED_URL, apps, bundle, emptyProfile } from "./appsSupport";

/*
 * Bundles fetched for the install screen wait in memory for `install` for 10 minutes: one the person closed without
 * installing goes after those 10 minutes on its own, without waiting for another preview.
 */

const MINUTE = 60 * 1000;
const held = (store: Apps) => (store as unknown as { staged: Map<string, unknown> }).staged.size;

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});
afterEach(() => { vi.useRealTimers(); });

describe("previewed bundles", () => {
  it("go after 10 minutes with no other call, each at its own time", async () => {
    let now = NOW_MS;
    const store = apps(net, { now: () => now });
    const v1 = await bundle();
    const v2 = await bundle({ sequence: 2 });
    net.put(BUNDLE_URL, v1.bytes);
    net.put(PINNED_URL, v2.bytes);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const later = async (ms: number) => { now += ms; await vi.advanceTimersByTimeAsync(ms); };

    await store.preview({ url: BUNDLE_URL });
    await later(4 * MINUTE);
    await store.preview({ url: PINNED_URL });
    expect(held(store)).toBe(2);

    await later(6 * MINUTE + 1);
    expect(held(store)).toBe(1);
    await expect(store.install({ digest: v1.digest, grant: ["chat"] })).rejects.toThrow(/^expired/);

    await later(4 * MINUTE + 1);
    expect(held(store)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("one installed in time is not held, and stop drops the wait", async () => {
    const store = apps(net);
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    expect(held(store)).toBe(0);
    await store.preview({ url: BUNDLE_URL });
    store.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
