import { afterEach, expect, it, vi } from "vitest";
import { FileDesk } from "../src/engine/fileDesk";
import { fileStore, type StoredFile } from "../src/shared/idb";
import type { FileTransferView } from "../src/shared/types";
// covers: files.large.offer

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const DAY = 24 * 60 * 60_000;

function desk() {
  vi.spyOn(fileStore, "patch").mockResolvedValue(undefined);
  const transfers = new Map<string, FileTransferView>();
  const desk = new FileDesk({ send: () => false, receivedBytes: () => 0, wireIds: () => new Set(), deleted: () => false, storeMessage: async () => {}, transfers, changed: () => {} });
  return { desk, transfers };
}

/**
 * A file said on the DHT floor whose offer never comes ends after a week, by itself, with the app left running. Before,
 * only a call nothing in the app made ended it: its bubble said it was waiting for the sender for good.
 */
it("a file said on the floor whose offer does not come within a week says so, with nothing else happening", async () => {
  vi.useFakeTimers();
  const t = desk();
  expect(t.desk.announce("chat", "wFloorWeek01", "chat-in-floor", 30_000)).toBe(true);
  await vi.advanceTimersByTimeAsync(6 * DAY);
  expect(t.transfers.get("chat-in-floor")).toMatchObject({ state: "transferring", stage: "waiting" });
  await vi.advanceTimersByTimeAsync(2 * DAY);
  expect(t.transfers.get("chat-in-floor")).toMatchObject({ state: "failed", error: "It did not come within a week" });
  t.desk.stop();
});

it("one said on the floor before a restart, its week over since, says so within the hour", async () => {
  vi.useFakeTimers();
  const t = desk();
  const stored = { id: "chat-in-old", linkId: "chat", direction: "in", announced: "wFloorWeek02", createdAt: Date.now() - 8 * DAY, metadata: { name: "a.bin", size: 30_000, mime: "application/octet-stream", timestamp: 1 } } as unknown as StoredFile;
  t.desk.restore("chat", [stored]);
  expect(t.transfers.get("chat-in-old")).toMatchObject({ stage: "waiting" });
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(t.transfers.get("chat-in-old")).toMatchObject({ state: "failed", error: "It did not come within a week" });
  t.desk.stop();
});
