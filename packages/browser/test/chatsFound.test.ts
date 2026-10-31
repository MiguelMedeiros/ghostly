import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, type PkarrTransport } from "@ghostly/core";
import { ChatTextSearch, SEARCH_KEPT_MS } from "../src/engine/chatSearch";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink, StoredMessage } from "../src/shared/types";
// covers: chats.list.search

/*
 * The chat list's search over the chats' whole histories, in the engine (`chatsFound`): the extension's pages hold each
 * chat's newest page only, and the first letter typed in the search asked for every 1:1 chat's whole history over the
 * port, as JSON. The engine answers which chats, reading each chat's texts once while the search lasts, and again after
 * the chat changed.
 */

const row = (linkId: string, id: string, text: string, sender: "me" | "peer" = "peer"): StoredMessage =>
  ({ linkId, id, wireId: id, text, sender, timestamp: 1_700_000_000_000 + Number(id.replace(/\D/g, "") || 0), via: "datalink" });

describe("the chats' texts searched in the engine", () => {
  afterEach(() => vi.useRealTimers());

  it("finds the chats with the query in any message, whatever the case and the accents, reading each once", async () => {
    const stored: Record<string, StoredMessage[]> = {
      a: [row("a", "1", "See you at the Café"), row("a", "2", "ok")],
      b: [row("b", "1", "nothing here")],
      c: [row("c", "1", "CAFE AU LAIT")],
    };
    const reads: string[] = [];
    const search = new ChatTextSearch(async (linkId) => { reads.push(linkId); return stored[linkId] ?? []; });
    expect(await search.found(["a", "b", "c"], "cafe")).toEqual(["a", "c"]);
    expect(await search.found(["a", "b", "c"], "café a")).toEqual(["c"]);
    expect(await search.found(["c", "a"], "c")).toEqual(["c", "a"]);
    expect(await search.found(["a", "b"], "")).toEqual([]);
    expect(reads).toEqual(["a", "b", "c"]);
  });

  it("reads a chat again after it changed, and lets every text go a while after the last search", async () => {
    vi.useFakeTimers();
    const stored: Record<string, StoredMessage[]> = { a: [row("a", "1", "first")], b: [row("b", "1", "other")] };
    const reads: string[] = [];
    const search = new ChatTextSearch(async (linkId) => { reads.push(linkId); return stored[linkId]; });
    expect(await search.found(["a", "b"], "second")).toEqual([]);
    stored.a = [...stored.a, row("a", "2", "second")];
    search.changed("a");
    expect(await search.found(["a", "b"], "second")).toEqual(["a"]);
    expect(reads).toEqual(["a", "b", "a"]);
    await vi.advanceTimersByTimeAsync(SEARCH_KEPT_MS - 1);
    expect(await search.found(["a", "b"], "first")).toEqual(["a"]);
    expect(reads).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(SEARCH_KEPT_MS);
    expect(await search.found(["a", "b"], "first")).toEqual(["a"]);
    expect(reads).toEqual(["a", "b", "a", "a", "b"]);
  });

  it("does not keep a read that failed", async () => {
    let fail = true;
    const search = new ChatTextSearch(async () => { if (fail) throw new Error("store closed"); return [row("a", "1", "hello")]; });
    await expect(search.found(["a"], "hello")).rejects.toThrow("store closed");
    fail = false;
    expect(await search.found(["a"], "hello")).toEqual(["a"]);
  });
});

/** A transport that sends nothing: the node runs in limited mode, and nothing it does here needs the network. */
const transport: PkarrTransport = {
  publish: async () => {}, publishPayload: async () => {}, resolve: async () => null,
  describe: () => ({ protocol: "none", relays: [] }), turnRead: async () => [], turnPut: async () => [],
};
const chat = (): StoredLink => ({ id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
  encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64 });
const nodes: GhostlyNode[] = [];

describe("chatsFound", () => {
  beforeEach(async () => {
    const stores = [STORES.settings, STORES.links, STORES.messages];
    await transact(stores, (s) => { for (const name of stores) s[name].clear(); });
  });
  afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown().catch(() => {}); });

  it("answers the 1:1 chats whose stored history holds the query, and what an edit changed", async () => {
    const [a, b] = [chat(), chat()];
    for (const link of [a, b]) await db.putLink(link);
    for (let i = 0; i < 500; i++) await db.putMessage(row(a.id, `m${i}`, i === 3 ? "the old Recipe" : `line ${i}`, "me"));
    await db.putMessage(row(b.id, "m1", "recipe for bread"));
    const node = new GhostlyNode({ onState: () => {}, onMessages: () => {}, onMessageChanges: () => {}, onCallSignal: () => {} }, { transport, limited: true, automaticWallets: false });
    nodes.push(node);
    await node.start();
    expect(await node.chatsFound({ query: "recipe", linkIds: [a.id, b.id] })).toEqual([a.id, b.id]);
    // Only the chats asked about, and only chats: no other id is read.
    expect(await node.chatsFound({ query: "recipe", linkIds: [b.id, "group:nope", "nobody"] })).toEqual([b.id]);
    // An edit is a change the pages hear: the next search reads the chat again.
    expect((await node.editMessage({ linkId: a.id, messageId: "m3", text: "the old soup" })).error).toBeNull();
    expect(await node.chatsFound({ query: "recipe", linkIds: [a.id, b.id] })).toEqual([b.id]);
    expect(await node.chatsFound({ query: "SOUP", linkIds: [a.id, b.id] })).toEqual([a.id]);
  });
});
