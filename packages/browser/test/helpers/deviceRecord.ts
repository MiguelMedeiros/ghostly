import type { DeviceRecord } from "../../src/devices/state";

/**
 * Puts a profile's device record in `ghostly-devices` directly, past the module and its checks: what a test uses to
 * put a profile in a state, since nothing can enroll a device yet. The database is made as the module makes it.
 */
export async function putDeviceRecord(record: DeviceRecord | Record<string, unknown>): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("ghostly-devices", 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("devices")) request.result.createObjectStore("devices", { keyPath: "profile" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("devices", "readwrite");
    tx.objectStore("devices").put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
  db.close();
}

export const dropDevicesDatabase = () => new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase("ghostly-devices"); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
