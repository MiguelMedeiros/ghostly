import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NO_AUDIO_METADATA, PLAYABLE_VIDEO } from "@ghostly/core";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import type { EngineState, LinkView, MessageFile } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { H264_MP4 } from "../../core/test/support/videoFixtures";
import { chatViewOf } from "./support/chatView";
// covers: headless.files, files.video.metadata, files.audio.metadata

/**
 * `file send` types a file by its extension as the apps' file picker does: an .m4v or .ogv video goes as one the
 * contact's app plays, not as bytes to download; a .wma is refused in an audio file's words, not a video's.
 */
const link = { id: "chat-types", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "open",
  capabilities: { files: true }, pairing: { status: "ready" } } as unknown as LinkView;

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-types-"));
  await openPersistentIndexedDb(join(dir, "db"));
  const files = new NodeFileBytes(join(dir, "files"));
  registerFileBytes("native", async () => files, true);
});

describe("file send types a file by its extension", () => {
  const sent: MessageFile[] = [];
  const node = {
    chatView: chatViewOf,
    getState: () => ({ links: [link], groups: [], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
    getMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => undefined),
    sendFile: vi.fn(async ({ file }: { file: MessageFile }) => { sent.push(file); }),
    setGroupTyping: vi.fn(async () => {}),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;

  it("an .m4v or .ogv video goes as a video the contact's app plays", async () => {
    for (const [name, bytes, mime] of [["clip.m4v", H264_MP4, "video/x-m4v"], ["clip.ogv", Buffer.from("not an Ogg stream, sent as it is"), "video/ogg"]] as const) {
      const path = join(dir, name);
      writeFileSync(path, bytes);
      await callApi(ctx, "file.send", { chat: "Alice", path });
      expect(sent[sent.length - 1]).toMatchObject({ name, mime });
      expect(PLAYABLE_VIDEO.test(sent[sent.length - 1]!.mime)).toBe(true);
    }
  });

  it("a .wma is refused as audio whose details cannot be removed, and nothing goes", async () => {
    // An ASF's header object GUID: a WMA's first bytes.
    const asf = Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c, ...new Array(200).fill(0)]);
    const path = join(dir, "song.wma");
    writeFileSync(path, asf);
    const before = sent.length;
    await expect(callApi(ctx, "file.send", { chat: "Alice", path })).rejects.toMatchObject({ code: "refused", message: NO_AUDIO_METADATA });
    expect(sent.length).toBe(before);
  });
});
