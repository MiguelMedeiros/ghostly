import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState, GroupView, LinkView, MessageFile } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { chatViewOf } from "./support/chatView";
// covers: headless.files

/**
 * `file send --reply` leaves the message it answers to the engine, which reads it by single rows (`replyFor`), and says
 * its refusal as `not_found`: the CLI's own look read the newest 200, then the chat's (or group's) whole history for an
 * older message or one it lacks, 0.8-1 s held at 100,000 messages on each send.
 */
const link = { id: "chat-one", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "open",
  capabilities: { files: true }, pairing: { status: "ready" } } as unknown as LinkView;
const group = { id: "g1", name: "Crew", status: "active", members: [] } as unknown as GroupView;

let path: string;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-file-reply-page-"));
  await openPersistentIndexedDb(join(dir, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(dir, "files")), true);
  path = join(dir, "note.txt");
  writeFileSync(path, "note");
});

const NOT_THERE = "That message is not in this chat, or cannot be replied to";

/** `missing`: the engine refuses the reply; `there`: a row it refuses is in the chat (or group) all the same. */
function fake(missing = false, there?: { id: string }) {
  const node = {
    chatView: chatViewOf,
    getState: () => ({ links: [link], groups: [group], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
    messagePage: vi.fn(async () => ({ messages: [], more: true })),
    getMessages: vi.fn(async () => []),
    groupMessages: vi.fn(async () => []),
    getMessage: vi.fn(async (_: string, id: string) => (there?.id === id ? there : undefined)),    sendFile: vi.fn(async (_: { file: MessageFile; replyTo?: string }) => { if (missing) throw new Error(NOT_THERE); }),
    groupFileCheck: vi.fn(() => ({ error: null })),
    sendGroupFile: vi.fn(async (_: { file: MessageFile; replyTo?: string }) => (missing ? { error: NOT_THERE } : { error: null, messageId: "mine:0:1" })),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  const reads = () => node.messagePage.mock.calls.length + node.getMessages.mock.calls.length + node.groupMessages.mock.calls.length;
  return { node, ctx, reads };
}

describe("file send --reply", () => {
  it("in a chat, goes to the engine with the reply, reading none of the history", async () => {
    const { node, ctx, reads } = fake();
    expect(await callApi(ctx, "file.send", { chat: "Alice", path, reply: "peer_old" })).toMatchObject({ chat: "chat-one" });
    expect(node.sendFile).toHaveBeenCalledWith(expect.objectContaining({ replyTo: "peer_old" }));
    expect(reads()).toBe(0);
  });

  it("in a chat, a message the engine finds nowhere is not_found, and the staged copy goes", async () => {
    const { node, ctx, reads } = fake(true);
    await expect(callApi(ctx, "file.send", { chat: "Alice", path, reply: "peer_gone" })).rejects.toMatchObject({
      code: "not_found", message: 'No message "peer_gone" in this chat, or it cannot be replied to (ghostly chat history Alice)',
    });
    expect(await fileStore.get(node.sendFile.mock.calls[0]![0].file.id)).toBeUndefined();
    expect(reads()).toBe(0);
  });

  it("in a group, the same: the engine checks it, a message it lacks is not_found and the staged copy goes", async () => {
    const sent = fake();
    expect(await callApi(sent.ctx, "file.send", { chat: "group:g1", path, reply: "k:0:1" })).toMatchObject({ group: "g1", messageId: "mine:0:1" });
    expect(sent.node.sendGroupFile).toHaveBeenCalledWith(expect.objectContaining({ replyTo: "k:0:1" }));
    expect(sent.reads()).toBe(0);
    const nowhere = fake(true);
    await expect(callApi(nowhere.ctx, "file.send", { chat: "group:g1", path, reply: "k:0:9" })).rejects.toMatchObject({
      code: "not_found", message: 'No message "k:0:9" in this group, or it cannot be replied to (ghostly group history group:g1)',
    });
    expect(await fileStore.get(nowhere.node.sendGroupFile.mock.calls[0]![0].file.id)).toBeUndefined();
    expect(nowhere.reads()).toBe(0);
  });

  it("a message that is there but cannot be replied to keeps the engine's refusal, in a chat and in a group", async () => {
    // An old app's text, stored by its time with no wire id: the engine's `replyFor` refuses it.
    const chat = fake(true, { id: "peer_1700000000000" });
    await expect(callApi(chat.ctx, "file.send", { chat: "Alice", path, reply: "peer_1700000000000" })).rejects.toMatchObject({ code: "refused", message: NOT_THERE });
    expect(chat.node.getMessage).toHaveBeenCalledWith("chat-one", "peer_1700000000000");
    expect(chat.reads()).toBe(0);
    // A group's event line: the engine refuses it, said as before (`not_found` with the engine's words).
    const inGroup = fake(true, { id: "k:0:3" });
    await expect(callApi(inGroup.ctx, "file.send", { chat: "group:g1", path, reply: "k:0:3" })).rejects.toMatchObject({ code: "not_found", message: NOT_THERE });
    expect(inGroup.node.getMessage).toHaveBeenCalledWith("group:g1", "k:0:3");
    expect(inGroup.reads()).toBe(0);
  });
});
