import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState, LinkView, FileTransferView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files

/**
 * A received file this device had no room for: the engine's record says `Could not store the file: QuotaExceededError…`
 * (core's `storeFailure`, named so for the app's matcher). The CLI says it as every other full disk: `unavailable`, its
 * own no-room words and `reason: "no_space"`. Before, `file wait` was `engine` with Node's raw `ENOSPC: …` (or the DOM
 * class name), and `file list` / `file resume` / `file save` showed the same.
 */
const link = { id: "chat-one", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "open",
  capabilities: { files: true, largeFiles: true }, pairing: { status: "ready" } } as unknown as LinkView;

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-no-room-"));
  await openPersistentIndexedDb(join(dir, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(dir, "files")), true);
});

function world(transfers: Record<string, FileTransferView>, messages: StoredMessage[] = []) {
  const node = {
    getState: () => ({ links: [link], groups: [], settings: {}, transport: {}, transfers }) as unknown as EngineState,
    getMessages: vi.fn(async () => messages),
    fileAction: vi.fn(),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

const WORDS = "No room left on the disk for this file: free some space, then ask for it again";
/** What the engine stores, a Node write's ENOSPC (since core names it) and the CLI store's own refusal. */
const STORED = [
  "Could not store the file: QuotaExceededError: ENOSPC: no space left on device, write",
  "Could not store the file: QuotaExceededError: No room left on the disk of /tmp/p: free some space, then try again",
  "Could not store the file: QuotaExceededError",
];
const failed = (id: string, error: string): FileTransferView => ({ state: "failed", transferred: 8_388_608, size: 20_000_000, direction: "in", error } as FileTransferView);
const raw = (text: string) => /ENOSPC|QuotaExceededError|Could not store/.test(text);

describe("a received file that failed for want of room", () => {
  it.each(STORED)("file wait answers unavailable with the CLI's words and reason no_space (%s)", async (error) => {
    const id = "chat-one-in-nr000001";
    const { ctx } = world({ [id]: failed(id, error) });
    const refused = await callApi(ctx, "file.wait", { file: id, timeout: 5 }).then(() => undefined, (e: unknown) => e as { code: string; message: string; details: Record<string, unknown> });
    expect(refused).toMatchObject({ code: "unavailable", message: WORDS, details: { file: id, chat: "chat-one", reason: "no_space", retry: false } });
    expect(raw(refused!.message)).toBe(false);
  });

  it("file wait on a file that failed for another reason keeps engine and its words", async () => {
    const id = "chat-one-in-nr000002";
    const { ctx } = world({ [id]: failed(id, "Could not store the file: EIO: i/o error, write") });
    await expect(callApi(ctx, "file.wait", { file: id, timeout: 5 })).rejects.toMatchObject({ code: "engine", message: "Could not store the file: EIO: i/o error, write" });
  });

  it("file list carries reason no_space next to the CLI's words", async () => {
    const id = "chat-one-in-nr000003", other = "chat-one-in-nr000004";
    const messages = [id, other].map((fileId, n) => ({ linkId: "chat-one", id: `peer_${n}`, text: "", sender: "peer", timestamp: n + 1, via: "datalink", file: { id: fileId, name: `${n}.bin`, size: 20_000_000, mime: "application/octet-stream" } })) as StoredMessage[];
    const { ctx } = world({ [id]: failed(id, STORED[0]), [other]: failed(other, "Cancelled by the sender") }, messages);
    const { files } = await callApi(ctx, "file.list", { chat: "chat-one" }) as { files: { file: { id: string }; transfer: Record<string, unknown> }[] };
    expect(files.find((f) => f.file.id === id)?.transfer).toMatchObject({ state: "failed", error: WORDS, reason: "no_space" });
    expect(files.find((f) => f.file.id === other)?.transfer).toEqual(failed(other, "Cancelled by the sender"));
  });

  it("file resume and file save say it ended in the CLI's words, with reason no_space", async () => {
    const id = "chat-one-in-nr000005";
    const { ctx, node } = world({ [id]: failed(id, STORED[1]) });
    await fileStore.put({ id, linkId: "chat-one", createdAt: 1, direction: "in", metadata: { name: "big.bin", size: 20_000_000, mime: "application/octet-stream", timestamp: 1 }, transfer: failed(id, STORED[1]) } as never);
    await expect(callApi(ctx, "file.action", { file: id, action: "resume" })).rejects.toMatchObject({ code: "refused", message: `It ended: ${WORDS}`, details: { reason: "no_space" } });
    await expect(callApi(ctx, "file.action", { file: id, action: "request" })).rejects.toMatchObject({ code: "refused", message: `It ended: ${WORDS}`, details: { reason: "no_space" } });
    await expect(callApi(ctx, "file.save", { file: id, dir })).rejects.toMatchObject({ code: "refused", message: `It ended: ${WORDS}`, details: { reason: "no_space" } });
    expect(node.fileAction).not.toHaveBeenCalled();
  });
});
