import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/engine/db";
import { IdbFileBytes } from "../src/shared/fileBytesIdb";
import { NO_ROOM_TO_SAVE, STORES, store, wrap } from "../src/shared/idb";
import type { StoredGroup } from "../src/shared/types";

/*
 * On a device out of storage, Chromium (the web app, Android's WebView) fires a write request's `success` and then
 * aborts its transaction with QuotaExceededError: the write is thrown away. A write awaited on its request alone read
 * as saved, so a group made then showed in the list and was gone after a restart. Here fake-indexeddb does the same.
 */

/** Every `put` on `name` from here on succeeds as a request, then its transaction aborts with Chromium's QuotaExceededError. */
function full(name: string): void {
  const real = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
    const request = real.apply(this, args);
    if (this.name !== name) return request;
    const tx = this.transaction;
    request.addEventListener("success", () => {
      const quota = new DOMException("", "QuotaExceededError");
      Object.defineProperty(tx, "error", { get: () => quota, set: () => {}, configurable: true });
      tx.abort();
    });
    return request;
  });
}

const group = (id: string) => ({ id, createdAt: 1, state: {}, contacts: {} }) as unknown as StoredGroup;

afterEach(() => { vi.restoreAllMocks(); });

describe("a write the device had no room for", () => {
  it("a group: putGroup refuses, saying there is no room, and nothing is kept", async () => {
    full(STORES.groups);
    const refused = await db.putGroup(group("g-full")).then(() => null, (error: Error) => error);
    expect(refused, "the caller is told").toBeInstanceOf(Error);
    expect(refused).toMatchObject({ name: "QuotaExceededError", message: NO_ROOM_TO_SAVE });
    expect(await wrap((await store(STORES.groups, "readonly")).get("g-full"))).toBeUndefined();
  });

  it("settings and a service refuse the same way", async () => {
    full(STORES.settings);
    await expect(db.putSettings({ nick: "Alice" } as Parameters<typeof db.putSettings>[0])).rejects.toThrow(NO_ROOM_TO_SAVE);
    vi.restoreAllMocks();
    full(STORES.services);
    await expect(db.putService({ id: "s-full" } as Parameters<typeof db.putService>[0])).rejects.toThrow(NO_ROOM_TO_SAVE);
  });

  it("a received file's piece: the flush refuses", async () => {
    full(STORES.fileChunks);
    const bytes = new IdbFileBytes();
    await bytes.append("f-full", 0, new Uint8Array([1, 2, 3]));
    await expect(bytes.flush("f-full")).rejects.toThrow(NO_ROOM_TO_SAVE);
  });

  it("with room, the write is kept and resolves", async () => {
    await db.putGroup(group("g-room"));
    expect(await wrap((await store(STORES.groups, "readonly")).get("g-room"))).toMatchObject({ id: "g-room" });
  });
});
