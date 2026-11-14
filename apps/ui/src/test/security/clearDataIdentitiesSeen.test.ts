import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySink } from "@ghostly/browser/backup/stream";
import { engine } from "@ghostly/browser/platform/engine";
import { clearAllData } from "../../lib/clearData";
import { markIdentityNewsSeen } from "../../lib/identities";
import { openProfileBackup, writeProfileBackup } from "../../lib/profileBackup";
import { ownsKey, ownsOriginalKey } from "../../lib/storage";

// covers: app.clear-data, backup.profile.file

vi.mock("@ghostly/browser/shared/fileBytes", async (importOriginal) => ({ ...await importOriginal<object>(), removeFileBytes: vi.fn(async () => {}) }));
vi.mock("../../lib/wakePush", async (importOriginal) => ({ ...await importOriginal<object>(), pushPlatform: () => null }));

/*
 * Identities' news seen is kept under `<prefix>identities_seen`. In the first profile that is `ghostly_identities_seen`,
 * whose suffix starts as another profile's id would (10 letters or digits and `_`), so the first profile never took it
 * as its own: Clear all data left it, with its links' and proofs' ids, and its backups and moves left it out.
 */

const KEY = "ghostly_identities_seen";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("ghostly_app_settings", "{}");
  localStorage.setItem("ghostly_chat1", "{}");
  markIdentityNewsSeen([{ key: "revoked/link-abc/github:alice", lasting: false }]);
});
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe("the first profile's Identities news seen", () => {
  it("is the first profile's own key", () => {
    expect(localStorage.getItem(KEY)).toContain("link-abc");
    expect(ownsKey(KEY)).toBe(true);
    expect(ownsOriginalKey(KEY)).toBe(true);
  });

  it("Clear all data of the first profile removes it", async () => {
    vi.spyOn(engine, "call").mockResolvedValue(undefined as never);
    await clearAllData();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem("ghostly_chat1")).toBeNull();
  });

  it("a backup of the first profile carries it", async () => {
    const sink = memorySink();
    await writeProfileBackup(sink, { passphrase: null });
    const { storage } = (await openProfileBackup(sink.bytes())).payload;
    expect(Object.keys(storage)).toContain("identities_seen");
  });
});
