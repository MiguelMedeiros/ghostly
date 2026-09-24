import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { fileStore } from "../src/shared/idb";
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
