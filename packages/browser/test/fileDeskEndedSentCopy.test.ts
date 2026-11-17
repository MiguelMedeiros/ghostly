import "fake-indexeddb/auto";
import { beforeEach, expect, it } from "vitest";
import type { FileTransferRecord } from "@ghostly/core";
import { FileDesk } from "../src/engine/fileDesk";
import { fileStore, setDatabaseName } from "../src/shared/idb";
import { fileBytes, resetFileBytes } from "../src/shared/fileBytes";
// covers: files.large.resume

beforeEach(async () => {
  for (const { name } of await indexedDB.databases()) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name!); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  setDatabaseName("ghostly");
  resetFileBytes();
});

const SIZE = 64 * 1024;
const record = (wireId: string, state: FileTransferRecord["state"], error?: string): FileTransferRecord => ({
  id: wireId, direction: "out", state, confirmed: 16_384, since: 1, ...(error && { error }), file: { name: "big.bin", size: SIZE, mime: "application/octet-stream", timestamp: 1 },
} as FileTransferRecord);

async function staged(wireId: string): Promise<string> {
  const id = `link1-out-${wireId}`, bytes = await fileBytes();
  await bytes.append(id, 0, new Uint8Array(SIZE));
  await fileStore.put({ id, linkId: "link1", direction: "out", wireId, createdAt: 1, bytes: bytes.kind, digest: "d", metadata: { name: "big.bin", size: SIZE, mime: "application/octet-stream", timestamp: 1 } });
  return id;
}

/**
 * A file sent from here whose transfer the contact cancelled or declined, or this side cancelled, is never sent again
 * (Retry is refused: "It ended"). Its staged copy stayed in the profile for good: 7 cancelled big files kept 3.5 GB on
 * the sender's disk. It goes once the transfer ends so; its record stays, for its bubble. A failed one can be sent
 * again, and keeps its copy.
 */
it("a sent file's staged copy goes once its transfer is cancelled or declined, and stays while it can be sent again", async () => {
  const desk = new FileDesk({ send: () => false, receivedBytes: () => 0, wireIds: () => new Set(), deleted: () => false, storeMessage: async () => {}, transfers: new Map(), changed: () => {} });
  const inner = desk as unknown as { changed(linkId: string, record: FileTransferRecord, transferred: number, progress: boolean): void; chat(linkId: string): { saving: Promise<unknown> } };
  const cancelled = await staged("w1"), declined = await staged("w2"), mine = await staged("w3"), failed = await staged("w4");

  inner.changed("link1", record("w1", "cancelled", "Cancelled by your contact"), 16_384, false);
  inner.changed("link1", record("w2", "declined", "Declined by your contact"), 0, false);
  inner.changed("link1", record("w3", "cancelled", "You cancelled it"), 16_384, false);
  inner.changed("link1", record("w4", "failed", "The connection dropped"), 16_384, false);
  await inner.chat("link1").saving;

  const bytes = await fileBytes();
  for (const id of [cancelled, declined, mine]) {
    expect(await bytes.size(id), `${id}: never sent again, its copy goes`).toBeNull();
    expect(await fileStore.get(id), `${id}: its record stays, for its bubble`).toMatchObject({ direction: "out", wire3: { state: expect.stringMatching(/cancelled|declined/) } });
  }
  expect(await bytes.size(failed), "a failed one is sent again from its copy").toBe(SIZE);
});
