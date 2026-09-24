import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { IdentityDisplay } from "@ghostly/core";
import { NostrSocial, effectiveNostrSettings, type NostrSocialHost } from "../src/engine/nostrSocial";
import type { NostrContactCache, NostrSocialSettings } from "../src/nostr/types";
import { nodeSocket, TestNostrRelay } from "./helpers/nostrRelay";

const now = Math.floor(Date.now() / 1000);
const alice = generateSecretKey(), bob = generateSecretKey(), carol = generateSecretKey();
const A = getPublicKey(alice), B = getPublicKey(bob), C = getPublicKey(carol);

/** Bob's engine: Alice is a contact who shared a Nostr proof (unless `verified` says otherwise), Bob's own key is B. */
function bobsEngine(relay: TestNostrRelay, options: { settings?: Partial<NostrSocialSettings>; verified?: string[]; own?: string[]; online?: boolean; clock?: () => number } = {}) {
  const contacts: Record<string, Record<string, NostrContactCache>> = {};
  const displays: { linkId: string; subject: string; display: IdentityDisplay }[] = [];
  const state = { settings: { relays: [relay.url], autoLoadProfiles: false, publish: false, ...options.settings } as NostrSocialSettings, verified: options.verified ?? [A], own: options.own ?? [B], online: options.online ?? true };
  const host: NostrSocialHost = {
    settings: () => state.settings,
    online: () => state.online,
    emit: vi.fn(),
    ownSubjects: () => state.own,
    contactSubjects: linkId => linkId === "chat" ? state.verified : [],
    linkIds: () => ["chat"],
    readContacts: linkId => contacts[linkId],
    writeContacts: async (linkId, cache) => { contacts[linkId] = cache; },
    setDisplay: async (linkId, subject, display) => { displays.push({ linkId, subject, display }); },
    makeSocket: nodeSocket,
    now: options.clock,
  };
  const engine = new NostrSocial(host);
  return { engine, state, contacts, displays, host };
}

describe("the Nostr social layer in the engine", () => {
  const relay = new TestNostrRelay();
  beforeAll(async () => {
    await relay.listen();
    relay.add({ kind: 0, tags: [], content: JSON.stringify({ name: "alice", display_name: "Alice", about: "hi", picture: "https://image.nostr.build/alice.png", nip05: "alice@example.com" }), created_at: now - 100 }, alice);
    relay.add({ kind: 3, tags: [["p", B], ["p", C]], content: "", created_at: now - 90 }, alice);
    for (let i = 0; i < 25; i++) relay.add({ kind: 1, tags: i === 3 ? [["p", C]] : [], content: i === 5 ? "buy at the casino" : `note ${i}`, created_at: now - 1000 + i }, alice);
    relay.add({ kind: 3, tags: [["p", A], ["p", C]], content: "", created_at: now - 80 }, bob);
    relay.add({ kind: 10000, tags: [["word", "casino"], ["p", C]], content: "", created_at: now - 70 }, bob);
  });
  afterAll(() => relay.close());

  it("defaults: the public relays, nothing automatic, no publication", () => {
    expect(effectiveNostrSettings(undefined)).toEqual({ relays: ["wss://relay.damus.io", "wss://nos.lol"], autoLoadProfiles: false, publish: false });
    expect(effectiveNostrSettings({ relays: ["not a relay"], autoLoadProfiles: true, publish: true }).relays).toEqual(["wss://relay.damus.io", "wss://nos.lol"]);
  });

  it("loads nothing for a key the contact did not prove, and nothing while offline", async () => {
    const { engine } = bobsEngine(relay, { verified: [] });
    await engine.load();
    expect(engine.linkView("chat")).toBeUndefined();
    const before = relay.requests.length;
    await expect(engine.loadContact({ linkId: "chat", subject: A, what: "profile" })).rejects.toThrow(/not shared a verified Nostr identity/);
    expect(relay.requests.length).toBe(before);
    const offline = bobsEngine(relay, { online: false });
    await expect(offline.engine.loadContact({ linkId: "chat", subject: A, what: "profile" })).rejects.toThrow(/Offline/);
    expect(relay.requests.length).toBe(before);
  });

  it("profile on request: cached with source and time, the received proof gets the name, stale after a day", async () => {
    const clock = { t: Date.now() };
    const { engine, contacts, displays } = bobsEngine(relay, { clock: () => clock.t });
    await engine.load();
    expect(engine.linkView("chat")).toEqual([{ subject: A, npub: expect.stringMatching(/^npub1/) }]);
    await engine.loadContact({ linkId: "chat", subject: A, what: "profile" });
    const view = engine.linkView("chat")![0];
    expect(view.profile).toMatchObject({ found: true, stale: false, relays: [relay.url], profile: { name: "Alice", handle: "alice", about: "hi", nip05: "alice@example.com", hasPicture: true } });
    expect(view.profile!.profile!.avatar).toBeUndefined(); // no image decoding in Node: name stays usable
    expect(contacts.chat[A].profile!.profile!.picture).toBe("https://image.nostr.build/alice.png");
    expect(displays).toEqual([{ linkId: "chat", subject: A, display: { name: "Alice", source: "Nostr profile (kind 0, signed by this key, self-described)", fetchedAt: expect.any(Number) } }]);
    clock.t += 25 * 3600_000;
    expect(engine.linkView("chat")![0].profile!.stale).toBe(true);
  });

  it("follows: count and direction hints only once the person's own list is loaded", async () => {
    const { engine } = bobsEngine(relay);
    await engine.load();
    await engine.loadContact({ linkId: "chat", subject: A, what: "follows" });
    let view = engine.linkView("chat")![0];
    expect(view.follows).toMatchObject({ count: 2, eventAt: now - 90, stale: false });
    expect(view.follows!.hints).toBeUndefined();
    await engine.loadOwn({ subject: B });
    const own = engine.state().own[0];
    expect(own).toMatchObject({ subject: B, follows: { follows: [A, C] }, mute: { words: 1, pubkeys: 1, hasPrivate: false }, profile: { found: false } });
    view = engine.linkView("chat")![0];
    expect(view.follows!.hints).toEqual({ followsYou: true, youFollow: true, mutual: 1, myKey: B, myFollowsAt: expect.any(Number) });
  });

  it("notes: newest first, paginated, bounded, hidden by the person's own mute list", async () => {
    // Not loaded from storage: the previous test saved Bob's mute list there, and this one loads it on purpose below.
    const { engine } = bobsEngine(relay);
    await engine.loadContact({ linkId: "chat", subject: A, what: "notes" });
    let view = engine.linkView("chat")![0];
    expect(view.notes!.notes.length).toBe(20);
    expect(view.notes!.notes[0].content).toBe("note 24");
    expect(view.notes!.more).toBe(true);
    expect(view.notes!.hidden).toBe(0);
    await engine.loadContact({ linkId: "chat", subject: A, what: "notes", more: true });
    view = engine.linkView("chat")![0];
    expect(view.notes!.notes.length).toBe(25);
    expect(view.notes!.more).toBe(false);
    expect(relay.requests.at(-1)).toMatchObject({ kinds: [1], authors: [A], limit: 20, until: now - 1000 + 5 - 1 });
    await engine.loadOwn({ subject: B });
    view = engine.linkView("chat")![0];
    expect(view.notes!.notes.length).toBe(23);
    expect(view.notes!.hidden).toBe(2);
    expect(view.notes!.notes.some(n => n.content.includes("casino"))).toBe(false);
    expect(view.notes!.authorMuted).toBe(false);
    await engine.forgetContact({ linkId: "chat", subject: A });
    expect(engine.linkView("chat")![0].notes).toBeUndefined();
  });

  it("what a key that is no longer verified had loaded is dropped; auto-load fetches only when the setting says so", async () => {
    const { engine, state, contacts } = bobsEngine(relay);
    await engine.load();
    await engine.loadContact({ linkId: "chat", subject: A, what: "profile" });
    state.verified = [];
    await engine.ledgerChanged("chat");
    expect(contacts.chat).toEqual({});
    const before = relay.requests.length;
    state.verified = [A];
    await engine.ledgerChanged("chat");
    expect(relay.requests.length).toBe(before);
    expect(contacts.chat[A]).toBeUndefined();
    state.settings.autoLoadProfiles = true;
    await engine.ledgerChanged("chat");
    expect(relay.requests.length).toBe(before + 1);
    expect(contacts.chat[A].profile!.profile!.name).toBe("Alice");
    await engine.ledgerChanged("chat");
    expect(relay.requests.length).toBe(before + 1); // fresh: not asked again
  });

  it("publication is off by default, then a draft is confirmed and signed outside and checked against exactly what was drafted", async () => {
    const { engine, state } = bobsEngine(relay);
    await engine.load();
    await expect(engine.draft({ subject: B, action: "note", content: "hi" })).rejects.toThrow(/Publishing on Nostr is off/);
    state.settings.publish = true;
    await expect(engine.draft({ subject: A, action: "note", content: "hi" })).rejects.toThrow(/No Nostr identity with this key/);
    const draft = await engine.draft({ subject: B, action: "note", content: " hello nostr " });
    expect(draft).toMatchObject({ subject: B, template: { kind: 1, tags: [], content: "hello nostr" }, summary: "Post a note", relays: [relay.url] });
    expect(draft.notice).toMatch(/public on Nostr/);
    expect(draft.notice).toContain(relay.url);
    // Signed by another key, or changed by the signer: refused, nothing sent.
    const published = relay.published.length;
    await expect(engine.publish({ draftId: draft.draftId, event: finalizeEvent(draft.template, alice) })).rejects.toThrow(/different key/);
    await expect(engine.publish({ draftId: draft.draftId, event: finalizeEvent({ ...draft.template, content: "changed" }, bob) })).rejects.toThrow(/changed the event/);
    await expect(engine.publish({ draftId: "nope", event: finalizeEvent(draft.template, bob) })).rejects.toThrow(/too old/);
    expect(relay.published.length).toBe(published);
    const result = await engine.publish({ draftId: draft.draftId, event: finalizeEvent(draft.template, bob) });
    expect(result).toEqual({ accepted: [relay.url], rejected: [] });
    expect(relay.published.at(-1)).toMatchObject({ kind: 1, pubkey: B, content: "hello nostr" });
    // A draft is used once.
    await expect(engine.publish({ draftId: draft.draftId, event: finalizeEvent(draft.template, bob) })).rejects.toThrow(/too old/);
  });

  it("follow and unfollow rebuild the current list from the relays so nothing else is dropped; the profile update keeps unknown fields", async () => {
    const { engine, state } = bobsEngine(relay, { settings: { publish: true } });
    await engine.load();
    await expect(engine.draft({ subject: B, action: "follow", target: A })).rejects.toThrow(/Already followed/);
    await expect(engine.draft({ subject: B, action: "follow", target: B })).rejects.toThrow(/your own key/);
    const draft = await engine.draft({ subject: B, action: "unfollow", target: C });
    expect(draft.template).toMatchObject({ kind: 3, tags: [["p", A]] });
    expect(draft.summary).toMatch(/^Unfollow npub1/);
    await engine.publish({ draftId: draft.draftId, event: finalizeEvent(draft.template, bob) });
    expect(engine.state().own[0].follows!.follows).toEqual([A]);
    const again = await engine.draft({ subject: B, action: "follow", target: C });
    expect(again.template.tags).toEqual([["p", A], ["p", C]]);
    relay.add({ kind: 0, tags: [], content: JSON.stringify({ name: "bob", lud16: "bob@wallet.example" }), created_at: now - 50 }, bob);
    const profile = await engine.draft({ subject: B, action: "profile", fields: { displayName: "Bob", about: "hello" } });
    expect(JSON.parse(profile.template.content)).toEqual({ name: "bob", lud16: "bob@wallet.example", display_name: "Bob", about: "hello" });
    await engine.publish({ draftId: profile.draftId, event: finalizeEvent(profile.template, bob) });
    expect(engine.state().own[0].profile!.profile).toMatchObject({ name: "Bob", handle: "bob", about: "hello" });
    // Without a relay answering, a replaceable event is never rebuilt blind.
    state.settings.relays = ["ws://127.0.0.1:1"];
    await expect(engine.draft({ subject: B, action: "follow", target: A })).rejects.toThrow(/No relay answered/);
  });

  it("a relay that refuses everything makes the publication fail with its reason", async () => {
    const bad = new TestNostrRelay();
    await bad.listen();
    bad.behaviour = { rejectPublish: "blocked: pow" };
    try {
      const { engine } = bobsEngine(bad, { settings: { publish: true } });
      await engine.load();
      const draft = await engine.draft({ subject: B, action: "note", content: "x" });
      await expect(engine.publish({ draftId: draft.draftId, event: finalizeEvent(draft.template, bob) })).rejects.toThrow(/blocked: pow/);
    } finally { await bad.close(); }
  });
});
