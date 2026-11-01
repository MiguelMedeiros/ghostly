import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import { STORES, transact } from "../src/shared/idb";
import { NostrSocial } from "../src/engine/nostrSocial";
import type { NostrContactCache, NostrOwnCache } from "../src/nostr/types";
// covers: nostr.social.follows, nostr.social.notes

/**
 * `linkView` runs for each chat in every engine state, whether or not the contact's card is open: what it works out of
 * lists of thousands is kept until a list behind it changes.
 */
const hex = (n: number) => n.toString(16).padStart(64, "0");
const ME = hex(1), THEM = hex(2), FRIEND = hex(3), NOISY = hex(4);
const fetched = { fetchedAt: Math.floor(Date.now() / 1000), relays: ["wss://relay.test"] };
const note = (n: number, content: string, mentions: string[] = []) => ({ id: hex(100 + n), createdAt: n, content, reply: false, mentions });

const ownCache = (follows: string[], words: string[]) => ({
  [ME]: {
    subject: ME,
    follows: { ...fetched, follows },
    mute: { ...fetched, list: { pubkeys: [NOISY], eventIds: [], words, eventId: hex(5), eventAt: 1, hasPrivate: false } },
  },
}) as unknown as Record<string, NostrOwnCache>;
const putOwn = (own: Record<string, NostrOwnCache>) => transact([STORES.settings], stores => { stores[STORES.settings].put(own, "nostrSocial"); });

function engine() {
  const contacts = { [THEM]: {
    subject: THEM,
    follows: { ...fetched, follows: [ME, FRIEND], eventId: hex(6), eventAt: 1 },
    notes: { ...fetched, exhausted: true, notes: [note(1, "hello"), note(2, "buy at the casino"), note(3, "quiet", [NOISY])] },
  } } as unknown as Record<string, NostrContactCache>;
  const ownSubjects = vi.fn(() => [ME]);
  const social = new NostrSocial({
    settings: () => undefined, online: () => true, emit: () => {}, ownSubjects, contactSubjects: () => [THEM], linkIds: () => ["chat"],
    readContacts: () => contacts, writeContacts: async () => {}, setDisplay: async () => {},
  });
  return { social, ownSubjects, contacts };
}

beforeEach(() => putOwn(ownCache([THEM, FRIEND], ["casino"])));

it("asks for the person's keys a fixed number of times per state, however many posts the contact has", async () => {
  const { social, ownSubjects } = engine();
  await social.load();
  ownSubjects.mockClear();
  social.linkView("chat");
  expect(ownSubjects.mock.calls.length).toBeLessThanOrEqual(2);
});

it("keeps the shown posts between states, until a list behind them changes", async () => {
  const { social, contacts } = engine();
  await social.load();
  const first = social.linkView("chat")![0];
  expect(first.notes).toMatchObject({ hidden: 2 });
  expect(first.notes!.notes.map(n => n.content)).toEqual(["hello"]);
  expect(first.follows!.hints).toEqual({ followsYou: true, youFollow: true, mutual: 1, myKey: ME, myFollowsAt: fetched.fetchedAt });

  const second = social.linkView("chat")![0];
  expect(second.notes!.notes).toBe(first.notes!.notes);
  expect(second.follows!.hints).toBe(first.follows!.hints);

  // The person's own lists loaded again: fewer words muted, nobody followed.
  await putOwn(ownCache([], []));
  await social.load();
  const reloaded = social.linkView("chat")![0];
  expect(reloaded.notes).toMatchObject({ hidden: 1 });
  expect(reloaded.notes!.notes.map(n => n.content)).toEqual(["hello", "buy at the casino"]);
  expect(reloaded.follows!.hints).toMatchObject({ youFollow: false, mutual: 0 });

  // The contact's posts loaded again.
  contacts[THEM] = { ...contacts[THEM], notes: { ...fetched, exhausted: true, notes: [note(4, "new")] } } as NostrContactCache;
  expect(social.linkView("chat")![0].notes!.notes.map(n => n.content)).toEqual(["new"]);
});
