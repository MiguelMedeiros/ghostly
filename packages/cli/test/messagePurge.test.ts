import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { EngineState, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
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
    chatView: chatViewOf, groupView: groupViewOf, getState: () => ({ links: [link], groups: [], settings: {}, transport: {} }) as unknown as EngineState,
    getMessage: get,
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
});
