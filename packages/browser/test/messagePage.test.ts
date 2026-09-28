import { IDBFactory, IDBIndex, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredMessage } from "../src/shared/types";
// covers: storage.indexeddb

/**
 * A page of a chat's history, read from the newest back (`db.getMessagePage`): the pages, walked to the oldest, are
 * exactly the whole history `getMessages` reads, in its order.
 */
await import("../src/engine/db");
let db: typeof import("../src/engine/db").db;

beforeEach(async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.resetModules();
  ({ db } = await import("../src/engine/db"));
}, 60_000);
afterEach(() => vi.unstubAllGlobals());

const message = (linkId: string, id: string, timestamp: number): StoredMessage => ({ linkId, id, text: id, sender: "peer", timestamp, via: "datalink" });
/** A seeded shuffle, so a failure replays. */
function shuffled<T>(items: T[], seed = 7): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
/** Every page from the newest back, joined oldest first. */
async function walk(linkId: string, limit: number): Promise<{ ids: string[]; pages: number }> {
  let page = await db.getMessagePage(linkId, { limit });
  const pages = [page.messages];
  while (page.more) {
    const first = page.messages[0]!;
    page = await db.getMessagePage(linkId, { limit, before: first });
    pages.unshift(page.messages);
  }
  return { ids: pages.flat().map((m) => m.id), pages: pages.length };
}

const getAllRecords = Object.getOwnPropertyDescriptor(IDBIndex.prototype, "getAllRecords")!;

describe.each([
  ["one descending read", true],
  ["a cursor, where IndexedDB reads only forward", false],
])("a page of history, by %s", (_, descending) => {
  beforeEach(() => { if (!descending) Reflect.deleteProperty(IDBIndex.prototype, "getAllRecords"); });
  afterEach(() => { Object.defineProperty(IDBIndex.prototype, "getAllRecords", getAllRecords); });

  it("is the newest messages, oldest first, and the pages reach the oldest in getMessages' order", async () => {
    // Many share a time (ties go by id, as getMessages has them); two other chats sit around this one in the store.
    const chat = Array.from({ length: 237 }, (_, i) => message("chat-b", `m${(i * 37) % 1000}`, 1_000 + Math.floor(i / 3)));
    const around = ["chat-a", "chat-c", "group:g1"].flatMap((linkId) => Array.from({ length: 40 }, (_, i) => message(linkId, `x${i}`, 1_000 + i)));
    for (const m of shuffled([...chat, ...around])) await db.putMessage(m);

    const all = (await db.getMessages("chat-b")).map((m) => m.id);
    expect(all).toHaveLength(237);
    const newest = await db.getMessagePage("chat-b", { limit: 50 });
    expect(newest.messages.map((m) => m.id)).toEqual(all.slice(-50));
    expect(newest.more).toBe(true);
    for (const limit of [1, 7, 50, 236, 237, 500]) {
      const walked = await walk("chat-b", limit);
      expect(walked.ids).toEqual(all);
      expect(walked.pages).toBe(Math.max(1, Math.ceil(237 / limit)));
    }
  });

  it("before a time holds only what is older than it; before a message, what comes before it", async () => {
    for (const [id, at] of [["a", 1], ["b", 2], ["c", 2], ["d", 3]] as const) await db.putMessage(message("chat", id, at));
    expect(await db.getMessagePage("chat", { limit: 10, before: { timestamp: 2 } })).toEqual({ messages: [expect.objectContaining({ id: "a" })], more: false });
    const beforeC = await db.getMessagePage("chat", { limit: 1, before: { timestamp: 2, id: "c" } });
    expect(beforeC.messages.map((m) => m.id)).toEqual(["b"]);
    expect(beforeC.more).toBe(true);
    expect(await db.getMessagePage("chat", { limit: 10, before: { timestamp: 1, id: "a" } })).toEqual({ messages: [], more: false });
    expect(await db.getMessagePage("nobody", { limit: 10 })).toEqual({ messages: [], more: false });
    expect((await db.getMessage("chat", "c"))?.timestamp).toBe(2);
    expect(await db.getMessage("chat", "zz")).toBeUndefined();
  });

  it("works on a database kept before pages (v8): the upgrade indexes the history already there", async () => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("ghostly", 8);
      open.onupgradeneeded = () => {
        const messages = open.result.createObjectStore("messages", { keyPath: ["linkId", "id"] });
        messages.createIndex("byLink", "linkId");
        for (let i = 0; i < 30; i++) messages.put(message("old", `m${i}`, 100 - i));
      };
      open.onsuccess = () => { open.result.close(); resolve(); };
      open.onerror = () => reject(open.error);
    });
    const page = await db.getMessagePage("old", { limit: 5 });
    expect(page.messages.map((m) => m.id)).toEqual(["m4", "m3", "m2", "m1", "m0"]);
    expect((await walk("old", 4)).ids).toEqual((await db.getMessages("old")).map((m) => m.id));
  });
});
