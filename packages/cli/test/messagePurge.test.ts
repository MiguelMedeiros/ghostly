import { execFileSync } from "node:child_process";
import { createReadStream, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { COMMANDS, positionals } from "../src/commands";
import { openPersistentIndexedDb, type PersistentIndexedDb } from "../src/runtime/storage";
import { chatViewOf, groupViewOf } from "./support/chatView";
// covers: headless.chat

// A fold held where it opens its snapshot's file, while `foldHeld` is set: the test starts an export meanwhile.
const foldHeld = vi.hoisted(() => ({ gate: null as Promise<void> | null, reached: () => {} }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (foldHeld.gate && String(args[0]).endsWith(".tmp")) { foldHeld.reached(); await foldHeld.gate; }
      return fs.open(...args);
    },
  };
});

/**
 * `message delete --purge`: what the message said leaves the profile's folder before the command answers. Without it
 * the store's journal keeps it until its fold, within the hour (a token a bot saved, then deleted, was still in
 * `db/journal.bin` 2 s later).
 */
const SECRET = "sk-made-up-0123456789abcdef";
const link = { id: "chat-one", label: "Alice", peerPubKeyZ32: "pchat-one", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" } } as unknown as LinkView;
const group = { id: "g1", name: "Crew", createdAt: 1, profile: "mesh", isAdmin: false, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {}, members: [] } as unknown as GroupView;

let dir: string;
let store: PersistentIndexedDb;
let db: IDBDatabase;

const done = (request: IDBRequest) => new Promise<unknown>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const put = (message: StoredMessage) => new Promise<void>((resolve, reject) => {
  const tx = db.transaction("messages", "readwrite");
  tx.objectStore("messages").put(message);
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
});
const get = (linkId: string, id: string) => done(db.transaction("messages").objectStore("messages").get([linkId, id])) as Promise<StoredMessage | undefined>;

/** The profile's db folder, every file's bytes: whether the secret is in any (journal.bin, rows.db and its WAL). */
const holding = () => readdirSync(dir).filter((file) => readFileSync(join(dir, file)).includes(SECRET));

/** A node whose delete takes the row out on later turns, as the engine's `forgetMessage` does (its files first). */
function fake() {
  const node = {
    chatView: chatViewOf, groupView: groupViewOf, getState: () => ({ links: [link], groups: [group], settings: {}, transport: {} }) as unknown as EngineState,
    getMessage: get,
    groupMessages: async () => [],
    forgetQuotesOf: async () => {},
    deleteMessage: ({ linkId, messageId }: { linkId: string; messageId: string }) => {
      setTimeout(() => { const tx = db.transaction("messages", "readwrite"); tx.objectStore("messages").delete([linkId, messageId]); }, 30);
      return { everyone: false };
    },
  };
  return { runtime: { server: { node }, store, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
}

describe("message delete --purge", () => {
  beforeAll(async () => {
    dir = join(mkdtempSync(join(tmpdir(), "ghostly-purge-")), "db");
    store = await openPersistentIndexedDb(dir);
    const open = indexedDB.open("ghostly", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("messages", { keyPath: ["linkId", "id"] });
    db = (await done(open)) as IDBDatabase;
  });

  it("is a flag of `message delete`, sent only when given", () => {
    const command = COMMANDS["message delete"]!;
    const line = (...argv: string[]) => { const parsed = parseArgs(argv, command.options ?? {}); return command.params!(parsed, positionals(command, parsed.positionals)); };
    expect(command.usage).toBe("message delete <chat|group> <message> [--everyone [--wait none|confirmed|sent] [--timeout s]] [--purge]");
    expect(line("Alice", "peer_1", "--purge")).toMatchObject({ chat: "Alice", message: "peer_1", everyone: false, purge: true });
    expect(line("Alice", "peer_1")).not.toHaveProperty("purge");
  });

  it("without it the journal keeps what the message said; with it nothing in the profile's folder does when it answers", async () => {
    const ctx = fake();
    await put({ linkId: "chat-one", id: "peer_1", text: `the token: ${SECRET}`, sender: "peer", timestamp: 1, via: "datalink" });
    expect(holding()).toContain("journal.bin");
    expect(await callApi(ctx, "chat.delete", { chat: "Alice", message: "peer_1" })).toEqual({ chat: "chat-one", messageId: "peer_1", deleted: "peer_1", everyone: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await get("chat-one", "peer_1")).toBeUndefined();
    // Gone from the chat, not from the disk: the fold comes within the hour.
    expect(holding()).toContain("journal.bin");

    await put({ linkId: "chat-one", id: "peer_2", text: `again: ${SECRET}`, sender: "peer", timestamp: 2, via: "datalink" });
    const answer = await callApi(ctx, "chat.delete", { chat: "Alice", message: "peer_2", purge: true });
    // The earlier delete's text too: the fold takes the whole journal.
    expect(holding()).toEqual([]);
    expect(store.journalBytes()).toBe(0);
    expect(answer).toEqual({ chat: "chat-one", messageId: "peer_2", deleted: "peer_2", everyone: false, purged: true });
  });

  it("folds the store too when the delete answers no: a message no longer here, another member's in a group", async () => {
    const ctx = fake();
    const folded = "The store was folded anyway, so a deleted copy of it is gone from the profile's folder. ";
    // Deleted here without --purge (or by the contact for everyone): its row is gone, its text still in the journal.
    await put({ linkId: "chat-one", id: "peer_3", text: `once more: ${SECRET}`, sender: "peer", timestamp: 3, via: "datalink" });
    await callApi(ctx, "chat.delete", { chat: "Alice", message: "peer_3" });
    await vi.waitFor(async () => expect(await get("chat-one", "peer_3")).toBeUndefined());
    // Without --purge, no fold: the journal keeps it, and the error is as it was.
    await expect(callApi(ctx, "chat.delete", { chat: "Alice", message: "peer_3" })).rejects.toMatchObject({ code: "not_found", message: "No message \"peer_3\" in this chat (ghostly chat history Alice)", details: undefined });
    expect(holding()).toContain("journal.bin");
    const gone = callApi(ctx, "chat.delete", { chat: "Alice", message: "peer_3", purge: true });
    await expect(gone).rejects.toThrow();
    expect(holding()).toEqual([]);
    expect(store.journalBytes()).toBe(0);
    await expect(gone).rejects.toMatchObject({ code: "not_found", message: `${folded}No message "peer_3" in this chat (ghostly chat history Alice)`, details: { purged: true } });

    // A group's message another member sent: only its author deletes it, for everyone. Refused, the store folds all the
    // same: the journal is empty, the text only in rows.db, where the message still is.
    await put({ linkId: "group:g1", id: "k:1:0", text: `in the group: ${SECRET}`, sender: "peer", member: "k", timestamp: 4, via: "datalink" });
    const theirs = { chat: "group:g1", message: "k:1:0", everyone: true, purge: true };
    const refusal = { code: "not_found", message: `${folded}No message "k:1:0" of yours in this group: only your own messages are deleted for everyone (ghostly group history group:g1)`, details: { purged: true } };
    expect(holding()).toContain("journal.bin");
    await expect(callApi(ctx, "chat.delete", theirs)).rejects.toMatchObject(refusal);
    expect(store.journalBytes()).toBe(0);
    expect(holding()).toEqual(["rows.db"]);
    // Once its author deleted it for everyone, it is gone here and the same command leaves nothing of it on disk.
    await new Promise<void>((resolve) => { const tx = db.transaction("messages", "readwrite"); tx.objectStore("messages").delete(["group:g1", "k:1:0"]); tx.oncomplete = () => resolve(); });
    // The snapshot still has it until a fold.
    expect(holding()).toEqual(["rows.db"]);
    const after = callApi(ctx, "chat.delete", theirs);
    await expect(after).rejects.toThrow();
    expect(holding()).toEqual([]);
    await expect(after).rejects.toMatchObject(refusal);
    // A usage mistake folds nothing.
    await put({ linkId: "chat-one", id: "peer_4", text: `last: ${SECRET}`, sender: "peer", timestamp: 5, via: "datalink" });
    await expect(callApi(ctx, "chat.delete", { chat: "group:g1", message: "k:1:0", everyone: true, wait: "confirmed", purge: true })).rejects.toMatchObject({ code: "bad_request", details: undefined });
    expect(holding()).toContain("journal.bin");
  });

  // A FIFO nobody reads yet holds the export where it is, rows.db read as it was when it began.
  async function heldExport() {
    const fifo = join(mkdtempSync(join(tmpdir(), "ghostly-purge-export-")), "store.bin");
    execFileSync("mkfifo", [fifo]);
    const exported = store.exportSnapshot(fifo);
    const out = createReadStream(fifo);
    const read: Buffer[] = [];
    out.on("data", (chunk) => read.push(chunk as Buffer));
    out.pause();
    await new Promise((resolve) => setTimeout(resolve, 200));
    return async () => {
      out.resume();
      // Read whole, then refused at its sync: a FIFO has nothing to sync.
      await expect(exported).rejects.toMatchObject({ code: "EINVAL" });
      return Buffer.concat(read);
    };
  }

  /** A message whose text, its own secret, is in rows.db only (the one above is still in a message here). */
  async function folded(id: string, secret: string) {
    await put({ linkId: "chat-one", id, text: `under a backup: ${secret}`, sender: "peer", timestamp: 6, via: "datalink" });
    // Past a pipe's buffer, so the export waits on its writes.
    for (let i = 0; i < 300; i++) await put({ linkId: "chat-one", id: `${id}_filler_${i}`, text: "x".repeat(1000), sender: "peer", timestamp: 7 + i, via: "datalink" });
    await store.compact();
    const holds = () => readdirSync(dir).filter((file) => readFileSync(join(dir, file)).includes(secret));
    expect(holds()).toEqual(["rows.db"]);
    return holds;
  }

  it.skipIf(process.platform === "win32")("during a backup's export, answers once the export ends, nothing of the text left in rows.db", async () => {
    const holds = await folded("peer_5", "sk-made-up-backed-up-fedcba9876543210");
    const release = await heldExport();
    let held: string[] | null = null;
    const purge = callApi(fake(), "chat.delete", { chat: "Alice", message: "peer_5", purge: true }).then((answer) => { held = holds(); return answer; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Not while the export holds rows.db: its checkpoint would stop there, the text kept in rows.db's pages.
    expect(held).toBeNull();
    await release();
    expect(await purge).toEqual({ chat: "chat-one", messageId: "peer_5", deleted: "peer_5", everyone: false, purged: true });
    expect(held).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("an export that begins while the purge's fold is written begins after it: no write waits for the export", async () => {
    const secret = "sk-made-up-begun-later-0123fedcba987654";
    const holds = await folded("peer_6", secret);
    let open!: () => void;
    const reached = new Promise<void>((resolve) => { foldHeld.reached = resolve; });
    foldHeld.gate = new Promise<void>((resolve) => { open = resolve; });
    let held: string[] | null = null;
    const purge = callApi(fake(), "chat.delete", { chat: "Alice", message: "peer_6", purge: true }).then((answer) => { held = holds(); return answer; });
    await reached;
    const release = await heldExport();
    foldHeld.gate = null;
    open();
    // The export is held at its FIFO: the purge answers all the same, and a write commits (its `complete` was behind
    // the fold, the fold behind the export, every write in the daemon held until the backup's export ended).
    const late = () => new Promise((resolve) => setTimeout(() => resolve("held"), 2_000));
    expect(await Promise.race([purge, late()])).toEqual({ chat: "chat-one", messageId: "peer_6", deleted: "peer_6", everyone: false, purged: true });
    expect(held).toEqual([]);
    expect(await Promise.race([put({ linkId: "chat-one", id: "peer_7", text: "meanwhile", sender: "peer", timestamp: 400, via: "datalink" }).then(() => "written"), late()])).toBe("written");
    // Begun after the fold, the backup has nothing of the purged text.
    const exported = await release();
    expect(exported.length).toBeGreaterThan(300_000);
    expect(exported.includes(secret)).toBe(false);
  });
});
