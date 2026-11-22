import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import type { EngineState, LinkView, FileTransferView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files

/**
 * A 1:1 file no longer here (its sender deleted it for everyone mid-transfer, its message was deleted here, or the id
 * is wrong past a real chat's id): no transfer in the engine's state, no record. `file request` answered "Nothing to
 * ask for: the file is all here", `file resend` "it arrived whole", and the other actions the engine's raw "No such
 * file transfer" as `engine`, while `file save` and `file wait` said `not_found` (agents#6037).
 */
const link = { id: "chat-one", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "open",
  capabilities: { files: true, largeFiles: true }, pairing: { status: "ready" } } as unknown as LinkView;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-file-action-gone-"));
  await openPersistentIndexedDb(join(dir, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(dir, "files")), true);
});

function world(transfers: Record<string, FileTransferView>) {
  const node = {
    getState: () => ({ links: [link], groups: [], settings: {}, transport: {}, transfers }) as unknown as EngineState,
    fileAction: vi.fn(async () => { throw new Error("No such file transfer"); }),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

const IN = "chat-one-in-gone", OUT = "chat-one-out-gone";

describe("file actions on a 1:1 file no longer here", () => {
  it("every action on a received one is not_found, as file save says", async () => {
    const { ctx, node } = world({});
    for (const action of ["accept", "decline", "pause", "resume", "cancel", "request"]) {
      await expect(callApi(ctx, "file.action", { file: IN, action })).rejects.toMatchObject({ code: "not_found", message: `No file "${IN}" (ghostly file list <chat|group>)` });
    }
    expect(node.fileAction).not.toHaveBeenCalled();
  });

  it("every action on a sent one is not_found, resend too", async () => {
    const { ctx, node } = world({});
    for (const action of ["pause", "resume", "cancel", "resend"]) {
      await expect(callApi(ctx, "file.action", { file: OUT, action })).rejects.toMatchObject({ code: "not_found", message: `No file "${OUT}" (ghostly file list <chat|group>)` });
    }
    expect(node.fileAction).not.toHaveBeenCalled();
  });

  it("one the engine still moves goes to the engine, as before", async () => {
    const { ctx, node } = world({ [IN]: { state: "transferring", transferred: 10, size: 100, direction: "in" } as FileTransferView });
    node.fileAction.mockResolvedValue(undefined as never);
    await expect(callApi(ctx, "file.action", { file: IN, action: "pause" })).resolves.toMatchObject({ action: "pause" });
    expect(node.fileAction).toHaveBeenCalledTimes(1);
  });
});
