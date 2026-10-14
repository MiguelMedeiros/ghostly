import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { expect, it, vi } from "vitest";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.storage

/** A Node without `node:sqlite` (22.12 needs a flag for it): the messages stay in memory and in the snapshot, as before rows.db. */
vi.mock("../src/runtime/rows", async (original) => ({ ...(await original<typeof import("../src/runtime/rows")>()), loadSqlite: async () => null }));

const folder = () => mkdtempSync(join(tmpdir(), "ghostly-no-sqlite-"));

it("keeps every value in a snapshot of format 1, with no rows.db", async () => {
  const dir = folder();
  const store = await openPersistentIndexedDb(dir);
  const d = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = store.factory.open("ghostly", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("messages", { keyPath: ["linkId", "id"] });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => { const t = d.transaction("messages", "readwrite"); t.objectStore("messages").put({ linkId: "a", id: "1", text: "hi" }); t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
  d.close();
  await store.compact();
  await store.close();
  const snapshot = deserialize(readFileSync(join(dir, "snapshot.bin"))) as { format: number; databases: { stores: { records: unknown[] }[] }[] };
  expect(snapshot.format).toBe(1);
  expect(snapshot.databases[0]!.stores[0]!.records).toEqual([[["a", "1"], { linkId: "a", id: "1", text: "hi" }]]);
  expect(existsSync(join(dir, "rows.db"))).toBe(false);
});

it("refuses a profile whose messages are in rows.db, naming the Node it needs", async () => {
  const dir = folder();
  writeFileSync(join(dir, "snapshot.bin"), serialize({ format: 2, databases: [] }));
  writeFileSync(join(dir, "rows.db"), "");
  await expect(openPersistentIndexedDb(dir)).rejects.toThrow(/needs Node 22\.13 or newer/);
});
