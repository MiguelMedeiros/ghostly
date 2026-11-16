import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { connectDaemon } from "../src/client";
import { serve, type Host } from "../src/host";
import { lockPath } from "../src/profiles";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { chatViewOf } from "./support/chatView";
// covers: headless.daemon, headless.files

/**
 * Ctrl-C on `file send` through a daemon closes the command's connection, and the command says it stopped before the
 * daemon answered. While a large file was still being copied into the profile (seconds per GiB), the daemon went on:
 * the file was in the chat a moment later and went to the contact (agents' hunt on zero: 1 GiB, Ctrl-C at 2 s, in the
 * chat as sent within a minute). Sent again, it went twice.
 */
const link = { id: "chat-gone", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "open",
  capabilities: { files: true, largeFiles: true }, pairing: { status: "ready" } } as unknown as LinkView;
const group = { id: "g1", name: "Team", status: "active", members: [] } as unknown as GroupView;

const root = mkdtempSync(join(tmpdir(), "gh-file-gone-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeAll(async () => {
  await openPersistentIndexedDb(join(root, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(root, "files")), true);
});
afterEach(() => { vi.restoreAllMocks(); });

const staged = () => {
  const files = join(root, "files");
  return existsSync(files) ? readdirSync(files, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length : 0;
};

describe.skipIf(process.platform === "win32").each([
  { name: "a chat", chat: "Alice", linkId: "chat-gone", sent: "sendFile" },
  { name: "a group", chat: "group:g1", linkId: "group:g1", sent: "sendGroupFile" },
] as const)("a file send to $name whose client went away while the file was copied in", ({ name, chat, linkId, sent }) => {
  it("is not sent: the copy stops, and neither the chat's row nor the copied bytes are kept", async () => {
    const dir = join(root, `p-${linkId.replace(":", "-")}`);
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(lockPath(dir), String(process.pid));
    const address = { dir, socket: join(dir, "daemon.sock") };
    const node = {
      chatView: chatViewOf,
      getState: () => ({ links: [link], groups: [group], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
      getMessages: async () => [],
      getMessage: async () => undefined,
      sendFile: vi.fn(async () => {}),
      groupFileCheck: vi.fn(async () => ({ error: null })),
      sendGroupFile: vi.fn(async () => ({ error: null, messageId: "m1" })),
      setTyping: vi.fn(async () => {}),
      setGroupTyping: vi.fn(async () => {}),
    };
    const ctx = { runtime: { server: { node }, paths: { ...address, name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" };
    const path = join(root, `big-${linkId.replace(":", "-")}.bin`);
    writeFileSync(path, new Uint8Array(8 * 1024 * 1024).fill(5));
    // The copy held after its first step until the client is gone: the file is being copied in when Ctrl-C comes.
    let copying = false, release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const append = NodeFileBytes.prototype.append;
    vi.spyOn(NodeFileBytes.prototype, "append").mockImplementation(async function (this: NodeFileBytes, id, offset, bytes) {
      await append.call(this, id, offset, bytes);
      if (offset === 0) { copying = true; await held; }
    });
    const served = await serve({ ctx } as unknown as Host);
    try {
      const client = (await connectDaemon(address))!;
      void client.call("file.send", { chat, path, wait: "none" }).catch(() => {});
      await expect.poll(() => copying).toBe(true);
      client.destroy();
      const connections = () => new Promise<number>((resolve) => served.server.getConnections((_error, count) => resolve(count)));
      await expect.poll(connections).toBe(0);
      release();
      // The copy's own cleanup has run once its bytes are gone.
      await expect.poll(staged).toBe(0);
      // Before: called with the whole file, which went to the contact (or the group) though the command said it stopped.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(node[sent], name).not.toHaveBeenCalled();
      expect(await fileStore.listForLink(linkId)).toEqual([]);
    } finally { await served.close(); }
  });
});
