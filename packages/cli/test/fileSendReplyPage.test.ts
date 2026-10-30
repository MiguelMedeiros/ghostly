import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import type { EngineState, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files

/**
 * `file send --reply` checks the message it answers among the chat's (or group's) newest first: a reply almost always
 * names one of them, and the whole history of a 20,000-message chat costs a quarter of a second to read. All of it is
 * read only when the message is not among the newest and there are more.
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

function fake(page: { id: string }[], more: boolean, all: { id: string }[]) {
  const node = {
    getState: () => ({ links: [link], groups: [group], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
    messagePage: vi.fn(async () => ({ messages: page, more })),
    getMessages: vi.fn(async () => all),
    groupMessages: vi.fn(async () => all),
    getMessage: vi.fn(async () => undefined),
    sendFile: vi.fn(async () => {}),
    // Past the reply's check, the group stops the send: what is asked here is only the check.
    groupFileCheck: vi.fn(async () => ({ error: "You were removed from this group", refused: true })),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { node, ctx };
}

const NOT_HERE = "That message is not in this chat, or cannot be replied to";

describe("file send --reply", () => {
  it("in a chat, finds the message among the newest without reading the whole history", async () => {
    const { node, ctx } = fake([{ id: "peer_new" }], true, []);
    expect(await callApi(ctx, "file.send", { chat: "Alice", path, reply: "peer_new" })).toMatchObject({ chat: "chat-one" });
    expect(node.messagePage).toHaveBeenCalledWith({ linkId: "chat-one", limit: 200 });
    expect(node.getMessages).not.toHaveBeenCalled();
    expect(node.sendFile).toHaveBeenCalledWith(expect.objectContaining({ replyTo: "peer_new" }));
  });

  it("in a chat, reads the whole history for an older message, and says one that is nowhere is not there", async () => {
    const older = fake([{ id: "peer_new" }], true, [{ id: "peer_old" }, { id: "peer_new" }]);
    await callApi(older.ctx, "file.send", { chat: "Alice", path, reply: "peer_old" });
    expect(older.node.getMessages).toHaveBeenCalledWith("chat-one");
    expect(older.node.sendFile).toHaveBeenCalledWith(expect.objectContaining({ replyTo: "peer_old" }));
    const nowhere = fake([{ id: "peer_new" }], true, [{ id: "peer_new" }]);
    await expect(callApi(nowhere.ctx, "file.send", { chat: "Alice", path, reply: "peer_gone" })).rejects.toMatchObject({ code: "not_found", message: NOT_HERE });
    expect(nowhere.node.sendFile).not.toHaveBeenCalled();
  });

  it("in a chat whose newest are all it has, a message not there is not_found without a second read", async () => {
    const { node, ctx } = fake([{ id: "peer_new" }], false, []);
    await expect(callApi(ctx, "file.send", { chat: "Alice", path, reply: "peer_gone" })).rejects.toMatchObject({ code: "not_found", message: NOT_HERE });
    expect(node.getMessages).not.toHaveBeenCalled();
  });

  it("in a group, looks among its newest (group:<id>) first, then its whole history", async () => {
    const newest = fake([{ id: "k:0:2" }], true, []);
    await expect(callApi(newest.ctx, "file.send", { chat: "group:g1", path, reply: "k:0:2" })).rejects.toMatchObject({ code: "refused" });
    expect(newest.node.messagePage).toHaveBeenCalledWith({ linkId: "group:g1", limit: 200 });
    expect(newest.node.groupMessages).not.toHaveBeenCalled();
    const older = fake([{ id: "k:0:2" }], true, [{ id: "k:0:1" }, { id: "k:0:2" }]);
    await expect(callApi(older.ctx, "file.send", { chat: "group:g1", path, reply: "k:0:1" })).rejects.toMatchObject({ code: "refused" });
    expect(older.node.groupMessages).toHaveBeenCalledWith({ groupId: "g1" });
    const nowhere = fake([{ id: "k:0:2" }], true, [{ id: "k:0:2" }]);
    await expect(callApi(nowhere.ctx, "file.send", { chat: "group:g1", path, reply: "k:0:9" })).rejects.toMatchObject({ code: "not_found", message: "That message is not in this group, or cannot be replied to" });
    expect(nowhere.node.groupFileCheck).not.toHaveBeenCalled();
  });
});
