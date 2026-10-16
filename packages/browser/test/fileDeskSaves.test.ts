import { afterEach, expect, it, vi } from "vitest";
import type { FileTransferRecord } from "@ghostly/core";
import { FileDesk } from "../src/engine/fileDesk";
import { fileStore } from "../src/shared/idb";
// covers: files.large.resume

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const record = (confirmed: number): FileTransferRecord => ({
  id: "w1", direction: "out", state: "sending", confirmed, since: 1, file: { name: "cut.bin", size: 1_000_000, mime: "application/octet-stream", timestamp: 1 },
} as FileTransferRecord);

/**
 * A sending file's progress is written at most every 2 s, and only its first ack in each 2 s was: one that came later
 * was never written unless something else changed. A cut and a restart within 2 s of a resume then showed the progress
 * of the cut before (e2e/web/large-files.spec.ts:180, red on a fast run). The last ack held back is written once the
 * 2 s are up, and at once when the session closes.
 */
it("writes the last progress the 2 s throttle held back, once they are up and at once when the session closes", async () => {
  vi.useFakeTimers();
  const patch = vi.spyOn(fileStore, "patch").mockResolvedValue(undefined);
  const saved = () => patch.mock.calls.map(([, change]) => (change.wire3 as FileTransferRecord).confirmed);
  const desk = new FileDesk({ send: () => false, receivedBytes: () => 0, wireIds: () => new Set(), deleted: () => false, storeMessage: async () => {}, transfers: new Map(), changed: () => {} });
  const changed = (confirmed: number, progress = true) => (desk as unknown as { changed(l: string, r: FileTransferRecord, t: number, p: boolean): void }).changed("chat", record(confirmed), confirmed, progress);

  // The resume (a change of state) is written at once; the acks right after it wait for the 2 s.
  changed(100_000, false);
  changed(200_000);
  changed(300_000);
  await vi.advanceTimersByTimeAsync(0);
  expect(saved()).toEqual([100_000]);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(saved()).toEqual([100_000, 300_000]);

  // Cut within the next 2 s: the session closing writes what was confirmed last, before any restart.
  changed(400_000);
  desk.session("chat", false);
  await vi.advanceTimersByTimeAsync(0);
  expect(saved()).toEqual([100_000, 300_000, 400_000]);
  // And only once.
  await vi.advanceTimersByTimeAsync(5_000);
  expect(saved()).toEqual([100_000, 300_000, 400_000]);
});
