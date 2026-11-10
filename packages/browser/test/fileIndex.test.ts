import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/engine/db";
import { FILE_INDEX, STORES, openDb, setDatabaseName } from "../src/shared/idb";
import type { StoredMessage } from "../src/shared/types";
// covers: storage.indexeddb

/**
 * The file index: the messages store indexes the rows that carry a file by their chat or group, so a chat's files are
 * read without its texts. The index follows the rows: an edit, a deleted message, a deleted chat or group.
 */

let n = 0;
const message = (linkId: string, fileId?: string, patch: Partial<StoredMessage> = {}): StoredMessage => ({
  linkId, id: `m${String(++n).padStart(4, "0")}`, text: fileId ? "" : "hello", sender: "peer", timestamp: 1_700_000_000_000 + n, via: "datalink",
  ...(fileId && { file: { id: fileId, name: `${fileId}.txt`, size: 1, mime: "text/plain" } }), ...patch,
});
const fileIds = async (linkId: string) => (await db.getFileMessages(linkId)).map((m) => m.file?.id);

afterEach(async () => {
  for (const id of ["chat-a", "chat-b", "chat-a-in-x"]) await db.deleteLink(id);
  await db.deleteGroup("crew");
});

describe("the file index", () => {
  it("lists one chat's or group's file rows, by time, and nothing else", async () => {
    await db.addMessage(message("chat-a"));
    await db.addMessage(message("chat-a", "chat-a-out-2", { timestamp: 1_800_000_000_000 }));
    await db.addMessage(message("chat-a", "chat-a-in-1"));
    // A chat whose id starts with the other's, and a group: neither is chat-a's.
    await db.addMessage(message("chat-a-in-x", "chat-a-in-x-in-3"));
    await db.addMessage(message("group:crew", "group-crew-in-4"));
    expect(await fileIds("chat-a")).toEqual(["chat-a-in-1", "chat-a-out-2"]);
    expect(await fileIds("group:crew")).toEqual(["group-crew-in-4"]);
    expect(await fileIds("chat-b")).toEqual([]);
  });

  it("orders rows of one time by id, as the whole history has them", async () => {
    const at = { timestamp: 1_750_000_000_000 };
    await db.addMessage(message("chat-a", "chat-a-in-z", { ...at, id: "peer_b" }));
    await db.addMessage(message("chat-a", "chat-a-in-a", { ...at, id: "peer_c" }));
    await db.addMessage(message("chat-a", "chat-a-in-m", { ...at, id: "peer_a" }));
    expect((await db.getFileMessages("chat-a")).map((m) => m.id)).toEqual((await db.getMessages("chat-a")).filter((m) => m.file).map((m) => m.id));
  });

  it("follows the rows: an edit that drops the file, a deleted message, a deleted chat and group", async () => {
    const edited = message("chat-a", "chat-a-in-1"), deleted = message("chat-a", "chat-a-in-2");
    for (const m of [edited, deleted, message("chat-a", "chat-a-in-3"), message("group:crew", "group-crew-in-4")]) await db.addMessage(m);
    await db.patchMessage("chat-a", edited.id, () => ({ file: undefined, text: "never mind" }));
    await db.deleteMessage("chat-a", deleted.id);
    expect(await fileIds("chat-a")).toEqual(["chat-a-in-3"]);
    await db.deleteLink("chat-a");
    await db.deleteGroup("crew");
    expect(await fileIds("chat-a")).toEqual([]);
    expect(await fileIds("group:crew")).toEqual([]);
  });

  it("holds the file rows alone: a long chat's texts are not in it", async () => {
    for (let i = 0; i < 300; i++) await db.addMessage(message("chat-a"));
    await db.addMessage(message("chat-a", "chat-a-in-1"));
    const messages = (await openDb()).transaction(STORES.messages, "readonly").objectStore(STORES.messages);
    const indexed = await new Promise<number>((resolve, reject) => { const r = messages.index(FILE_INDEX).count(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    expect(indexed).toBe(1);
  });
});

describe("a profile from before the index", () => {
  it("has its file rows indexed when the store is upgraded", async () => {
    const name = `ghostly-before-files-${crypto.randomUUID()}`;
    // The messages store as version 15 left it, with a file message in it.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 15);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORES.messages, { keyPath: ["linkId", "id"] });
        store.createIndex("byLink", "linkId");
        store.createIndex("byLinkTime", ["linkId", "timestamp"]);
        store.createIndex("byCardKind", "card.kind");
        store.put(message("chat-old", "chat-old-in-1"));
        store.put(message("chat-old"));
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    vi.resetModules();
    const idb = await import("../src/shared/idb");
    idb.setDatabaseName(name);
    const fresh = await import("../src/engine/db");
    try {
      expect((await fresh.db.getFileMessages("chat-old")).map((m) => m.file?.id)).toEqual(["chat-old-in-1"]);
    } finally {
      (await idb.openDb()).close();
      setDatabaseName("ghostly");
    }
  });
});
