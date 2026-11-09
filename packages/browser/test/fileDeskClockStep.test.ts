import { afterEach, expect, it, vi } from "vitest";
import { FILE_LIMITS, type FileTransferRecord } from "@ghostly/core";
import { FileDesk, outgoingFileId } from "../src/engine/fileDesk";
import { fileStore } from "../src/shared/idb";
import type { FileTransferView } from "../src/shared/types";
// covers: files.large.resend

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const SIZE = 100_000_000;
const record = (confirmed: number): FileTransferRecord => ({
  id: "w1", direction: "out", state: "sending", confirmed, since: 1, file: { name: "big.bin", size: SIZE, mime: "application/octet-stream", timestamp: 1 },
} as FileTransferRecord);

function desk() {
  vi.spyOn(fileStore, "patch").mockResolvedValue(undefined);
  const transfers = new Map<string, FileTransferView>();
  const desk = new FileDesk({ send: () => false, receivedBytes: () => 0, wireIds: () => new Set(), deleted: () => false, storeMessage: async () => {}, transfers, changed: () => {} });
  /** The contact confirmed `confirmed` bytes (`progress`), or a session said again where the file stands. */
  const changed = (confirmed: number, progress = true) => (desk as unknown as { changed(l: string, r: FileTransferRecord, t: number, p: boolean): void }).changed("chat", record(confirmed), confirmed, progress);
  // The chat's session is up: a file under way shows its speed only then.
  desk.session("chat", true);
  return { changed, view: () => transfers.get(outgoingFileId("chat", "w1"))! };
}

/**
 * When a transfer last moved and how fast it goes are durations: the device's clock set back mid-transfer (by hand, an
 * NTP correction, a resume) must not stretch them by the step. On `Date.now()`, after a 1 h step back a stuck file showed
 * no "stuck" (nor its Send again) for an hour, and its speed stayed what it was before the step.
 */
it("a file that stops moving after the clock is set back shows stuck after the usual quiet spell, not the step later", async () => {
  vi.useFakeTimers();
  const t = desk();
  t.changed(1_000_000);
  await vi.advanceTimersByTimeAsync(1_000);
  t.changed(2_000_000);
  vi.setSystemTime(Date.now() - 60 * 60_000);
  // Nothing moves any more; the session says where it stands now and then.
  await vi.advanceTimersByTimeAsync(FILE_LIMITS.stallMs + 1_000);
  t.changed(2_000_000, false);
  expect(t.view()).toMatchObject({ state: "transferring", stalled: true });
});

it("a file's speed follows its bytes after the clock is set back, not the speed from before the step", async () => {
  vi.useFakeTimers();
  const t = desk();
  // 1 MB/s for a few seconds.
  for (let s = 0; s <= 4; s++) { t.changed(s * 1_000_000); await vi.advanceTimersByTimeAsync(1_000); }
  expect(t.view().rate).toBeGreaterThan(900_000);
  vi.setSystemTime(Date.now() - 60 * 60_000);
  // Then 10 MB/s.
  for (let s = 1; s <= 6; s++) { await vi.advanceTimersByTimeAsync(1_000); t.changed(4_000_000 + s * 10_000_000); }
  expect(t.view().rate).toBeGreaterThan(8_000_000);
});

it("a file whose clock went ahead does not read as stuck while its bytes move", async () => {
  vi.useFakeTimers();
  const t = desk();
  t.changed(1_000_000);
  vi.setSystemTime(Date.now() + 60 * 60_000);
  await vi.advanceTimersByTimeAsync(500);
  t.changed(1_000_000, false);
  expect(t.view().stalled).toBeUndefined();
});
