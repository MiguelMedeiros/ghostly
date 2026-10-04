import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, firstDeviceSetSecret, fromBase64Url, identityFromSeed, sign, signTurnPacket, toBase64Url, turnKeys } from "@ghostly/core";
import { STORES, openDb, transact, wrap } from "../src/shared/idb";
import { readBackupHeader, bytesSource, DEVICE_SET_BACKUP_VERSION } from "../src/backup/stream";
import { PENDING_RAISE_KEY, isPendingRaise } from "../src/devices/raise";
import { activeName, bundleSecret, peekTurn, restoreCase, restoredStandby, type BundleDevices, type TurnPeek } from "../src/devices/restoreGuard";
import { closeDevicesDb, setDeviceMirror } from "../src/devices/store";
import { newDeviceKey, sealSeed } from "../src/engine/paymentAdapters/persistence";
import { putDeviceRecord, dropDevicesDatabase } from "./helpers/deviceRecord";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
import { setStorageProfile } from "../../../apps/ui/src/lib/storage";
import { bundleDidSeed, createProfileBackup, openProfileBackup, restoreOpenedBackup, restoreProfileBackup } from "../../../apps/ui/src/lib/profileBackup";
import { listProfiles, namespaceOf } from "../../../apps/ui/src/lib/profiles";
// covers: devices.restore-guard, devices.raised-counters

/*
 * WISP 06 § A backup restored where a device set exists: an enrolled profile's bundle carries its device set (never a
 * device signing key) in an envelope an older app refuses; a restore reads the turn at the bundle's address before it
 * registers anything; and every restored copy raises its counters at its first start.
 */

class FakeStorage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(k: string) { return this.entries.get(k) ?? null; }
  setItem(k: string, v: string) { this.entries.set(k, v); }
  removeItem(k: string) { this.entries.delete(k); }
}
beforeEach(async () => {
  for (const { name } of await indexedDB.databases()) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name!); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  setDeviceMirror(null);
  await closeDevicesDb();
  await dropDevicesDatabase();
  setStorageProfile("");
  Object.defineProperty(globalThis, "localStorage", { value: new FakeStorage(), configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: vi.fn(), location: { hash: "", reload: vi.fn() } }, configurable: true });
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "deriveKey").mockImplementation(((algorithm: Pbkdf2Params, ...rest: [CryptoKey, AesKeyGenParams, boolean, KeyUsage[]]) => derive({ ...algorithm, iterations: 1_000 }, ...rest)) as typeof crypto.subtle.deriveKey);
});
afterEach(() => { vi.restoreAllMocks(); });

const PASS = "a long backup passphrase";
const D = toBase64Url(new Uint8Array(32).fill(0x44));
const MAC = toBase64Url(new Uint8Array(32).fill(1)), PHONE = toBase64Url(new Uint8Array(32).fill(2));

async function seed(): Promise<void> {
  await openDb();
  await transact([STORES.links, STORES.settings], (s) => {
    s[STORES.links].put({ id: "link1", seedB64: "seed", peerPubKeyZ32: "peer" });
    s[STORES.settings].put({ nick: "Nick" }, "settings");
  });
}

describe("a bundle of an enrolled profile", () => {
  it("carries the device set in an envelope of its own version, and never this device's key, packet or state", async () => {
    await seed();
    await putDeviceRecord({ v: 1, profile: "ghostly", state: "active", saved: 3, turn: 812, rev: 4, d: D, ownSlot: 0, activeSlot: 0, signingKey: "seed",
      deviceSet: [{ key: MAC, name: "MacBook" }, { key: PHONE, name: "Phone" }], turnPacket: "c2VjcmV0cGFja2V0", takeovers: 2, earlierSets: [],
      verifier: { v: 1, setup: "c2V0dXA", record: "cmVjb3Jk" } });
    const bundle = await createProfileBackup(PASS);
    expect((await readBackupHeader(bytesSource(bundle)))?.header.version).toBe(DEVICE_SET_BACKUP_VERSION);
    const opened = await openProfileBackup(bundle, PASS);
    expect(opened.devices).toEqual({ d: D, set: [{ key: MAC, name: "MacBook" }, { key: PHONE, name: "Phone" }], turn: 812, takeovers: 2 });
    expect(JSON.stringify(opened.devices)).not.toContain("c2VjcmV0cGFja2V0");
    expect(JSON.stringify(opened.devices)).not.toContain("c2V0dXA");
  });

  it("a profile with no device set keeps the envelope of today, which every app since streamed backups reads", async () => {
    await seed();
    const bundle = await createProfileBackup(PASS);
    expect((await readBackupHeader(bytesSource(bundle)))?.header.version).toBe(2);
    expect((await openProfileBackup(bundle, PASS)).devices).toBeUndefined();
  });

  it("an envelope above the device set's is from a newer Ghostly and is refused before it is read", async () => {
    const line = new TextEncoder().encode(`${JSON.stringify({ format: "ghostly-backup", version: DEVICE_SET_BACKUP_VERSION + 1, protection: "none", check: { name: "SHA-256-chain" } })}\n`);
    await expect(readBackupHeader(bytesSource(line))).rejects.toThrow("newer Ghostly");
  });

  it("a restored copy notes the raise its engine makes before it first starts", async () => {
    await seed();
    const restored = await restoreProfileBackup(await createProfileBackup(PASS), PASS);
    expect(listProfiles().map((p) => p.id)).toContain(restored.id);
    const db = await wrap(indexedDB.open(`ghostly_${namespaceOf(restored.id)}`));
    const note = await wrap(db.transaction("settings").objectStore("settings").get(PENDING_RAISE_KEY));
    db.close();
    expect(isPendingRaise(note)).toBe(true);
    expect(note).toMatchObject({ why: "restore", takeovers: 0 });
  });

  it("a bundle made before enrollment leads to the first device-set secret through its DID key", async () => {
    await seed();
    const did = createIdentity();
    const deviceKey = newDeviceKey();
    const sealed = await sealSeed(did.seedB64, deviceKey);
    await transact([STORES.settings], (s) => { s[STORES.settings].put({ seed: { sealed, deviceKey } }, "profileDid"); });
    const opened = await openProfileBackup(await createProfileBackup(PASS), PASS);
    const seedBytes = await bundleDidSeed(opened);
    expect(seedBytes && toBase64Url(seedBytes)).toBe(toBase64Url(fromBase64Url(did.seedB64)));
    expect(toBase64Url(bundleSecret(undefined, seedBytes)!)).toBe(toBase64Url(firstDeviceSetSecret(seedBytes!)));
  });
});

const devices: BundleDevices = { d: D, set: [{ key: MAC, name: "MacBook" }, { key: PHONE, name: "Phone" }], turn: 812, takeovers: 1 };
const peek = (result: TurnPeek["result"], record?: TurnPeek["record"]): TurnPeek => ({ result, ...(record ? { record } : {}) });

describe("the cases of a restore", () => {
  it("follows the WISP's list, with a bundle's device set and a `none` read being the active case", () => {
    const record = { turn: 813, active: 1, slots: devices.set };
    expect(restoreCase(undefined, peek("none"))).toBe("plain");
    expect(restoreCase(devices, peek("none"))).toBe("active");
    expect(restoreCase(undefined, peek("other", record))).toBe("active");
    expect(restoreCase(devices, peek("other", record))).toBe("active");
    expect(restoreCase(devices, peek("tombstone"))).toBe("tombstone");
    expect(restoreCase(devices, peek("unreachable"))).toBe("unreadable");
    expect(restoreCase(devices, peek("closed"))).toBe("unreadable");
    expect(restoreCase(devices, null)).toBe("unreadable");
    // A bundle with no device set whose turn cannot be read: restored, and it starts limited until a read (`unchecked`).
    expect(restoreCase(undefined, peek("unreachable"))).toBe("unchecked");
    expect(activeName(devices, peek("other", record))).toBe("Phone");
    expect(activeName(devices, peek("none"))).toBe("MacBook");
  });

  it("a copy that takes over gets a free slot for its new key, or the active device's when all four are used", () => {
    const own = new Uint8Array(32).fill(9);
    const free = restoredStandby(devices, null, peek("other", { turn: 813, active: 1, slots: [...devices.set, null, null] }), own, "Laptop");
    expect(free).toMatchObject({ d: D, ownSlot: 2, activeSlot: 1, turn: 813, takeovers: 1, copy: "restored" });
    expect(free.deviceSet).toEqual([...devices.set, { key: toBase64Url(own), name: "Laptop" }]);
    const four = [...devices.set, { key: toBase64Url(new Uint8Array(32).fill(3)), name: "Tablet" }, { key: toBase64Url(new Uint8Array(32).fill(4)), name: "Work" }];
    const full = restoredStandby(devices, null, peek("other", { turn: 900, active: 3, slots: four }), own, "Laptop");
    expect(full).toMatchObject({ ownSlot: 3, turn: 900 });
    expect(full.activeSlot).toBeUndefined();
    expect(full.deviceSet?.[3]).toEqual({ key: toBase64Url(own), name: "Laptop" });
  });
});

describe("the read before a restore", () => {
  it("reads the bundle's address as a device that holds no record: none, a record with its active device, a tombstone", async () => {
    const d = new Uint8Array(32).fill(0x45);
    const keys = turnKeys(d);
    const network = new FakeTurnNetwork();
    expect((await peekTurn(d, network)).result).toBe("none");
    const phone = identityFromSeed(new Uint8Array(32).fill(7));
    const slots = [{ key: new Uint8Array(32).fill(1), name: "MacBook" }, { key: phone.publicKey, name: "Phone" }, null, null];
    network.seed(await signTurnPacket(keys, { turn: 50, rev: 0, author: 1, active: 1, slots, instance: new Uint8Array(8).fill(1) }, (bytes) => sign(bytes, phone.seed)));
    const read = await peekTurn(d, network);
    expect(read).toMatchObject({ result: "other", record: { turn: 50, active: 1 } });
    expect(read.record?.slots[1]).toEqual({ key: toBase64Url(phone.publicKey), name: "Phone" });
    for (const source of network.sources) source.down = true;
    expect((await peekTurn(d, network)).result).toBe("unreachable");
  });
});

describe("what a restore refuses and keeps (review of part 6)", () => {
  const enrolled = async () => {
    await seed();
    await transact([STORES.settings], (s) => { s[STORES.settings].put({ v: 1, setup: "c2V0dXA", record: "cmVjb3Jk" }, "handoffVerifier"); });
    await putDeviceRecord({ v: 1, profile: "ghostly", state: "active", saved: 1, turn: 812, rev: 0, d: D, ownSlot: 0, activeSlot: 0,
      deviceSet: [{ key: MAC, name: "MacBook" }], takeovers: 0, earlierSets: [] });
  };

  it("keeps the bundle's password proof verifier, for a restored copy's takeover", async () => {
    await enrolled();
    expect((await openProfileBackup(await createProfileBackup(PASS), PASS)).verifier).toEqual({ v: 1, setup: "c2V0dXA", record: "cmVjb3Jk" });
  });

  it("refuses a bundle of the device set's envelope whose device set it cannot read", async () => {
    await enrolled();
    const { encode } = await import("../src/backup/codec");
    const { BackupWriter, memorySink } = await import("../src/backup/stream");
    const sink = memorySink();
    const writer = await BackupWriter.start(sink, PASS, undefined, DEVICE_SET_BACKUP_VERSION);
    await writer.json(await encode({ t: "profile", format: "ghostly-profile", version: 2, createdAt: 1, profile: { name: "Work" }, storage: {}, files: 0, bytes: 0 }));
    await writer.json(await encode({ t: "devices", d: "not a secret", set: [], turn: 1, takeovers: 0 }));
    await writer.json(await encode({ t: "end", files: 0, bytes: 0 }));
    await writer.finish();
    await expect(openProfileBackup(sink.bytes(), PASS)).rejects.toThrow("damaged");
    // The same envelope with no device set record at all is refused too.
    const bare = memorySink();
    const second = await BackupWriter.start(bare, PASS, undefined, DEVICE_SET_BACKUP_VERSION);
    await second.json(await encode({ t: "profile", format: "ghostly-profile", version: 2, createdAt: 1, profile: { name: "Work" }, storage: {}, files: 0, bytes: 0 }));
    await second.json(await encode({ t: "end", files: 0, bytes: 0 }));
    await second.finish();
    await expect(openProfileBackup(bare.bytes(), PASS)).rejects.toThrow("damaged");
  });

  it("writes what must be true of the copy before it is listed, and lists nothing when that fails", async () => {
    await enrolled();
    const opened = await openProfileBackup(await createProfileBackup(PASS), PASS);
    const before = listProfiles().length;
    await expect(restoreOpenedBackup(opened, {}, async () => { throw new Error("crash"); })).rejects.toThrow("crash");
    expect(listProfiles()).toHaveLength(before);
    let listedDuring = -1;
    const entry = await restoreOpenedBackup(opened, {}, async () => { listedDuring = listProfiles().length; });
    expect(listedDuring).toBe(before);
    expect(listProfiles().map((p) => p.id)).toContain(entry.id);
  });
});
