import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredLink, StoredMessage } from "../src/shared/types";
// covers: storage.indexeddb, app.clear-data, profiles.create

/**
 * The peer's IndexedDB database with real IndexedDB semantics (fake-indexeddb):
 * each test gets an empty factory and fresh modules, so no connection is shared.
 */
// Loaded once up front: each test re-evaluates these modules, and transforming them inside a hook can outlast its timeout.
await import("../src/engine/db");
let idb: typeof import("../src/shared/idb");
let db: typeof import("../src/engine/db").db;

beforeEach(async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.resetModules();
  idb = await import("../src/shared/idb");
  ({ db } = await import("../src/engine/db"));
}, 60_000);
afterEach(() => vi.unstubAllGlobals());

const link = (id: string, over: Partial<StoredLink> = {}) => ({ id, seedB64: "seed", peerPubKeyZ32: "peer", encKeyB64: "enc", createdAt: 1, ...over }) as StoredLink;
const message = (linkId: string, id: string, over: Partial<StoredMessage> = {}) => ({ linkId, id, text: id, sender: "me", timestamp: 1, via: "datalink", ...over }) as StoredMessage;
const count = async (name: string) => (await idb.wrap((await idb.store(name, "readonly")).getAll())).length;
const request = <T>(r: IDBRequest<T>) => idb.wrap(r);

describe("opening the database", () => {
  const olderDatabase = (version: number, build: (db: IDBDatabase) => void) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("ghostly", version);
    open.onupgradeneeded = () => build(open.result);
    open.onsuccess = () => { open.result.close(); resolve(); };
    open.onerror = () => reject(open.error);
  });

  it("upgrades a v4 schema in place, keeping the chats and the coins it held", async () => {
    await olderDatabase(4, (old) => {
      old.createObjectStore("links", { keyPath: "id" }).put(link("kept"));
      old.createObjectStore("proofs", { keyPath: "secret" }).put({ secret: "s1", amount: 8 });
    });
    const opened = await idb.openDb();
    expect(opened.version).toBe(7);
    expect([...opened.objectStoreNames].sort()).toEqual(Object.values(idb.STORES).sort());
    expect((await db.getLinks()).map((l) => l.id)).toEqual(["kept"]);
    expect(await count(idb.STORES.proofs)).toBe(1);
  });

  it("upgrades a v6 schema by adding only the groups store", async () => {
    await olderDatabase(6, (old) => {
      for (const name of Object.values(idb.STORES)) {
        if (name === idb.STORES.groups) continue;
        const keyPath = { messages: ["linkId", "id"], proofs: "secret", quotes: "quote", melts: "quote", paymentIntents: "review.id" }[name as string] ?? "id";
        const created = name === idb.STORES.settings ? old.createObjectStore(name) : old.createObjectStore(name, { keyPath });
        if (name === idb.STORES.messages || name === idb.STORES.files) created.createIndex("byLink", "linkId");
      }
    });
    const opened = await idb.openDb();
    expect([...opened.objectStoreNames].sort()).toEqual(Object.values(idb.STORES).sort());
    await db.putGroup({ id: "g" } as never);
    expect(await db.getGroups()).toEqual([{ id: "g" }]);
  });

  it("keeps each profile in a database of its own", async () => {
    idb.setDatabaseName("ghostly-work");
    expect(idb.databaseName()).toBe("ghostly-work");
    await db.putLink(link("work-chat"));
    expect((await idb.openDb()).name).toBe("ghostly-work");
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).toEqual(["ghostly-work"]);
  });

  it("lets another context replace the database instead of blocking it, then opens the new one", async () => {
    await db.putLink(link("before"));
    const blocked = vi.fn();
    await new Promise<void>((resolve, reject) => {
      const del = indexedDB.deleteDatabase("ghostly");
      del.onblocked = blocked;
      del.onsuccess = () => resolve();
      del.onerror = () => reject(del.error);
    });
    expect(blocked).not.toHaveBeenCalled();
    expect(await db.getLinks()).toEqual([]);
    await db.putLink(link("after"));
    expect((await db.getLinks()).map((l) => l.id)).toEqual(["after"]);
  });
});

describe("writes across stores", () => {
  it("lands nothing when the work fails halfway, and reports the failure", async () => {
    await expect(idb.transact([idb.STORES.proofs, idb.STORES.walletTx], (stores) => {
      stores[idb.STORES.proofs].put({ secret: "spent", amount: 1 });
      throw new Error("mint answered nonsense");
    })).rejects.toThrow("mint answered nonsense");
    expect(await count(idb.STORES.proofs)).toBe(0);
  });

  it("lands nothing when one request fails, even after others succeeded", async () => {
    await idb.transact([idb.STORES.proofs], (stores) => void stores[idb.STORES.proofs].put({ secret: "a", amount: 1 }));
    await expect(idb.transact([idb.STORES.proofs, idb.STORES.walletTx], (stores) => {
      stores[idb.STORES.walletTx].put({ id: "tx-1" });
      stores[idb.STORES.proofs].add({ secret: "a", amount: 2 });
    })).rejects.toBeTruthy();
    expect(await count(idb.STORES.walletTx)).toBe(0);
    expect(await idb.wrap((await idb.store(idb.STORES.proofs, "readonly")).get("a"))).toEqual({ secret: "a", amount: 1 });
  });

  it("clears chats, messages, files, services and groups but never the wallet", async () => {
    await db.putLink(link("l"));
    await db.addMessage(message("l", "m"));
    await idb.fileStore.put({ id: "f", linkId: "l", blob: new Blob(["x"]), createdAt: 1 });
    await db.putService({ id: "svc" } as never);
    await db.putGroup({ id: "g" } as never);
    await idb.transact([idb.STORES.proofs, idb.STORES.payments], (stores) => {
      stores[idb.STORES.proofs].put({ secret: "coin", amount: 64 });
      stores[idb.STORES.payments].put({ id: "pay" });
    });
    await idb.clearChatData();
    for (const name of [idb.STORES.links, idb.STORES.messages, idb.STORES.files, idb.STORES.services, idb.STORES.groups]) expect(await count(name)).toBe(0);
    expect(await count(idb.STORES.proofs)).toBe(1);
    expect(await count(idb.STORES.payments)).toBe(1);
  });

  it("has nothing to clear where there is no IndexedDB", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(idb.clearChatData()).resolves.toBeUndefined();
  });

  it("deletes one chat's files and no one else's", async () => {
    await idb.fileStore.put({ id: "a1", linkId: "a", blob: new Blob(["1"]), createdAt: 1 });
    await idb.fileStore.put({ id: "a2", linkId: "a", blob: new Blob(["2"]), createdAt: 1 });
    await idb.fileStore.put({ id: "b1", linkId: "b", blob: new Blob(["3"]), createdAt: 1 });
    await idb.fileStore.deleteForLink("a");
    expect(await idb.fileStore.listForLink("a")).toEqual([]);
    expect((await idb.fileStore.listForLink("b")).map((f) => f.id)).toEqual(["b1"]);
  });
});

describe("links", () => {
  it("patches a stored link without changing its id, and refuses to create one that is gone", async () => {
    await db.putLink(link("l", { label: "old" }));
    await db.patchLink("l", { label: "new", id: "hijack" });
    expect(await db.getLinks()).toEqual([link("l", { label: "new" })]);
    await expect(db.patchLink("gone", { label: "x" })).rejects.toThrow("Link unavailable");
    expect((await db.getLinks()).map((l) => l.id)).toEqual(["l"]);
  });

  it("changes a contact's proofs only on a confirmed chat, and keeps them when the change fails", async () => {
    await db.putLink(link("unconfirmed"));
    await expect(db.updatePeerProofs("unconfirmed", (l) => l)).rejects.toThrow("Confirmed conversation unavailable");
    await expect(db.updatePeerProofs("gone", (l) => l)).rejects.toThrow("Confirmed conversation unavailable");

    await db.putLink(link("confirmed", { pairedPeerKey: "k", label: "keep me" }));
    const first = await db.updatePeerProofs("confirmed", (l) => ({ ...l, marker: 1 }) as never);
    expect(first).toMatchObject({ marker: 1 });
    await expect(db.updatePeerProofs("confirmed", () => { throw new Error("bad proof"); })).rejects.toThrow("bad proof");
    const stored = (await db.getLinks()).find((l) => l.id === "confirmed")!;
    expect(stored.peerProofs).toEqual(first);
    expect(stored.label).toBe("keep me");
  });

  it("changes identity proofs only on a paired chat, keeping every other field", async () => {
    await db.putLink(link("legacy"));
    await expect(db.updateIdentities("legacy", (l) => l)).rejects.toThrow("Paired chat unavailable");
    await db.putLink(link("paired", { profile: "paired-chat/1", pairedPeerKey: "k" }));
    const ledger = await db.updateIdentities("paired", (l) => ({ ...l, marker: 2 }) as never);
    await expect(db.updateIdentities("paired", () => { throw new Error("refused"); })).rejects.toThrow("refused");
    const stored = (await db.getLinks()).find((l) => l.id === "paired")!;
    expect(stored.identities).toEqual(ledger);
    expect(stored.pairedPeerKey).toBe("k");
  });

  it("will not pin a contact on a chat that was never an invitation", async () => {
    await db.putLink(link("plain"));
    await expect(db.pinPeer("plain", "k")).rejects.toThrow("Invitation already consumed or unavailable");
    expect((await db.getLinks())[0].pairedPeerKey).toBeUndefined();
  });

  it("deletes a chat with its messages and files, leaving other chats alone", async () => {
    await db.putLink(link("a"));
    await db.putLink(link("b"));
    await db.addMessage(message("a", "1"));
    await db.addMessage(message("b", "1"));
    await idb.fileStore.put({ id: "fa", linkId: "a", blob: new Blob(["x"]), createdAt: 1 });
    await db.deleteLink("a");
    expect((await db.getLinks()).map((l) => l.id)).toEqual(["b"]);
    expect(await db.getMessages("a")).toEqual([]);
    expect(await db.getMessages("b")).toHaveLength(1);
    expect(await idb.fileStore.get("fa")).toBeUndefined();
  });
});

describe("messages", () => {
  it("returns a chat's messages oldest first", async () => {
    await db.addMessage(message("l", "late", { timestamp: 30 }));
    await db.addMessage(message("l", "early", { timestamp: 10 }));
    await db.addMessage(message("other", "x", { timestamp: 20 }));
    expect((await db.getMessages("l")).map((m) => m.id)).toEqual(["early", "late"]);
  });

  it("never takes back a delivery receipt, and gives no status to a message that had none", async () => {
    await db.addMessage(message("l", "sent", { delivery: "sending" }));
    await db.addMessage(message("l", "received", { sender: "peer" }));
    await db.updateDelivery("l", "sent", "failed", "offline");
    expect((await db.getMessages("l")).find((m) => m.id === "sent")).toMatchObject({ delivery: "failed", deliveryError: "offline" });
    await db.updateDelivery("l", "sent", "delivered");
    await db.updateDelivery("l", "sent", "failed", "timeout");
    await db.updateDelivery("l", "received", "delivered");
    const [received, sent] = await db.getMessages("l").then((all) => [all.find((m) => m.id === "received"), all.find((m) => m.id === "sent")]);
    expect(sent).toMatchObject({ delivery: "delivered", deliveryError: undefined });
    expect(received?.delivery).toBeUndefined();
  });

  it("does not bring a deleted message back through a late receipt", async () => {
    await db.addMessage(message("l", "m", { delivery: "sending" }));
    await db.deleteMessage("l", "m");
    await db.updateDelivery("l", "m", "delivered");
    expect(await db.getMessages("l")).toEqual([]);
  });

  it("forgets a group with its history only", async () => {
    await db.putGroup({ id: "g1" } as never);
    await db.putGroup({ id: "g2" } as never);
    await db.addMessage(message("group:g1", "1"));
    await db.addMessage(message("group:g2", "1"));
    await db.deleteGroup("g1");
    expect((await db.getGroups()).map((g) => g.id)).toEqual(["g2"]);
    expect(await db.getMessages("group:g1")).toEqual([]);
    expect(await db.getMessages("group:g2")).toHaveLength(1);
  });
});

describe("settings and services", () => {
  it("starts with empty settings and keeps what is saved", async () => {
    expect(await db.getSettings()).toEqual({});
    await db.putSettings({ online: false } as never);
    expect(await db.getSettings()).toEqual({ online: false });
  });

  it("stores and removes shared services", async () => {
    await db.putService({ id: "svc", name: "Notes" } as never);
    expect(await db.getServices()).toEqual([{ id: "svc", name: "Notes" }]);
    await db.deleteService("svc");
    expect(await request((await idb.store(idb.STORES.services, "readonly")).count())).toBe(0);
  });
});
