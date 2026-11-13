import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/engine/db";
import { FRAME_INDEX, STORES, openDb, setDatabaseName } from "../src/shared/idb";
import type { StoredMessage } from "../src/shared/types";
// covers: storage.indexeddb

/**
 * The frame index: the messages store indexes a group's rows that hold the frame their message came in, so a group's
 * start takes the frames it hands on without its whole history. The index follows the rows: a frame given up or taken
 * again, a deleted message, a deleted group.
 */

let n = 0;
const frame = (text: string) => ({ t: "group-msg", g: "crew", e: 0, s: "member", n: n, ts: 1, nn: "nonce", c: text, sig: "sig" });
const message = (linkId: string, framed: boolean, patch: Partial<StoredMessage> = {}): StoredMessage => ({
  linkId, id: `m${String(++n).padStart(4, "0")}`, text: "hello", sender: "peer", timestamp: 1_700_000_000_000 + n, via: "datalink",
  ...(framed && { frame: frame(`c${n}`) }), ...patch,
});
const framedIds = async (linkId: string) => (await db.getFramedMessages(linkId)).map((m) => m.id);
const indexed = async () => {
  const messages = (await openDb()).transaction(STORES.messages, "readonly").objectStore(STORES.messages);
  return new Promise<number>((resolve, reject) => { const r = messages.index(FRAME_INDEX).count(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
};

afterEach(async () => {
  for (const id of ["chat-a"]) await db.deleteLink(id);
  for (const id of ["crew", "crew2"]) await db.deleteGroup(id);
});

describe("the frame index", () => {
  it("lists one group's rows that hold a frame, by time, with their frames, and nothing else", async () => {
    const late = message("group:crew", true, { timestamp: 1_800_000_000_000 });
    const first = message("group:crew", true);
    await db.addMessage(late);
    await db.addMessage(message("group:crew", false));
    await db.addMessage(first);
    // Another group whose id starts with the first's, and a 1:1 chat: neither is the group's.
    await db.addMessage(message("group:crew2", true));
    await db.addMessage(message("chat-a", false));
    const rows = await db.getFramedMessages("group:crew");
    expect(rows.map((m) => m.id)).toEqual([first.id, late.id]);
    expect(rows.map((m) => m.frame)).toEqual([first.frame, late.frame]);
    expect(await db.getFramedMessages("group:nobody")).toEqual([]);
  });

  it("orders rows of one time by id, as the whole history has them", async () => {
    const at = { timestamp: 1_750_000_000_000 };
    for (const id of ["peer_b", "peer_c", "peer_a"]) await db.addMessage(message("group:crew", true, { ...at, id }));
    expect(await framedIds("group:crew")).toEqual((await db.getMessages("group:crew")).filter((m) => m.frame).map((m) => m.id));
  });

  it("follows the rows: a frame given up and taken again, a deleted message, a deleted group", async () => {
    const givenUp = message("group:crew", true), taken = message("group:crew", false), deleted = message("group:crew", true), kept = message("group:crew", true);
    for (const m of [givenUp, taken, deleted, kept]) await db.addMessage(m);
    // As the engine's `forgetFrame` and `keepFrame` patch them.
    await db.patchMessage("group:crew", givenUp.id, (stored) => stored.frame ? { frame: undefined } : null, true);
    await db.patchMessage("group:crew", taken.id, () => ({ frame: frame("again") }), true);
    await db.deleteMessage("group:crew", deleted.id);
    expect(await framedIds("group:crew")).toEqual([taken.id, kept.id]);
    await db.deleteGroup("crew");
    expect(await framedIds("group:crew")).toEqual([]);
  });

  it("holds the framed rows alone: a long history's other rows are not in it", async () => {
    for (let i = 0; i < 300; i++) await db.addMessage(message("group:crew", false));
    await db.addMessage(message("group:crew", true));
    expect(await indexed()).toBe(1);
  });
});

describe("a profile from before the index", () => {
  it("has its framed rows indexed when the store is upgraded", async () => {
    const name = `ghostly-before-frames-${crypto.randomUUID()}`;
    const framed = message("group:old", true), plain = message("group:old", false);
    // The messages store as version 16 left it, with a framed row in it.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 16);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORES.messages, { keyPath: ["linkId", "id"] });
        store.createIndex("byLink", "linkId");
        store.createIndex("byLinkTime", ["linkId", "timestamp"]);
        store.createIndex("byCardKind", "card.kind");
        store.createIndex("byLinkFile", ["linkId", "file.id"]);
        store.put(framed);
        store.put(plain);
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    vi.resetModules();
    const idb = await import("../src/shared/idb");
    idb.setDatabaseName(name);
    const fresh = await import("../src/engine/db");
    try {
      expect((await fresh.db.getFramedMessages("group:old")).map((m) => m.id)).toEqual([framed.id]);
    } finally {
      (await idb.openDb()).close();
      setDatabaseName("ghostly");
    }
  });
});
