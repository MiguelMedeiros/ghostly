import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { MAX_CACHED_PROFILES, PROFILE_REFRESH_SECONDS, PROFILE_RETRY_SECONDS, PublicProfiles, type ProfileSubject, type PublicProfileHost } from "../src/engine/publicProfiles";
import type { PublicProfileData, PublicProfileReader } from "../src/profiles/readers";
// covers: proofs.public-profile, proofs.public-profile.setting

const ALICE: ProfileSubject = { provider: "pubky", subject: "alice" };
const BOB: ProfileSubject = { provider: "nostr", subject: "bob" };

/** A cache with a scripted network: `answers` per subject (an Error is a failed request), a movable clock. */
function setup(options: { eligible?: ProfileSubject[]; enabled?: boolean; online?: boolean } = {}) {
  const world = { eligible: options.eligible ?? [ALICE], enabled: options.enabled ?? true, online: options.online ?? true, now: 1_800_000_000_000 };
  const answers = new Map<string, PublicProfileData | Error>([["alice", { found: true, name: "Alice", followers: 3, hosts: ["nexus.pubky.app"] }], ["bob", { found: true, name: "Bob", hosts: ["relay.example"] }]]);
  const read = vi.fn(async (subject: string) => { const a = answers.get(subject); if (!a || a instanceof Error) throw a ?? new Error("down"); return a; });
  const reader: PublicProfileReader = { network: "test", read };
  const emit = vi.fn();
  const host: PublicProfileHost = {
    enabled: () => world.enabled, online: () => world.online, emit, eligible: () => world.eligible, nostrRelays: () => [],
    now: () => world.now, readers: { pubky: reader, nostr: reader },
    fetch: async () => { throw new Error("no network in this test"); },
  };
  const cache = new PublicProfiles(host);
  const later = (seconds: number) => { world.now += seconds * 1000; };
  /** fake-indexeddb lives as long as the file: a test that starts from nothing clears what earlier ones kept. */
  const fresh = async () => { await cache.load(); await cache.clear(); };
  return { world, answers, read, emit, host, cache, later, fresh };
}

describe("public profile cache", () => {
  it("asks only for an eligible identity, with the setting on and online, and shows what came", async () => {
    const t = setup({ eligible: [ALICE] });
    await t.fresh();
    expect(t.cache.view(ALICE)).toBeUndefined();
    await t.cache.request(BOB);
    t.world.online = false; await t.cache.request(ALICE);
    t.world.online = true; t.world.enabled = false; await t.cache.request(ALICE);
    await t.cache.request({ provider: "domain", subject: "alice" });
    expect(t.read).not.toHaveBeenCalled();
    t.world.enabled = true;
    await t.cache.request(ALICE);
    expect(t.read).toHaveBeenCalledTimes(1);
    expect(t.cache.view(ALICE)).toMatchObject({ found: true, name: "Alice", followers: 3, hosts: ["nexus.pubky.app"], fetchedAt: 1_800_000_000 });
  });

  it("asks again after a day; a miss or a failure after five minutes; force still waits five minutes", async () => {
    const t = setup();
    await t.fresh();
    await t.cache.request(ALICE);
    t.later(PROFILE_RETRY_SECONDS - 1); await t.cache.request({ ...ALICE, force: true });
    t.later(2); await t.cache.request(ALICE);
    expect(t.read).toHaveBeenCalledTimes(1);
    await t.cache.request({ ...ALICE, force: true });
    expect(t.read).toHaveBeenCalledTimes(2);
    t.later(PROFILE_REFRESH_SECONDS - 60); await t.cache.request(ALICE);
    expect(t.read).toHaveBeenCalledTimes(2);
    t.later(61); await t.cache.request(ALICE);
    expect(t.read).toHaveBeenCalledTimes(3);
    // A miss is asked again sooner than a day.
    t.answers.set("alice", { found: false, hosts: ["nexus.pubky.app"] });
    t.later(PROFILE_REFRESH_SECONDS); await t.cache.request(ALICE);
    t.later(PROFILE_RETRY_SECONDS); await t.cache.request(ALICE);
    expect(t.read).toHaveBeenCalledTimes(5);
  });

  it("a failure keeps the copy it had and says so; concurrent requests share one read", async () => {
    const t = setup();
    await t.fresh();
    await Promise.all([t.cache.request(ALICE), t.cache.request(ALICE)]);
    expect(t.read).toHaveBeenCalledTimes(1);
    t.answers.set("alice", new Error("The Pubky index answered 502"));
    t.later(PROFILE_REFRESH_SECONDS + 1); await t.cache.request(ALICE);
    expect(t.cache.view(ALICE)).toMatchObject({ found: true, name: "Alice", error: "The Pubky index answered 502" });
    t.later(PROFILE_RETRY_SECONDS); await t.cache.request(ALICE);
    expect(t.read).toHaveBeenCalledTimes(3);
  });

  it("is kept for offline use across restarts", async () => {
    const t = setup();
    await t.fresh();
    await t.cache.request(ALICE);
    const again = setup({ online: false });
    await again.cache.load();
    expect(again.cache.view(ALICE)).toMatchObject({ found: true, name: "Alice" });
  });

  it("drops a profile once its identity is no longer eligible (expired, removed, withdrawn, revoked), but not before the chats load", async () => {
    const t = setup({ eligible: [ALICE, BOB] });
    await t.fresh();
    await t.cache.request(ALICE); await t.cache.request(BOB);
    t.world.eligible = [BOB];
    await t.cache.prune();
    expect(t.cache.view(ALICE)).toBeDefined();
    t.cache.start();
    await t.cache.prune();
    t.cache.stop();
    expect(t.cache.view(ALICE)).toBeUndefined();
    expect(t.cache.view(BOB)).toMatchObject({ name: "Bob" });
    const reloaded = setup({ eligible: [BOB] });
    await reloaded.cache.load();
    expect(reloaded.cache.view(ALICE)).toBeUndefined();
  });

  it("an answer that arrives after the proof went, or the setting was turned off, is not kept", async () => {
    const t = setup();
    await t.fresh();
    let release!: () => void;
    t.read.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ found: true, name: "Late", hosts: [] }); }));
    const pending = t.cache.request(ALICE);
    expect(t.cache.view(ALICE)).toMatchObject({ loading: true, found: false, fetchedAt: 0 });
    t.world.eligible = [];
    release(); await pending;
    t.world.eligible = [ALICE];
    expect(t.cache.view(ALICE)).toBeUndefined();
  });

  it("with the setting off nothing is shown, and turning it off deletes what was kept", async () => {
    const t = setup();
    await t.fresh();
    await t.cache.request(ALICE);
    t.world.enabled = false;
    expect(t.cache.view(ALICE)).toBeUndefined();
    await t.cache.clear();
    t.world.enabled = true;
    expect(t.cache.view(ALICE)).toBeUndefined();
    const reloaded = setup();
    await reloaded.cache.load();
    expect(reloaded.cache.view(ALICE)).toBeUndefined();
  });

  it("keeps at most MAX_CACHED_PROFILES, the least recently asked go first", async () => {
    const many = Array.from({ length: MAX_CACHED_PROFILES + 3 }, (_, i) => ({ provider: "pubky", subject: `k${i}` }));
    const t = setup({ eligible: many });
    for (const s of many) t.answers.set(s.subject, { found: true, name: s.subject, hosts: [] });
    await t.fresh();
    for (const s of many) { await t.cache.request(s); t.later(1); }
    expect(t.cache.view(many[0])).toBeUndefined();
    expect(t.cache.view(many[many.length - 1])).toMatchObject({ name: `k${many.length - 1}` });
  });
});
