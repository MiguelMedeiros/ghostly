import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceRecord, HeldFile } from "../src/devices/state";
import { amendDevice, closeDevicesDb, readDeviceRecord, setDeviceMirror, type DeviceMirror } from "../src/devices/store";
import { dropDevicesDatabase, putDeviceRecord } from "./helpers/deviceRecord";
// covers: devices.gate

/*
 * A device that gave its profile away keeps, on standby, the list of every file its frozen copy holds (up to 10,000).
 * Its standby screen reads the record every 3 s and the record does not change in between: the list is checked again
 * only when a write changed the record, on the web and on Desktop, where the file is not parsed or compared again
 * either. What each read answers is still what it read.
 */

const parses = vi.hoisted(() => ({ lists: 0 }));
vi.mock("../src/devices/state", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/devices/state")>();
  return {
    ...real,
    parseDeviceRecord: (value: unknown) => {
      if ((value as { heldFiles?: unknown } | null)?.heldFiles) parses.lists++;
      return real.parseDeviceRecord(value);
    },
  };
});

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const heldFiles: HeldFile[] = Array.from({ length: 1_000 }, (_, i) => ({ sha256: `${KEY.slice(0, 37)}${String(i).padStart(6, "0")}`, size: 1_000 + i, id: `file-${i}` }));
const frozen = (patch: Partial<DeviceRecord> = {}): DeviceRecord => ({
  v: 1, profile: "ghostly", state: "standby", saved: 3, turn: 5, rev: 0, deviceSet: [{ key: KEY, name: "MacBook" }], takeovers: 0, earlierSets: [],
  releasedTurn: 5, heldFiles, leftFiles: [{ sha256: KEY, size: 20_000_000, where: "large" }], copy: "frozen", ...patch,
});

function fileMirror(text: string | null): DeviceMirror & { text: string | null; reads: number; writes: number } {
  const m = {
    text, reads: 0, writes: 0,
    read: async () => { m.reads++; return m.text; },
    write: async (_profile: string, record: string | null) => { m.writes++; m.text = record; },
  };
  return m;
}

beforeEach(async () => { setDeviceMirror(null); await closeDevicesDb(); await dropDevicesDatabase(); parses.lists = 0; });

describe("a standby whose record lists its frozen files", () => {
  it("checks the list once, not on every read, and again after a write", async () => {
    await putDeviceRecord(frozen());
    for (let poll = 0; poll < 5; poll++) expect(await readDeviceRecord("ghostly")).toMatchObject({ state: "standby", saved: 3, heldFiles });
    expect(parses.lists).toBe(1);

    const amended = await amendDevice("ghostly", { seenSequence: 9 });
    parses.lists = 0;
    for (let poll = 0; poll < 3; poll++) expect(await readDeviceRecord("ghostly")).toEqual(amended);
    expect(parses.lists).toBe(1);
  });

  it("checks again a record that changed without its write count, and answers what it read", async () => {
    await putDeviceRecord(frozen());
    await readDeviceRecord("ghostly");
    // Another window removed the profile and a new one under the same name reached the same count.
    await putDeviceRecord(frozen({ deviceSet: [{ key: KEY.replace(/^A/, "B"), name: "Other" }] }));
    expect(await readDeviceRecord("ghostly")).toMatchObject({ deviceSet: [{ name: "Other" }] });
    await putDeviceRecord(frozen({ heldFiles: heldFiles.slice(1) }));
    expect((await readDeviceRecord("ghostly"))?.heldFiles).toHaveLength(999);
    expect(parses.lists).toBe(3);
    // A list that no longer reads stops the read, as before.
    await putDeviceRecord(frozen({ saved: 4, heldFiles: [{ sha256: "not base64!", size: 1, id: "x" }] }));
    await expect(readDeviceRecord("ghostly")).rejects.toThrow("a held file");
  });

  it("on Desktop, parses the file and compares the copies once while neither changes", async () => {
    const mirror = fileMirror(JSON.stringify(frozen()));
    setDeviceMirror(mirror);
    await putDeviceRecord(frozen());
    const stringify = vi.spyOn(JSON, "stringify");
    const parse = vi.spyOn(JSON, "parse");
    for (let poll = 0; poll < 5; poll++) expect(await readDeviceRecord("ghostly")).toMatchObject({ state: "standby", saved: 3, heldFiles });
    // The database's copy and the file's, the first time only.
    expect(parses.lists).toBe(2);
    expect(parse).toHaveBeenCalledTimes(1);
    const big = stringify.mock.calls.filter(([value]) => (value as { heldFiles?: unknown } | null)?.heldFiles).length;
    expect(big).toBe(1);
    expect(mirror.reads).toBe(5);
    expect(mirror.writes).toBe(0);
  });

  it("on Desktop, a file that changed is read and the stricter copy kept, as before", async () => {
    const mirror = fileMirror(JSON.stringify(frozen()));
    setDeviceMirror(mirror);
    await putDeviceRecord(frozen());
    await readDeviceRecord("ghostly");
    await readDeviceRecord("ghostly");
    // Another window's write reached the file and not yet the database (a crash in between).
    mirror.text = JSON.stringify(frozen({ saved: 4, seenSequence: 12 }));
    expect(await readDeviceRecord("ghostly")).toMatchObject({ saved: 4, seenSequence: 12 });
    expect(await readDeviceRecord("ghostly")).toMatchObject({ saved: 4, seenSequence: 12 });
    expect(mirror.writes).toBe(0);
    // The file gone: the database's copy goes back to it.
    mirror.text = null;
    expect(await readDeviceRecord("ghostly")).toMatchObject({ saved: 4 });
    expect(mirror.writes).toBe(1);
    expect(JSON.parse(mirror.text!)).toMatchObject({ saved: 4, heldFiles });
  });
});
