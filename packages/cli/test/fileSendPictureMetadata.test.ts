import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NO_PICTURE_METADATA } from "@ghostly/core";
import { blobDigest, registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState, GroupView, LinkView, MessageFile } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files, files.image.metadata

/** `file send` of a photo: it leaves without its metadata, as the apps send it; one that cannot be stripped is refused. */
const link = { id: "chat-exif", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "open",
  capabilities: { files: true }, pairing: { status: "ready" } } as unknown as LinkView;
const group = { id: "gexif", name: "Team", status: "active", members: [] } as unknown as GroupView;

const SECRET = "GHOSTLY-SECRET-GPS 52.37N 4.89E";
const ascii = (value: string) => [...value].map((c) => c.charCodeAt(0));
const segment = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
/** A 300 × 200 JPEG, with an Exif holding `secret` when given. */
const jpegWith = (secret?: string) => Buffer.from([0xff, 0xd8,
  ...(secret ? segment(0xe1, [...ascii("Exif\0\0"), 0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, ...ascii(secret)]) : []),
  ...segment(0xdb, [0, ...new Array(64).fill(1)]), ...segment(0xc0, [8, 0, 200, 1, 44, 1, 1, 0x11, 0]),
  ...segment(0xc4, [0, ...new Array(16).fill(0)]), ...segment(0xda, [1, 1, 0, 0, 63, 0]), 0x12, 0x34, 0xff, 0xd9]);

let dir: string;
let files: NodeFileBytes;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-exif-"));
  await openPersistentIndexedDb(join(dir, "db"));
  files = new NodeFileBytes(join(dir, "files"));
  registerFileBytes("native", async () => files, true);
});

describe("file send of a photo", () => {
  const sent: MessageFile[] = [];
  const node = {
    getState: () => ({ links: [link], groups: [group], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
    getMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => undefined),
    sendFile: vi.fn(async ({ file }: { file: MessageFile }) => { sent.push(file); }),
    groupFileCheck: vi.fn(async () => ({ error: null })),
    sendGroupFile: vi.fn(async ({ file }: { file: MessageFile }) => { sent.push(file); return { error: null, messageId: "m" }; }),
    setGroupTyping: vi.fn(async () => {}),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;

  it("goes without its metadata, to a chat and to a group: what is stored, sized and digested is the stripped copy", async () => {
    const path = join(dir, "IMG_0001.jpg");
    writeFileSync(path, jpegWith(SECRET));
    const clean = jpegWith();
    for (const chat of ["Alice", "group:gexif"]) {
      const answer = await callApi(ctx, "file.send", { chat, path }) as { file: { id: string; size: number; name: string; image?: unknown } };
      const stored = await fileStore.get(answer.file.id);
      const bytes = Buffer.from(await files.read(answer.file.id, 0, 1 << 20));
      expect(bytes.includes(Buffer.from(SECRET, "latin1"))).toBe(false);
      expect(bytes).toEqual(clean);
      expect(answer.file).toMatchObject({ name: "IMG_0001.jpg", size: clean.length, image: { width: 300, height: 200 } });
      expect(sent[sent.length - 1]!.size).toBe(clean.length);
      expect(stored!.metadata!.size).toBe(clean.length);
      expect(stored!.transfer!.size).toBe(clean.length);
      expect(stored!.digest).toBe(await blobDigest(new Blob([clean])));
    }
  });

  it("is refused when its metadata cannot be removed, and nothing of it is stored or sent", async () => {
    const path = join(dir, "cut.jpg");
    writeFileSync(path, jpegWith(SECRET).subarray(0, -2));
    const before = sent.length;
    for (const chat of ["Alice", "group:gexif"]) {
      await expect(callApi(ctx, "file.send", { chat, path })).rejects.toMatchObject({ code: "refused", message: NO_PICTURE_METADATA });
    }
    expect(sent.length).toBe(before);
  });
});
