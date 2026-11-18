import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { setDatabaseName } from "@ghostly/browser/shared/idb";
import { linkedFilesDatabase } from "../../lib/apps/webFiles";
import { handoffProfileHost } from "../../lib/handoffProfile";
// covers: devices.handoff

/*
 * The folders and files a profile's apps were given on this device (linked files: handles, never copies) live in a
 * database of their own beside the namespace's. A namespace dropped (the old one once a take finished, a fork
 * discarded) takes them along: nothing names that namespace any more, so nothing would drop them later.
 */

const names = async () => (await indexedDB.databases()).map((d) => d.name).filter((name): name is string => !!name);

function makeDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("handles");
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
}

beforeEach(async () => {
  localStorage.clear();
  for (const name of await names()) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  setDatabaseName("ghostly_new");
});

describe("dropping a namespace a handoff left", () => {
  it("drops its linked files too, and only its own", async () => {
    await makeDatabase("ghostly_old");
    await makeDatabase(linkedFilesDatabase("ghostly_old"));
    await makeDatabase(linkedFilesDatabase("ghostly_new"));

    await handoffProfileHost("1.1.7", "web").staging.drop("ghostly_old");

    expect(await names()).not.toContain(linkedFilesDatabase("ghostly_old"));
    expect(await names()).toContain(linkedFilesDatabase("ghostly_new"));
  });
});
