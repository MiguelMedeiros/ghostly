import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySink } from "@ghostly/browser/backup/stream";
import { engine } from "@ghostly/browser/platform/engine";
import { clearAllData } from "../../lib/clearData";
import { openProfileBackup, writeProfileBackup } from "../../lib/profileBackup";

// covers: app.clear-data, backup.profile.file, devices.handoff

vi.mock("@ghostly/browser/shared/fileBytes", async (importOriginal) => ({ ...await importOriginal<object>(), removeFileBytes: vi.fn(async () => {}) }));
vi.mock("../../lib/wakePush", async (importOriginal) => ({ ...await importOriginal<object>(), pushPlatform: () => null }));

/*
 * "Keep this computer awake" and "Stay connected" are this device's switches, kept under the first profile's prefix
 * (`DEVICE_KEYS`). Clear all data of the first profile turned both off for every profile on the device, and its backups
 * and moves carried them (bug hunt, 2026-11-11).
 */

const SWITCHES = ["ghostly_keep_awake", "ghostly_stay_connected"];

beforeEach(() => {
  localStorage.clear();
  for (const key of SWITCHES) localStorage.setItem(key, "1");
  localStorage.setItem("ghostly_app_settings", "{}");
  localStorage.setItem("ghostly_chat1", "{}");
});
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe("this device's switches and the first profile's data", () => {
  it("Clear all data of the first profile keeps them, and clears the profile's own keys", async () => {
    vi.spyOn(engine, "call").mockResolvedValue(undefined as never);
    await clearAllData();
    for (const key of SWITCHES) expect(localStorage.getItem(key)).toBe("1");
    expect(localStorage.getItem("ghostly_chat1")).toBeNull();
  });

  it.each([{ kind: "a backup", handoff: undefined }, { kind: "a move", handoff: true as const }])("$kind of the first profile leaves them out", async ({ handoff }) => {
    const sink = memorySink();
    await writeProfileBackup(sink, { passphrase: null, handoff });
    const { storage } = (await openProfileBackup(sink.bytes())).payload;
    expect(Object.keys(storage)).toContain("chat1");
    expect(Object.keys(storage)).not.toContain("keep_awake");
    expect(Object.keys(storage)).not.toContain("stay_connected");
  });
});
