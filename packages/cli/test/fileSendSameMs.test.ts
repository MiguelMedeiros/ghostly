import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files

/**
 * Files sent in the same millisecond (a bot's photos, `ghostly file send` run in parallel): the engine names a sent
 * file's row after its time (`me_<timestamp>`), so each one needs its own, or the chat keeps only one of them.
 */
const link = { id: "chat-burst", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "open",
  capabilities: { files: true }, pairing: { status: "ready" } } as unknown as LinkView;

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-burst-"));
  await openPersistentIndexedDb(join(dir, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(dir, "files")), true);
});

afterEach(() => { vi.restoreAllMocks(); });

describe("file send in one millisecond", () => {
  const sent: number[] = [];
  const node = {
    getState: () => ({ links: [link], groups: [], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
    getMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => undefined),
    sendFile: vi.fn(async ({ timestamp }: { timestamp: number }) => { sent.push(timestamp); }),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;

  it("gives each file its own time", async () => {
    const paths = Array.from({ length: 10 }, (_, i) => {
      const path = join(dir, `photo-${i}.txt`);
      writeFileSync(path, `photo ${i}`);
      return path;
    });
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const answers = await Promise.all(paths.map((path) => callApi(ctx, "file.send", { chat: "Alice", path }) as Promise<{ file: { id: string } }>));
    expect(new Set(sent).size).toBe(10);
    // Kept with each file too: a resend after a drop finds its own row by it.
    const kept = await Promise.all(answers.map(async (a) => (await fileStore.get(a.file.id))?.metadata?.timestamp));
    expect(new Set(kept).size).toBe(10);
  });

  it("goes on from the last time it gave, never back", async () => {
    sent.length = 0;
    const path = join(dir, "later.txt");
    writeFileSync(path, "later");
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    await callApi(ctx, "file.send", { chat: "Alice", path });
    await callApi(ctx, "file.send", { chat: "Alice", path });
    expect(sent[1]).toBeGreaterThan(sent[0]!);
  });

  it("answers the message's id, the row the engine names after that time", async () => {
    sent.length = 0;
    const path = join(dir, "named.txt");
    writeFileSync(path, "named");
    const answer = await callApi(ctx, "file.send", { chat: "Alice", path }) as { chat: string; messageId: string; file: { id: string } };
    // What `message delete --everyone`, `react`, `pin` and `--reply` take, as a group's file and `send` answer it.
    expect(answer).toMatchObject({ chat: "chat-burst", messageId: `me_${sent[0]}` });
  });
});
