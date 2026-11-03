import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState, LinkView, FileTransferView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files

/**
 * A 1:1 transfer that ended (cancelled, declined, failed): the engine takes any action on it and does nothing, so the
 * CLI refuses it with the transfer's words rather than echoing the action with exit 0. `file save` says it ended.
 */
const link = { id: "chat-one", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "open",
  capabilities: { files: true, largeFiles: true }, pairing: { status: "ready" } } as unknown as LinkView;

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-action-ended-"));
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
const ended = (direction: "in" | "out", error: string, retry = false) =>
  ({ state: "failed", transferred: 8_388_608, size: 12_582_912, direction, error, ...(retry ? { retry } : {}) }) as FileTransferView;

describe("file actions on an ended 1:1 transfer", () => {
  it("pause, resume, cancel, accept and decline of a received file the sender cancelled are refused with its words", async () => {
    const { ctx, node } = world({ [IN]: ended("in", "Cancelled by the sender") });
    for (const action of ["pause", "resume", "cancel", "accept", "decline"]) {
      await expect(callApi(ctx, "file.action", { file: IN, action })).rejects.toMatchObject({ code: "refused", message: "It ended: Cancelled by the sender" });
    }
    expect(node.fileAction).not.toHaveBeenCalled();
  });

  it("pause, resume and cancel of a sent file this side cancelled are refused; accept and decline are not for a sent file", async () => {
    const { ctx, node } = world({ [OUT]: ended("out", "You cancelled it") });
    for (const action of ["pause", "resume", "cancel"]) {
      await expect(callApi(ctx, "file.action", { file: OUT, action })).rejects.toMatchObject({ code: "refused", message: "It ended: You cancelled it" });
    }
    for (const action of ["accept", "decline"]) {
      await expect(callApi(ctx, "file.action", { file: OUT, action })).rejects.toMatchObject({ code: "bad_request" });
    }
    expect(node.fileAction).not.toHaveBeenCalled();
  });

  it("a sent file that failed and can go again names file resend", async () => {
    const { ctx } = world({ [OUT]: ended("out", "The contact stopped answering", true) });
    await expect(callApi(ctx, "file.action", { file: OUT, action: "resume" })).rejects.toMatchObject({ code: "refused", message: "It ended: The contact stopped answering (file resend sends it again)" });
  });

  it("an ended transfer known only from its record (after a restart) is refused too", async () => {
    await fileStore.put({ id: "chat-one-in-r", linkId: "chat-one", createdAt: 1, direction: "in", metadata: { name: "r.bin", size: 10, mime: "application/octet-stream", timestamp: 1 }, transfer: { state: "failed", transferred: 4, size: 10, error: "You declined it" } } as never);
    const { ctx, node } = world({});
    await expect(callApi(ctx, "file.action", { file: "chat-one-in-r", action: "accept" })).rejects.toMatchObject({ code: "refused", message: "It ended: You declined it" });
    expect(node.fileAction).not.toHaveBeenCalled();
  });

  it("a transfer still moving takes the action", async () => {
    const { ctx, node } = world({ [IN]: { state: "transferring", transferred: 1, size: 10, direction: "in" } as FileTransferView });
    await expect(callApi(ctx, "file.action", { file: IN, action: "pause" })).resolves.toMatchObject({ action: "pause" });
    expect(node.fileAction).toHaveBeenCalledWith({ linkId: "chat-one", fileId: IN, action: "pause" });
  });

  it("cancel of a sent file that arrived whole is refused: too late, the engine would do nothing and it ends done", async () => {
    const whole = { state: "transferring", transferred: 12_582_912, size: 12_582_912, direction: "out" } as const;
    for (const view of [{ ...whole, stage: "verifying" }, whole, { ...whole, stage: "waiting" }] as FileTransferView[]) {
      const { ctx, node } = world({ [OUT]: view });
      await expect(callApi(ctx, "file.action", { file: OUT, action: "cancel" })).rejects.toMatchObject({ code: "refused", message: "Too late to cancel: it arrived whole, and the contact keeps it" });
      expect(node.fileAction).not.toHaveBeenCalled();
    }
    // The contact asks about it again, or it is paused here: it can still be cancelled. One arriving here always can.
    for (const view of [{ ...whole, stage: "asking" }, { ...whole, stage: "paused", pausedBy: "me" }, { ...whole, stage: "verifying", direction: "in" }] as FileTransferView[]) {
      const id = view.direction === "in" ? IN : OUT;
      const { ctx, node } = world({ [id]: view });
      await expect(callApi(ctx, "file.action", { file: id, action: "cancel" })).resolves.toMatchObject({ action: "cancel" });
      expect(node.fileAction).toHaveBeenCalledWith({ linkId: "chat-one", fileId: id, action: "cancel" });
    }
  });

  it("file save of a received file that ended says it ended, not that it is on its way", async () => {
    await fileStore.put({ id: IN, linkId: "chat-one", createdAt: 1, direction: "in", metadata: { name: "big.bin", size: 12_582_912, mime: "application/octet-stream", timestamp: 1 }, transfer: { state: "transferring", transferred: 8_388_608, size: 12_582_912 } } as never);
    const { ctx } = world({ [IN]: ended("in", "Cancelled by the sender") });
    await expect(callApi(ctx, "file.save", { file: IN, path: join(dir, "big.bin") })).rejects.toMatchObject({ code: "refused", message: "It ended: Cancelled by the sender" });
  });

  it("pause of a file being checked is refused: the engine would do nothing and it ends done", async () => {
    for (const [id, direction] of [[OUT, "out"], [IN, "in"]] as const) {
      const { ctx, node } = world({ [id]: { state: "transferring", stage: "verifying", transferred: 10, size: 10, direction } as FileTransferView });
      await expect(callApi(ctx, "file.action", { file: id, action: "pause" })).rejects.toMatchObject({ code: "refused", message: "Too late to pause: it is being checked" });
      expect(node.fileAction).not.toHaveBeenCalled();
    }
  });

  it("pause of a sent file that arrived whole, offered again, is refused: paused, it could be cancelled", async () => {
    const whole = { state: "transferring", transferred: 12_582_912, size: 12_582_912, direction: "out" } as const;
    for (const view of [whole, { ...whole, stage: "waiting" }] as FileTransferView[]) {
      const { ctx, node } = world({ [OUT]: view });
      await expect(callApi(ctx, "file.action", { file: OUT, action: "pause" })).rejects.toMatchObject({ code: "refused", message: "Too late to pause: it arrived whole, and the contact keeps it" });
      expect(node.fileAction).not.toHaveBeenCalled();
    }
  });
});
