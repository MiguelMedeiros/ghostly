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

it("a link's files are read in a constant number of requests, each with what changed about it and nothing of another link's", async () => {
  // Every start lists every chat's and group's files: one fileState read per file was 16,000 requests with 200 per chat
  // and 300 per group (50 chats, 20 groups).
  const linkId = "group:files-many";
  for (let i = 0; i < 300; i++) {
    const id = `group-files-many-in-${String(i).padStart(3, "0")}`;
    await fileStore.put({ id, linkId, createdAt: i, bytes: "opfs" });
    if (i % 2) await fileStore.updateTransfer(id, { state: "done", transferred: i, size: i });
  }
  // Another link's file sorted among them, with a state of its own.
  await fileStore.put({ id: "group-files-many-in-150x", linkId: "group:other", createdAt: 1, bytes: "opfs" });
  await fileStore.updateTransfer("group-files-many-in-150x", { state: "failed", transferred: 0, size: 1 });

  const requests = { count: 0 };
  const spies = [IDBObjectStore.prototype, IDBIndex.prototype].flatMap(proto => (["get", "getAll", "openCursor"] as const).map(name => {
    const orig = proto[name] as (...args: unknown[]) => IDBRequest;
    return vi.spyOn(proto, name).mockImplementation(function (this: unknown, ...args: unknown[]) { requests.count++; return orig.apply(this, args); });
  }));
  const files = await fileStore.listForLink(linkId);
  for (const spy of spies) spy.mockRestore();

  expect(requests.count).toBeLessThanOrEqual(2);
  expect(files).toHaveLength(300);
  expect(files.filter(file => file.transfer?.state === "done").map(file => file.createdAt)).toEqual(Array.from({ length: 150 }, (_, i) => 2 * i + 1));
  expect(files.filter(file => file.transfer && file.transfer.state !== "done")).toEqual([]);
});
