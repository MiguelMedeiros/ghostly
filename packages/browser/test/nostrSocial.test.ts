import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { checkedEvent, normalizeNostrRelay, normalizeNostrRelays, publishToRelays, readRelays, type NostrEvent } from "../src/nostr/relay";
import {
  followHints, followsTemplate, mutedBecause, newestOf, noteTemplate, normalizePubkey, parseFollows, parseMuteList, parseNote, parseProfile, plainText, profileTemplate, MAX_NOTE_LENGTH,
} from "../src/nostr/social";
import { nodeSocket, TestNostrRelay } from "./helpers/nostrRelay";

const now = Math.floor(Date.now() / 1000);
const alice = generateSecretKey(), bob = generateSecretKey(), carol = generateSecretKey();
const A = getPublicKey(alice), B = getPublicKey(bob), C = getPublicKey(carol);
const signed = (template: { kind: number; tags?: string[][]; content: string; created_at?: number }, secret = alice): NostrEvent =>
  finalizeEvent({ kind: template.kind, tags: template.tags ?? [], content: template.content, created_at: template.created_at ?? now }, secret) as NostrEvent;

describe("parsing kinds 0, 3, 1 and 10000", () => {
  it("profile: plain text, bounded, https pictures only, by the exact key", () => {
    const e = signed({ kind: 0, content: JSON.stringify({ name: "alice", display_name: " Alice ‮ Wonder\n", about: "line one\nline two\u0007", picture: "https://image.nostr.build/a.png", nip05: "Alice@Example.COM", website: "javascript:alert(1)", lud16: "a@b.c" }) });
    const p = parseProfile(e, A)!;
    expect(p).toMatchObject({ name: "Alice  Wonder", handle: "alice", about: "line one\nline two", picture: "https://image.nostr.build/a.png", nip05: "alice@example.com", eventId: e.id, eventAt: now });
    expect(p.website).toBeUndefined();
    expect(parseProfile(e, B)).toBeUndefined();
    expect(parseProfile(signed({ kind: 0, content: "not json" }), A)).toBeUndefined();
    expect(parseProfile(signed({ kind: 0, content: JSON.stringify({ about: "x".repeat(5000) }) }), A)!.about!.length).toBe(500);
    expect(parseProfile(signed({ kind: 1, content: "{}" }), A)).toBeUndefined();
    expect(parseProfile(signed({ kind: 0, content: JSON.stringify({ picture: "http://image.nostr.build/a.png" }) }), A)!.picture).toBeUndefined();
  });
  it("follows: the p tags, deduplicated, bad entries skipped, hints and petnames ignored", () => {
    const e = signed({ kind: 3, tags: [["p", B, "wss://r", "bobby"], ["p", B], ["p", "nothex"], ["e", C], ["p", C.toUpperCase()]], content: "{}" });
    expect(parseFollows(e, A)).toEqual({ follows: [B, C], eventId: e.id, eventAt: now });
    expect(parseFollows(e, B)).toBeUndefined();
  });
  it("notes: plain text capped, reply and mentions", () => {
    const e = signed({ kind: 1, tags: [["e", "a".repeat(64)], ["p", B]], content: "hello‮ world\n\nsecond line" });
    expect(parseNote(e, A)).toEqual({ id: e.id, createdAt: now, content: "hello world\n\nsecond line", reply: true, mentions: [B] });
    expect(parseNote(signed({ kind: 1, content: "   " }), A)).toBeUndefined();
    expect(parseNote(signed({ kind: 1, content: "x".repeat(6000) }), A)!.content.length).toBe(MAX_NOTE_LENGTH);
  });
  it("mute list: public p, e and word tags; the private part is noticed, not read", () => {
    const e = signed({ kind: 10000, tags: [["p", B], ["e", "b".repeat(64)], ["word", " Spam "], ["word", ""]], content: "encrypted…" });
    expect(parseMuteList(e, A)).toMatchObject({ pubkeys: [B], eventIds: ["b".repeat(64)], words: ["spam"], hasPrivate: true });
  });
  it("mutes by author, mention, note id and word", () => {
    const mute = parseMuteList(signed({ kind: 10000, tags: [["p", B], ["e", "c".repeat(64)], ["word", "casino"]], content: "" }), A)!;
    const note = (content: string, mentions: string[] = [], id = "d".repeat(64)) => ({ id, createdAt: now, content, reply: false, mentions });
    expect(mutedBecause(note("hi"), B, mute)).toBe("author");
    expect(mutedBecause(note("hi", [B]), C, mute)).toBe("mention");
    expect(mutedBecause(note("hi", [], "c".repeat(64)), C, mute)).toBe("note");
    expect(mutedBecause(note("Best CASINO ever"), C, mute)).toBe("word");
    expect(mutedBecause(note("fine"), C, mute)).toBeUndefined();
    expect(mutedBecause(note("fine"), B, undefined)).toBeUndefined();
  });
  it("newest replaceable event wins, smaller id on a tie", () => {
    const older = signed({ kind: 0, content: '{"name":"old"}', created_at: now - 10 });
    const newer = signed({ kind: 0, content: '{"name":"new"}', created_at: now });
    const other = signed({ kind: 0, content: '{"name":"bob"}' }, bob);
    expect(newestOf([older, other, newer], 0, A)).toBe(newer);
    const tie1 = signed({ kind: 3, content: "1", created_at: now }), tie2 = signed({ kind: 3, content: "2", created_at: now });
    expect(newestOf([tie1, tie2], 3, A)!.id).toBe([tie1.id, tie2.id].sort()[0]);
  });
  it("follow hints name their direction", () => {
    expect(followHints([B, C], [A, C], [B], A)).toEqual({ followsYou: true, youFollow: true, mutual: [C] });
    expect(followHints([], [], [B], A)).toEqual({ followsYou: false, youFollow: false, mutual: [] });
  });
  it("plain text never keeps controls or bidi overrides", () => {
    expect(plainText("a\u0000b‮c⁦d", 10)).toBe("abcd");
    expect(plainText("x".repeat(1000), 10)).toBe("x".repeat(10));
    expect(plainText("x".repeat(70_000), 10)).toBeUndefined();
    expect(plainText(42, 10)).toBeUndefined();
  });
  it("public keys: npub or hex", () => {
    expect(normalizePubkey(A.toUpperCase())).toBe(A);
    expect(() => normalizePubkey("npub1notreal")).toThrow(/npub1/);
  });
});

describe("relay addresses", () => {
  it("accepts wss and loopback ws, refuses the rest", () => {
    expect(normalizeNostrRelay(" wss://relay.damus.io/ ")).toBe("wss://relay.damus.io");
    expect(normalizeNostrRelay("ws://127.0.0.1:4444")).toBe("ws://127.0.0.1:4444");
    for (const bad of ["ws://relay.damus.io", "https://relay.damus.io", "wss://u:p@relay.damus.io", "wss://relay.damus.io/#x", "wss://relay.damus.io/?a=1", "", "relay"]) expect(() => normalizeNostrRelay(bad)).toThrow();
    expect(normalizeNostrRelays(["wss://a.example", "wss://a.example/"])).toEqual(["wss://a.example"]);
    expect(() => normalizeNostrRelays([])).toThrow(/at least one/);
    expect(() => normalizeNostrRelays(Array.from({ length: 9 }, (_, i) => `wss://r${i}.example`))).toThrow(/At most 8/);
  });
});

describe("publication templates", () => {
  it("a note is plain text within the limit", () => {
    expect(noteTemplate("  hello‮\n", now)).toEqual({ kind: 1, created_at: now, tags: [], content: "hello" });
    expect(() => noteTemplate("   ", now)).toThrow(/Write something/);
    expect(() => noteTemplate("x".repeat(MAX_NOTE_LENGTH + 1), now)).toThrow(/at most/);
  });
  it("a follow list keeps every other tag and the legacy content, refuses no-ops", () => {
    const current = signed({ kind: 3, tags: [["p", B, "wss://r", "bobby"], ["t", "topic"]], content: '{"wss://r":{"read":true}}' });
    expect(followsTemplate(current, C, true, now)).toEqual({ kind: 3, created_at: now, tags: [["p", B, "wss://r", "bobby"], ["t", "topic"], ["p", C]], content: current.content });
    expect(followsTemplate(current, B, false, now).tags).toEqual([["t", "topic"]]);
    expect(() => followsTemplate(current, B, true, now)).toThrow(/Already/);
    expect(() => followsTemplate(current, C, false, now)).toThrow(/Not followed/);
    expect(followsTemplate(undefined, C, true, now)).toEqual({ kind: 3, created_at: now, tags: [["p", C]], content: "" });
  });
  it("a profile keeps fields it does not know, removes with an empty string, validates the rest", () => {
    const current = signed({ kind: 0, content: JSON.stringify({ name: "alice", lud16: "a@b.c", banner: "https://x/y" }) });
    const t = profileTemplate(current, { displayName: "Alice", about: "", website: "https://alice.example", picture: "" }, now);
    expect(JSON.parse(t.content)).toEqual({ name: "alice", lud16: "a@b.c", banner: "https://x/y", display_name: "Alice", website: "https://alice.example/" });
    expect(() => profileTemplate(current, { website: "ftp://x" }, now)).toThrow(/website/);
    expect(() => profileTemplate(current, { nip05: "nope" }, now)).toThrow(/NIP-05/);
    expect(profileTemplate(undefined, { name: "new" }, now).content).toBe('{"name":"new"}');
  });
});

describe("the relay client", () => {
  const relay = new TestNostrRelay();
  const bad = new TestNostrRelay();
  beforeAll(async () => { await relay.listen(); await bad.listen(); });
  afterAll(async () => { await relay.close(); await bad.close(); });

  it("checks events strictly on a copy: shape, bounds, id and signature", () => {
    const e = signed({ kind: 1, content: "ok" });
    expect(checkedEvent(e)).toEqual(e);
    expect(checkedEvent({ ...e, content: "changed" })).toBeUndefined();
    expect(checkedEvent({ ...e, sig: "0".repeat(128) })).toBeUndefined();
    expect(checkedEvent({ ...e, created_at: now + 3600 })).toBeUndefined();
    expect(checkedEvent({ ...e, content: "x".repeat(20 * 1024) })).toBeUndefined();
    expect(checkedEvent("nope")).toBeUndefined();
    const flagged = { ...e, content: "forged", [Symbol.for("verified")]: true };
    expect(checkedEvent(flagged)).toBeUndefined();
  });

  it("reads until EOSE, verifies, deduplicates across relays and reports who answered", async () => {
    relay.add({ kind: 0, tags: [], content: '{"name":"Alice"}', created_at: now - 5 }, alice);
    relay.add({ kind: 1, tags: [], content: "first", created_at: now - 3 }, alice);
    relay.add({ kind: 1, tags: [], content: "second", created_at: now - 2 }, alice);
    relay.add({ kind: 1, tags: [], content: "bob's", created_at: now - 1 }, bob);
    const result = await readRelays([relay.url, "ws://127.0.0.1:1", relay.url.replace("ws://", "ws://") + "/"], { kinds: [1], authors: [A] }, { makeSocket: nodeSocket, timeoutMs: 3000 });
    expect(result.events.map(e => e.content)).toEqual(["second", "first"]);
    expect(result.answered).toEqual([relay.url, relay.url + "/"]);
    expect(result.failed).toEqual(["ws://127.0.0.1:1"]);
    expect(relay.requests.at(-1)).toEqual({ kinds: [1], authors: [A] });
  });

  it("an oversize frame ends that relay's read; a relay that never says EOSE times out as answered only if it sent something", async () => {
    bad.behaviour = { oversizeFrame: true };
    let result = await readRelays([bad.url], { kinds: [1], authors: [A] }, { makeSocket: nodeSocket, timeoutMs: 2000 });
    expect(result.events).toEqual([]);
    expect(result.failed).toEqual([bad.url]);
    bad.behaviour = { eose: false };
    bad.add({ kind: 1, tags: [], content: "late", created_at: now }, alice);
    const started = Date.now();
    result = await readRelays([bad.url], { kinds: [1], authors: [A] }, { makeSocket: nodeSocket, timeoutMs: 1000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(result.events.map(e => e.content)).toEqual(["late"]);
    expect(result.answered).toEqual([bad.url]);
    bad.behaviour = { eose: true };
  });

  it("stops at the event budget and honours abort", async () => {
    for (let i = 0; i < 10; i++) relay.add({ kind: 1, tags: [], content: `n${i}`, created_at: now - 100 + i }, carol);
    const result = await readRelays([relay.url], { kinds: [1], authors: [C] }, { makeSocket: nodeSocket, maxEvents: 4 });
    expect(result.events.length).toBe(4);
    const controller = new AbortController();
    controller.abort();
    await expect(readRelays([relay.url], { kinds: [1] }, { makeSocket: nodeSocket, signal: controller.signal })).rejects.toThrow();
  });

  it("publishes and reads back the OK, reporting refusals per relay", async () => {
    const e = signed({ kind: 1, content: "posted" }, carol);
    bad.behaviour = { rejectPublish: "blocked: no" };
    const result = await publishToRelays([relay.url, bad.url, "ws://127.0.0.1:1"], e, { makeSocket: nodeSocket, timeoutMs: 2000 });
    expect(result.accepted).toEqual([relay.url]);
    expect(result.rejected).toEqual(expect.arrayContaining([{ relay: bad.url, reason: "blocked: no" }, { relay: "ws://127.0.0.1:1", reason: expect.any(String) }]));
    expect(relay.published.at(-1)!.id).toBe(e.id);
    bad.behaviour = { silentPublish: true };
    const silent = await publishToRelays([bad.url], e, { makeSocket: nodeSocket, timeoutMs: 500 });
    expect(silent.rejected).toEqual([{ relay: bad.url, reason: "No answer from the relay" }]);
    bad.behaviour = { eose: true };
  });
});
