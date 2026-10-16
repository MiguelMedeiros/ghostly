import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatInvite, knockSlotIdentity, knockSlotOf, linkRecords, readContactLink, readKnockSlot, readLinkRecord, REQUEST_LIFETIME_MS, type GhostRecord } from "@ghostly/core";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import { ContactLinks } from "../src/engine/contactLinks";
import { ASK_FAST_MS, CONTACT_ASKS_KEY, ContactAsks } from "../src/engine/contactAsks";

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
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
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
