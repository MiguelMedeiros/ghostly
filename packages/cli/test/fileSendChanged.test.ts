import { appendFileSync, chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { asCliError } from "../src/errors";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files

/**
 * `file send` (to a chat and to a group) of a file that changes on disk while it is copied in: Node refuses every read
 * of the Blob `openAsBlob` gave once the file grew, shrank or was written again. The send says so with the file's path
 * as `unavailable` (send it again later), not as `engine` "The blob could not be read", and keeps nothing.
 */
const link = { id: "chat-one", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "idle",
  capabilities: { files: true, largeFiles: true }, pairing: { status: "ready" } } as unknown as LinkView;
const group = { id: "g1", name: "Team", status: "active", members: [] } as unknown as GroupView;
const SIZE = 24 * 1024 * 1024;

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-changed-"));
  await openPersistentIndexedDb(join(dir, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(dir, "files")), true);
});

let timer: ReturnType<typeof setInterval> | undefined;
afterEach(() => {
  if (timer) clearInterval(timer);
  timer = undefined;
  vi.restoreAllMocks();
});

function contextFor() {
  const node = {
    getState: () => ({ links: [link], groups: [group], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
    getMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => undefined),
    sendFile: vi.fn(async () => {}),
    groupFileCheck: vi.fn(async () => ({ error: null })),
    sendGroupFile: vi.fn(async () => ({ error: null, messageId: "m1" })),
    setTyping: vi.fn(async () => {}),
    setGroupTyping: vi.fn(async () => {}),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { node, ctx };
}

const targets = [
  { name: "a chat", chat: "Alice", linkId: "chat-one", sent: "sendFile" },
  { name: "a group", chat: "group:g1", linkId: "group:g1", sent: "sendGroupFile" },
] as const;

/** What is kept: rows of the chat or group, and staged copies in the profile's files folder (a failed send adds neither). */
async function kept(linkId: string) {
  const files = join(dir, "files");
  const staged = existsSync(files) ? readdirSync(files, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length : 0;
  return { rows: (await fileStore.listForLink(linkId)).length, staged };
}

const changed = (path: string) => ({ code: "unavailable", message: `${path} changed while it was being sent: send it again once nothing is writing to it`, details: { reason: "file_changed", path } });

describe.each(targets)("file send to $name of a file that changes while it is read", ({ chat, linkId, sent }) => {
  it("a file appended to every 2 ms: unavailable, naming it, nothing kept (3 runs)", async () => {
    for (let run = 1; run <= 3; run++) {
      const { node, ctx } = contextFor();
      const path = join(dir, `app-${run}.log`);
      writeFileSync(path, new Uint8Array(SIZE));
      const before = await kept(linkId);
      timer = setInterval(() => appendFileSync(path, "a log line\n"), 2);
      const error = await callApi(ctx, "file.send", { chat, path }).then(() => undefined, asCliError);
      clearInterval(timer);
      expect(error?.toJSON(), `run ${run}`).toEqual(changed(path));
      expect(node[sent]).not.toHaveBeenCalled();
      expect(await kept(linkId)).toEqual(before);
    }
  });

  it("a file written again with the same size while it is copied in: the same", async () => {
    const { node, ctx } = contextFor();
    const path = join(dir, "saved.bin");
    writeFileSync(path, new Uint8Array(SIZE).fill(1));
    // Past the file system's time granularity (a few ms on Linux), so the rewrite changes the file's time.
    await new Promise((done) => setTimeout(done, 50));
    const append = NodeFileBytes.prototype.append;
    vi.spyOn(NodeFileBytes.prototype, "append").mockImplementation(async function (this: NodeFileBytes, id, offset, bytes) {
      if (offset === 0) writeFileSync(path, new Uint8Array(SIZE).fill(7));
      return append.call(this, id, offset, bytes);
    });
    const before = await kept(linkId);
    const error = await callApi(ctx, "file.send", { chat, path }).then(() => undefined, asCliError);
    expect(error?.toJSON()).toEqual(changed(path));
    expect(node[sent]).not.toHaveBeenCalled();
    expect(await kept(linkId)).toEqual(before);
  });

  it("a file nothing writes to goes as before", async () => {
    const { node, ctx } = contextFor();
    const path = join(dir, "still.bin");
    writeFileSync(path, new Uint8Array(3 * 1024 * 1024 + 5).fill(3));
    const answer = await callApi(ctx, "file.send", { chat, path, wait: "none" }) as { file: { size: number; name: string } };
    expect(answer.file).toMatchObject({ size: 3 * 1024 * 1024 + 5, name: "still.bin" });
    expect(node[sent]).toHaveBeenCalledOnce();
    expect((await fileStore.listForLink(linkId)).length).toBe(1);
  });

  // Root reads anything, so only checked as another user.
  it.skipIf(process.getuid?.() === 0)("a file this user may not read is still refused with its path", async () => {
    const { node, ctx } = contextFor();
    const path = join(dir, `locked-${linkId.replace(":", "-")}.bin`);
    writeFileSync(path, new Uint8Array(1000), { mode: 0o000 });
    try {
      const error = await callApi(ctx, "file.send", { chat, path }).then(() => undefined, asCliError);
      expect(error?.toJSON()).toEqual({ code: "refused", message: `Not allowed to write or read ${path}` });
      expect(node[sent]).not.toHaveBeenCalled();
    } finally { chmodSync(path, 0o600); }
  });
});

describe("a Blob that could not be read anywhere else", () => {
  it("keeps its engine code and words", () => {
    expect(asCliError(new DOMException("The blob could not be read", "NotReadableError")).toJSON()).toEqual({ code: "engine", message: "The blob could not be read" });
  });
});
