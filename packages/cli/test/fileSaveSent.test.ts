import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState, LinkView, FileTransferView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files

/** `file save` of a file sent from here: its bytes were staged whole at send, so it saves before the contact takes it. */
const link = { id: "chat-one", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "idle",
  capabilities: { files: true }, pairing: { status: "ready" } } as unknown as LinkView;

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-save-sent-"));
  await openPersistentIndexedDb(join(dir, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(dir, "files")), true);
});

function world() {
  const transfers: Record<string, FileTransferView> = {};
  const node = {
    getState: () => ({ links: [link], groups: [], settings: {}, transport: {}, transfers }) as unknown as EngineState,
    getMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => undefined),
    sendFile: vi.fn(async () => {}),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, transfers };
}

describe("file save of a sent file", () => {
  it("writes its bytes while the contact has not taken it yet", async () => {
    const { ctx, transfers } = world();
    const path = join(dir, "report.txt");
    writeFileSync(path, "quarterly data");
    const sent = await callApi(ctx, "file.send", { chat: "Alice", path }) as { file: { id: string } };
    // The engine's upload, still waiting for the contact.
    transfers[sent.file.id] = { state: "transferring", transferred: 0, size: 14, direction: "out", stage: "offered" } as unknown as FileTransferView;
    const copy = join(dir, "copy.txt");
    expect(await callApi(ctx, "file.save", { file: sent.file.id, path: copy })).toMatchObject({ size: 14, name: "report.txt" });
    expect(readFileSync(copy, "utf8")).toBe("quarterly data");
    // Restored from a backup: no engine transfer, the record still says the upload had not ended.
    delete transfers[sent.file.id];
    const restored = join(dir, "restored.txt");
    expect(await callApi(ctx, "file.save", { file: sent.file.id, path: restored })).toMatchObject({ size: 14 });
    expect(readFileSync(restored, "utf8")).toBe("quarterly data");
  });

  it("a received file part way in is still not all here", async () => {
    const { ctx } = world();
    await fileStore.put({ id: "chat-one-in-x", linkId: "chat-one", createdAt: 1, direction: "in", metadata: { name: "in.txt", size: 10, mime: "text/plain", timestamp: 1 }, transfer: { state: "transferring", transferred: 4, size: 10 } } as never);
    await expect(callApi(ctx, "file.save", { file: "chat-one-in-x", path: join(dir, "in.txt") })).rejects.toMatchObject({ code: "unavailable", message: "The file is not all here yet (4 of 10 bytes)" });
  });
});
