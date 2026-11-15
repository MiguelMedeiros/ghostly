import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
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
    const folded = "; the store was folded anyway, so a deleted copy of it is gone from the profile's folder";
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
    await expect(gone).rejects.toMatchObject({ code: "not_found", message: `No message "peer_3" in this chat (ghostly chat history Alice)${folded}`, details: { purged: true } });

    // A group's message another member sent: only its author deletes it, for everyone. Refused, the store folds all the
    // same: the journal is empty, the text only in rows.db, where the message still is.
    await put({ linkId: "group:g1", id: "k:1:0", text: `in the group: ${SECRET}`, sender: "peer", member: "k", timestamp: 4, via: "datalink" });
    const theirs = { chat: "group:g1", message: "k:1:0", everyone: true, purge: true };
    const refusal = { code: "not_found", message: `No message "k:1:0" of yours in this group: only your own messages are deleted for everyone (ghostly group history group:g1)${folded}`, details: { purged: true } };
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
});
