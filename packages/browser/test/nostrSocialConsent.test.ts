import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { NostrSocial, type NostrSocialHost } from "../src/engine/nostrSocial";
import type { NostrContactCache, NostrSocialSettings } from "../src/nostr/types";
import { nodeSocket, TestNostrRelay } from "./helpers/nostrRelay";
// covers: nostr.social.profile, nostr.social.notes, nostr.social.publish, nostr.social.no-proof

/**
 * The Nostr social layer's consent rules and failure paths (the happy paths are in
 * nostrSocialEngine.test.ts): nothing fetched for a key that is not proven now, nothing automatic
 * unless the setting says so, nothing published once publication is off (even from an older draft),
 * and what the person sees when relays do not answer.
 */

const now = Math.floor(Date.now() / 1000);
const alice = generateSecretKey(), bob = generateSecretKey(), carol = generateSecretKey(), dave = generateSecretKey();
const A = getPublicKey(alice), B = getPublicKey(bob), C = getPublicKey(carol), D = getPublicKey(dave);
const DEAD = "ws://127.0.0.1:1";

function bobsEngine(relay: TestNostrRelay, options: { settings?: Partial<NostrSocialSettings>; verified?: string[] } = {}) {
  const contacts: Record<string, Record<string, NostrContactCache>> = {};
  const writes = { count: 0 };
  const state = { settings: { relays: [relay.url], autoLoadProfiles: false, publish: false, ...options.settings } as NostrSocialSettings, verified: options.verified ?? [A], own: [B], online: true };
  const host: NostrSocialHost = {
    settings: () => state.settings,
    online: () => state.online,
    emit: vi.fn(),
    ownSubjects: () => state.own,
    contactSubjects: linkId => linkId === "chat" ? state.verified : [],
    linkIds: () => ["chat"],
    readContacts: linkId => contacts[linkId],
    writeContacts: async (linkId, cache) => { writes.count++; contacts[linkId] = cache; },
    setDisplay: async () => {},
    makeSocket: nodeSocket,
  };
  return { engine: new NostrSocial(host), state, contacts, writes };
}

describe("Nostr social: consent and failures", () => {
  const relay = new TestNostrRelay();
  beforeAll(async () => {
    await relay.listen();
    relay.add({ kind: 0, tags: [], content: JSON.stringify({ name: "alice", website: "https://alice.example/", nip05: "alice@example.com" }), created_at: now - 100 }, alice);
    for (let i = 0; i < 3; i++) relay.add({ kind: 1, tags: [], content: `carol ${i}`, created_at: now - 500 + i }, carol);
    relay.add({ kind: 10000, tags: [["p", C]], content: "", created_at: now - 70 }, bob);
  });
  afterAll(() => relay.close());
  afterEach(() => { vi.useRealTimers(); });

  it("with auto-load on but the network off, a chat opening fetches nothing", async () => {
    const { engine, state, contacts } = bobsEngine(relay, { settings: { autoLoadProfiles: true } });
    state.online = false;
    const before = relay.requests.length;
    await engine.ledgerChanged("chat");
    expect(relay.requests.length).toBe(before);
    expect(contacts.chat).toBeUndefined();
  });

  it("a key that stops being verified while its profile loads: what arrives is not kept", async () => {
    const { engine, state, contacts } = bobsEngine(relay);
    const loading = engine.loadContact({ linkId: "chat", subject: A, what: "profile" });
    expect(engine.linkView("chat")![0].loading).toBe("profile");
    state.verified = [];
    await loading;
    expect(contacts.chat).toBeUndefined();
  });

  it("the same request twice while in flight asks the relays once", async () => {
    const { engine } = bobsEngine(relay);
    const before = relay.requests.length;
    await Promise.all([engine.loadContact({ linkId: "chat", subject: A, what: "follows" }), engine.loadContact({ linkId: "chat", subject: A, what: "follows" })]);
    expect(relay.requests.length).toBe(before + 1);
    await Promise.all([engine.loadOwn({ subject: B }), engine.loadOwn({ subject: B })]);
    expect(relay.requests.length).toBe(before + 2);
  });

  it("a key with nothing published shows as not found, with no follows, and the profile fields that exist", async () => {
    const { engine } = bobsEngine(relay, { verified: [A, D] });
    await engine.loadContact({ linkId: "chat", subject: D, what: "profile" });
    await engine.loadContact({ linkId: "chat", subject: D, what: "follows" });
    const [a, d] = [engine.linkView("chat")!.find(v => v.subject === A)!, engine.linkView("chat")!.find(v => v.subject === D)!];
    expect(d.profile).toMatchObject({ found: false });
    expect(d.profile!.profile).toBeUndefined();
    expect(d.follows).toMatchObject({ count: 0, eventAt: 0 });
    expect(a.profile).toBeUndefined();
    await engine.loadContact({ linkId: "chat", subject: A, what: "profile" });
    expect(engine.linkView("chat")!.find(v => v.subject === A)!.profile!.profile).toMatchObject({ website: "https://alice.example/", nip05: "alice@example.com", hasPicture: false });
  });

  it("when no relay answers, the person sees why and nothing is cached; forgetting the chat clears the message", async () => {
    const { engine, contacts } = bobsEngine({ url: DEAD } as TestNostrRelay);
    for (const what of ["profile", "follows", "notes"] as const) {
      await expect(engine.loadContact({ linkId: "chat", subject: A, what })).rejects.toThrow(/No relay answered/);
      expect(engine.linkView("chat")![0]).toMatchObject({ error: "No relay answered" });
      expect(engine.linkView("chat")![0].loading).toBeUndefined();
    }
    expect(contacts.chat).toBeUndefined();
    await expect(engine.loadOwn({ subject: B })).rejects.toThrow(/No relay answered/);
    expect(engine.state().own[0]).toMatchObject({ subject: B, error: "No relay answered" });
    expect(engine.state().own[0].loading).toBeUndefined();
    engine.forgetLink("chat");
    expect(engine.linkView("chat")![0].error).toBeUndefined();
  });

  it("the person's own data is loaded only for a key of theirs, and only online", async () => {
    const { engine, state } = bobsEngine(relay);
    const before = relay.requests.length;
    await expect(engine.loadOwn({ subject: A })).rejects.toThrow(/No Nostr identity with this key/);
    state.online = false;
    await expect(engine.loadOwn({ subject: B })).rejects.toThrow(/Offline/);
    expect(relay.requests.length).toBe(before);
    state.online = true;
    const loading = engine.loadOwn({ subject: B });
    expect(engine.state().own[0].loading).toBe(true);
    await loading;
  });

  it("an author the person muted has every note hidden", async () => {
    const { engine } = bobsEngine(relay, { verified: [C] });
    await engine.loadOwn({ subject: B });
    await engine.loadContact({ linkId: "chat", subject: C, what: "notes" });
    expect(engine.linkView("chat")![0].notes).toMatchObject({ notes: [], hidden: 3, authorMuted: true, more: false });
  });

  it("forgetting what was never loaded writes nothing", async () => {
    const { engine, writes } = bobsEngine(relay);
    await engine.forgetContact({ linkId: "chat", subject: A });
    expect(writes.count).toBe(0);
  });

  it("a draft made while publication was on is not published once it is off", async () => {
    const { engine, state } = bobsEngine(relay, { settings: { publish: true } });
    const draft = await engine.draft({ subject: B, action: "note", content: "hello" });
    state.settings.publish = false;
    const published = relay.published.length;
    await expect(engine.publish({ draftId: draft.draftId, event: finalizeEvent(draft.template, bob) })).rejects.toThrow(/Publishing on Nostr is off/);
    state.settings.publish = true;
    state.online = false;
    await expect(engine.publish({ draftId: draft.draftId, event: finalizeEvent(draft.template, bob) })).rejects.toThrow(/Offline/);
    expect(relay.published.length).toBe(published);
  });

  it("refuses an unknown action, and anything the signer returns that is not a signed event", async () => {
    const { engine } = bobsEngine(relay, { settings: { publish: true } });
    await expect(engine.draft({ subject: B, action: "delete" } as never)).rejects.toThrow(/Unknown action/);
    const draft = await engine.draft({ subject: B, action: "note", content: "hello" });
    const unsigned = { ...draft.template, pubkey: B, id: "0".repeat(64), sig: "0".repeat(128) };
    await expect(engine.publish({ draftId: draft.draftId, event: unsigned })).rejects.toThrow(/did not return a valid signed event/);
    await expect(engine.publish({ draftId: draft.draftId, event: "not an event" })).rejects.toThrow(/did not return a valid signed event/);
  });

  it("drafts expire after ten minutes, at most eight wait, and stopping the engine drops them", async () => {
    const { engine } = bobsEngine(relay, { settings: { publish: true } });
    vi.useFakeTimers({ toFake: ["Date"] });
    const old = await engine.draft({ subject: B, action: "note", content: "old" });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await expect(engine.publish({ draftId: old.draftId, event: finalizeEvent(old.template, bob) })).rejects.toThrow(/too old/);
    const drafts = [];
    for (let i = 0; i < 9; i++) drafts.push(await engine.draft({ subject: B, action: "note", content: `n${i}` }));
    await expect(engine.publish({ draftId: drafts[0].draftId, event: finalizeEvent(drafts[0].template, bob) })).rejects.toThrow(/too old/);
    engine.stop();
    await expect(engine.publish({ draftId: drafts[8].draftId, event: finalizeEvent(drafts[8].template, bob) })).rejects.toThrow(/too old/);
  });

  it("a profile update starts from the newest of what the relays hold and what this app last published", async () => {
    const { engine } = bobsEngine(relay, { settings: { publish: true } });
    const first = await engine.draft({ subject: B, action: "profile", fields: { displayName: "Bob", about: "one" } });
    // The signer must sign exactly the draft, its time included; signed as drafted, it goes out and is remembered.
    await expect(engine.publish({ draftId: first.draftId, event: finalizeEvent({ ...first.template, created_at: first.template.created_at + 5 }, bob) })).rejects.toThrow(/changed the event/);
    await engine.publish({ draftId: first.draftId, event: finalizeEvent(first.template, bob) });
    const second = await engine.draft({ subject: B, action: "profile", fields: { about: "two" } });
    expect(JSON.parse(second.template.content)).toMatchObject({ display_name: "Bob", about: "two" });
    expect(engine.state().own[0].profile).toMatchObject({ found: true, profile: { about: "one" } });
  });
});
