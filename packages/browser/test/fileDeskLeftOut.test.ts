import "fake-indexeddb/auto";
import { beforeEach, expect, it } from "vitest";
import type { FileTransferRecord } from "@ghostly/core";
import { FileDesk } from "../src/engine/fileDesk";
import { fileStore, setDatabaseName } from "../src/shared/idb";
import { fileBytes, resetFileBytes } from "../src/shared/fileBytes";
import { markLeftOutFiles } from "../src/shared/restoredRows";
// covers: backup.light

beforeEach(async () => {
  for (const { name } of await indexedDB.databases()) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name!); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  setDatabaseName("ghostly");
  resetFileBytes();
});

const ID = "link1-in-video", SIZE = 4 * 1024 * 1024;
const record = (confirmed: number): FileTransferRecord => ({
  id: "w1", direction: "in", state: "receiving", confirmed, since: 1, file: { name: "video.bin", size: SIZE, mime: "application/octet-stream", timestamp: 1 },
} as FileTransferRecord);

/**
 * A files/3 file still arriving when a light backup was made goes as left out (its bytes on disk were over 1 MiB),
 * with its transfer under way. After the restore its sender offers it again and it arrives whole: it is no longer
 * "not in this backup", which kept `file save` refusing it and the app's bubble without a Save.
 */
it("a file left out by a light backup while it arrived is no longer left out once its receive starts again", async () => {
  const kind = (await fileBytes()).kind;
  await fileStore.put({ id: ID, linkId: "link1", direction: "in", wireId: "w1", createdAt: 1, bytes: kind, metadata: { name: "video.bin", size: SIZE, mime: "application/octet-stream", timestamp: 1 }, wire3: record(2_031_616) });
  await (await fileBytes()).append(ID, 0, new Uint8Array(1_835_008));
  // The restore: the record marked, nothing of it says where its bytes were.
  await (await fileBytes()).remove(ID);
  await markLeftOutFiles([ID]);
  expect((await fileStore.get(ID))?.leftOut).toBe(true);

  const desk = new FileDesk({ send: () => false, receivedBytes: () => 0, wireIds: () => new Set(), deleted: () => false, storeMessage: async () => {}, transfers: new Map(), changed: () => {} });
  const inner = desk as unknown as { chat(linkId: string): { local: Map<string, string> }; openTarget(linkId: string, record: FileTransferRecord): Promise<{ offset: number }> };
  inner.chat("link1").local.set("w1", ID);
  const target = await inner.openTarget("link1", record(2_031_616));

  expect(target.offset, "nothing of it is here: it comes again from the start").toBe(0);
  expect(await fileStore.get(ID)).toMatchObject({ leftOut: false, bytes: kind });

  // A later light backup and restore that leaves it out again marks it again, over what the first restore cleared.
  await markLeftOutFiles([ID]);
  expect((await fileStore.get(ID))?.leftOut).toBe(true);
});
