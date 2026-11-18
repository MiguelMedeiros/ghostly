import { afterEach, expect, it, vi } from "vitest";
import { FILE_LIMITS, type FileTransferRecord, type TransferState } from "@ghostly/core";
import { FileDesk, outgoingFileId } from "../src/engine/fileDesk";
import { fileStore } from "../src/shared/idb";
import type { FileTransferView } from "../src/shared/types";
// covers: files.large.resend

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const SIZE = 100_000_000;
const record = (state: TransferState, confirmed = 0): FileTransferRecord => ({
  id: "w1", direction: "out", state, confirmed, since: 1, file: { name: "big.bin", size: SIZE, mime: "application/octet-stream", timestamp: 1 },
} as FileTransferRecord);

function desk() {
  vi.spyOn(fileStore, "patch").mockResolvedValue(undefined);
  const transfers = new Map<string, FileTransferView>();
  const desk = new FileDesk({ send: () => false, receivedBytes: () => 0, wireIds: () => new Set(), deleted: () => false, storeMessage: async () => {}, transfers, changed: () => {} });
  /** The file's record changed to `state` (`progress`: bytes the contact confirmed). */
  const changed = (state: TransferState, confirmed = 0, progress = false) => (desk as unknown as { changed(l: string, r: FileTransferRecord, t: number, p: boolean): void }).changed("chat", record(state, confirmed), confirmed, progress);
  desk.session("chat", true);
  return { changed, view: () => transfers.get(outgoingFileId("chat", "w1"))! };
}

/**
 * A minute and more waiting on a person is not a stuck transfer: the file only just went on. Before, the time its offer
 * waited for an answer (or its pause) counted, so the file read as stuck the moment it was accepted (or resumed), with
 * "Send again" / "Ask again" beside it, until its first bytes moved: for as long as it waited its turn behind others.
 */
for (const waited of ["asking", "paused"] as const) {
  it(`a file that waited ${waited === "asking" ? "for an answer" : "paused"} for minutes does not read as stuck when it goes on`, async () => {
    vi.useFakeTimers();
    const t = desk();
    t.changed(waited);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    t.changed(waited);
    expect(t.view().stalled).toBeUndefined();
    t.changed("queued");
    expect(t.view().stalled).toBeUndefined();
    t.changed("active");
    expect(t.view().stalled).toBeUndefined();
    // Then it does, after the usual quiet spell with nothing moving.
    await vi.advanceTimersByTimeAsync(FILE_LIMITS.stallMs + 1_000);
    t.changed("active");
    expect(t.view()).toMatchObject({ state: "transferring", stalled: true });
  });
}
