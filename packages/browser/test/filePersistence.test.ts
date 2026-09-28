import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { fileStore, type StoredFile } from "../src/shared/idb";
// covers: files.persistence, storage.indexeddb

it("does not report durable success when the write request succeeds but its transaction aborts", async () => {
  const original = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value, key) {
    const request = original.call(this, value, key);
    if (this.name === "files") request.addEventListener("success", () => this.transaction.abort());
    return request;
  });
  try {
    await expect(fileStore.put({ id: "abort-fixture", linkId: "fixture", blob: new Blob(["test"]), createdAt: 1 })).rejects.toBeTruthy();
  } finally { spy.mockRestore(); }
  expect(await fileStore.get("abort-fixture")).toBeUndefined();
});

it("status updates preserve bytes/digest and cannot resurrect a deleted file", async () => {
  const file = { id: "persist-fixture", linkId: "fixture", blob: new Blob(["test"]), createdAt: 1, digest: "verified" };
  await fileStore.put(file);
  await fileStore.updateTransfer(file.id, { state: "done", transferred: 4, size: 4 });
  const stored = await fileStore.get(file.id);
  expect(stored?.digest).toBe("verified"); expect(await stored?.blob.text()).toBe("test");
  expect(stored?.transfer?.state).toBe("done");
  await fileStore.delete(file.id); await fileStore.updateTransfer(file.id, { state: "failed", transferred: 0, size: 4 });
  expect(await fileStore.get(file.id)).toBeUndefined();
});

// WebKit (the macOS app, Safari) keeps a stored Blob as a file its record points to. A record written back with the
// Blob it read can lose that file, and every read after fails with "The object can not be found here.": a voice
// message stored whole was never sent, and Retry could not read it either. Found with Playwright's WebKit: put a
// record with a Blob, wait a second or two, get it and put it back, and the Blob of every later get is gone.
it("a stored file's record is written once: what changes later never writes its Blob back", async () => {
  const file = { id: "written-once", linkId: "fixture-once", blob: new Blob(["voice"]), createdAt: 1, direction: "out" as const };
  await fileStore.put(file);
  const original = IDBObjectStore.prototype.put;
  const writes: unknown[] = [];
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value, key) {
    if (this.name === "files") writes.push(value);
    return original.call(this, value, key);
  });
  const wire3 = { id: "w", direction: "out", state: "failed", error: "x" } as unknown as NonNullable<StoredFile["wire3"]>;
  try {
    await fileStore.patch(file.id, { digest: "d1", wire3 });
    await fileStore.updateTransfer(file.id, { state: "failed", transferred: 0, size: 5, error: "x" });
    await fileStore.patch(file.id, { bytes: "idb", digest: "d2" });
  } finally { spy.mockRestore(); }
  expect(writes).toEqual([]);
  const stored = await fileStore.get(file.id);
  expect(stored).toMatchObject({ digest: "d2", bytes: "idb", wire3, transfer: { state: "failed", error: "x" } });
  expect(await stored?.blob?.text()).toBe("voice");
  expect((await fileStore.listForLink("fixture-once"))[0]).toMatchObject({ id: file.id, digest: "d2", transfer: { state: "failed" } });
});

it("a file stored again, or deleted, keeps nothing of what changed about the one before", async () => {
  await fileStore.put({ id: "again", linkId: "fixture-again", blob: new Blob(["a"]), createdAt: 1 });
  await fileStore.patch("again", { digest: "old", transfer: { state: "failed", transferred: 0, size: 1 } });
  await fileStore.put({ id: "again", linkId: "fixture-again", blob: new Blob(["b"]), createdAt: 2, digest: "new" });
  expect(await fileStore.get("again")).toMatchObject({ digest: "new", createdAt: 2 });
  expect((await fileStore.get("again"))?.transfer).toBeUndefined();

  await fileStore.patch("again", { transfer: { state: "done", transferred: 1, size: 1 } });
  await fileStore.delete("again");
  await fileStore.put({ id: "again", linkId: "fixture-again", blob: new Blob(["c"]), createdAt: 3 });
  expect((await fileStore.get("again"))?.transfer).toBeUndefined();

  await fileStore.patch("again", { transfer: { state: "done", transferred: 1, size: 1 } });
  await fileStore.deleteForLink("fixture-again");
  expect(await fileStore.get("again")).toBeUndefined();
  await fileStore.put({ id: "again", linkId: "fixture-again", blob: new Blob(["d"]), createdAt: 4 });
  expect((await fileStore.get("again"))?.transfer).toBeUndefined();
});
