import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64Url } from "@ghostly/core";
import { dropDataKey, hasDataKey, openSecret, sealSecret, setDataKey, whenDataKeyDropped, type DeviceSealed } from "../src/engine/dataKey";
import { ProfileDid, type ProfileDidHost } from "../src/engine/did";
import { X401Credentials, X401_KEY } from "../src/engine/x401";
import { createProfileKey, isSealedField } from "../src/shared/profileKey";
import { STORES, clearProfileStores, store, wrap } from "../src/shared/idb";
// covers: did.dht.profile

/*
 * The engine's data key slot (WISP 04, Encrypted profile, slice 2): with no key, secrets are sealed as before
 * (version 1, a device key beside them); with one, as version 2 under it, and both read while a profile holds both.
 */

/** PBKDF2 at 600,000 rounds costs about a second per call; the derivation runs with fewer rounds here. */
beforeEach(async () => {
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "deriveKey").mockImplementation(((algorithm: Pbkdf2Params, ...rest: [CryptoKey, AesKeyGenParams, boolean, KeyUsage[]]) =>
    derive({ ...algorithm, iterations: 1_000 }, ...rest)) as typeof crypto.subtle.deriveKey);
  dropDataKey();
  await clearProfileStores();
});
afterEach(() => { dropDataKey(); vi.restoreAllMocks(); });

const dataKey = async () => (await createProfileKey("throwaway passphrase 1", "")).key;
const at = { store: STORES.settings, key: "k1", field: "test.seed" };
const SECRET = "a-test-secret-of-a-throwaway-profile";

describe("sealing a secret with and without the data key", () => {
  it("with no key, writes version 1 with a device key beside it, as before, and opens it", async () => {
    expect(hasDataKey()).toBe(false);
    const sealed = await sealSecret(SECRET, at) as DeviceSealed;
    expect(sealed.sealed.version).toBe(1);
    expect(sealed.deviceKey).toMatch(/^[A-Za-z0-9+/]{43}$/);
    expect(await openSecret(sealed, at)).toBe(SECRET);
  });

  it("with a key, writes version 2 with no device key, and still reads version 1 written before", async () => {
    const before = await sealSecret(SECRET, at);
    setDataKey(await dataKey());
    const after = await sealSecret(SECRET, at);
    expect(isSealedField(after)).toBe(true);
    expect(after).not.toHaveProperty("deviceKey");
    expect(JSON.stringify(after)).not.toContain(SECRET);
    expect(await openSecret(after, at)).toBe(SECRET);
    expect(await openSecret(before, at)).toBe(SECRET);
    await expect(openSecret(after, { ...at, key: "k2" }), "bound to its place").rejects.toThrow("could not be opened");
  });

  it("a version 2 secret does not open once the key is dropped, nor under another profile's key", async () => {
    setDataKey(await dataKey());
    const sealed = await sealSecret(SECRET, at);
    dropDataKey();
    await expect(openSecret(sealed, at)).rejects.toThrow("This profile is locked. Enter its passphrase first.");
    setDataKey(await dataKey());
    await expect(openSecret(sealed, at)).rejects.toThrow("could not be opened");
  });

  it("dropping the key tells every cache that listens, until it stops listening", () => {
    const heard: string[] = [];
    const stop = whenDataKeyDropped(() => heard.push("one"));
    whenDataKeyDropped(() => heard.push("two"))();
    dropDataKey();
    stop();
    dropDataKey();
    expect(heard).toEqual(["one"]);
  });
});

describe("the engine's secrets under the data key", () => {
  const host: ProfileDidHost = { online: () => false, emit: () => {}, listable: () => new Map(), proofIds: () => [], publish: async () => {} };
  const didRecord = async () => wrap<{ seed: unknown } | undefined>((await store(STORES.settings, "readonly")).get("profileDid"));

  it("the DID key is made sealed under the key, and the seed it keeps in memory goes when the key is dropped", async () => {
    const key = await dataKey();
    setDataKey(key);
    const did = new ProfileDid(host);
    await did.load();
    did.start();
    const seed = await did.deviceSetSeed();
    const stored = JSON.stringify(await didRecord());
    expect(isSealedField((await didRecord())!.seed)).toBe(true);
    expect(stored).not.toContain("deviceKey");
    expect(stored).not.toContain(toBase64Url(seed));
    dropDataKey();
    await expect(did.deviceSetSeed(), "nothing left in memory to read it from").rejects.toThrow("This profile is locked");
    setDataKey(key);
    expect(await did.deviceSetSeed()).toEqual(seed);
    did.stop();
  });

  it("a DID made before the profile had a key keeps opening with one", async () => {
    const before = new ProfileDid(host);
    await before.load();
    const seed = await before.deviceSetSeed();
    setDataKey(await dataKey());
    const after = new ProfileDid(host);
    await after.load();
    expect(await after.deviceSetSeed()).toEqual(seed);
  });

  it("an x401 holder key is sealed under the key", async () => {
    setDataKey(await dataKey());
    await new X401Credentials().newKey();
    const record = await wrap<{ keys: { secret: unknown }[] }>((await store(STORES.settings, "readonly")).get(X401_KEY));
    expect(isSealedField(record.keys[0]!.secret)).toBe(true);
  });
});
