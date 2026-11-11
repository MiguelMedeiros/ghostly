import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySink } from "@ghostly/browser/backup/stream";
import { writeProfileBackup } from "../../lib/profileBackup";
import { pinnedOrder } from "../../lib/storage";
// covers: devices.handoff, app.backup

/*
 * The first profile's keys share `ghostly_` with every other profile's and space's, so a pass over local storage asks
 * of each key whether it is the first profile's own. That question read every key again to find the other spaces: a
 * move's bundle, a backup, Clear all data and the pinned chats read local storage once per key, about 2 s of a frozen
 * page at 2,000 keys and 9 s at 4,000 in Chromium (bug hunt, 2026-11-11).
 */

const CHATS = 600;

function seed(): void {
  for (let i = 0; i < CHATS; i++) {
    localStorage.setItem(`ghostly_chat${i}`, "{}");
    localStorage.setItem(`ghostly_read_chat${i}`, "0");
  }
  for (let i = 0; i < 20; i++) localStorage.setItem(`ghostly_pin_chat${i}`, "1");
  localStorage.setItem("ghostly_app_settings", "{}");
  // Another profile's key, and a Desktop space's: never the first profile's.
  localStorage.setItem("ghostly_abcdefghij_chat1", "{}");
  localStorage.setItem("ghostly_desk_app_settings", "{}");
  localStorage.setItem("ghostly_desk_chat1", "{}");
}

/** How many times `run` reads a key of local storage by its index, per key there is. */
async function readsPerKey(run: () => unknown): Promise<number> {
  const key = vi.spyOn(Storage.prototype, "key");
  await run();
  const reads = key.mock.calls.length;
  key.mockRestore();
  return reads / localStorage.length;
}

beforeEach(() => { localStorage.clear(); seed(); });
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe("a pass over the first profile's local keys", () => {
  it("reads each key a few times for a move's bundle, not once per key", async () => {
    const sink = memorySink();
    expect(await readsPerKey(() => writeProfileBackup(sink, { passphrase: null, handoff: true }))).toBeLessThan(10);
  });

  it("reads each key a few times for the pinned chats", async () => {
    expect(await readsPerKey(() => pinnedOrder())).toBeLessThan(10);
    expect(pinnedOrder()).toHaveLength(20);
  });
});
