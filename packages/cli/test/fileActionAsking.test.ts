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
 * A 1:1 file offered to this side that waits for its `file accept` (over 25 MiB): the engine takes `pause`, `resume` and
 * `request` of it and does nothing (it stays "waiting for you to take it"), so the CLI refuses them with the step,
 * rather than echoing the action with exit 0, which read as the file paused or asked for.
 */
const link = { id: "chat-one", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "open",
  capabilities: { files: true, largeFiles: true }, pairing: { status: "ready" } } as unknown as LinkView;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-file-action-asking-"));
  await openPersistentIndexedDb(join(dir, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(dir, "files")), true);
});

function world(transfers: Record<string, FileTransferView>) {
  const node = {
    getState: () => ({ links: [link], groups: [], settings: {}, transport: {}, transfers }) as unknown as EngineState,
    fileAction: vi.fn(),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

const IN = "chat-one-in-a", OUT = "chat-one-out-b";
const asking = (direction: "in" | "out") => ({ state: "transferring", stage: "asking", transferred: 0, size: 268_435_456, direction }) as FileTransferView;

describe("file actions on a 1:1 file offered here that waits for file accept", () => {
  it("pause, resume and request are refused with the step, and the engine is not asked", async () => {
    const { ctx, node } = world({ [IN]: asking("in") });
    for (const action of ["pause", "resume", "request"]) {
      await expect(callApi(ctx, "file.action", { file: IN, action })).rejects.toMatchObject({ code: "refused", message: "Not taken yet: it waits for you to take it (file accept, or file decline)" });
    }
    expect(node.fileAction).not.toHaveBeenCalled();
  });

  it("accept, decline and cancel still go", async () => {
    for (const action of ["accept", "decline", "cancel"]) {
      const { ctx, node } = world({ [IN]: asking("in") });
      await expect(callApi(ctx, "file.action", { file: IN, action })).resolves.toMatchObject({ action });
      expect(node.fileAction).toHaveBeenCalledTimes(1);
    }
  });

  it("a sent one the contact has not taken yet may still be paused or resumed here", async () => {
    const { ctx, node } = world({ [OUT]: asking("out") });
    for (const action of ["pause", "resume", "resend"]) await expect(callApi(ctx, "file.action", { file: OUT, action })).resolves.toMatchObject({ action });
    expect(node.fileAction).toHaveBeenCalledTimes(3);
  });
});
