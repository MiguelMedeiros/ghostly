import { IDBFactory, IDBIndex, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredMessage } from "../src/shared/types";
// covers: storage.indexeddb

/**
 * A chat's whole history (`db.getMessages`) is read by the chat's key range, not through the `byLink` index: the same
 * rows in the same order, without the per-row lookup that made each read cost 4-9 times more on the CLI.
 */
await import("../src/engine/db");
let db: typeof import("../src/engine/db").db;

beforeEach(async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.resetModules();
  ({ db } = await import("../src/engine/db"));
}, 60_000);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const message = (linkId: string, id: string, timestamp: number): StoredMessage => ({ linkId, id, text: id, sender: "peer", timestamp, via: "datalink" });

describe("a chat's whole history", () => {
  it("is its own rows only, by time and then id, read without the byLink index", async () => {
    // Chats whose ids begin with this one's, sort just around it, or are a group's, all in the same store.
    const neighbours = ["chat", "chat-", "chat-a", "chat-b", "chat-bb", "chat-b\u0000", "chat-c", "group:chat-b", ""];
    for (const linkId of neighbours) {
      for (let i = 0; i < 25; i++) await db.putMessage(message(linkId, `m${(i * 7) % 25}`, 1_000 + Math.floor(i / 4)));
    }
    const index = vi.spyOn(IDBIndex.prototype, "getAll");

    for (const linkId of neighbours) {
      const read = await db.getMessages(linkId);
      expect(read).toHaveLength(25);
      expect(read.every((m) => m.linkId === linkId)).toBe(true);
      const order = read.map((m) => [m.timestamp, m.id] as const);
      expect(order).toEqual([...order].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
    }
    expect(await db.getMessages("nobody")).toEqual([]);
    expect(index).not.toHaveBeenCalled();
  });
});
