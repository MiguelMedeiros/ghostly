import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64Url, type PkarrTransport } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { setHandoffProfileHost, type HandoffProfileHost } from "../src/devices/handoffHost";
import { closeDevicesDb, readDeviceRecord, setDeviceMirror } from "../src/devices/store";
import { deviceSetView } from "../src/devices/links";
import { forkTimes } from "../src/devices/state";
import { databaseName } from "../src/shared/idb";
import { dropDevicesDatabase, putDeviceRecord } from "./helpers/deviceRecord";
// covers: devices.handoff.take

/*
 * A replaced device that took the profile back with Use here keeps its old namespace, the fork (WISP 06 § Installing the
 * staged state): "Only on this device" in Data and storage until the person discards it. Discard deletes that namespace
 * through the app's staging host and takes it off the record; it never touches the profile's own storage or a name the
 * record does not list.
 */

const transport: PkarrTransport = { publish: async () => {}, publishPayload: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }) };
const nodes: GhostlyNode[] = [];
beforeEach(async () => { setDeviceMirror(null); await closeDevicesDb(); await dropDevicesDatabase(); });
afterEach(async () => { setHandoffProfileHost(null); for (const node of nodes.splice(0)) await node.shutdown().catch(() => {}); vi.restoreAllMocks(); });

describe("a fork kept on the active device", () => {
  it("is listed, discarded through the staging host, and taken off the record; nothing else can be", async () => {
    const dropped: string[] = [];
    setHandoffProfileHost({ app: "1.1.0", kind: "web", staging: { open: vi.fn(), install: vi.fn(), revert: vi.fn(), drop: async (database: string) => { dropped.push(database); } }, source: vi.fn(), storedVersion: vi.fn() } as unknown as HandoffProfileHost);
    const key = toBase64Url(new Uint8Array(32).fill(1));
    await putDeviceRecord({ v: 1, profile: databaseName(), state: "active", saved: 1, turn: 8, rev: 0, takeovers: 0, earlierSets: [], deviceSet: [{ key, name: "Laptop" }], ownSlot: 0, activeSlot: 0, forks: ["ghostly_oldcopy"] });
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false });
    nodes.push(node);
    await expect(node.deviceForkDiscard({ database: databaseName() })).rejects.toThrow("There is no such copy");
    await expect(node.deviceForkDiscard({ database: "ghostly_other" })).rejects.toThrow("There is no such copy");
    expect(dropped).toEqual([]);
    await node.deviceForkDiscard({ database: "ghostly_oldcopy" });
    expect(dropped).toEqual(["ghostly_oldcopy"]);
    expect((await readDeviceRecord(databaseName()))?.forks).toEqual([]);
  });
});

describe("when each fork was kept (forkKeptAt)", () => {
  const key = toBase64Url(new Uint8Array(32).fill(1));
  const record = (more: object) => ({ v: 1 as const, profile: databaseName(), state: "active" as const, saved: 1, turn: 8, rev: 0, takeovers: 0, earlierSets: [], deviceSet: [{ key, name: "Laptop" }], ownSlot: 0, activeSlot: 0, ...more });
  const host = (dropped: string[]) => setHandoffProfileHost({ app: "1.1.0", kind: "web", staging: { open: vi.fn(), install: vi.fn(), revert: vi.fn(), drop: async (database: string) => { dropped.push(database); } }, source: vi.fn(), storedVersion: vi.fn() } as unknown as HandoffProfileHost);

  it("is in the view beside each fork; Discard takes the fork and its time off the record, and the other keeps its own", async () => {
    const dropped: string[] = [];
    host(dropped);
    await putDeviceRecord(record({ forks: ["ghostly_a", "ghostly_b"], forkKeptAt: { ghostly_a: 1_700_000_000_000, ghostly_b: 1_750_000_000_000 } }));
    const view = deviceSetView(await readDeviceRecord(databaseName()), []);
    expect(view.forks).toEqual(["ghostly_a", "ghostly_b"]);
    expect(view.forkKeptAt).toEqual({ ghostly_a: 1_700_000_000_000, ghostly_b: 1_750_000_000_000 });
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false });
    nodes.push(node);
    await node.deviceForkDiscard({ database: "ghostly_b" });
    expect(dropped).toEqual(["ghostly_b"]);
    const after = await readDeviceRecord(databaseName());
    expect(after?.forks).toEqual(["ghostly_a"]);
    expect(after?.forkKeptAt).toEqual({ ghostly_a: 1_700_000_000_000 });
    await node.deviceForkDiscard({ database: "ghostly_a" });
    expect((await readDeviceRecord(databaseName()))?.forkKeptAt).toBeUndefined();
  });

  it("a record an older build wrote, with forks and no times, still loads, shows them with none, and discards", async () => {
    const dropped: string[] = [];
    host(dropped);
    await putDeviceRecord(record({ forks: ["ghostly_a", "ghostly_b"] }));
    const read = await readDeviceRecord(databaseName());
    expect(read?.forks).toEqual(["ghostly_a", "ghostly_b"]);
    expect(deviceSetView(read, []).forkKeptAt).toEqual({});
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false });
    nodes.push(node);
    await node.deviceForkDiscard({ database: "ghostly_a" });
    expect(dropped).toEqual(["ghostly_a"]);
    const after = await readDeviceRecord(databaseName());
    expect(after?.forks).toEqual(["ghostly_b"]);
    expect(after?.forkKeptAt).toBeUndefined();
  });

  it("reads only a listed fork's time that a date holds: anything else in the field is no time, never a refusal", () => {
    expect(forkTimes({ forks: ["ghostly_a", "ghostly_b", "ghostly_c"], forkKeptAt: { ghostly_a: 5, ghostly_b: -1, ghostly_c: 1e20, ghostly_x: 9 } })).toEqual({ ghostly_a: 5 });
    expect(forkTimes({ forks: ["ghostly_a"], forkKeptAt: "soon" as unknown as Record<string, number> })).toEqual({});
    expect(forkTimes({ forks: ["ghostly_a"], forkKeptAt: { ghostly_a: "5" } as unknown as Record<string, number> })).toEqual({});
    expect(forkTimes({ forks: ["toString"], forkKeptAt: {} })).toEqual({});
    expect(forkTimes({})).toEqual({});
  });
});
