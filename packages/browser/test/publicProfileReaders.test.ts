import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { newIdentityBinding } from "@ghostly/core";
import type { IdentityFetch, IdentityFetchResponse } from "../src/proofs/contract";
import { atprotoReader, nostrReader, pubkyReader, hasPublicProfile, PUBLIC_PROFILE_READERS, type ReaderContext } from "../src/profiles/readers";
import { nodeSocket, TestNostrRelay } from "./helpers/nostrRelay";
import { testAtprotoNetwork } from "./helpers/atprotoNetwork";
// covers: proofs.public-profile, proofs.public-profile.picture, proofs.public-profile.nostr, proofs.public-profile.pubky, proofs.public-profile.atproto, profiles.picture.sanitize

vi.setConfig({ testTimeout: 20_000 });

/** A 1×1 PNG header: enough for the dimension check; decoding is stubbed. */
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
const SVG = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
/** What nexus.pubky.app/static/avatar/{id} answers (checked 2026-09-26): an extended WebP. */
const WEBP_EXTENDED = new Uint8Array(readFileSync(new URL("../../../e2e/support/avatar-fixtures/avatar-extended.webp", import.meta.url)));

/** createImageBitmap/OffscreenCanvas as a browser has them: every decode is counted, every encode is a tiny JPEG. */
function stubCanvas() {
  const decoded = vi.fn(async () => ({ close() {} }));
  vi.stubGlobal("createImageBitmap", decoded);
  vi.stubGlobal("OffscreenCanvas", class { getContext() { return { drawImage() {} }; } async convertToBlob() { return new Blob([new Uint8Array([255, 216, 255, 217])], { type: "image/jpeg" }); } });
  return decoded;
}
beforeEach(() => { stubCanvas(); });
afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body: unknown, contentType = "application/json"): IdentityFetchResponse => {
  const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  return { status, contentType, text: new TextDecoder().decode(bytes), bytes };
};
const ctxOf = (fetch: IdentityFetch, extra: Partial<ReaderContext> = {}): ReaderContext =>
  ({ fetch, signal: new AbortController().signal, relays: [], ...extra });
const JPEG_DATA = /^data:image\/jpeg;base64,/;

describe("which identities have a public profile", () => {
  it("only Nostr, Pubky and Bluesky; nothing else is ever looked up", () => {
    expect(Object.keys(PUBLIC_PROFILE_READERS).sort()).toEqual(["atproto", "nostr", "pubky"]);
    for (const p of ["domain", "openpgp", "oidc", "ssh", "bitcoin", "did", "constructor", "__proto__"]) expect(hasPublicProfile(p)).toBe(false);
  });
});

describe("Nostr: signed kind-0 of exactly this key, following = the follow list's size", () => {
  let relay: TestNostrRelay;
  const secret = generateSecretKey(), key = getPublicKey(secret);
  beforeEach(async () => { relay = new TestNostrRelay(); await relay.listen(); });
  afterEach(async () => { await relay.close(); });
  const avatarFetch = vi.fn(async () => new Response(PNG));
  const ctx = () => ctxOf(async () => { throw new Error("no HTTP for Nostr"); }, { relays: [relay.url], makeSocket: nodeSocket, avatarFetch: avatarFetch as unknown as typeof fetch });
  const now = () => Math.floor(Date.now() / 1000);

  it("reads the profile, its picture from a fixed host, and counts the follows; no followers are invented", async () => {
    relay.add({ kind: 0, created_at: now() - 10, tags: [], content: JSON.stringify({ name: "alice", display_name: "Alice\u202e\u0007 Liddell", about: "Down the\nrabbit hole", picture: "https://image.nostr.build/a.png" }) }, secret);
    const follows = Array.from({ length: 3 }, () => ["p", getPublicKey(generateSecretKey())]);
    relay.add({ kind: 3, created_at: now() - 5, tags: [...follows, follows[0], ["e", "x"]], content: "" }, secret);
    const p = await nostrReader.read(key, ctx());
    expect(p).toMatchObject({ found: true, name: "Alice Liddell", handle: "alice", about: "Down the\nrabbit hole", following: 3, hosts: [new URL(relay.url).host, "image.nostr.build"] });
    expect(p.followers).toBeUndefined();
    expect(p.avatar).toMatch(JPEG_DATA);
    expect(avatarFetch).toHaveBeenCalledTimes(1);
    expect(relay.requests.every(f => f.authors?.length === 1 && f.authors[0] === key)).toBe(true);
  });

  it("the website is an https link or nothing", async () => {
    relay.add({ kind: 0, created_at: now(), tags: [], content: JSON.stringify({ name: "w", website: "javascript:alert(1)" }) }, secret);
    expect((await nostrReader.read(key, ctx())).website).toBeUndefined();
    relay.add({ kind: 0, created_at: now() + 1, tags: [], content: JSON.stringify({ name: "w", website: "https://alice.example/" }) }, secret);
    expect((await nostrReader.read(key, ctx())).website).toBe("https://alice.example/");
  });

  it("a picture on any other host is not fetched: the card keeps its mark", async () => {
    avatarFetch.mockClear();
    relay.add({ kind: 0, created_at: now(), tags: [], content: JSON.stringify({ name: "bob", picture: "https://evil.test/track.png" }) }, secret);
    const p = await nostrReader.read(key, ctx());
    expect(p.name).toBe("bob");
    expect(p.avatar).toBeUndefined();
    expect(p.avatarMiss).toBe("it is on evil.test, a host this app does not load pictures from");
    expect(p.hosts).toEqual([new URL(relay.url).host]);
    expect(avatarFetch).not.toHaveBeenCalled();
  });

  it("a forged event, another key's event and an oversized one are not a profile", async () => {
    const real = relay.add({ kind: 0, created_at: now() - 100, tags: [], content: JSON.stringify({ name: "real" }) }, secret);
    relay.events.push({ ...real, id: real.id, created_at: now(), content: JSON.stringify({ name: "forged" }) });
    const other = generateSecretKey();
    const theirs = relay.add({ kind: 0, created_at: now(), tags: [], content: JSON.stringify({ name: "someone else" }) }, other);
    relay.events.push({ ...theirs, pubkey: key });
    expect((await nostrReader.read(key, ctx())).name).toBe("real");
    relay.events.length = 0;
    relay.add({ kind: 0, created_at: now(), tags: [], content: JSON.stringify({ name: "big", about: "x".repeat(9000) }) }, secret);
    expect(await nostrReader.read(key, ctx())).toEqual({ found: false, hosts: [new URL(relay.url).host] });
  });

  it("no relay answering is a failure (a kept copy stays), not an empty profile", async () => {
    await expect(nostrReader.read(key, ctxOf(async () => reply(500, ""), { relays: ["ws://127.0.0.1:1"], makeSocket: nodeSocket }))).rejects.toThrow("No relay answered");
  });

  it("a subject that is not a Nostr key asks nobody", async () => {
    expect(await nostrReader.read("npub1xyz", ctx())).toEqual({ found: false, hosts: [] });
    expect(relay.requests).toEqual([]);
  });
});

describe("Pubky: the index's details and counts for exactly this key", () => {
  const key = newIdentityBinding({ provider: "pubky", subject: "x", validitySeconds: 60 }).binding.key;
  const other = newIdentityBinding({ provider: "pubky", subject: "x", validitySeconds: 60 }).binding.key;
  const nexus = (routes: Record<string, () => IdentityFetchResponse>) => {
    const asked: string[] = [];
    const fetch: IdentityFetch = async url => { asked.push(url); const r = routes[url.replace(`https://nexus.pubky.app`, "")]; if (!r) throw new TypeError("Failed to fetch"); return r(); };
    return { asked, fetch };
  };

  it("name, bio, picture from the official avatar route, followers and following", async () => {
    const n = nexus({
      [`/v0/user/${key}/details`]: () => reply(200, { id: key, name: "Pat\u2066", bio: "Builds\u0000 things", image: "pubky://x/pub/pubky.app/files/1", links: [], indexed_at: 1 }),
      [`/v0/user/${key}/counts`]: () => reply(200, { followers: 12, following: 7, friends: 3, posts: 99 }),
      [`/static/avatar/${key}`]: () => reply(200, PNG, "image/png"),
    });
    const p = await pubkyReader.read(key, ctxOf(n.fetch));
    expect(p).toMatchObject({ found: true, name: "Pat", about: "Builds things", followers: 12, following: 7, hosts: ["nexus.pubky.app"] });
    expect(p.avatar).toMatch(JPEG_DATA);
    expect(n.asked.every(u => u.startsWith("https://nexus.pubky.app/"))).toBe(true);
  });

  it("the website is the first https link the profile lists", async () => {
    const n = nexus({
      [`/v0/user/${key}/details`]: () => reply(200, { id: key, name: "Pat", links: [{ title: "x", url: "http://plain.example" }, { title: "y", url: "https://pat.example/" }] }),
      [`/v0/user/${key}/counts`]: () => reply(404, ""),
    });
    expect((await pubkyReader.read(key, ctxOf(n.fetch))).website).toBe("https://pat.example/");
  });

  it("the avatar as the real index serves it: an extended WebP (VP8X) whatever was uploaded", async () => {
    const decoded = stubCanvas();
    const n = nexus({
      [`/v0/user/${key}/details`]: () => reply(200, { id: key, name: "Pat", image: "pubky://x/pub/pubky.app/files/0035N3QJCY3SG", links: [], indexed_at: 1 }),
      [`/v0/user/${key}/counts`]: () => reply(404, ""),
      [`/static/avatar/${key}`]: () => reply(200, WEBP_EXTENDED, "image/webp"),
    });
    const p = await pubkyReader.read(key, ctxOf(n.fetch));
    expect(p.avatar).toMatch(JPEG_DATA);
    expect(p.avatarMiss).toBeUndefined();
    expect((decoded.mock.calls[0] as unknown as [Blob])[0].type).toBe("image/webp");
    const missing = nexus({ [`/v0/user/${key}/details`]: () => reply(200, { id: key, name: "Pat", image: "x" }), [`/static/avatar/${key}`]: () => reply(404, "") });
    expect(await pubkyReader.read(key, ctxOf(missing.fetch))).toMatchObject({ found: true, name: "Pat", avatarMiss: "nexus.pubky.app answered 404" });
  });

  it("an answer for another key is refused; a deleted or unindexed account has no profile", async () => {
    await expect(pubkyReader.read(key, ctxOf(nexus({ [`/v0/user/${key}/details`]: () => reply(200, { id: other, name: "Mallory" }) }).fetch))).rejects.toThrow("another key");
    expect(await pubkyReader.read(key, ctxOf(nexus({ [`/v0/user/${key}/details`]: () => reply(200, { id: key, name: "Gone", deleted: true }) }).fetch))).toEqual({ found: false, hosts: ["nexus.pubky.app"] });
    expect(await pubkyReader.read(key, ctxOf(nexus({ [`/v0/user/${key}/details`]: () => reply(404, { error: "not found" }) }).fetch))).toEqual({ found: false, hosts: ["nexus.pubky.app"] });
  });

  it("asks with the size caps, and drops broken counts, a name that is only the key, an SVG picture", async () => {
    const caps: (number | undefined)[] = [];
    const decoded = stubCanvas();
    const routes: Record<string, () => IdentityFetchResponse> = {
      [`/v0/user/${key}/details`]: () => reply(200, { id: key, name: key, image: "x" }),
      [`/v0/user/${key}/counts`]: () => reply(200, { followers: -1, following: 2 ** 60 }),
      [`/static/avatar/${key}`]: () => reply(200, SVG, "image/svg+xml"),
    };
    const fetch: IdentityFetch = async (url, init) => { caps.push(init?.maxBytes); return routes[url.replace("https://nexus.pubky.app", "")](); };
    const p = await pubkyReader.read(key, ctxOf(fetch));
    expect(p).toEqual({ found: true, hosts: ["nexus.pubky.app"], avatarMiss: "it is an SVG; only PNG, JPEG and WebP pictures are shown" });
    expect(decoded).not.toHaveBeenCalled();
    expect(caps).toEqual([16 * 1024, 16 * 1024, 2 * 1024 * 1024]);
  });

  it("an oversized or unreachable index is a failure", async () => {
    await expect(pubkyReader.read(key, ctxOf(async () => { throw new Error("Identity check response too large"); }))).rejects.toThrow("too large");
    await expect(pubkyReader.read(key, ctxOf(async () => reply(502, "")))).rejects.toThrow("502");
    await expect(pubkyReader.read("not-a-key", ctxOf(async () => { throw new Error("asked"); }))).resolves.toEqual({ found: false, hosts: [] });
  });
});

describe("Bluesky: the public AppView for exactly this DID, the picture from the account's own server", () => {
  const CID = "bafkreihwihm6kpd6zuwhhlro75p5qks5qtrcu55jp3gddbfjsieiv7wuka";
  function network(profile: (did: string) => IdentityFetchResponse, blob: () => IdentityFetchResponse = () => reply(200, PNG, "image/jpeg")) {
    const net = testAtprotoNetwork();
    const alice = net.account("alice", { pds: "https://pds.alice.example" });
    const fetch: IdentityFetch = async (url, init) => {
      const u = new URL(url);
      if (u.origin === "https://public.api.bsky.app" && u.pathname === "/xrpc/app.bsky.actor.getProfile") { net.asked.push(url); return profile(u.searchParams.get("actor")!); }
      if (u.pathname === "/xrpc/com.atproto.sync.getBlob") { net.asked.push(url); return blob(); }
      return net.fetch(url, init);
    };
    return { net, alice, fetch };
  }
  const answer = (did: string, extra: Record<string, unknown> = {}) => reply(200, {
    did, handle: "alice.example.com", displayName: "Alice", description: "Hello\u202e there", followersCount: 1204, followsCount: 87, postsCount: 3,
    avatar: `https://cdn.bsky.app/img/avatar/plain/${did}/${CID}@jpeg`, ...extra,
  });

  it("name, handle, bio, counts; the picture's blob from the account's server, never cdn.bsky.app", async () => {
    const { net, alice, fetch } = network(answer);
    const p = await atprotoReader.read(alice.did, ctxOf(fetch));
    expect(p).toMatchObject({ found: true, name: "Alice", handle: "@alice.example.com", about: "Hello there", followers: 1204, following: 87, hosts: ["public.api.bsky.app", "pds.alice.example"] });
    expect(p.avatar).toMatch(JPEG_DATA);
    expect(net.asked.some(u => u.startsWith(`https://pds.alice.example/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(alice.did)}&cid=${CID}`))).toBe(true);
    expect(net.asked.some(u => u.includes("cdn.bsky.app"))).toBe(false);
  });

  it("an answer about another account is refused", async () => {
    const { alice, fetch } = network(() => answer("did:plc:z72i7hdynmk6r22z27h6tvur"));
    await expect(atprotoReader.read(alice.did, ctxOf(fetch))).rejects.toThrow("another account");
  });

  it("an invalid handle, broken counts and an avatar named for another DID or host are dropped", async () => {
    for (const avatar of [`https://cdn.bsky.app/img/avatar/plain/did:plc:z72i7hdynmk6r22z27h6tvur/${CID}@jpeg`, `https://evil.test/img/avatar/plain/x/${CID}`, "javascript:alert(1)"]) {
      const { net, alice, fetch } = network(did => answer(did, { handle: "handle.invalid", followersCount: "many", followsCount: -3, avatar }));
      const p = await atprotoReader.read(alice.did, ctxOf(fetch));
      expect(p).toEqual({ found: true, name: "Alice", about: "Hello there", hosts: ["public.api.bsky.app"], avatarMiss: "Bluesky named it at an address this app does not read" });
      expect(net.asked.some(u => u.includes("getBlob"))).toBe(false);
    }
  });

  it("a server on a private address is not asked for the picture; the rest still shows", async () => {
    const { net, alice, fetch } = network(answer);
    net.zone.a!["pds.alice.example"] = ["10.0.0.7"];
    const p = await atprotoReader.read(alice.did, ctxOf(fetch));
    expect(p).toMatchObject({ found: true, name: "Alice", hosts: ["public.api.bsky.app"], avatarMiss: "the account's server could not be asked for it" });
    expect(p.avatar).toBeUndefined();
    expect(net.asked.some(u => u.includes("getBlob"))).toBe(false);
  });

  it("an unknown account has no profile; a failing AppView is a failure", async () => {
    const { alice, fetch } = network(() => reply(400, { error: "InvalidRequest", message: "Profile not found" }));
    expect(await atprotoReader.read(alice.did, ctxOf(fetch))).toEqual({ found: false, hosts: ["public.api.bsky.app"] });
    const down = network(() => reply(503, ""));
    await expect(atprotoReader.read(down.alice.did, ctxOf(down.fetch))).rejects.toThrow("503");
  });
});
