import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readContactLink, readLinkRecord, type GhostRecord } from "@ghostly/core";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import { CONTACT_LINKS_KEY, ContactLinks, LINK_REPUBLISH_MS, OFF_FOR_MS, OFF_REPUBLISH_MS, type ContactLinkHost } from "../src/engine/contactLinks";

// The seed is sealed with a 600k-iteration PBKDF2 key; a cheap reversible seal keeps these tests fast.
vi.mock("../src/engine/paymentAdapters/persistence", async importOriginal => {
  const real = await importOriginal<typeof import("../src/engine/paymentAdapters/persistence")>();
  const mix = (bytes: Uint8Array, password: string) => bytes.map((b, i) => b ^ password.charCodeAt(i % password.length));
  return {
    ...real,
    sealSeed: async (seed: string, password: string) => ({ version: 1, salt: [], iv: [], ciphertext: [...mix(new TextEncoder().encode(seed), password)] }),
    unsealSeed: async (sealed: { ciphertext: number[] }, password: string) => new TextDecoder().decode(mix(new Uint8Array(sealed.ciphertext), password)),
  };
});

/** A profile and a Pkarr that records every put: the key it went under and what the link record says. */
function world() {
  const state = { online: true, fail: null as Error | null, puts: [] as { key: string; state: string | undefined }[], emits: 0 };
  const host: ContactLinkHost = {
    online: () => state.online,
    emit: () => { state.emits++; },
    publish: async (identity, records: GhostRecord[]) => {
      if (state.fail) throw state.fail;
      state.puts.push({ key: identity.pubKeyZ32, state: readLinkRecord(records)?.state });
    },
  };
  return { state, make: () => new ContactLinks(host) };
}

const keyOf = (code: string) => { const r = readContactLink(code); if (!r.ok) throw new Error(r.reason); return r.linkKeyZ32; };
const NOW = Date.UTC(2026, 9, 16, 12);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  await transact([STORES.settings], stores => { stores[STORES.settings].delete(CONTACT_LINKS_KEY); });
});
afterEach(() => { vi.useRealTimers(); });

describe("the profile's contact link (WISP 8xx)", () => {
  it("is made on request, names only its own key, and says open under it", async () => {
    const { state, make } = world();
    const links = make();
    await links.load();
    expect(links.view()).toBeUndefined();
    const view = await links.create();
    expect(view.code).toMatch(/^ghostly1r[a-z0-9]{58}$/);
    expect(view.link).toBe(`https://ghostly.tools/#${view.code}`);
    expect(view.state).toBe("open");
    expect(state.puts).toEqual([{ key: keyOf(view.code), state: "open" }]);
    expect(links.view()?.publishedAt).toBe(NOW);
    // The seed is kept sealed, never as is.
    const stored = JSON.stringify(await wrap((await store(STORES.settings, "readonly")).get(CONTACT_LINKS_KEY)));
    expect(stored).not.toMatch(/"seedB64"/);
    const again = make();
    await again.load();
    expect(again.view()?.code).toBe(view.code);
  });

  it("a new link turns the one before off: one link per profile at a time", async () => {
    const { state, make } = world();
    const links = make();
    await links.load();
    const first = await links.create();
    const second = await links.create();
    expect(second.code).not.toBe(first.code);
    expect(links.view()?.code).toBe(second.code);
    expect(state.puts.slice(1)).toEqual(expect.arrayContaining([{ key: keyOf(second.code), state: "open" }, { key: keyOf(first.code), state: "off" }]));
  });

  it("turned off, it says off once a day for 30 days, then nothing", async () => {
    const { state, make } = world();
    const links = make();
    await links.load();
    const { code } = await links.create();
    await links.turnOff();
    expect(links.view()).toBeUndefined();
    const offs = () => state.puts.filter(p => p.key === keyOf(code) && p.state === "off").length;
    expect(offs()).toBe(1);
    await links.publishNow();
    expect(offs()).toBe(1);
    vi.setSystemTime(NOW + OFF_REPUBLISH_MS);
    await links.publishNow();
    expect(offs()).toBe(2);
    vi.setSystemTime(NOW + OFF_FOR_MS);
    await links.publishNow();
    expect(offs()).toBe(2);
    expect(JSON.stringify(await wrap((await store(STORES.settings, "readonly")).get(CONTACT_LINKS_KEY)))).not.toContain(keyOf(code));
  });

  it("publishes nothing offline, and says why a publish failed", async () => {
    const { state, make } = world();
    const links = make();
    await links.load();
    state.online = false;
    await links.create();
    expect(state.puts).toEqual([]);
    state.online = true;
    state.fail = new Error("relays down");
    await links.publishNow();
    expect(links.view()?.error).toBe("relays down");
    state.fail = null;
    await links.publishNow();
    expect(links.view()?.error).toBeUndefined();
  });

  it("goes out again every hour while the app runs", async () => {
    const { state, make } = world();
    const links = make();
    await links.load();
    await links.create();
    links.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state.puts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(LINK_REPUBLISH_MS);
    expect(state.puts).toHaveLength(3);
    links.stop();
    await vi.advanceTimersByTimeAsync(LINK_REPUBLISH_MS);
    expect(state.puts).toHaveLength(3);
  });

  it("Clear all data: every link it still holds says off once", async () => {
    const { state, make } = world();
    const links = make();
    await links.load();
    const first = await links.create();
    const second = await links.create();
    state.puts = [];
    await links.withdraw();
    expect(state.puts).toEqual(expect.arrayContaining([{ key: keyOf(first.code), state: "off" }, { key: keyOf(second.code), state: "off" }]));
    expect(state.puts).toHaveLength(2);
  });
});
