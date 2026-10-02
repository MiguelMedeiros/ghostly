import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readStatusCard, statusCardText, type StatusCard } from "@ghostly/core";
import { db } from "../src/engine/db";
import { GhostlyNode } from "../src/engine/node";
import { CARD_INDEX, STORES, openDb, setDatabaseName } from "../src/shared/idb";
import type { StoredMessage } from "../src/shared/types";
// covers: chat.tasks-board

/**
 * The card index (WISP 4xx · Status Cards § The Tasks board): the messages store indexes the rows that carry a card,
 * so the Tasks board reads every task and routine of the profile, from its 1:1 chats, private groups and communities,
 * without reading a chat's history. The index follows the rows: an edit, a deleted message, a deleted chat or group.
 */

const card = (extra: Record<string, unknown> = {}): StatusCard => readStatusCard({ kind: "task", id: "relay", title: "Fix relay rotation", status: "running", ...extra })!;
let n = 0;
const message = (linkId: string, c: StatusCard | undefined, patch: Partial<StoredMessage> = {}): StoredMessage => ({
  linkId, id: `m${++n}`, text: c ? statusCardText(c) : "hello", sender: "peer", timestamp: 1_700_000_000_000 + n, via: "datalink", ...(c && { card: c }), ...patch,
});
const node = () => new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() }, { automaticWallets: false });
const ids = async () => (await node().statusCardIndex()).map((row) => `${row.linkId}/${row.card.id}`);

const links = ["chat-a", "chat-b"], groups = ["mesh-1", "community-1"];
afterEach(async () => {
  for (const id of links) await db.deleteLink(id);
  for (const id of groups) await db.deleteGroup(id);
});

describe("the card index", () => {
  it("lists the cards of 1:1 chats, private groups and communities, oldest first, and nothing else", async () => {
    await db.addMessage(message("chat-a", undefined));
    await db.addMessage(message("chat-a", card({ id: "relay" })));
    await db.addMessage(message("group:mesh-1", card({ id: "docs", status: "queued" }), { member: "member-hermes" }));
    await db.addMessage(message("group:community-1", card({ id: "nightly", kind: "routine", name: "Nightly", schedule: "every day 01:00", state: "active" }), { member: "member-coordinator" }));
    await db.addMessage(message("chat-b", card({ id: "mine", status: "done" }), { sender: "me" }));
    // A message with buttons is a card on the wire, but not a status the board follows.
    await db.addMessage(message("chat-b", readStatusCard({ kind: "buttons", id: "ask", buttons: [{ id: "yes", label: "Yes" }] })!));

    const rows = await node().statusCardIndex();
    expect(rows.map((row) => [row.linkId, row.card.kind, row.card.id, row.sender, row.member])).toEqual([
      ["chat-a", "task", "relay", "peer", undefined],
      ["group:mesh-1", "task", "docs", "peer", "member-hermes"],
      ["group:community-1", "routine", "nightly", "peer", "member-coordinator"],
      ["chat-b", "task", "mine", "me", undefined],
    ]);
    // Only what the board needs of a message: not its text, its details or its delivery.
    expect(Object.keys(rows[0]).sort()).toEqual(["card", "id", "linkId", "sender", "timestamp"]);
  });

  it("follows an edit: the card of the latest version, and when it was made", async () => {
    const sent = message("chat-a", card({ status: "running", progress: 40 }));
    await db.addMessage(sent);
    await db.patchMessage("chat-a", sent.id, () => ({ card: card({ status: "done", progress: 100 }), edit: { seq: 1, at: sent.timestamp + 60_000, history: [] } }));
    const [row] = await node().statusCardIndex();
    expect(row.card).toMatchObject({ status: "done", progress: 100 });
    expect(row.editedAt).toBe(sent.timestamp + 60_000);

    // An edit that leaves the message a text takes it out of the index.
    await db.patchMessage("chat-a", sent.id, () => ({ card: undefined, text: "never mind" }));
    expect(await node().statusCardIndex()).toEqual([]);
  });

  it("forgets the cards of a deleted message, a deleted chat and a forgotten group", async () => {
    const one = message("chat-a", card({ id: "one" }));
    await db.addMessage(one);
    await db.addMessage(message("chat-a", card({ id: "two" })));
    await db.addMessage(message("chat-b", card({ id: "three" })));
    await db.addMessage(message("group:mesh-1", card({ id: "four" }), { member: "member-hermes" }));
    expect(await ids()).toEqual(["chat-a/one", "chat-a/two", "chat-b/three", "group:mesh-1/four"]);

    await db.deleteMessage("chat-a", one.id);
    expect(await ids()).toEqual(["chat-a/two", "chat-b/three", "group:mesh-1/four"]);
    await db.deleteLink("chat-a");
    expect(await ids()).toEqual(["chat-b/three", "group:mesh-1/four"]);
    await db.deleteGroup("mesh-1");
    expect(await ids()).toEqual(["chat-b/three"]);
  });

  it("reads the index alone: a long chat's history is never read for it", async () => {
    for (let i = 0; i < 300; i++) await db.addMessage(message("chat-a", undefined));
    await db.addMessage(message("chat-a", card()));
    const messages = (await openDb()).transaction(STORES.messages, "readonly").objectStore(STORES.messages);
    const indexed = await new Promise<number>((resolve, reject) => { const r = messages.index(CARD_INDEX).count(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    expect(indexed).toBe(1);
    expect(await ids()).toEqual(["chat-a/relay"]);
  });
});

describe("a profile from before the index", () => {
  it("has its cards indexed when the store is upgraded", async () => {
    const name = `ghostly-before-cards-${crypto.randomUUID()}`;
    // The store as version 10 left it, with a card message in it.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 10);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORES.messages, { keyPath: ["linkId", "id"] });
        store.createIndex("byLink", "linkId");
        store.createIndex("byLinkTime", ["linkId", "timestamp"]);
        store.put(message("chat-old", card({ id: "old" })));
        store.put(message("chat-old", undefined));
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    vi.resetModules();
    const idb = await import("../src/shared/idb");
    idb.setDatabaseName(name);
    const fresh = await import("../src/engine/db");
    try {
      expect((await fresh.db.getCardMessages()).map((m) => m.card?.id)).toEqual(["old"]);
    } finally {
      (await idb.openDb()).close();
      setDatabaseName("ghostly");
    }
  });
});
