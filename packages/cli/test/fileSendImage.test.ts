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
// covers: headless.files, files.image.meta

/** `file send` of a picture: its size, read from its first bytes, goes with it to the engine and back in the answer. */
const link = { id: "chat-pic", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "open",
  capabilities: { files: true }, pairing: { status: "ready" } } as unknown as LinkView;

/** The first bytes of a PNG of this size, then some more: nothing past the header is read. */
function png(width: number, height: number): Buffer {
  const head = Buffer.alloc(33);
  head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(4096)]);
}

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-image-"));
  await openPersistentIndexedDb(join(dir, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(dir, "files")), true);
});

describe("file send of a picture", () => {
  const sent: MessageFile[] = [];
  const node = {
    getState: () => ({ links: [link], groups: [], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
    getMessages: vi.fn(async () => []),
    sendFile: vi.fn(async ({ file }: { file: MessageFile }) => { sent.push(file); }),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;

  it("sends its size and answers with it", async () => {
    const path = join(dir, "tall.png");
    writeFileSync(path, png(640, 1280));
    const answer = await callApi(ctx, "file.send", { chat: "Alice", path }) as { file: { id: string; image?: unknown } };
    expect(answer.file.image).toEqual({ width: 640, height: 1280 });
    expect(sent[sent.length - 1]!.image).toEqual({ width: 640, height: 1280 });
    // Kept with the file, so a resend or a forward sends it again.
    expect((await fileStore.get(answer.file.id))?.metadata?.image).toEqual({ width: 640, height: 1280 });
  });

  it("sends none for a picture whose first bytes do not say, or for anything else", async () => {
    for (const [name, bytes] of [["broken.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0])], ["notes.txt", png(10, 10)]] as const) {
      const path = join(dir, name);
      writeFileSync(path, bytes);
      const answer = await callApi(ctx, "file.send", { chat: "Alice", path }) as { file: { image?: unknown } };
      expect(answer.file.image).toBeUndefined();
      expect(sent[sent.length - 1]!.image).toBeUndefined();
    }
  });
});
