import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceKeyZ32, firstDeviceSetSecret, fromBase64Url, randomBytes, readTurnPacket, seedSigner, toBase64Url, turnKeys, verify } from "@ghostly/core";
import { DeviceSetError, deviceIdentity, firstDeviceSet, firstTurn, openTurnKeeper } from "../src/devices/setup";
import { DEVICE_KEYS_DB, checkNonExtractableEd25519, closeDeviceKeysDb, createDeviceSigningKey, forgetDeviceSigningKey, loadDeviceSigningKey } from "../src/devices/signingKey";
import { parseDeviceRecord } from "../src/devices/state";
import { DEVICES_DB, closeDevicesDb, enrollDevice, forgetDevice, readDeviceRecord, setDeviceMirror } from "../src/devices/store";
import { dropDevicesDatabase } from "./helpers/deviceRecord";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
// covers: devices.signing-key, devices.links.derivation, devices.turn.keeper

/*
 * The device signing key (WISP 06 § Terms): made on the device, non-extractable through WebCrypto where the engine
 * makes, stores and reads back such a key, a stored seed elsewhere; the device record says which. And the first
 * device set of a profile, from its DID key's seed, with the turn keeper signing through that key. Every key and
 * seed here is made in the test. Node's WebCrypto has Ed25519, and the fake IndexedDB stores a `CryptoKey` as a
 * browser does (a structured clone); the browsers themselves are measured in `e2e/web/device-signing-key.spec.ts`.
 */

const dropKeys = () => new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(DEVICE_KEYS_DB); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
const databases = async () => (await indexedDB.databases()).map((d) => d.name).sort();
/** What is stored for a profile, read past the module. */
async function storedKey(profile: string): Promise<Record<string, unknown> | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(DEVICE_KEYS_DB); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try {
    return await new Promise((resolve, reject) => { const r = db.transaction("keys").objectStore("keys").get(profile); r.onsuccess = () => resolve(r.result as Record<string, unknown> | undefined); r.onerror = () => reject(r.error); });
  } finally { db.close(); }
}
const message = new TextEncoder().encode("a turn record to sign");

beforeEach(async () => { setDeviceMirror(null); await closeDevicesDb(); await closeDeviceKeysDb(); await dropDevicesDatabase(); await dropKeys(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("the device signing key", () => {
  it("is non-extractable where the engine makes, keeps and reads back such a key: no seed is stored, and it signs what the library verifies", async () => {
    expect(await checkNonExtractableEd25519()).toEqual({ supported: true });
    const key = await createDeviceSigningKey("ghostly");
    expect(key.kind).toBe("webcrypto");
    expect(key.publicKey).toHaveLength(32);
    expect(verify(await key.sign(message), message, key.publicKey)).toBe(true);
    const stored = (await storedKey("ghostly"))!;
    expect(stored.kind).toBe("webcrypto");
    expect(stored.seed).toBeUndefined();
    const privateKey = stored.privateKey as CryptoKey;
    expect(privateKey.extractable).toBe(false);
    expect(privateKey.algorithm.name).toBe("Ed25519");
    for (const format of ["pkcs8", "jwk", "raw"] as const) await expect(crypto.subtle.exportKey(format, privateKey)).rejects.toThrow();
    // Nothing of the private key is in what the record holds as text.
    expect(JSON.stringify({ ...stored, privateKey: undefined })).not.toMatch(/"(seed|d)":/);
  });

  it("signs again after the database was closed and opened: the key a later start reads is the key that was made", async () => {
    const made = await createDeviceSigningKey("ghostly");
    await closeDeviceKeysDb();
    const read = (await loadDeviceSigningKey("ghostly"))!;
    expect(read.kind).toBe("webcrypto");
    expect(read.publicKey).toEqual(made.publicKey);
    expect(verify(await read.sign(message), message, made.publicKey)).toBe(true);
  });

  it("is kept: asking again answers the same key, and each profile has its own", async () => {
    const first = await createDeviceSigningKey("ghostly");
    const again = await createDeviceSigningKey("ghostly", { forceSeed: true });
    expect(again.kind).toBe("webcrypto");
    expect(again.publicKey).toEqual(first.publicKey);
    const other = await createDeviceSigningKey("ghostly_work");
    expect(other.publicKey).not.toEqual(first.publicKey);
    // Two pages that make one at the same moment end with one key.
    const [a, b] = await Promise.all([createDeviceSigningKey("ghostly_race"), createDeviceSigningKey("ghostly_race")]);
    expect(b.publicKey).toEqual(a.publicKey);
    expect((await loadDeviceSigningKey("ghostly_race"))!.publicKey).toEqual(a.publicKey);
    expect(verify(await b.sign(message), message, a.publicKey)).toBe(true);
  });

  it("is a stored seed where WebCrypto has no Ed25519, and says so", async () => {
    vi.spyOn(crypto.subtle, "generateKey").mockRejectedValue(new DOMException("Unrecognized name.", "NotSupportedError"));
    expect(await checkNonExtractableEd25519()).toEqual({ supported: false, reason: "NotSupportedError: Unrecognized name." });
    const key = await createDeviceSigningKey("ghostly");
    expect(key.kind).toBe("seed");
    expect(verify(await key.sign(message), message, key.publicKey)).toBe(true);
    const stored = (await storedKey("ghostly"))!;
    expect(stored.kind).toBe("seed");
    expect(stored.privateKey).toBeUndefined();
    expect(fromBase64Url(stored.seed as string)).toHaveLength(32);
    await closeDeviceKeysDb();
    const read = (await loadDeviceSigningKey("ghostly"))!;
    expect(read.kind).toBe("seed");
    expect(read.publicKey).toEqual(key.publicKey);
  });

  it("is a stored seed where the engine hands out a key it lets be exported", async () => {
    const generate = crypto.subtle.generateKey.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "generateKey").mockImplementation((async () => generate({ name: "Ed25519" }, true, ["sign", "verify"])) as typeof crypto.subtle.generateKey);
    expect(await checkNonExtractableEd25519()).toEqual({ supported: false, reason: "The key was made extractable" });
    expect((await createDeviceSigningKey("ghostly")).kind).toBe("seed");
  });

  it("is never handed out when it does not sign: a stored key that fails its check and cannot be taken back is refused", async () => {
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    let calls = 0;
    // The first signature (the engine check) works; the one with the key read back from storage fails.
    vi.spyOn(crypto.subtle, "sign").mockImplementation(((...args: Parameters<typeof crypto.subtle.sign>) => (++calls === 1 ? sign(...args) : Promise.reject(new DOMException("broken", "OperationError")))) as typeof crypto.subtle.sign);
    // And taking it back fails too.
    vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(() => { throw new DOMException("The disk is full", "UnknownError"); });
    await expect(createDeviceSigningKey("ghostly")).rejects.toThrow("does not sign");
    // The key that does not sign is still stored, and nothing named it: a device record is written only with a key that signs.
    expect((await storedKey("ghostly"))!.kind).toBe("webcrypto");
  });

  it("taking back the key this page made never removes one another page stored meanwhile, and that one is used", async () => {
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    const otherSeed = randomBytes(32), otherKey = seedSigner(otherSeed);
    let calls = 0;
    vi.spyOn(crypto.subtle, "sign").mockImplementation((async (...args: Parameters<typeof crypto.subtle.sign>) => {
      if (++calls === 1) return sign(...args);
      // While this page checks the key it stored, another page put a key of its own in its place (the first was
      // forgotten and a new one made); then this page's check fails.
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(DEVICE_KEYS_DB); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("keys", "readwrite");
        tx.objectStore("keys").put({ profile: "ghostly", kind: "seed", publicKey: toBase64Url(otherKey.publicKey), seed: toBase64Url(otherSeed), createdAt: 1 });
        tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
      });
      db.close();
      throw new DOMException("broken", "OperationError");
    }) as typeof crypto.subtle.sign);
    const key = await createDeviceSigningKey("ghostly");
    expect(key.publicKey).toEqual(otherKey.publicKey);
    expect((await storedKey("ghostly"))!.publicKey).toBe(toBase64Url(otherKey.publicKey));
    expect(verify(await key.sign(message), message, otherKey.publicKey)).toBe(true);
  });

  it("is a stored seed where the engine cannot keep the key it made, and nothing of that key stays behind", async () => {
    const generate = crypto.subtle.generateKey.bind(crypto.subtle);
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    const exportKey = crypto.subtle.exportKey.bind(crypto.subtle);
    // A key object the database cannot clone: what an engine that does not store CryptoKeys throws on.
    const real = new WeakMap<object, CryptoKey>();
    vi.spyOn(crypto.subtle, "generateKey").mockImplementation((async () => {
      const pair = await generate({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair;
      const wrapped = { extractable: false, unclonable: () => {} };
      real.set(wrapped, pair.privateKey);
      return { publicKey: pair.publicKey, privateKey: wrapped as unknown as CryptoKey };
    }) as typeof crypto.subtle.generateKey);
    vi.spyOn(crypto.subtle, "sign").mockImplementation(((algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) => sign(algorithm, real.get(key) ?? key, data)) as typeof crypto.subtle.sign);
    vi.spyOn(crypto.subtle, "exportKey").mockImplementation(((format: KeyFormat, key: CryptoKey) => exportKey(format as "raw", real.get(key) ?? key)) as typeof crypto.subtle.exportKey);
    expect((await checkNonExtractableEd25519()).supported).toBe(true);
    const key = await createDeviceSigningKey("ghostly");
    expect(key.kind).toBe("seed");
    const stored = (await storedKey("ghostly"))!;
    expect(stored.kind).toBe("seed");
    expect(stored.privateKey).toBeUndefined();
    expect(verify(await key.sign(message), message, key.publicKey)).toBe(true);
  });

  it("is never made or looked for by a read: a profile that has none makes no database", async () => {
    expect(await loadDeviceSigningKey("ghostly")).toBeNull();
    await forgetDeviceSigningKey("ghostly");
    expect(await databases()).toEqual([]);
  });

  it("goes with the profile: forgetting the device state forgets the key, and only that profile's", async () => {
    const kept = await createDeviceSigningKey("ghostly_work");
    await createDeviceSigningKey("ghostly");
    await enrollDevice("ghostly", "active", await firstDeviceSet("ghostly", randomBytes(32), "MacBook"));
    await forgetDevice("ghostly");
    expect(await loadDeviceSigningKey("ghostly")).toBeNull();
    expect(await readDeviceRecord("ghostly")).toBeNull();
    expect((await loadDeviceSigningKey("ghostly_work"))!.publicKey).toEqual(kept.publicKey);
  });
});

describe("the first device set of a profile", () => {
  it("has the first D from the DID key's seed, this device alone in slot 0, and says which form its key has", async () => {
    const didSeed = randomBytes(32);
    const patch = await firstDeviceSet("ghostly", didSeed, "Miguel's MacBook Pro 16");
    const record = await enrollDevice("ghostly", "active", patch);
    expect(parseDeviceRecord(record)).toBe(record);
    expect(record.d).toBe(toBase64Url(firstDeviceSetSecret(didSeed)));
    const key = (await loadDeviceSigningKey("ghostly"))!;
    // The name is cut to the 16 bytes a slot holds.
    expect(record.deviceSet).toEqual([{ key: toBase64Url(key.publicKey), name: "Miguel's MacBook" }]);
    expect(record).toMatchObject({ state: "active", ownSlot: 0, activeSlot: 0, rev: 0, signingKey: "webcrypto" });
    expect(record.turn).toBeLessThan(2 ** 29);
    // The same seed on another device leads to the same turn address: what a restored backup reads.
    const elsewhere = await firstDeviceSet("ghostly_restored", didSeed, "Phone", { forceSeed: true });
    expect(elsewhere.d).toBe(record.d);
    expect(elsewhere.signingKey).toBe("seed");
    expect(turnKeys(fromBase64Url(elsewhere.d!)).identity.pubKeyZ32).toBe(turnKeys(fromBase64Url(record.d!)).identity.pubKeyZ32);
    // The record is JSON, as Desktop's file holds it, and carries no key material but D.
    const text = JSON.stringify(record);
    expect(JSON.parse(text)).toEqual(record);
    expect(text).not.toContain("privateKey");
    expect(text).not.toContain("seed");
  });

  it("starts at a random turn under 2^29", () => {
    expect(firstTurn(() => new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toBe(2 ** 29 - 1);
    expect(firstTurn(() => new Uint8Array([0xe0, 0, 0, 0]))).toBe(0);
    expect(firstTurn(() => new Uint8Array([0x01, 0x02, 0x03, 0x04]))).toBe(0x01020304);
    for (let i = 0; i < 200; i++) expect(firstTurn()).toBeLessThan(2 ** 29);
  });

  it("a record the device cannot act in is refused: no D, no slot, no key, or a key that is not the one it names", async () => {
    const patch = await firstDeviceSet("ghostly", randomBytes(32), "MacBook");
    const record = await enrollDevice("ghostly", "active", patch);
    expect((await deviceIdentity("ghostly"))!.ownSlot).toBe(0);
    await expect(deviceIdentity("ghostly", { record: { ...record, d: undefined } })).rejects.toThrow("no device-set secret");
    await expect(deviceIdentity("ghostly", { record: { ...record, ownSlot: undefined } })).rejects.toThrow("which slot");
    await expect(deviceIdentity("ghostly", { record: { ...record, deviceSet: [{ key: toBase64Url(randomBytes(32)), name: "MacBook" }] } })).rejects.toThrow("not the one the device state names");
    await expect(deviceIdentity("ghostly", { record, loadKey: async () => null })).rejects.toBeInstanceOf(DeviceSetError);
    // A `single` profile: null, and its key is not even looked for.
    const loadKey = vi.fn(async () => null);
    expect(await deviceIdentity("ghostly_single", { loadKey })).toBeNull();
    expect(loadKey).not.toHaveBeenCalled();
  });
});

describe("the turn keeper with the device's own key", () => {
  const clock = { t: 1_000_000 };
  const timing = { now: () => clock.t, sleep: async (ms: number) => { clock.t += ms; } };

  it.each([["a non-extractable key", false], ["a stored seed", true]] as const)("signs the turn record with %s, under the D and the slot of the device record", async (_name, forceSeed) => {
    const network = new FakeTurnNetwork();
    const didSeed = randomBytes(32);
    await enrollDevice("ghostly", "active", await firstDeviceSet("ghostly", didSeed, "MacBook", { forceSeed, turn: 41 }));
    const key = (await loadDeviceSigningKey("ghostly"))!;
    expect(key.kind).toBe(forceSeed ? "seed" : "webcrypto");
    const keeper = (await openTurnKeeper("ghostly", network, timing))!;
    const outcome = await keeper.check(true);
    expect(outcome.kind).toBe("start");
    // The record went out under the turn address of D0, signed by this device's key from its own slot.
    const keys = turnKeys(firstDeviceSetSecret(didSeed));
    const stored = (await readDeviceRecord("ghostly"))!;
    const payload = fromBase64Url(stored.turnPacket!);
    for (const source of network.sources) expect(source.held).toEqual(payload);
    const read = readTurnPacket(keys, payload);
    expect(read.kind).toBe("valid");
    if (read.kind !== "valid") return;
    expect(read.record).toMatchObject({ turn: 41, author: 0, active: 0 });
    expect(read.record.slots[0]!.key).toEqual(key.publicKey);
    expect(deviceKeyZ32(read.record.slots[0]!.key)).toBe(deviceKeyZ32(key.publicKey));
    expect(network.calls.filter((c) => c.op === "put").length).toBeGreaterThan(0);
  });

  it("is none for a profile with no device set: nothing is read, put or signed, no key is looked for and no database is made", async () => {
    const network = new FakeTurnNetwork();
    const loadKey = vi.fn(async () => null);
    expect(await openTurnKeeper("ghostly", network, { loadKey })).toBeNull();
    expect(loadKey).not.toHaveBeenCalled();
    expect(network.calls).toEqual([]);
    expect(network.warmed).toBe(0);
    expect(await databases()).toEqual([]);
  });

  it("is refused to a device whose stored key is not the one its record names", async () => {
    const network = new FakeTurnNetwork();
    await enrollDevice("ghostly", "active", await firstDeviceSet("ghostly", randomBytes(32), "MacBook"));
    const other = await createDeviceSigningKey("ghostly_other");
    await expect(openTurnKeeper("ghostly", network, { loadKey: async () => other })).rejects.toBeInstanceOf(DeviceSetError);
    expect(network.calls).toEqual([]);
    expect((await databases())).toEqual([DEVICE_KEYS_DB, DEVICES_DB].sort());
  });
});
