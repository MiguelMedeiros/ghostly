import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { newIdentityBinding } from "@ghostly/core";
import type { IdentityFetch, IdentityFetchResponse } from "../src/proofs/contract";
import {
  ACTIVITY_READERS, atprotoActivity, blueskyPost, expandLinkFacets, GRAPH_MAX, hasActivity, noteImages, nostrActivity, POST_TEXT_MAX, POSTS_PAGE,
  postText, pubkyActivity, pubkyPost, readPostImage,
} from "../src/profiles/activity";
import type { ReaderContext } from "../src/profiles/readers";
import { nodeSocket, TestNostrRelay } from "./helpers/nostrRelay";
import { testAtprotoNetwork } from "./helpers/atprotoNetwork";
// covers: proofs.public-activity, proofs.public-activity.nostr, proofs.public-activity.pubky, proofs.public-activity.atproto, proofs.public-activity.graph

vi.setConfig({ testTimeout: 20_000 });

/** A 1×1 PNG header: enough for the dimension check; decoding is stubbed. */
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
beforeEach(() => {
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1, height: 1, close() {} })));
  vi.stubGlobal("OffscreenCanvas", class { getContext() { return { drawImage() {} }; } async convertToBlob() { return new Blob([new Uint8Array([255, 216, 255, 217])], { type: "image/jpeg" }); } });
});
afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body: unknown, contentType = "application/json"): IdentityFetchResponse => {
  const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  return { status, contentType, text: new TextDecoder().decode(bytes), bytes };
};
const ctxOf = (fetch: IdentityFetch, extra: Partial<ReaderContext> = {}): ReaderContext => ({ fetch, signal: new AbortController().signal, relays: [], ...extra });
const now = () => Math.floor(Date.now() / 1000);
const BIDI = "‮⁦\u0007";

describe("which identities have posts and follows", () => {
  it("only Nostr, Pubky and Bluesky; nothing else is ever looked up", () => {
    expect(Object.keys(ACTIVITY_READERS).sort()).toEqual(["atproto", "nostr", "pubky"]);
    for (const p of ["domain", "oidc", "did", "constructor", "__proto__", "toString"]) expect(hasActivity(p)).toBe(false);
  });
});

describe("post text is plain, bounded and without direction controls", () => {
  it("strips bidi overrides and controls, keeps newlines, never parses markup", () => {
    expect(postText(`<b>hi</b>${BIDI}\nthere <img src=x onerror=alert(1)>`)).toBe("<b>hi</b>\nthere <img src=x onerror=alert(1)>");
  });
  it("huge text is cut with an ellipsis; non-strings and blanks are nothing", () => {
    const t = postText("x".repeat(200_000))!;
    expect(t.length).toBe(POST_TEXT_MAX);
    expect(t.endsWith("…")).toBe(true);
    for (const v of [undefined, 42, {}, "   ", BIDI]) expect(postText(v)).toBeUndefined();
  });
});

describe("Nostr: kind-1 notes and the kind-3 list of exactly this key, from the person's relays", () => {
  let relay: TestNostrRelay;
  const secret = generateSecretKey(), key = getPublicKey(secret);
  beforeEach(async () => { relay = new TestNostrRelay(); await relay.listen(); });
  afterEach(async () => { await relay.close(); });
  const ctx = () => ctxOf(async () => { throw new Error("no HTTP for Nostr"); }, { relays: [relay.url], makeSocket: nodeSocket });

  it("the newest own notes (replies left out), a link to open each, pictures only on fixed hosts", async () => {
    relay.add({ kind: 1, created_at: now() - 30, tags: [], content: `Hello${BIDI} world https://image.nostr.build/cat.jpg https://evil.test/track.png` }, secret);
    relay.add({ kind: 1, created_at: now() - 20, tags: [["e", "a".repeat(64)]], content: "a reply" }, secret);
    relay.add({ kind: 1, created_at: now() - 10, tags: [], content: "<script>alert(1)</script>" }, secret);
    relay.add({ kind: 1, created_at: now() - 5, tags: [], content: "someone else" }, generateSecretKey());
    const page = await nostrActivity.posts(key, ctx());
    expect(page.posts.map(p => p.text)).toEqual(["<script>alert(1)</script>", "Hello world https://image.nostr.build/cat.jpg https://evil.test/track.png"]);
    expect(page.posts[1].images).toEqual([{ source: { kind: "url", url: "https://image.nostr.build/cat.jpg" }, host: "image.nostr.build" }]);
    expect(page.posts[0].url).toMatch(/^https:\/\/njump\.me\/note1[a-z0-9]+$/);
    expect(page.cursor).toBeUndefined();
    expect(page.hosts).toEqual([new URL(relay.url).host]);
    expect(relay.requests.every(f => f.authors?.length === 1 && f.authors[0] === key)).toBe(true);
  });

  it("pages: ten at a time, the next page from the last note shown", async () => {
    for (let i = 0; i < 25; i++) relay.add({ kind: 1, created_at: now() - 1000 + i, tags: [], content: `note ${i}` }, secret);
    const first = await nostrActivity.posts(key, ctx());
    expect(first.posts).toHaveLength(POSTS_PAGE);
    expect(first.posts[0].text).toBe("note 24");
    expect(first.cursor).toBe(String(first.posts[POSTS_PAGE - 1].createdAt));
    const second = await nostrActivity.posts(key, ctx(), first.cursor);
    expect(second.posts[0].text).toBe("note 15");
    expect(relay.requests[1].until).toBe(Number(first.cursor));
  });

  it("an oversized note and a forged one are not shown", async () => {
    relay.add({ kind: 1, created_at: now() - 10, tags: [], content: "x".repeat(20_000) }, secret);
    const real = relay.add({ kind: 1, created_at: now() - 20, tags: [], content: "real" }, secret);
    relay.events.push({ ...real, created_at: now(), content: "forged" });
    expect((await nostrActivity.posts(key, ctx())).posts.map(p => p.text)).toEqual(["real"]);
  });

  it("follows = the newest kind-3's keys; followers are never listed", async () => {
    const follows = Array.from({ length: 3 }, () => getPublicKey(generateSecretKey()));
    relay.add({ kind: 3, created_at: now(), tags: [...follows.map(k => ["p", k]), ["p", "not-a-key"], ["p", follows[0]]], content: "" }, secret);
    const g = await nostrActivity.graph(key, ctx());
    expect(g).toEqual({ following: follows, followingComplete: true, hosts: [new URL(relay.url).host] });
  });

  it("no relay answering is a failure; a subject that is not a key asks nobody", async () => {
    await expect(nostrActivity.posts(key, ctxOf(async () => reply(500, ""), { relays: ["ws://127.0.0.1:1"], makeSocket: nodeSocket }))).rejects.toThrow("No relay answered");
    expect(await nostrActivity.posts("npub1xyz", ctx())).toEqual({ posts: [], hosts: [] });
    expect(relay.requests).toEqual([]);
    expect(nostrActivity.profileUrl(key)).toMatch(/^https:\/\/njump\.me\/npub1/);
  });

  it("picture links: fixed hosts only, at most four, never a data: or http: link", () => {
    const text = ["https://image.nostr.build/a.png", "http://image.nostr.build/b.png", "data:image/png;base64,AAAA", "https://m.primal.net/c.webp?x=1",
      "https://i.imgur.com/d.jpeg", "https://nostr.build/i/e.jpg", "https://pbs.twimg.com/f.png", "https://pbs.twimg.com/g.png"].join(" ");
    expect(noteImages(text).map(i => i.host)).toEqual(["image.nostr.build", "m.primal.net", "i.imgur.com", "image.nostr.build"]);
  });
});

describe("Pubky: the index's posts stream and follow lists for exactly this key", () => {
  const key = newIdentityBinding({ provider: "pubky", subject: "x", validitySeconds: 60 }).binding.key;
  const other = newIdentityBinding({ provider: "pubky", subject: "x", validitySeconds: 60 }).binding.key;
  const post = (id: string, extra: Record<string, unknown> = {}, rel: Record<string, unknown> = {}) => ({
    details: { content: `post ${id}`, id, indexed_at: 1_790_000_000_000, author: key, kind: "short", uri: `pubky://${key}/pub/pubky.app/posts/${id}`, attachments: [], ...extra },
    counts: { tags: 0, replies: 0, reposts: 0 }, tags: [], relationships: { replied: null, reposted: null, mentioned: [], ...rel }, bookmark: null,
  });
  const nexus = (routes: Record<string, (u: URL) => IdentityFetchResponse>) => {
    const asked: string[] = [];
    const fetch: IdentityFetch = async url => { asked.push(url); const u = new URL(url); const r = routes[u.pathname]; if (!r) throw new TypeError("Failed to fetch"); return r(u); };
    return { asked, fetch };
  };

  it("posts: text, time, a link to pubky.app, reply marks, own picture files only", async () => {
    const file = (owner: string, id: string) => `pubky://${owner}/pub/pubky.app/files/${id}`;
    const n = nexus({ "/v0/stream/posts": () => reply(200, [
      post("0035RMX0NHSAG", { content: `Hi${BIDI} <b>there</b>`, attachments: [file(key, "0035RMX0NHQC0"), file(other, "0035RMX0NHQC1"), file(key, "0035RMX0NHQC2")] }),
      { ...post("0035RMX0NHSAH", {}, { replied: "pubky://x/pub/pubky.app/posts/1" }) },
      post("0035RMX0NHSAJ", { content: "" }, { reposted: "pubky://x/pub/pubky.app/posts/2" }),
      post("0035RMX0NHSAK", { author: other }),
      post("bad id"),
    ].map((p, i) => i === 0 ? { ...p, attachments_metadata: [
      { uri: file(key, "0035RMX0NHQC0"), content_type: "image/jpeg", name: "cat.jpg" },
      { uri: file(key, "0035RMX0NHQC2"), content_type: "application/pdf", name: "doc.pdf" },
    ] } : p)) });
    const page = await pubkyActivity.posts(key, ctxOf(n.fetch));
    expect(page.posts).toEqual([
      { id: "0035RMX0NHSAG", createdAt: 1_790_000_000, text: "Hi <b>there</b>", url: `https://pubky.app/post/${key}/0035RMX0NHSAG`, images: [{ source: { kind: "nexus", owner: key, file: "0035RMX0NHQC0" }, host: "nexus.pubky.app", alt: "cat.jpg" }] },
      { id: "0035RMX0NHSAH", createdAt: 1_790_000_000, text: "post 0035RMX0NHSAH", url: `https://pubky.app/post/${key}/0035RMX0NHSAH`, reply: true, images: [] },
    ]);
    const asked = new URL(n.asked[0]);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ source: "author", author_id: key, limit: "10", skip: "0", include_attachment_metadata: "true" });
    expect(asked.searchParams.has("viewer_id")).toBe(false);
    expect(page.cursor).toBeUndefined();
  });

  it("pages by skip; a full page offers more", async () => {
    const n = nexus({ "/v0/stream/posts": u => reply(200, Array.from({ length: 10 }, (_, i) => post(`0035RMX0N${String(i + Number(u.searchParams.get("skip"))).padStart(4, "0")}`))) });
    const first = await pubkyActivity.posts(key, ctxOf(n.fetch));
    expect(first.cursor).toBe("10");
    await pubkyActivity.posts(key, ctxOf(n.fetch), first.cursor);
    expect(new URL(n.asked[1]).searchParams.get("skip")).toBe("10");
    await pubkyActivity.posts(key, ctxOf(n.fetch), "-5; drop");
    expect(new URL(n.asked[2]).searchParams.get("skip")).toBe("0");
  });

  it("a hostile answer: not a list, deep nesting, a failure", async () => {
    for (const body of ['{"a":1}', "<html>"]) {
      const n = nexus({ "/v0/stream/posts": () => reply(200, body) });
      await expect(pubkyActivity.posts(key, ctxOf(n.fetch))).rejects.toThrow("something else");
    }
    // Nesting parses (or not) without harm: nothing in it is a post.
    const deep = nexus({ "/v0/stream/posts": () => reply(200, "[".repeat(50_000) + "]".repeat(50_000)) });
    expect((await pubkyActivity.posts(key, ctxOf(deep.fetch)).catch(() => ({ posts: [] }))).posts).toEqual([]);
    await expect(pubkyActivity.posts(key, ctxOf(nexus({ "/v0/stream/posts": () => reply(500, "") }).fetch))).rejects.toThrow("answered 500");
    expect((await pubkyActivity.posts(key, ctxOf(nexus({ "/v0/stream/posts": () => reply(404, "") }).fetch))).posts).toEqual([]);
  });

  it("follow lists: 200 per page until a short page; invalid keys dropped; a cap makes it partial", async () => {
    const keys = Array.from({ length: 250 }, () => newIdentityBinding({ provider: "pubky", subject: "x", validitySeconds: 60 }).binding.key);
    const n = nexus({
      [`/v0/user/${key}/following`]: u => reply(200, [...keys.slice(Number(u.searchParams.get("skip")), Number(u.searchParams.get("skip")) + 200), "not-a-key"].slice(0, 200)),
      [`/v0/user/${key}/followers`]: () => reply(200, Array.from({ length: 200 }, () => keys[0])),
    });
    const g = await pubkyActivity.graph(key, ctxOf(n.fetch));
    expect(g.following).toEqual(keys);
    expect(g.followingComplete).toBe(true);
    expect(g.followers).toEqual([keys[0]]);
    expect(g.followersComplete).toBe(false);
    expect(n.asked.filter(u => u.includes("/followers")).length).toBe(GRAPH_MAX / 200);
  });

  it("only exactly this author: a post by another key is dropped", () => {
    expect(pubkyPost(post("0035RMX0NHSAG", { author: other }), key)).toBeUndefined();
    expect(pubkyPost(null, key)).toBeUndefined();
    expect(pubkyPost({ details: "x" }, key)).toBeUndefined();
  });
});

describe("Bluesky: the public AppView's author feed and follow lists for exactly this DID", () => {
  const DID = "did:plc:z72i7hdynmk6r22z27h6tvur";
  const CID = "bafkreih3mb3cwnbc5kv5b2qyy24q6banms25i5ut3cbty4ej2x7vjvd6y4";
  const item = (rkey: string, record: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    post: { uri: `at://${DID}/app.bsky.feed.post/${rkey}`, author: { did: DID }, record: { $type: "app.bsky.feed.post", text: `post ${rkey}`, createdAt: "2026-09-09T15:00:07.513Z", ...record }, indexedAt: "2026-09-09T15:00:45.669Z" },
    ...extra,
  });

  it("own posts only (no reposts, no one else's), full links from facets, pictures as blobs", async () => {
    const asked: string[] = [];
    const fetch: IdentityFetch = async url => { asked.push(url); return reply(200, { cursor: "next-1", feed: [
      item("3mv3shqdfuc2e", {
        text: `See example.com/abc…${BIDI}`, facets: [{ index: { byteStart: 4, byteEnd: 22 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com/abcdef" }] }],
        embed: { $type: "app.bsky.embed.images", images: [{ alt: `Apples${BIDI}`, image: { $type: "blob", ref: { $link: CID }, mimeType: "image/jpeg", size: 1 } }, { image: { ref: { $link: CID }, mimeType: "image/gif" } }] },
      }),
      item("3mv3shqdfuc2f", {}, { reason: { $type: "app.bsky.feed.defs#reasonRepost" } }),
      { post: { ...item("3mv3shqdfuc2g").post, uri: "at://did:plc:someoneelse/app.bsky.feed.post/3mv3shqdfuc2g", author: { did: "did:plc:someoneelse" } } },
      item("3mv3shqdfuc2h", { createdAt: "2999-01-01T00:00:00Z" }),
    ] }); };
    const page = await atprotoActivity.posts(DID, ctxOf(fetch));
    expect(page.posts.map(p => p.id)).toEqual(["3mv3shqdfuc2e", "3mv3shqdfuc2h"]);
    expect(page.posts[0]).toMatchObject({ text: "See https://example.com/abcdef", url: `https://bsky.app/profile/${DID}/post/3mv3shqdfuc2e`, createdAt: Math.floor(Date.parse("2026-09-09T15:00:07.513Z") / 1000) });
    expect(page.posts[0].images).toEqual([{ source: { kind: "atproto-blob", did: DID, cid: CID }, alt: "Apples" }]);
    expect(page.posts[1].createdAt).toBeLessThanOrEqual(now() + 5 * 60);
    expect(page.cursor).toBe("next-1");
    const u = new URL(asked[0]);
    expect(u.origin + u.pathname).toBe("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed");
    expect(Object.fromEntries(u.searchParams)).toEqual({ actor: DID, limit: "10", filter: "posts_no_replies" });
  });

  it("link facets: out of range, overlapping or non-https ones are ignored", () => {
    const f = (byteStart: number, byteEnd: number, uri: string) => ({ index: { byteStart, byteEnd }, features: [{ $type: "app.bsky.richtext.facet#link", uri }] });
    expect(expandLinkFacets("go x.com now", [f(3, 8, "javascript:alert(1)")])).toBe("go x.com now");
    expect(expandLinkFacets("go x.com now", [f(3, 99, "https://x.com/a")])).toBe("go x.com now");
    expect(expandLinkFacets("go x.com now", [f(3, 8, "https://x.com/a"), f(5, 10, "https://y.com")])).toBe("go https://x.com/a now");
    expect(expandLinkFacets("é x.com", [f(3, 8, "https://x.com/é")])).toBe("é https://x.com/é");
    expect(expandLinkFacets("text", "junk")).toBe("text");
    // A range that cuts a character in half.
    expect(expandLinkFacets("a … b", [f(2, 3, "https://x.com")])).toBe("a … b");
  });

  it("a deactivated account has no posts; other failures throw", async () => {
    expect((await atprotoActivity.posts(DID, ctxOf(async () => reply(400, { error: "AccountDeactivated" })))).posts).toEqual([]);
    await expect(atprotoActivity.posts(DID, ctxOf(async () => reply(502, "")))).rejects.toThrow("Bluesky answered 502");
    expect(blueskyPost({ post: "x" }, DID)).toBeUndefined();
  });

  it("follow lists: follows and followers by cursor, until the cap", async () => {
    const asked: string[] = [];
    let n = 0;
    const fetch: IdentityFetch = async url => {
      asked.push(url);
      const u = new URL(url);
      if (u.pathname.endsWith("getFollows")) return reply(200, { follows: [{ did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" }, { did: "not a did" }] });
      return reply(200, { followers: Array.from({ length: 100 }, () => ({ did: `did:plc:${String(n++).padStart(24, "b")}` })), cursor: "more" });
    };
    const g = await atprotoActivity.graph(DID, ctxOf(fetch));
    expect(g.following).toEqual(["did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"]);
    expect(g.followingComplete).toBe(true);
    expect(g.followers).toHaveLength(GRAPH_MAX);
    expect(g.followersComplete).toBe(false);
    expect(asked.every(u => u.startsWith("https://public.api.bsky.app/xrpc/app.bsky.graph."))).toBe(true);
  });
});

describe("a post's picture, on a tap", () => {
  it("Nostr: from the fixed host, re-encoded; another host is never asked", async () => {
    const avatarFetch = vi.fn(async () => new Response(PNG));
    const r = await readPostImage({ kind: "url", url: "https://image.nostr.build/cat.png" }, ctxOf(async () => reply(500, ""), { avatarFetch: avatarFetch as unknown as typeof fetch }));
    expect(r.avatar).toMatch(/^data:image\/jpeg;base64,/);
    expect(r.hosts).toEqual(["image.nostr.build"]);
    const refused = await readPostImage({ kind: "url", url: "https://evil.test/x.png" }, ctxOf(async () => reply(500, ""), { avatarFetch: avatarFetch as unknown as typeof fetch }));
    expect(refused.miss).toMatch(/evil\.test/);
    expect(avatarFetch).toHaveBeenCalledTimes(1);
  });

  it("Pubky: the index's feed-size file", async () => {
    const asked: string[] = [];
    const r = await readPostImage({ kind: "nexus", owner: "o", file: "F" }, ctxOf(async url => { asked.push(url); return reply(200, PNG, "image/png"); }));
    expect(asked).toEqual(["https://nexus.pubky.app/static/files/o/F/feed"]);
    expect(r.avatar).toMatch(/^data:image\/jpeg/);
  });

  it("Bluesky: the blob from the account's own server, never cdn.bsky.app", async () => {
    const net = testAtprotoNetwork();
    const alice = net.account("alice", { pds: "https://pds.alice.example" });
    const fetch: IdentityFetch = async (url, init) => (new URL(url).pathname === "/xrpc/com.atproto.sync.getBlob" ? (net.asked.push(url), reply(200, PNG, "image/jpeg")) : net.fetch(url, init));
    const r = await readPostImage({ kind: "atproto-blob", did: alice.did, cid: "bafkreih3mb3cwnbc5kv5b2qyy24q6banms25i5ut3cbty4ej2x7vjvd6y4" }, ctxOf(fetch));
    expect(r.avatar).toMatch(/^data:image\/jpeg/);
    expect(r.hosts).toEqual(["pds.alice.example"]);
    expect(net.asked.some(u => u.includes("cdn.bsky.app"))).toBe(false);
  });

  it("an SVG or an HTML page is never decoded", async () => {
    const r = await readPostImage({ kind: "nexus", owner: "o", file: "F" }, ctxOf(async () => reply(200, new TextEncoder().encode("<svg onload=alert(1)>"), "image/svg+xml")));
    expect(r.avatar).toBeUndefined();
    expect(r.miss).toMatch(/an SVG/);
  });
});
