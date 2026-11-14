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
 * A 1:1 transfer the contact paused: only their resume moves it. The engine takes `resume`, `request` and `resend` here
 * and does nothing (the file stays "paused by the contact"), so the CLI refuses them rather than echoing the action with
 * exit 0, which a bot read as the file going on.
 */
const link = { id: "chat-one", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "open",
  capabilities: { files: true, largeFiles: true }, pairing: { status: "ready" } } as unknown as LinkView;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-file-action-paused-"));
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
const paused = (direction: "in" | "out", pausedBy: "me" | "peer") =>
  ({ state: "transferring", stage: "paused", pausedBy, transferred: 50_331_648, size: 268_435_456, direction }) as FileTransferView;

describe("file actions on a 1:1 transfer the contact paused", () => {
  it("resume and request of a received file the sender paused are refused, and the engine is not asked", async () => {
    const { ctx, node } = world({ [IN]: paused("in", "peer") });
    for (const action of ["resume", "request"]) {
      await expect(callApi(ctx, "file.action", { file: IN, action })).rejects.toMatchObject({ code: "refused", message: "Paused by the contact: it goes on when they resume it" });
    }
    expect(node.fileAction).not.toHaveBeenCalled();
  });

  it("resume and resend of a sent file the receiver paused are refused", async () => {
    const { ctx, node } = world({ [OUT]: paused("out", "peer") });
    for (const action of ["resume", "resend"]) {
      await expect(callApi(ctx, "file.action", { file: OUT, action })).rejects.toMatchObject({ code: "refused", message: "Paused by the contact: it goes on when they resume it" });
    }
    expect(node.fileAction).not.toHaveBeenCalled();
  });

  it("pause and cancel of one the contact paused still go: this side may hold it too, or end it", async () => {
    const { ctx, node } = world({ [IN]: paused("in", "peer"), [OUT]: paused("out", "peer") });
    for (const file of [IN, OUT]) for (const action of ["pause", "cancel"]) await expect(callApi(ctx, "file.action", { file, action })).resolves.toMatchObject({ action });
    expect(node.fileAction).toHaveBeenCalledTimes(4);
  });

  it("resume of one paused here goes, as before", async () => {
    const { ctx, node } = world({ [IN]: paused("in", "me"), [OUT]: paused("out", "me") });
    for (const file of [IN, OUT]) await expect(callApi(ctx, "file.action", { file, action: "resume" })).resolves.toMatchObject({ action: "resume" });
    await expect(callApi(ctx, "file.action", { file: IN, action: "request" })).resolves.toMatchObject({ action: "request" });
    await expect(callApi(ctx, "file.action", { file: OUT, action: "resend" })).resolves.toMatchObject({ action: "resend" });
    expect(node.fileAction).toHaveBeenCalledTimes(4);
  });
});
