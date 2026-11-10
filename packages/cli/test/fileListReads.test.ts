import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@ghostly/browser/engine/db";
import { GhostlyNode } from "@ghostly/browser/engine/node";
import type { EngineState, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files

/**
 * `file list` reads a chat's (or a group's) file rows only, on the CLI's disk store: a bot that polls it in a chat of
 * thousands of texts pays for its files, not for every text. Before, each call read the whole history (75 ms at 9,000
 * texts on a live daemon, with the daemon's other calls waiting behind it).
 */
let dir: string, store: Awaited<ReturnType<typeof openPersistentIndexedDb>>;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-list-"));
  store = await openPersistentIndexedDb(join(dir, "db"));
});
afterAll(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const T0 = 1_700_000_000_000;
const text = (linkId: string, i: number): StoredMessage => ({ linkId, id: `peer_${T0 + i}`, text: `text ${i}`, sender: "peer", timestamp: T0 + i, via: "datalink" });
const withFile = (linkId: string, i: number, fileId: string, sender: "me" | "peer" = "peer"): StoredMessage => ({
  ...text(linkId, i), id: `${sender}_${T0 + i}`, sender, text: "", file: { id: fileId, name: `${fileId}.txt`, size: 10, mime: "text/plain" },
});

function fake() {
  const s = {
    links: [{ id: "chat-one", label: "Alice", peerPubKeyZ32: "p", createdAt: 1, lastMessageAt: 0, pairing: { status: "ready" } } as unknown as LinkView],
    groups: [{ id: "crew", name: "Crew", members: [] }],
    settings: {}, transport: {}, transfers: {},
  } as unknown as EngineState;
  const node = {
    getState: () => s,
    getMessages: vi.fn((linkId: string) => GhostlyNode.prototype.getMessages.call(null as never, linkId)),
    groupMessages: vi.fn(({ groupId }: { groupId: string }) => GhostlyNode.prototype.getMessages.call(null as never, `group:${groupId}`)),
    fileMessages: (linkId: string) => GhostlyNode.prototype.fileMessages.call(null as never, linkId),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

describe("file list in a long chat", () => {
  it("lists a chat's and a group's files, by time, without reading their whole history", async () => {
    for (let i = 0; i < 2000; i++) await db.putMessage(text("chat-one", i));
    for (let i = 0; i < 500; i++) await db.putMessage(text("group:crew", i));
    // Out of order on purpose: listed by the message's time, as the history has them.
    await db.putMessage(withFile("chat-one", 1500, "chat-one-out-b", "me"));
    await db.putMessage(withFile("chat-one", 10, "chat-one-in-a"));
    await db.putMessage(withFile("group:crew", 20, "group-crew-in-c"));
    // Another chat's file is not this one's.
    await db.putMessage(withFile("chat-two", 30, "chat-two-in-d"));

    const { ctx, node } = fake();
    const chat = await callApi(ctx, "file.list", { chat: "Alice" }) as { chat: string; files: { messageId: string; from: string; file: { id: string } }[] };
    expect(chat.chat).toBe("chat-one");
    expect(chat.files.map((f) => [f.messageId, f.from, f.file.id])).toEqual([[`peer_${T0 + 10}`, "peer", "chat-one-in-a"], [`me_${T0 + 1500}`, "me", "chat-one-out-b"]]);
    const group = await callApi(ctx, "file.list", { chat: "Crew" }) as { group: string; files: { file: { id: string } }[] };
    expect(group.files.map((f) => f.file.id)).toEqual(["group-crew-in-c"]);

    expect(node.getMessages).not.toHaveBeenCalled();
    expect(node.groupMessages).not.toHaveBeenCalled();
  });

  it("follows the history: a file's deleted message leaves the list, an edit that drops the file too", async () => {
    await db.putMessage(withFile("chat-one", 2100, "chat-one-in-e"));
    await db.putMessage(withFile("chat-one", 2101, "chat-one-in-f"));
    await db.deleteMessage("chat-one", `peer_${T0 + 2100}`);
    await db.patchMessage("chat-one", `peer_${T0 + 2101}`, () => ({ file: undefined, text: "gone" }));
    const { files } = await callApi(fake().ctx, "file.list", { chat: "Alice" }) as { files: { file: { id: string } }[] };
    expect(files.map((f) => f.file.id)).toEqual(["chat-one-in-a", "chat-one-out-b"]);
  });
});
