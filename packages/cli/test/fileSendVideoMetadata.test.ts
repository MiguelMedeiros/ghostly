import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NO_VIDEO_METADATA } from "@ghostly/core";
import { blobDigest, registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState, GroupView, LinkView, MessageFile } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { H264_MP4, PLACE, hasPlace, withMovie, xyzUdta } from "../../core/test/support/videoFixtures";
import { chatViewOf } from "./support/chatView";
// covers: headless.files, files.video.metadata

/** `file send` of a video: it leaves without where it was recorded, as the apps send it; one that cannot be stripped is refused. */
const link = { id: "chat-xyz", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "open",
  capabilities: { files: true }, pairing: { status: "ready" } } as unknown as LinkView;
const group = { id: "gxyz", name: "Team", status: "active", members: [] } as unknown as GroupView;

let dir: string;
let files: NodeFileBytes;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-xyz-"));
  await openPersistentIndexedDb(join(dir, "db"));
  files = new NodeFileBytes(join(dir, "files"));
  registerFileBytes("native", async () => files, true);
});

describe("file send of a video", () => {
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

  it("goes without where it was recorded, to a chat and to a group: what is stored, sized and digested is the stripped copy", async () => {
    const path = join(dir, "VID_20261103.mp4");
    const recorded = withMovie(H264_MP4, [xyzUdta()], Buffer.from(`location ${PLACE}`, "latin1"));
    writeFileSync(path, recorded);
    for (const chat of ["Alice", "group:gxyz"]) {
      const answer = await callApi(ctx, "file.send", { chat, path }) as { file: { id: string; size: number; name: string } };
      const stored = await fileStore.get(answer.file.id);
      const bytes = Buffer.from(await files.read(answer.file.id, 0, 1 << 20));
      expect(hasPlace(bytes)).toBe(false);
      expect(bytes.length).toBe(recorded.length);
      expect(answer.file).toMatchObject({ name: "VID_20261103.mp4", size: recorded.length });
      expect(sent[sent.length - 1]!.size).toBe(recorded.length);
      expect(stored!.digest).toBe(await blobDigest(new Blob([bytes])));
    }
  });

  it("is refused when its metadata cannot be removed, and nothing of it is stored or sent", async () => {
    const path = join(dir, "cut.mp4");
    writeFileSync(path, withMovie(H264_MP4, [xyzUdta()]).subarray(0, 500));
    const before = sent.length;
    for (const chat of ["Alice", "group:gxyz"]) {
      await expect(callApi(ctx, "file.send", { chat, path })).rejects.toMatchObject({ code: "refused", message: NO_VIDEO_METADATA });
    }
    expect(sent.length).toBe(before);
  });
});
