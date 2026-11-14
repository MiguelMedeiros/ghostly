import { closeSync, mkdtempSync, openSync, ftruncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@ghostly/core";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { asCliError } from "../src/errors";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { chatViewOf } from "./support/chatView";
// covers: headless.files

/**
 * `file send` of a file past files/2's 100 MB to a contact who is away: the engine keeps it and offers it on the next
 * session, where files/3 is agreed again (node.ts `sendWaitingFile`), as the app's composer sends it. Only a session
 * open now whose contact's app says it takes no files/3 refuses it at once. Before, the capabilities of a chat with no
 * session (all false) refused it as "Too large for the contact's app".
 */
const SIZE = LIMITS.maxFileBytes + 1024 * 1024;

let dir: string, path: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-away-"));
  await openPersistentIndexedDb(join(dir, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(dir, "files")), true);
  // Sparse: its size without writing it.
  path = join(dir, "big.bin");
  const fd = openSync(path, "w");
  ftruncateSync(fd, SIZE);
  closeSync(fd);
});

function contextFor(link: Partial<LinkView>) {
  const view = { id: "chat-one", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", pairing: { status: "ready" }, ...link } as unknown as LinkView;
  const node = {
    chatView: chatViewOf,
    getState: () => ({ links: [view], groups: [], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
    getMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => undefined),
    sendFile: vi.fn(async () => {}),
    setTyping: vi.fn(async () => {}),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { node, ctx };
}

describe("file send past 100 MB", () => {
  it("to a contact who is away (no session): kept for their next session, not refused", async () => {
    const { node, ctx } = contextFor({ dataLink: "idle", capabilities: { files: false, payments: false, largeFiles: false } as LinkView["capabilities"] });
    const answer = await callApi(ctx, "file.send", { chat: "Alice", path, wait: "none" }) as { file: { size: number } };
    expect(answer.file.size).toBe(SIZE);
    expect(node.sendFile).toHaveBeenCalledOnce();
  });

  it("on an open session whose contact's app takes no files/3: still refused at once", async () => {
    const { node, ctx } = contextFor({ dataLink: "open", capabilities: { files: true, payments: false, largeFiles: false } as LinkView["capabilities"] });
    const error = await callApi(ctx, "file.send", { chat: "Alice", path, wait: "none" }).then(() => undefined, asCliError);
    expect(error?.toJSON()).toEqual({ code: "refused", message: `Too large for the contact's app (at most ${LIMITS.maxFileBytes} bytes)` });
    expect(node.sendFile).not.toHaveBeenCalled();
  });
});
