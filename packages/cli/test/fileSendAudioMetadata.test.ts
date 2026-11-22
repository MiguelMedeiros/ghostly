import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NO_AUDIO_METADATA } from "@ghostly/core";
import { blobDigest, registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState, GroupView, LinkView, MessageFile } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { hasPlace, taggedM4a, taggedMp3 } from "../../core/test/support/audioFixtures";
import { chatViewOf } from "./support/chatView";
// covers: headless.files, files.audio.metadata

/** `file send` of an audio file or a voice note: it leaves without its tags, as the apps send it; one that cannot be stripped is refused. */
const link = { id: "chat-tags", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "open",
  capabilities: { files: true }, pairing: { status: "ready" } } as unknown as LinkView;
const group = { id: "gtags", name: "Team", status: "active", members: [] } as unknown as GroupView;

let dir: string;
let files: NodeFileBytes;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-tags-"));
  await openPersistentIndexedDb(join(dir, "db"));
  files = new NodeFileBytes(join(dir, "files"));
  registerFileBytes("native", async () => files, true);
});

describe("file send of audio", () => {
  const sent: MessageFile[] = [];
  const node = {
    chatView: chatViewOf,
    getState: () => ({ links: [link], groups: [group], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
    getMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => undefined),
    sendFile: vi.fn(async ({ file }: { file: MessageFile }) => { sent.push(file); }),
    groupFileCheck: vi.fn(async () => ({ error: null })),
    sendGroupFile: vi.fn(async ({ file }: { file: MessageFile }) => { sent.push(file); return { error: null, messageId: "m" }; }),
    setGroupTyping: vi.fn(async () => {}),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;

  for (const [as, name, bytes, extra] of [
    ["a file", "memo.mp3", taggedMp3(), {}],
    ["a voice note (--voice)", "memo.m4a", taggedM4a(), { voice: 1200, peaks: ["0", "40", "255"] }],
  ] as const)
    it(`goes as ${as} without its tags, to a chat and to a group: what is stored, sized and digested is the stripped copy`, async () => {
      const path = join(dir, name);
      writeFileSync(path, bytes);
      for (const chat of ["Alice", "group:gtags"]) {
        const answer = await callApi(ctx, "file.send", { chat, path, ...extra }) as { file: { id: string; size: number; name: string } };
        const stored = await fileStore.get(answer.file.id);
        const out = Buffer.from(await files.read(answer.file.id, 0, 1 << 20));
        expect(hasPlace(out)).toBe(false);
        expect(out.length).toBe(bytes.length);
        expect(answer.file).toMatchObject({ name, size: bytes.length });
        expect(sent[sent.length - 1]!.size).toBe(bytes.length);
        expect(stored!.digest).toBe(await blobDigest(new Blob([out])));
      }
    });

  it("is refused when its tags cannot be removed, and nothing of it is stored or sent", async () => {
    const path = join(dir, "cut.mp3");
    writeFileSync(path, taggedMp3().subarray(0, 40));
    const before = sent.length;
    for (const chat of ["Alice", "group:gtags"]) {
      await expect(callApi(ctx, "file.send", { chat, path })).rejects.toMatchObject({ code: "refused", message: NO_AUDIO_METADATA });
    }
    expect(sent.length).toBe(before);
  });
});
