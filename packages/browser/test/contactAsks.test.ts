import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChatInvite, createIdentity, createRelayPayload, encodeContactLink, identityFromSeed, knockSlotIdentity, knockSlotOf, linkRecords, parseRelayPayload,
  readContactLink, readKnockSlot, readLinkRecord, REQUEST_LIFETIME_MS, type GhostRecord, type Identity,
} from "@ghostly/core";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import { ContactLinks } from "../src/engine/contactLinks";
import { ASK_FAST_MS, CONTACT_ASKS_KEY, ContactAsks } from "../src/engine/contactAsks";

/** The next asker key the requester makes, when a test needs one it knows. */
const askers: { next?: Identity } = {};
vi.mock("@ghostly/core", async importOriginal => {
  const real = await importOriginal<typeof import("@ghostly/core")>();
  return { ...real, createIdentity: () => { const next = askers.next; askers.next = undefined; return next ?? real.createIdentity(); } };
});

vi.mock("../src/engine/paymentAdapters/persistence", async importOriginal => {
  const real = await importOriginal<typeof import("../src/engine/paymentAdapters/persistence")>();
  const mix = (bytes: Uint8Array, password: string) => bytes.map((b, i) => b ^ password.charCodeAt(i % password.length));
  return {
    ...real,
    sealSeed: async (seed: string, password: string) => ({ version: 1, salt: [], iv: [], ciphertext: [...mix(new TextEncoder().encode(seed), password)] }),
    unsealSeed: async (sealed: { ciphertext: number[] }, password: string) => new TextDecoder().decode(mix(new Uint8Array(sealed.ciphertext), password)),
  };
});

const NOW = Date.UTC(2026, 9, 16, 12);

/**
 * An owner and a requester on one in-memory Pkarr. The two profiles keep their records apart in one database the way
 * two apps would, since each reads and writes only its own key of the settings store.
 */
function world() {
  const pkarr = new Map<string, GhostRecord[]>();
  const chats: { linkId: string; inviteCode: string; label?: string; text: string }[] = [];
  /** The requester's own links: another profile than the owner's. */
  const ownLinks = new Set<string>();
  const reads: string[] = [];
  const common = {
    online: () => true,
    emit: () => {},
    publish: async (identity: { pubKeyZ32: string }, records: GhostRecord[]) => { pkarr.set(identity.pubKeyZ32, records); },
    resolve: async (key: string) => { reads.push(key); return pkarr.get(key) ?? null; },
  };
  const owner = new ContactLinks({ ...common, ownInvite: () => false, accept: async () => "accepted" });
  const requester = new ContactAsks({
    ...common,
    createChat: async ({ label, text }) => {
      // A real invite, so the request holds: the core checks it reads as one.
      const chat = { linkId: `chat-${chats.length + 1}`, inviteCode: createChatInvite().inviteCode, ...(label ? { label } : {}), text };
      chats.push(chat);
      return { linkId: chat.linkId, inviteCode: chat.inviteCode };
    },
    ownLink: key => ownLinks.has(key),
  });
  return { pkarr, chats, owner, requester, ownLinks, reads };
}

/** Runs an engine call that waits on its own timers (the knock is read back a second later). */
async function settled<T>(work: Promise<T>): Promise<T> {
  let done = false;
  void work.finally(() => { done = true; }).catch(() => {});
  for (let i = 0; i < 20 && !done; i++) await vi.advanceTimersByTimeAsync(1_000);
  return work;
}

const keyOf = (code: string) => { const r = readContactLink(code); if (!r.ok) throw new Error(r.reason); return r.linkKeyZ32; };

beforeEach(async () => {
  // A fake `performance` too: the paced stamp then never sees its slice end and is made at once, as these tests expect.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  vi.setSystemTime(NOW);
  await transact([STORES.settings], stores => { stores[STORES.settings].clear(); });
});
afterEach(() => { vi.useRealTimers(); });

describe("asking through a contact link (WISP 8xx)", () => {
  it("a request reaches the owner's Requests, and the requester learns it arrived and nothing else", async () => {
    const w = world();
    await w.owner.load();
    await w.requester.load();
    const { code } = await w.owner.create();
    const { chatId } = await settled(w.requester.ask({ code, name: "Kevin", text: "Hi! I read your site.", label: "Alice's site" }));
    expect(w.chats).toEqual([expect.objectContaining({ linkId: chatId, label: "Alice's site", text: "Hi! I read your site." })]);
    // The chat is answered before the stamp and the publishing, which come right after as the first look.
    await settled(w.requester.tick());
    expect(w.requester.views()).toEqual([{ chatId, state: "knocking", expires: NOW + REQUEST_LIFETIME_MS }]);
    await w.owner.poll();
    expect(w.owner.requests()).toEqual([expect.objectContaining({ name: "Kevin", text: "Hi! I read your site." })]);
    vi.setSystemTime(NOW + ASK_FAST_MS);
    await settled(w.requester.tick());
    expect(w.requester.views()[0].state).toBe("seen");
    // Seen: nothing more goes out for it.
    const before = new Map(w.pkarr);
    vi.setSystemTime(NOW + 2 * ASK_FAST_MS);
    await settled(w.requester.tick());
    expect(w.pkarr).toEqual(before);
    // With no answer, it ends after its seven days, seen or not.
    vi.setSystemTime(NOW + REQUEST_LIFETIME_MS);
    await settled(w.requester.tick());
    expect(w.requester.views()[0].state).toBe("ended");
  });

  it("answers with the chat before the stamp is made or anything goes out", async () => {
    const w = world();
    await w.owner.load();
    await w.requester.load();
    const { code } = await w.owner.create();
    const before = w.pkarr.size;
    let answered = false;
    const asking = w.requester.ask({ code, name: "Kevin", text: "hi" }).then((r) => { answered = true; return r; });
    const { chatId } = await asking;
    expect(answered).toBe(true);
    expect(w.requester.views()).toEqual([{ chatId, state: "sending", expires: NOW + REQUEST_LIFETIME_MS }]);
    expect(w.pkarr.size).toBe(before);
    await settled(w.requester.tick());
    expect(w.pkarr.size).toBeGreaterThan(before);
  });

  it("knocks again when someone wiped its knock", async () => {
    const w = world();
    await w.owner.load();
    await w.requester.load();
    const { code } = await w.owner.create();
    const link = keyOf(code);
    await settled(w.requester.ask({ code, name: "Kevin", text: "Hello" }));
    const asks = await wrap<{ key: string }[]>((await store(STORES.settings, "readonly")).get(CONTACT_ASKS_KEY));
    const slot = knockSlotIdentity(link, knockSlotOf(link, asks[0].key)).pubKeyZ32;
    w.pkarr.delete(slot);
    vi.setSystemTime(NOW + ASK_FAST_MS);
    await settled(w.requester.tick());
    expect(readKnockSlot(link, w.pkarr.get(slot)!).map(k => k.key)).toEqual([asks[0].key]);
  });

  it("refuses a link turned off, a busy one, its own, and a second request while one waits", async () => {
    const w = world();
    await w.owner.load();
    await w.requester.load();
    const { code } = await w.owner.create();
    w.ownLinks.add(keyOf(code));
    await expect(w.requester.ask({ code, name: "Me", text: "hi" })).rejects.toThrow("This is your contact link.");
    const other = world();
    await other.owner.load();
    const theirs = await other.owner.create();
    w.pkarr.set(keyOf(theirs.code), linkRecords({ state: "busy", bits: 18, seen: [] }));
    await expect(w.requester.ask({ code: theirs.code, name: "Kevin", text: "hi" })).rejects.toThrow("not taking requests right now");
    w.pkarr.set(keyOf(theirs.code), linkRecords({ state: "off", bits: 18, seen: [] }));
    await expect(w.requester.ask({ code: theirs.code, name: "Kevin", text: "hi" })).rejects.toThrow("turned off");
    w.pkarr.set(keyOf(theirs.code), linkRecords({ state: "open", bits: 18, seen: [] }));
    await settled(w.requester.ask({ code: theirs.code, name: "Kevin", text: "hi" }));
    await expect(w.requester.ask({ code: theirs.code, name: "Kevin", text: "again" })).rejects.toThrow("already sent a request");
    expect(w.chats).toHaveLength(1);
  });

  it("deleting the request's chat takes it back: nothing more goes out, the owner finds no request, and asking again is open", async () => {
    const w = world();
    await w.owner.load();
    await w.requester.load();
    const { code } = await w.owner.create();
    const link = keyOf(code);
    const { chatId } = await settled(w.requester.ask({ code, name: "Kevin", text: "Hi! I read your site." }));
    await settled(w.requester.tick());
    const [{ key }] = await wrap<{ key: string }[]>((await store(STORES.settings, "readonly")).get(CONTACT_ASKS_KEY));
    expect(w.pkarr.get(key)).toBeDefined();
    await w.requester.forgetChat(chatId);
    expect(w.requester.views()).toEqual([]);
    // The request under the asker key is gone: an owner who had not read it yet finds nothing to take. An empty packet
    // is one a relay takes and a reader reads as no records.
    expect(w.pkarr.get(key)).toEqual([]);
    const empty = createIdentity();
    expect(parseRelayPayload(empty.pubKeyZ32, createRelayPayload(empty, [])).records).toEqual([]);
    await w.owner.poll();
    expect(w.owner.requests()).toEqual([]);
    // Nothing more goes out for it: no request again, no knock again when the knock is wiped.
    w.pkarr.delete(knockSlotIdentity(link, knockSlotOf(link, key)).pubKeyZ32);
    const before = new Map(w.pkarr);
    vi.setSystemTime(NOW + ASK_FAST_MS);
    await settled(w.requester.tick());
    expect(w.pkarr).toEqual(before);
    // Asking again is open, under the same asker key.
    const again = await settled(w.requester.ask({ code, name: "Kevin", text: "Hi again" }));
    expect(again.chatId).not.toBe(chatId);
    await settled(w.requester.tick());
    // The owner read that key, empty, a moment ago: it reads it again an hour later (WISP 8xx § Taking requests).
    vi.setSystemTime(NOW + 60 * 60_000 + ASK_FAST_MS);
    await w.owner.poll();
    expect(w.owner.requests()).toEqual([expect.objectContaining({ id: key, text: "Hi again" })]);
  });

  it("a deleted chat that no request made changes nothing", async () => {
    const w = world();
    await w.owner.load();
    await w.requester.load();
    const { code } = await w.owner.create();
    const { chatId } = await settled(w.requester.ask({ code, name: "Kevin", text: "hi" }));
    await w.requester.forgetChat("another-chat");
    expect(w.requester.views()).toEqual([expect.objectContaining({ chatId })]);
  });

  it("a name or text that does not fit makes no chat", async () => {
    const w = world();
    await w.owner.load();
    await w.requester.load();
    const { code } = await w.owner.create();
    await expect(w.requester.ask({ code, name: "x".repeat(49), text: "hi" })).rejects.toThrow("name of up to 48");
    await expect(w.requester.ask({ code, name: "Kevin", text: "\"".repeat(200) })).rejects.toThrow("Shorten the message.");
    await expect(w.requester.ask({ code: "ghostly1qqqq", name: "Kevin", text: "hi" })).rejects.toThrow("not a Ghostly contact link");
    expect(w.chats).toEqual([]);
  });

  it("with no answer in seven days it ends, and asking again goes under the same asker key", async () => {
    const w = world();
    await w.owner.load();
    await w.requester.load();
    const other = world();
    await other.owner.load();
    const { code } = await other.owner.create();
    w.pkarr.set(keyOf(code), other.pkarr.get(keyOf(code))!);
    await settled(w.requester.ask({ code, name: "Kevin", text: "hi" }));
    const first = (await wrap<{ key: string }[]>((await store(STORES.settings, "readonly")).get(CONTACT_ASKS_KEY)))[0].key;
    vi.setSystemTime(NOW + REQUEST_LIFETIME_MS);
    await settled(w.requester.tick());
    expect(w.requester.views()[0].state).toBe("ended");
    expect(readLinkRecord(w.pkarr.get(keyOf(code))!)?.state).toBe("open");
    await settled(w.requester.ask({ code, name: "Kevin", text: "hi again" }));
    const again = await wrap<{ key: string; state: string }[]>((await store(STORES.settings, "readonly")).get(CONTACT_ASKS_KEY));
    expect(again).toEqual([expect.objectContaining({ key: first, state: "knocking" })]);
  });

  it("makes the stamp without holding the thread: the page's other tasks run while it is made", async () => {
    const w = world();
    await w.requester.load();
    // For this link, asker key and day the first 20-bit stamp is 505,622: about a second of hashing in one go.
    const link = identityFromSeed(new Uint8Array(32).fill(3)).pubKeyZ32;
    w.pkarr.set(link, linkRecords({ state: "open", bits: 20, seen: [] }));
    askers.next = identityFromSeed(new Uint8Array(32).fill(7));
    // Real timers, so the stamp runs in real time; the day stays the one the stamp above is for.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    // A task that posts itself again, as the page's input, drawing and port messages come one task at a time.
    let last = performance.now(), longest = 0, running = true;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const at = performance.now();
      longest = Math.max(longest, at - last);
      last = at;
      if (running) channel.port2.postMessage(null);
    };
    channel.port2.postMessage(null);
    await w.requester.ask({ code: encodeContactLink(link), name: "Kevin", text: "hi" });
    // Behind the first look the answer started.
    await w.requester.tick();
    running = false;
    channel.port1.close();
    const [ask] = await wrap<{ stamp: { stamp: number } }[]>((await store(STORES.settings, "readonly")).get(CONTACT_ASKS_KEY));
    expect(ask.stamp.stamp).toBe(505_622);
    expect(w.requester.views()[0].state).toBe("knocking");
    expect(longest).toBeLessThan(250);
  });

  it("looks at the link every 30 s while it waits to be seen", async () => {
    const w = world();
    await w.owner.load();
    await w.requester.load();
    const other = world();
    await other.owner.load();
    const { code } = await other.owner.create();
    w.pkarr.set(keyOf(code), other.pkarr.get(keyOf(code))!);
    await settled(w.requester.ask({ code, name: "Kevin", text: "hi" }));
    w.requester.start();
    const looks = () => w.reads.filter(key => key === keyOf(code)).length;
    const first = looks();
    for (let i = 1; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(ASK_FAST_MS);
      expect(looks()).toBe(first + i);
    }
    w.requester.stop();
  });
});
