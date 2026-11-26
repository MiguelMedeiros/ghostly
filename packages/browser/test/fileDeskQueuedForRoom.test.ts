import { afterEach, expect, it, vi } from "vitest";
import { FILE_LIMITS, type FileTransferRecord, type TransferState } from "@ghostly/core";
import { FileDesk, outgoingFileId } from "../src/engine/fileDesk";
import { fileStore } from "../src/shared/idb";
import type { FileTransferView } from "../src/shared/types";
// covers: files.large.resend, files.large.limits

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const record = (state: TransferState): FileTransferRecord => ({
  id: "w1", direction: "out", state, confirmed: 0, since: 1, file: { name: "photo.jpg", size: 2_000_000, mime: "image/jpeg", timestamp: 1 },
} as FileTransferRecord);

function desk(live = true) {
  vi.spyOn(fileStore, "patch").mockResolvedValue(undefined);
  const transfers = new Map<string, FileTransferView>();
  const desk = new FileDesk({ send: () => false, receivedBytes: () => 0, wireIds: () => new Set(), deleted: () => false, storeMessage: async () => {}, transfers, changed: () => {} });
  const changed = (state: TransferState) => (desk as unknown as { changed(l: string, r: FileTransferRecord, t: number, p: boolean): void }).changed("chat", record(state), 0, false);
  desk.session("chat", live);
  return { changed, view: () => transfers.get(outgoingFileId("chat", "w1"))! };
}

/**
 * A file past the contact's limit of files waiting there waits here, `queued`, with the chat connected, until one of
 * the others ends. That is its turn, not a stuck transfer: before, after a minute it read "Not moving" with a
 * "Send again" that sent nothing (there is still no room), and its bubble's spinner turned until the file went.
 */
it("a sent file waiting its turn behind the contact's limit reads as queued, not stuck", async () => {
  vi.useFakeTimers();
  const t = desk();
  t.changed("queued");
  expect(t.view()).toMatchObject({ state: "transferring", stage: "queued" });
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  t.changed("queued");
  expect(t.view().stalled).toBeUndefined();
  expect(t.view().stage).toBe("queued");
  // Offered at last: its quiet spell starts now, not when it was sent.
  t.changed("asking");
  t.changed("active");
  expect(t.view().stalled).toBeUndefined();
  await vi.advanceTimersByTimeAsync(FILE_LIMITS.stallMs + 1_000);
  t.changed("active");
  expect(t.view()).toMatchObject({ state: "transferring", stalled: true });
});

it("a sent file waiting for the contact to connect still offers Send again after a minute", async () => {
  vi.useFakeTimers();
  const t = desk(false);
  t.changed("queued");
  expect(t.view()).toMatchObject({ state: "transferring", stage: "waiting" });
  await vi.advanceTimersByTimeAsync(FILE_LIMITS.stallMs + 1_000);
  t.changed("queued");
  expect(t.view()).toMatchObject({ stage: "waiting", stalled: true });
});
