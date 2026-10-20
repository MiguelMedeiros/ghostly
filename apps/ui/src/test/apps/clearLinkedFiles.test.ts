import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engine } from "@ghostly/browser/platform/engine";
import { clearAllData } from "../../lib/clearData";
import { idbPickStore, linkedFilesDatabase } from "../../lib/apps/webFiles";
import { profileDatabase } from "../../lib/profileData";
import { activeProfileId } from "../../lib/profiles";

// covers: apps.linked-files, app.clear-data

vi.mock("@ghostly/browser/shared/fileBytes", async (importOriginal) => ({ ...await importOriginal<object>(), removeFileBytes: vi.fn(async () => {}) }));
vi.mock("../../lib/wakePush", async (importOriginal) => ({ ...await importOriginal<object>(), pushPlatform: () => null }));

afterEach(() => vi.restoreAllMocks());

describe("Clear all data on the web (WISP 04)", () => {
  it("drops the profile's linked files: the paths its apps were given and the folders kept for them", async () => {
    vi.spyOn(engine, "call").mockResolvedValue(undefined as never);
    // The store the web app keeps its apps' picks in (apps/web/src/main.tsx).
    const store = idbPickStore(() => linkedFilesDatabase(profileDatabase(activeProfileId())));
    await store.put({ ref: "pubkeyalpha/cinema", id: "p1", keep: { files: [] }, entries: [{ id: "a".repeat(22), path: "Films/Up.mp4", size: 1, modified: 1 }] });
    expect(await store.all("pubkeyalpha/cinema")).toHaveLength(1);
    await clearAllData();
    // The same app installed again in this profile finds nothing it was given before.
    expect(await store.all("pubkeyalpha/cinema")).toEqual([]);
  });
});
