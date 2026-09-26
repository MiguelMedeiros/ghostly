import { describe, expect, it, vi } from "vitest";
import { ACTIVITY_RETRY_SECONDS, GRAPH_TTL_SECONDS, MAX_ACTIVITY_ENTRIES, MAX_POSTS_KEPT, POSTS_TTL_SECONDS, PublicActivity, type PublicActivityHost } from "../src/engine/publicActivity";
import type { ActivityReader, PublicGraph, PublicPost, PublicPostsPage } from "../src/profiles/activity";
import type { ProfileSubject } from "../src/engine/publicProfiles";
// covers: proofs.public-activity, proofs.public-activity.graph, proofs.public-profile.setting

const ALICE: ProfileSubject = { provider: "pubky", subject: "alice" };
const post = (id: string, extra: Partial<PublicPost> = {}): PublicPost => ({ id, createdAt: 1, text: `post ${id}`, images: [], ...extra });

/** A cache with a scripted reader and a movable clock. */
function setup(options: { eligible?: ProfileSubject[]; own?: ProfileSubject[]; contacts?: (ProfileSubject & { linkId: string })[] } = {}) {
  const world = {
    eligible: options.eligible ?? [ALICE], enabled: true, online: true, now: 1_800_000_000_000,
    own: options.own ?? [{ provider: "pubky", subject: "me" }],
    contacts: options.contacts ?? [{ provider: "pubky", subject: "alice", linkId: "L-alice" }, { provider: "pubky", subject: "carol", linkId: "L-carol" }, { provider: "pubky", subject: "dave", linkId: "L-dave" }],
    ownNostr: [] as string[],
  };
  const pages = new Map<string, PublicPostsPage | Error>([["", { posts: [post("1", { images: [{ source: { kind: "nexus", owner: "alice", file: "F" }, host: "nexus.pubky.app" }] }), post("2")], cursor: "2", hosts: ["nexus.pubky.app"] }], ["2", { posts: [post("2"), post("3")], hosts: ["nexus.pubky.app"] }]]);
  const graphs = new Map<string, PublicGraph | Error>([["alice", { following: ["me", "carol"], followingComplete: true, followers: ["dave"], followersComplete: true, hosts: ["nexus.pubky.app"] }]]);
  const posts = vi.fn(async (_s: string, _c: unknown, cursor?: string) => { const p = pages.get(cursor ?? ""); if (!p || p instanceof Error) throw p ?? new Error("down"); return p; });
  const graph = vi.fn(async (s: string) => { const g = graphs.get(s); if (!g || g instanceof Error) throw g ?? new Error("down"); return g; });
  const reader: ActivityReader = { posts, graph, profileUrl: s => `https://pubky.app/profile/${s}` };
  const host: PublicActivityHost = {
    enabled: () => world.enabled, online: () => world.online, eligible: () => world.eligible, nostrRelays: () => [],
    own: () => world.own, contacts: () => world.contacts, ownNostrFollows: () => world.ownNostr,
    now: () => world.now, readers: { pubky: reader, nostr: reader },
    fetch: async () => { throw new Error("no network in this test"); },
  };
  const cache = new PublicActivity(host);
  const later = (seconds: number) => { world.now += seconds * 1000; };
  return { world, pages, graphs, posts, graph, cache, later };
}

describe("posts", () => {
  it("only for an eligible identity, with the setting on; nothing is asked otherwise", async () => {
    const t = setup();
    expect(await t.cache.loadPosts({ provider: "pubky", subject: "bob" })).toBeNull();
    expect(await t.cache.loadPosts({ provider: "domain", subject: "alice" })).toBeNull();
    t.world.enabled = false;
    expect(await t.cache.loadPosts(ALICE)).toBeNull();
    expect(t.posts).not.toHaveBeenCalled();
    t.world.enabled = true;
    const v = await t.cache.loadPosts(ALICE);
    expect(v).toEqual({
      posts: [{ id: "1", createdAt: 1, text: "post 1", images: [{ host: "nexus.pubky.app" }] }, { id: "2", createdAt: 1, text: "post 2", images: [] }],
      more: true, hosts: ["nexus.pubky.app"], fetchedAt: 1_800_000_000, profileUrl: "https://pubky.app/profile/alice",
    });
  });

  it("kept for ten minutes; more adds the next page without repeats; offline shows what was kept", async () => {
    const t = setup();
    await t.cache.loadPosts(ALICE);
    t.later(POSTS_TTL_SECONDS - 1);
    await t.cache.loadPosts(ALICE);
    expect(t.posts).toHaveBeenCalledTimes(1);
    const more = await t.cache.loadPosts({ ...ALICE, more: true });
    expect(more?.posts.map(p => p.id)).toEqual(["1", "2", "3"]);
    expect(more?.more).toBe(false);
    t.later(2);
    t.world.online = false;
    expect((await t.cache.loadPosts(ALICE))?.posts).toHaveLength(3);
    expect(t.posts).toHaveBeenCalledTimes(2);
    t.world.online = true;
    await t.cache.loadPosts(ALICE);
    expect(t.posts).toHaveBeenCalledTimes(3);
  });

  it("at most fifty posts are kept for one identity", async () => {
    const t = setup();
    t.pages.set("", { posts: Array.from({ length: 30 }, (_, i) => post(`a${i}`)), cursor: "x", hosts: [] });
    t.pages.set("x", { posts: Array.from({ length: 30 }, (_, i) => post(`b${i}`)), cursor: "y", hosts: [] });
    await t.cache.loadPosts(ALICE);
    const v = await t.cache.loadPosts({ ...ALICE, more: true });
    expect(v?.posts).toHaveLength(MAX_POSTS_KEPT);
    expect(v?.more).toBe(false);
  });

  it("a failure is reported and spaces out the next ask; a kept page stays", async () => {
    const t = setup();
    t.pages.set("", new Error("The Pubky index answered 503"));
    await expect(t.cache.loadPosts(ALICE)).rejects.toThrow("503");
    await expect(t.cache.loadPosts(ALICE)).rejects.toThrow("503");
    expect(t.posts).toHaveBeenCalledTimes(1);
    t.later(ACTIVITY_RETRY_SECONDS);
    t.pages.set("", { posts: [post("9")], hosts: [] });
    expect((await t.cache.loadPosts(ALICE))?.posts.map(p => p.id)).toEqual(["9"]);
  });

  it("an answer that comes after the proof ended, or the setting went off, is dropped", async () => {
    const t = setup();
    let release!: () => void;
    t.posts.mockImplementationOnce(async () => { await new Promise<void>(r => { release = r; }); return { posts: [post("1")], hosts: [] }; });
    const pending = t.cache.loadPosts(ALICE);
    await Promise.resolve();
    t.world.eligible = [];
    release();
    expect(await pending).toBeNull();
    t.world.eligible = [ALICE];
    await t.cache.loadPosts(ALICE);
    expect(t.posts).toHaveBeenCalledTimes(2);
  });

  it("the setting off, or the proof gone, forgets everything", async () => {
    const t = setup();
    await t.cache.loadPosts(ALICE);
    t.cache.clear();
    await t.cache.loadPosts(ALICE);
    expect(t.posts).toHaveBeenCalledTimes(2);
    t.world.eligible = [];
    t.cache.prune();
    t.world.eligible = [ALICE];
    await t.cache.loadPosts(ALICE);
    expect(t.posts).toHaveBeenCalledTimes(3);
  });

  it("concurrent asks share one read; the cache is bounded", async () => {
    const t = setup({ eligible: Array.from({ length: MAX_ACTIVITY_ENTRIES + 5 }, (_, i) => ({ provider: "pubky", subject: `s${i}` })) });
    t.posts.mockImplementation(async () => ({ posts: [post("1")], hosts: [] }));
    await Promise.all([t.cache.loadPosts({ provider: "pubky", subject: "s0" }), t.cache.loadPosts({ provider: "pubky", subject: "s0" })]);
    expect(t.posts).toHaveBeenCalledTimes(1);
    for (let i = 1; i < MAX_ACTIVITY_ENTRIES + 5; i++) await t.cache.loadPosts({ provider: "pubky", subject: `s${i}` });
    t.posts.mockClear();
    await t.cache.loadPosts({ provider: "pubky", subject: "s0" });
    expect(t.posts).toHaveBeenCalledTimes(1);
  });

  it("the person's Nostr mute list hides notes", async () => {
    const t = setup({ eligible: [{ provider: "nostr", subject: "n" }] });
    const host = (t.cache as unknown as { host: PublicActivityHost }).host;
    host.nostrMuted = note => note.text.includes("spoiler");
    t.pages.set("", { posts: [post("1", { text: "big spoiler" }), post("2")], hosts: [] });
    const v = await t.cache.loadPosts({ provider: "nostr", subject: "n" });
    expect(v?.posts.map(p => p.id)).toEqual(["2"]);
    expect(v?.hidden).toBe(1);
  });
});

describe("follows, compared on this device", () => {
  it("follows you, you follow it (their followers), contacts it follows or who follow it", async () => {
    const t = setup({ own: [{ provider: "pubky", subject: "me" }] });
    t.graphs.set("alice", { following: ["me", "carol"], followingComplete: true, followers: ["dave", "me"], followersComplete: true, hosts: ["nexus.pubky.app"] });
    const g = await t.cache.loadGraph(ALICE);
    expect(g).toEqual({
      compared: true, followsYou: true, youFollow: true, hosts: ["nexus.pubky.app"], fetchedAt: 1_800_000_000,
      contacts: [{ linkId: "L-carol", follows: true, followedBy: false }, { linkId: "L-dave", follows: false, followedBy: true }],
    });
  });

  it("nobody to compare with: nothing is read", async () => {
    const t = setup({ own: [], contacts: [{ provider: "pubky", subject: "alice", linkId: "L-alice" }, { provider: "nostr", subject: "zed", linkId: "L-zed" }] });
    expect(await t.cache.loadGraph(ALICE)).toEqual({ compared: false, followsYou: false, youFollow: false, contacts: [], hosts: [], fetchedAt: 0 });
    expect(t.graph).not.toHaveBeenCalled();
  });

  it("a list cut at the cap says so; kept for an hour", async () => {
    const t = setup();
    t.graphs.set("alice", { following: [], followingComplete: false, followers: [], followersComplete: true, hosts: [] });
    expect((await t.cache.loadGraph(ALICE))?.partial).toBe(true);
    t.later(GRAPH_TTL_SECONDS - 1);
    await t.cache.loadGraph(ALICE);
    expect(t.graph).toHaveBeenCalledTimes(1);
    t.later(2);
    await t.cache.loadGraph(ALICE);
    expect(t.graph).toHaveBeenCalledTimes(2);
  });

  it("Nostr: no followers list, but the person's own follow list says whether they follow it", async () => {
    const t = setup({ eligible: [{ provider: "nostr", subject: "n" }], own: [], contacts: [] });
    t.world.ownNostr = ["n"];
    t.graphs.set("n", { following: [], followingComplete: true, hosts: ["relay.example"] });
    expect(await t.cache.loadGraph({ provider: "nostr", subject: "n" })).toMatchObject({ compared: true, youFollow: true, followsYou: false });
  });

  it("never names the reader or the contacts to any host: the reader only gets the identity asked for", async () => {
    const t = setup();
    await t.cache.loadGraph(ALICE);
    await t.cache.loadPosts(ALICE);
    for (const call of [...t.graph.mock.calls, ...t.posts.mock.calls]) expect(call[0]).toBe("alice");
  });
});

describe("post pictures", () => {
  it("only a picture of a post already loaded, by index; kept once loaded", async () => {
    const t = setup();
    await expect(t.cache.loadImage({ ...ALICE, postId: "1", index: 0 })).rejects.toThrow("load the posts again");
    await t.cache.loadPosts(ALICE);
    await expect(t.cache.loadImage({ ...ALICE, postId: "2", index: 0 })).rejects.toThrow();
    await expect(t.cache.loadImage({ ...ALICE, postId: "1", index: -1 })).rejects.toThrow();
    t.world.enabled = false;
    await expect(t.cache.loadImage({ ...ALICE, postId: "1", index: 0 })).rejects.toThrow("off");
  });
});
