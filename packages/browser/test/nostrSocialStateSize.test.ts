import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { STORES, transact } from "../src/shared/idb";
import { NostrSocial } from "../src/engine/nostrSocial";
import { MAX_FOLLOWS, MAX_NOTES_KEPT } from "../src/nostr/social";
import type { NostrContactCache, NostrOwnCache } from "../src/nostr/types";
// covers: nostr.social.follows, nostr.social.notes

/**
 * Every engine state carries `state()` and each chat's `linkView`, and the extension's port sends each state as JSON:
 * a follow list and a contact's posts at their limits stay out of it (counts only) and are read by a call when shown.
 */
const hex = (n: number) => n.toString(16).padStart(64, "0");
const ME = hex(1), THEM = hex(2);
const fetched = { fetchedAt: Math.floor(Date.now() / 1000), relays: ["wss://relay.test"] };
const follows = Array.from({ length: MAX_FOLLOWS }, (_, i) => hex(1000 + i));
const words = "Nostr posts are plain text, capped at four thousand characters, and these stand in for a typical one. ".repeat(3).slice(0, 290);
const notes = Array.from({ length: MAX_NOTES_KEPT }, (_, i) => ({ id: hex(100_000 + i), createdAt: 1_000_000 - i, content: words, reply: false, mentions: [] }));

async function engine() {
  const own = { [ME]: { subject: ME, follows: { ...fetched, follows }, mute: { ...fetched, list: { pubkeys: [], eventIds: [], words: [], eventId: hex(5), eventAt: 1, hasPrivate: false } } } } as unknown as Record<string, NostrOwnCache>;
  await transact([STORES.settings], stores => { stores[STORES.settings].put(own, "nostrSocial"); });
  const contacts = { [THEM]: {
    subject: THEM,
    follows: { ...fetched, follows, eventId: hex(6), eventAt: 1 },
    notes: { ...fetched, exhausted: true, notes },
  } } as unknown as Record<string, NostrContactCache>;
  const social = new NostrSocial({
    settings: () => undefined, online: () => true, emit: () => {}, ownSubjects: () => [ME], contactSubjects: l => l === "chat" ? [THEM] : [], linkIds: () => ["chat"],
    readContacts: () => contacts, writeContacts: async () => {}, setDisplay: async () => {},
  });
  await social.load();
  return social;
}

it("keeps a 2,000-key follow list and 200 posts out of the engine state and the chat's view, and gives them by a call", async () => {
  const social = await engine();
  const state = JSON.stringify(social.state()).length, view = JSON.stringify(social.linkView("chat")).length;
  expect(state).toBeLessThan(2048);
  expect(view).toBeLessThan(2048);

  expect(social.state().own[0].follows).toMatchObject({ count: MAX_FOLLOWS });
  expect(social.linkView("chat")![0].notes).toMatchObject({ count: MAX_NOTES_KEPT, hidden: 0, more: false, authorMuted: false });

  expect(social.ownFollowList({ subject: ME })).toEqual(follows);
  const shown = social.contactNotes({ linkId: "chat", subject: THEM });
  expect(shown).toHaveLength(MAX_NOTES_KEPT);
  expect(shown[0]).toEqual({ id: notes[0].id, createdAt: notes[0].createdAt, content: words, reply: false });
  // A key nobody proved in this chat, or one that is not the person's: nothing.
  expect(social.contactNotes({ linkId: "other", subject: THEM })).toEqual([]);
  expect(social.ownFollowList({ subject: THEM })).toEqual([]);
});
