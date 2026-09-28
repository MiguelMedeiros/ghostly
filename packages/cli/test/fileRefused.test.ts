import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files

/** `file send` when the engine refuses before anything starts: a `refused` error with its reason, and no staged copy. */
const link = { id: "chat-one", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "idle",
  capabilities: { files: true }, pairing: { status: "ready" } } as unknown as LinkView;

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-refused-"));
  await openPersistentIndexedDb(join(dir, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(dir, "files")), true);
});

describe("file send refused by the engine", () => {
  it("says why, as refused, and keeps nothing staged", async () => {
    const node = {
      getState: () => ({ links: [link], groups: [], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
      getMessages: vi.fn(async () => []),
      sendFile: vi.fn(async () => { throw new Error("This chat stopped: your contact's key changed."); }),
    };
    const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
    const path = join(dir, "note.txt");
    writeFileSync(path, "boo");
    await expect(callApi(ctx, "file.send", { chat: "Alice", path })).rejects.toMatchObject({ code: "refused", message: "This chat stopped: your contact's key changed." });
    expect(node.sendFile).toHaveBeenCalledOnce();
    expect(await fileStore.listForLink("chat-one")).toEqual([]);
  });
});
