import { afterEach, expect, it, vi } from "vitest";
import { FILE_LIMITS, type FileTransferRecord, type TransferState } from "@ghostly/core";
import { FileDesk } from "../src/engine/fileDesk";
import { fileStore } from "../src/shared/idb";
import type { FileTransferView } from "../src/shared/types";
// covers: files.large.resend, files.large.limits

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const ID = "chat-in-w1";
const record = (state: TransferState): FileTransferRecord => ({
  id: "w1", direction: "in", state, confirmed: 0, since: 1, file: { name: "video.mp4", size: 40_000_000, mime: "video/mp4", timestamp: 1 },
} as FileTransferRecord);

function desk(live = true) {
  vi.spyOn(fileStore, "patch").mockResolvedValue(undefined);
  const transfers = new Map<string, FileTransferView>();
  const desk = new FileDesk({ send: () => false, receivedBytes: () => 0, wireIds: () => new Set(), deleted: () => false, storeMessage: async () => {}, transfers, changed: () => {} });
  const inner = desk as unknown as { chat(linkId: string): { local: Map<string, string> }; changed(l: string, r: FileTransferRecord, t: number, p: boolean): void };
  inner.chat("chat").local.set("w1", ID);
  desk.session("chat", live);
  return { changed: (state: TransferState) => inner.changed("chat", record(state), 0, false), view: () => transfers.get(ID)! };
}

/**
 * A received file past the files arriving here at once (`FILE_LIMITS.maxActiveIncoming`) waits, `queued`, with the
 * chat connected, until one of them ends. That is its turn, not a stuck transfer: before, after a minute it read
 * "Ask again", which only told the sender again that it waits.
 */
it("a received file waiting its turn behind the files arriving here reads as queued, not stuck", async () => {
  vi.useFakeTimers();
  const t = desk();
  t.changed("queued");
  expect(t.view()).toMatchObject({ state: "transferring", stage: "queued" });
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  t.changed("queued");
  expect(t.view().stalled).toBeUndefined();
  // Its turn at last: its quiet spell starts now, not when it was accepted.
  t.changed("active");
  expect(t.view().stalled).toBeUndefined();
  await vi.advanceTimersByTimeAsync(FILE_LIMITS.stallMs + 1_000);
  t.changed("active");
  expect(t.view()).toMatchObject({ state: "transferring", stalled: true });
});

it("a received file taken while the chat is not connected still offers Ask again after a minute", async () => {
  vi.useFakeTimers();
  const t = desk(false);
  t.changed("queued");
  expect(t.view()).toMatchObject({ state: "transferring", stage: "waiting" });
  await vi.advanceTimersByTimeAsync(FILE_LIMITS.stallMs + 1_000);
  t.changed("queued");
  expect(t.view()).toMatchObject({ stage: "waiting", stalled: true });
});
