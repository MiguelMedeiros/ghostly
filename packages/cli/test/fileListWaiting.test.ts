import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState, LinkView, MessageFile } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files

/**
 * `file list` of a file sent while the contact is away: the engine has no transfer for it until the contact is back,
 * and its row says it waits for them, not `transfer: null` as one that finished before this run used to read.
 */
const link = { id: "chat-away", label: "Bob", peerPubKeyZ32: "pbob", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "open",
  capabilities: { files: true }, pairing: { status: "ready" } } as unknown as LinkView;

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-list-waiting-"));
  await openPersistentIndexedDb(join(dir, "db"));
  const files = new NodeFileBytes(join(dir, "files"));
  registerFileBytes("native", async () => files, true);
});

describe("file list of a file sent to a contact who is away", () => {
  const messages: { id: string; sender: string; timestamp: number; file: MessageFile }[] = [];
  const node = {
    getState: () => ({ links: [link], groups: [], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
    getMessages: vi.fn(async () => messages),
    // `file list` reads the history's file rows only (the file index): here every message carries one.
    fileMessages: vi.fn(async () => messages.filter((m) => m.file)),
    getMessage: vi.fn(async () => undefined),
    setTyping: vi.fn(),
    sendFile: vi.fn(async ({ file, timestamp }: { file: MessageFile; timestamp: number }) => { messages.push({ id: `me_${timestamp}`, sender: "me", timestamp, file }); }),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "one-shot", version: "test" } as unknown as ApiContext;

  it("shows it waiting for the contact, and one that finished before this run still reads done", async () => {
    const path = join(dir, "small.bin");
    writeFileSync(path, Buffer.alloc(1234, 7));
    const waiting = await callApi(ctx, "file.send", { chat: "Bob", path, wait: "none" }) as { file: { id: string } };
    const old = await callApi(ctx, "file.send", { chat: "Bob", path, wait: "none" }) as { file: { id: string } };
    const record = await fileStore.get(old.file.id);
    await fileStore.put({ ...record!, transfer: { state: "done", transferred: 1234, size: 1234 } });

    const { files } = await callApi(ctx, "file.list", { chat: "Bob" }) as { files: { file: { id: string }; transfer: unknown }[] };
    expect(files.find((f) => f.file.id === waiting.file.id)!.transfer).toEqual({ state: "transferring", transferred: 0, size: 1234, direction: "out", stage: "waiting", waitingFor: "contact" });
    expect(files.find((f) => f.file.id === old.file.id)!.transfer).toEqual({ state: "done", transferred: 1234, size: 1234, direction: "out" });
  });
});
