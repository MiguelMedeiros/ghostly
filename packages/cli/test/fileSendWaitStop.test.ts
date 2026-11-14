import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { connectDaemon } from "../src/client";
import type { CliError } from "../src/errors";
import { serve, type Host } from "../src/host";
import { lockPath } from "../src/profiles";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { chatViewOf } from "./support/chatView";
// covers: headless.daemon, headless.files

/**
 * A `file send --wait` through a daemon that stops (a restart) while the contact is still taking the file: it answers
 * with what it knows, as `send --wait` does, its `messageId` and the file's id among it. Its connection ended under the
 * wait before, and the command failed with exit 4 "may be done: check `ghostly chat history` for a message", with
 * nothing to say which message: a bot that sent again sent the file twice.
 */
const link = { id: "chat-stop", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "open",
  capabilities: { files: true }, pairing: { status: "ready" } } as unknown as LinkView;

const root = mkdtempSync(join(tmpdir(), "gh-file-stop-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeAll(async () => {
  await openPersistentIndexedDb(join(root, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(root, "files")), true);
});

describe.skipIf(process.platform === "win32")("a daemon that stops while a file send waits", () => {
  it("answers it before the connection ends: timeout with chat, messageId, the file's id, its progress and reason daemon-stopped", async () => {
    const dir = join(root, "profile");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(lockPath(dir), String(process.pid));
    const address = { dir, socket: join(dir, "daemon.sock") };
    let sending: string | undefined;
    let sentAt = 0;
    const node = {
      chatView: chatViewOf,
      getState: () => ({ links: [link], groups: [], settings: {}, transport: {}, transfers: sending ? { [sending]: { state: "transferring", direction: "out", transferred: 4, size: 8, stage: "sending" } } : {} }) as unknown as EngineState,
      getMessages: async () => [],
      getMessage: async () => undefined,
      sendFile: async ({ file, timestamp }: { file: { id: string }; timestamp: number }) => { sending = file.id; sentAt = timestamp; },
    };
    const ctx = { runtime: { server: { node }, paths: { ...address, name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" };
    const path = join(root, "photo.txt");
    writeFileSync(path, "12345678");
    const served = await serve({ ctx } as unknown as Host);
    const client = (await connectDaemon(address))!;
    const sent = client.call("file.send", { chat: "Alice", path, wait: "sent", timeout: 60 }).catch((error: unknown) => error);
    await expect.poll(() => sending).toBeDefined();
    await served.close();
    const failure = await sent as CliError;
    // Before: {"code":"timeout","message":"The daemon stopped before it answered file.send, which may be done: check …","details":{"method":"file.send","reason":"daemon-stopped"}}.
    expect(failure.code).toBe("timeout");
    expect(failure.details).toEqual({ chat: "chat-stop", messageId: `me_${sentAt}`, file: sending, transferred: 4, size: 8, stage: "sending", reason: "daemon-stopped" });
    expect(failure.message).not.toContain("chat history");
    expect(failure.message).toContain("The daemon stopped before the wait ended");
  });
});
