import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySink } from "@ghostly/browser/backup/stream";
import { engine } from "@ghostly/browser/platform/engine";
import { clearAllData } from "../../lib/clearData";
import { openProfileBackup, writeProfileBackup } from "../../lib/profileBackup";
import { handoffProfileHost } from "../../lib/handoffProfile";
import { pointProfile } from "../../lib/profiles";

// covers: app.clear-data, backup.profile.file, devices.handoff

vi.mock("@ghostly/browser/shared/fileBytes", async (importOriginal) => ({ ...await importOriginal<object>(), removeFileBytes: vi.fn(async () => {}) }));
vi.mock("../../lib/wakePush", async (importOriginal) => ({ ...await importOriginal<object>(), pushPlatform: () => null }));

/*
 * "Keep this computer awake" and "Stay connected" are this device's switches, kept under the first profile's prefix
 * (`DEVICE_KEYS`). Clear all data of the first profile turned both off for every profile on the device, and its backups
 * and moves carried them (bug hunt, 2026-11-11). So did the call's small window (its choice, its place and size, the
 * self view's) and the update notice dismissed here, which every profile on the device reads under the same keys; taking
 * the first profile back dropped them with its old copy's keys.
 */

const SWITCHES = ["ghostly_keep_awake", "ghostly_stay_connected", "ghostly_call_mini", "ghostly_call_window_box", "ghostly_call_self_view_box", "ghostly_update_dismissed"];
const suffixes = SWITCHES.map((key) => key.slice("ghostly_".length));

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
    for (const key of SWITCHES) expect(localStorage.getItem(key), key).toBe("1");
    expect(localStorage.getItem("ghostly_chat1")).toBeNull();
  });

  it.each([{ kind: "a backup", handoff: undefined }, { kind: "a move", handoff: true as const }])("$kind of the first profile leaves them out", async ({ handoff }) => {
    const sink = memorySink();
    await writeProfileBackup(sink, { passphrase: null, handoff });
    const { storage } = (await openProfileBackup(sink.bytes())).payload;
    expect(Object.keys(storage)).toContain("chat1");
    for (const suffix of suffixes) expect(Object.keys(storage)).not.toContain(suffix);
  });

  it("taking the first profile back keeps them, and drops its old copy's keys", async () => {
    pointProfile("ghostly", "ghostly_installed1");
    await handoffProfileHost("test", "web").staging.drop("ghostly");
    for (const key of SWITCHES) expect(localStorage.getItem(key), key).toBe("1");
    expect(localStorage.getItem("ghostly_chat1")).toBeNull();
  });
});
