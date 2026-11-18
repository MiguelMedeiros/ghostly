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

function world(transfers: Record<string, FileTransferView>, links: LinkView[] = [link]) {
  const node = {
    getState: () => ({ links, groups: [], settings: {}, transport: {}, transfers }) as unknown as EngineState,
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

  it("accept of an offer larger than the room left now is refused with the room (it keeps waiting); before, it started and failed part way", async () => {
    await fileStore.put({ id: IN, linkId: "chat-one", createdAt: 1, direction: "in", metadata: { name: "big.bin", size: 24_465_408, mime: "application/octet-stream", timestamp: 1 }, transfer: { state: "transferring", transferred: 0, size: 24_465_408 } } as never);
    const { ctx, node } = world({ [IN]: { state: "transferring", stage: "asking", transferred: 0, size: 24_465_408, direction: "in", room: 16_228_352 } as FileTransferView });
    // As the engine's `FileDesk.accept` refuses it.
    node.fileAction.mockRejectedValueOnce(Object.assign(new Error("No room on this device for this file (15.5 MB free)"), { room: 16_228_352, size: 24_465_408, coming: 0 }));
    await expect(callApi(ctx, "file.action", { file: IN, action: "accept" })).rejects.toMatchObject({
      code: "refused", message: `big.bin (24.5 MB) does not fit: 16.2 MB free. Free some space, then ghostly file accept ${IN} again (or file decline)`,
      details: { reason: "no_room", room: 16_228_352 },
    });
    // Any other engine error goes on as it came (the daemon's `asCliError` names it, as before).
    node.fileAction.mockRejectedValueOnce(new Error("No such file transfer"));
    await expect(callApi(ctx, "file.action", { file: IN, action: "accept" })).rejects.not.toHaveProperty("code");
  });

  /**
   * A file that fits the room but not beside a file already taken that still comes: the line said "No room … (38.8 MB
   * free)" for a 27.3 MB file, the room in binary MB and the size in decimal, and neither the other file nor the way out.
   */
  it("accept refused for no room beside a file still coming names the file, its size, the room and what still comes, in file save's MB", async () => {
    const id = "chat-one-in-room";
    await fileStore.put({ id, linkId: "chat-one", createdAt: 1, direction: "in", metadata: { name: "b26.bin", size: 27_262_976, mime: "application/octet-stream", timestamp: 1 }, transfer: { state: "transferring", transferred: 0, size: 27_262_976 } } as never);
    const { ctx, node } = world({ [id]: { state: "transferring", stage: "asking", transferred: 0, size: 27_262_976, direction: "in", room: 40_714_240 } as FileTransferView });
    node.fileAction.mockRejectedValueOnce(Object.assign(new Error("No room on this device for this file (38.8 MB free)"), { room: 40_714_240, size: 27_262_976, coming: 27_262_976 }));
    await expect(callApi(ctx, "file.action", { file: id, action: "accept" })).rejects.toMatchObject({
      code: "refused",
      message: `b26.bin (27.3 MB) does not fit: 40.7 MB free, and 27.3 MB of files still coming need it first. Free some space, then ghostly file accept ${id} again (or file decline)`,
      details: { reason: "no_room", room: 40_714_240 },
    });
  });

  /**
   * The files still coming that hold the room are named, with their chat and the command that cancels each: the line
   * said only how many MB of them there were, and nothing said which files, nor in which chat, to cancel to make room.
   */
  it("accept refused for no room beside the files still coming names them, their chats and how to cancel each", async () => {
    const id = "chat-one-in-named";
    const bob = { ...link, id: "chat-two", label: undefined, peerNick: "Bob", peerPubKeyZ32: "pbob" } as unknown as LinkView;
    const carol = { ...link, id: "chat-three", label: "Carol", peerPubKeyZ32: "pcarol" } as unknown as LinkView;
    const put = (fileId: string, linkId: string, name: string, size: number) => fileStore.put({ id: fileId, linkId, createdAt: 1, direction: "in", metadata: { name, size, mime: "application/octet-stream", timestamp: 1 }, transfer: { state: "transferring", transferred: 0, size } } as never);
    await put(id, "chat-one", "holiday.zip", 30_000_000);
    await put("chat-two-in-big", "chat-two", "backup.iso", 25_000_000);
    await put("chat-three-in-song", "chat-three", "song.flac", 10_000_000);
    const taken = (size: number, transferred: number, patch: Partial<FileTransferView> = {}) => ({ state: "transferring", direction: "in", size, transferred, ...patch }) as FileTransferView;
    const { ctx, node } = world({
      [id]: taken(30_000_000, 0, { stage: "asking", room: 4_000_000 }),
      "chat-two-in-big": taken(25_000_000, 1_000_000),
      "chat-three-in-song": taken(10_000_000, 4_000_000, { stage: "paused", pausedBy: "peer" }),
      "chat-four-in-nameless": taken(2_000_000, 0),
      // Not holding the room: one still asked about, one sent from here, one ended, a group's file.
      "chat-two-in-asked": taken(50_000_000, 0, { stage: "asking" }),
      "chat-two-out-sent": { state: "transferring", direction: "out", size: 70_000_000, transferred: 0 } as FileTransferView,
      "chat-two-in-failed": { state: "failed", direction: "in", size: 80_000_000, transferred: 0, error: "You cancelled it" } as FileTransferView,
      "group-g1-in-x": taken(90_000_000, 0),
    }, [link, bob, carol, { ...link, id: "chat-four", label: undefined, peerNick: undefined } as unknown as LinkView]);
    node.fileAction.mockRejectedValueOnce(Object.assign(new Error("No room on this device for this file beside the files still coming (3.8 MB left of 38.1 MB free)"), { room: 40_000_000, size: 30_000_000, coming: 32_000_000 }));
    await expect(callApi(ctx, "file.action", { file: id, action: "accept" })).rejects.toMatchObject({
      code: "refused",
      message: "holiday.zip (30 MB) does not fit: 40 MB free, and 32 MB of files still coming need it first: "
        + "backup.iso from Bob (24 MB to come: ghostly file cancel chat-two-in-big), "
        + "song.flac from Carol (6 MB to come: ghostly file cancel chat-three-in-song), "
        + "a file from chat-four (2 MB to come: ghostly file cancel chat-four-in-nameless). "
        + `Free some space or cancel one of them, then ghostly file accept ${id} again (or file decline)`,
      // The contract a script reads is the same: the code, the reason and the room.
      details: { reason: "no_room", room: 40_000_000 },
    });
    // Past three, the rest are counted.
    await put("chat-two-in-small", "chat-two", "small.bin", 1_000_000);
    const more = world({ [id]: taken(30_000_000, 0, { stage: "asking" }), "chat-two-in-big": taken(25_000_000, 1_000_000), "chat-three-in-song": taken(10_000_000, 4_000_000),
      "chat-four-in-nameless": taken(2_000_000, 0), "chat-two-in-small": taken(1_000_000, 0) }, [link, bob, carol, { ...link, id: "chat-four", label: undefined } as unknown as LinkView]);
    more.node.fileAction.mockRejectedValueOnce(Object.assign(new Error("No room on this device for this file beside the files still coming (3.8 MB left of 38.1 MB free)"), { room: 40_000_000, size: 30_000_000, coming: 33_000_000 }));
    const error = (await callApi(more.ctx, "file.action", { file: id, action: "accept" }).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain("(2 MB to come: ghostly file cancel chat-four-in-nameless) and 1 more. Free some space or cancel one of them");
    expect(error.message).not.toContain("small.bin");
  });
});
