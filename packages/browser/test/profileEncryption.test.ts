import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropDataKey, hasDataKey, openPasswordSeed, openRecordSecret, openSecret, sealSecret, setDataKey, takesUnsealed, type SealedSecret } from "../src/engine/dataKey";
import { newDeviceKey, sealSeed, unsealSeed, type EncryptedSeed } from "../src/engine/paymentAdapters/persistence";
import { changeProfilePassphrase, decryptProfile, encryptProfile, unlockProfile, applyProfileKey, type ProfileKeyHome } from "../src/engine/profileEncryption";
import { openRow } from "../src/engine/sealedRows";
import { isSealedField, unlockProfileKey, type ProfileKeyRecord } from "../src/shared/profileKey";
import { STORES, openDb, store, transact, wrap } from "../src/shared/idb";

/*
 * Turning a profile's encryption on and off, and changing its passphrase (WISP 04, Encrypted profile, slice 4): every
 * phase 1 secret of a profile is sealed under its data key and back, a walk cut short anywhere is finished at the next
 * unlock, and a profile with a Fedimint federation is refused with nothing written.
 */

const PASSPHRASE = "throwaway passphrase 1";
const OTHER = "another throwaway pass 2";
const PASSWORD = "a wallet password 123";
/** Every secret a raw read of the profile must not find once it is encrypted. */
const SECRETS = {
  chatSeed: "CHATSEEDsecret0001", invite: "INVITEsecret0002", groupSeed: "GROUPSEEDsecret0003", proof: "PROOFsecret0004", token: "cashuTOKENsecret0005",
  did: "DIDSEEDsecret0006", link: "LINKSEEDsecret0007", oldLink: "OLDLINKsecret0008", ask: "ASKSEEDsecret0009", x401: "X401KEYsecret0010", revoked: "REVOKEDsecret0011",
  ark: "abandon ark phrase secret0012", usdt: "abandon usdt phrase secret0013", spark: "abandon spark phrase secret0014", apiKey: "BREEZKEYsecret0015",
  fedimint: "abandon fedimint phrase secret0016", source: "SOURCEsecret0017", bark: "abandon bark phrase secret0018",
};

const at = (key: string, field: string) => ({ store: STORES.settings, key, field });

function memoryHome(): ProfileKeyHome & { record: ProfileKeyRecord | null } {
  const home = {
    record: null as ProfileKeyRecord | null,
    read: async () => home.record && structuredClone(home.record),
    write: async (record: ProfileKeyRecord) => { home.record = structuredClone(record); },
    remove: async () => { home.record = null; },
  };
  return home;
}

/** A profile as clients keep it today (no data key): plain rows, version 1 seeds beside their device keys. */
async function seedProfile(): Promise<void> {
  const v1 = async (value: string) => { const deviceKey = newDeviceKey(); return { seed: await sealSeed(value, deviceKey), deviceKey }; };
  const settings: Record<string, unknown> = {
    settings: { name: "kept as it is" },
    profileDid: { seed: await sealSecret(SECRETS.did, at("profileDid", "did.seed")), publicKey: "pk", createdAt: 1, listed: [] },
    contactLinks: { current: { seed: await sealSecret(SECRETS.link, at("lk1", "contactLink.seed")), linkKeyZ32: "lk1", createdAt: 1, inbox: {} }, retired: [{ seed: await sealSecret(SECRETS.oldLink, at("lk0", "contactLink.seed")), linkKeyZ32: "lk0", createdAt: 0, offAt: 1 }] },
    contactAsks: [{ link: "lk1", key: "asker", seed: await sealSecret(SECRETS.ask, at("lk1", "contactAsk.seed")) }],
    x401Credentials: { keys: [{ id: "h1", jwk: {}, secret: await sealSecret(SECRETS.x401, at("h1", "x401.holderKey")), createdAt: 1 }], credentials: [] },
    identityRevocations: [{ id: "r1", key: "k", seed: await sealSecret(SECRETS.revoked, at("r1", "identityProof.seed")), revokedAt: 1, expiresAt: 2 }],
    "arkWallet-mode-mainnet": { config: { network: "bitcoin" }, ...await v1(SECRETS.ark) },
    "usdtWallet-mode-testnet": { config: { network: "sepolia" }, seed: await sealSeed(SECRETS.usdt, PASSWORD) },
    "barkWallet-retired-5": { config: { network: "signet" }, ...await v1(SECRETS.bark) },
    "fedimintWallet-testnet": { ...await v1(SECRETS.fedimint), federations: [] },
    "onchainSource-mainnet": { providerId: "node", config: {}, ...(({ seed, deviceKey }) => ({ secrets: seed, deviceKey }))(await v1(JSON.stringify({ key: SECRETS.source }))), savedAt: 1 },
  };
  const spark = newDeviceKey();
  settings["sparkWallet-mode-testnet"] = { network: "regtest", seed: await sealSeed(SECRETS.spark, spark), apiKey: await sealSeed(SECRETS.apiKey, spark), deviceKey: spark, createdAt: 1 };
  await transact([STORES.settings, STORES.links, STORES.groups, STORES.proofs, STORES.payments], (s) => {
    for (const [key, value] of Object.entries(settings)) s[STORES.settings].put(value, key);
    s[STORES.links].put({ id: "chat1", seedB64: SECRETS.chatSeed, inviteCode: SECRETS.invite, name: "Alice" });
    s[STORES.groups].put({ id: "g1", state: { seedB64: SECRETS.groupSeed } });
    s[STORES.proofs].put({ secret: SECRETS.proof, amount: 8, id: "keyset", C: "02aa" });
    s[STORES.payments].put({ id: "pay1", token: SECRETS.token });
  });
}

/** The whole peer database as stored, every store. */
async function rawDump(): Promise<string> {
  const db = await openDb();
  const out: Record<string, unknown> = {};
  for (const name of [...db.objectStoreNames]) {
    const s = await store(name, "readonly");
    out[name] = { keys: await wrap(s.getAllKeys()), values: await wrap(s.getAll()) };
  }
  return JSON.stringify(out);
}
const leaks = async () => { const dump = await rawDump(); return Object.values(SECRETS).filter((secret) => dump.includes(secret)); };
const settingsOf = async (key: string) => wrap<Record<string, unknown>>((await store(STORES.settings, "readonly")).get(key));

/** What the engine's readers get back, through the same calls they make. */
async function readBack() {
  const links = await openRow(STORES.links, await wrap<Record<string, unknown>>((await store(STORES.links, "readonly")).get("chat1")));
  const groups = await openRow(STORES.groups, await wrap<Record<string, unknown>>((await store(STORES.groups, "readonly")).get("g1")));
  const proofs = await Promise.all((await wrap<Record<string, unknown>[]>((await store(STORES.proofs, "readonly")).getAll())).map((row) => openRow(STORES.proofs, row)));
  const did = await settingsOf("profileDid"), links2 = await settingsOf("contactLinks") as { current: { seed: SealedSecret }; retired: { seed: SealedSecret }[] };
  const ark = await settingsOf("arkWallet-mode-mainnet"), usdt = await settingsOf("usdtWallet-mode-testnet"), spark = await settingsOf("sparkWallet-mode-testnet");
  const source = await settingsOf("onchainSource-mainnet"), bark = await settingsOf("barkWallet-retired-5"), fedimint = await settingsOf("fedimintWallet-testnet");
  return {
    chatSeed: links.seedB64, invite: links.inviteCode, groupSeed: (groups.state as { seedB64: string }).seedB64, proof: proofs.map((p) => p.secret),
    did: await openSecret(did.seed as SealedSecret, at("profileDid", "did.seed")),
    link: await openSecret(links2.current.seed, at("lk1", "contactLink.seed")),
    oldLink: await openSecret(links2.retired[0].seed, at("lk0", "contactLink.seed")),
    ask: await openSecret(((await settingsOf("contactAsks")) as unknown as { seed: SealedSecret }[])[0].seed, at("lk1", "contactAsk.seed")),
    x401: await openSecret((((await settingsOf("x401Credentials")).keys) as { secret: SealedSecret }[])[0].secret, at("h1", "x401.holderKey")),
    revoked: await openSecret(((await settingsOf("identityRevocations")) as unknown as { seed: SealedSecret }[])[0].seed, at("r1", "identityProof.seed")),
    ark: await openRecordSecret(ark.seed as EncryptedSeed, ark.deviceKey as string | undefined, at("arkWallet-mode-mainnet", "ark.seed")),
    usdt: await unsealSeed(await openPasswordSeed(usdt.seed as EncryptedSeed, at("usdtWallet-mode-testnet", "usdt.seed")), PASSWORD),
    spark: await openRecordSecret(spark.seed as EncryptedSeed, spark.deviceKey as string | undefined, at("sparkWallet-mode-testnet", "spark.seed")),
    apiKey: await openRecordSecret(spark.apiKey as EncryptedSeed, spark.deviceKey as string | undefined, at("sparkWallet-mode-testnet", "spark.apiKey")),
    source: JSON.parse(await openRecordSecret(source.secrets as EncryptedSeed, source.deviceKey as string | undefined, at("onchainSource-mainnet", "providerSource.secrets"))).key,
    bark: await openRecordSecret(bark.seed as EncryptedSeed, bark.deviceKey as string | undefined, at("barkWallet-mode-testnet", "bark.seed")),
    fedimint: await openRecordSecret(fedimint.seed as EncryptedSeed, fedimint.deviceKey as string | undefined, at("fedimintWallet-testnet", "fedimint.seed")),
  };
}
const EXPECTED = { ...SECRETS, proof: [SECRETS.proof], token: undefined };
const expectReadBack = async () => { const { token: _token, ...expected } = EXPECTED; expect(await readBack()).toEqual(expected); };

/** Today's layout, as a client that is not encrypted keeps it. */
async function expectPlainLayout() {
  expect(await leaks(), "a plain profile keeps its rows readable").toEqual(Object.values(SECRETS).filter((s) => ![SECRETS.did, SECRETS.link, SECRETS.oldLink, SECRETS.ask, SECRETS.x401, SECRETS.revoked, SECRETS.ark, SECRETS.usdt, SECRETS.spark, SECRETS.apiKey, SECRETS.fedimint, SECRETS.source, SECRETS.bark].includes(s)));
  const dump = await rawDump();
  expect(dump).not.toContain('"v":2');
  for (const key of ["arkWallet-mode-mainnet", "sparkWallet-mode-testnet", "barkWallet-retired-5", "fedimintWallet-testnet", "onchainSource-mainnet"]) expect(typeof (await settingsOf(key)).deviceKey, key).toBe("string");
  expect(await settingsOf("arkWallet-mode-mainnet")).not.toHaveProperty("automatic");
  expect(await settingsOf("profileEncryption")).toBeUndefined();
}

/** PBKDF2 at 600,000 rounds costs about a second per call; the derivation runs with fewer rounds here. */
beforeEach(async () => {
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "deriveKey").mockImplementation(((algorithm: Pbkdf2Params, ...rest: [CryptoKey, AesKeyGenParams, boolean, KeyUsage[]]) =>
    derive({ ...algorithm, iterations: 1_000 }, ...rest)) as typeof crypto.subtle.deriveKey);
  dropDataKey();
  // Every store, the wallets' records included (the profile's own "Clear all data" keeps those).
  const db = await openDb();
  await transact([...db.objectStoreNames], (stores) => { for (const name of Object.keys(stores)) stores[name].clear(); });
  await seedProfile();
});
afterEach(() => { dropDataKey(); vi.restoreAllMocks(); });

describe("turning encryption on", () => {
  it("seals every phase 1 secret: a raw read of the database finds none, no device key is left, and each opens where it is read", async () => {
    const home = memoryHome();
    await encryptProfile(home, PASSPHRASE, "");
    expect(home.record).toMatchObject({ format: "ghostly-profile-key", profile: "" });
    expect(await leaks()).toEqual([]);
    expect(await rawDump()).not.toContain("deviceKey");
    expect(await settingsOf("arkWallet-mode-mainnet")).toMatchObject({ automatic: true });
    expect(await settingsOf("usdtWallet-mode-testnet"), "a password wallet still waits for its password").not.toHaveProperty("automatic");
    expect(await settingsOf("settings")).toEqual({ name: "kept as it is" });
    expect(await settingsOf("profileEncryption"), "the mark is cleared once the walk ends").toBeUndefined();
    expect(takesUnsealed(), "after the migration, a sealed place takes version 2 only").toBe(false);
    await expectReadBack();

    // The next start: the passphrase opens it, and a second walk has nothing to do.
    dropDataKey();
    const before = await rawDump();
    expect(await unlockProfile(home, PASSPHRASE, "")).toBe(true);
    expect(await rawDump()).toBe(before);
    await expectReadBack();
  });

  it("is refused while the profile has a Fedimint federation, with nothing written", async () => {
    await transact([STORES.settings], (s) => { s[STORES.settings].put({ seed: { version: 1 }, deviceKey: "k", federations: [{ id: "fed" }] }, "fedimintWallet-mainnet"); });
    const home = memoryHome();
    const before = await rawDump();
    await expect(encryptProfile(home, PASSPHRASE, "")).rejects.toThrow("This profile has a Fedimint federation");
    expect(home.record).toBeNull();
    expect(hasDataKey()).toBe(false);
    expect(await rawDump()).toBe(before);
  });

  it("refuses a profile that is already encrypted, and a short passphrase, before anything is written", async () => {
    const home = memoryHome();
    const before = await rawDump();
    await expect(encryptProfile(home, "too short", "")).rejects.toThrow("at least 12 characters");
    expect(await rawDump()).toBe(before);
    await encryptProfile(home, PASSPHRASE, "");
    await expect(encryptProfile(home, OTHER, "")).rejects.toThrow("already encrypted");
  });
});

/** The walk cut short after `calls` encryptions (a crash, a closed tab): the engine stops right there. */
function failEncryptAfter(calls: number) {
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  let left = calls;
  return vi.spyOn(crypto.subtle, "encrypt").mockImplementation(((...args: Parameters<typeof crypto.subtle.encrypt>) => {
    if (left-- <= 0) return Promise.reject(new Error("cut short"));
    return encrypt(...args);
  }) as typeof crypto.subtle.encrypt);
}

describe("a walk cut short", () => {
  // 0: the record's wrap; 1: the mark (nothing written yet); 2-14: the settings records (written together); 15-16: the
  // chats; 17: the groups; 18: the payments; 19: the proofs.
  it.each([0, 1, 2, 9, 15, 16, 17, 18, 19])("on, cut after %i seals: the next unlock finishes it, and plain, version 1 and version 2 read meanwhile", async (calls) => {
    const home = memoryHome();
    const cut = failEncryptAfter(calls);
    await expect(encryptProfile(home, PASSPHRASE, "")).rejects.toThrow("cut short");
    cut.mockRestore();
    expect(hasDataKey(), "a walk that failed leaves the slot empty").toBe(false);
    if (home.record) {
      // Mid-walk: what is sealed and what is not yet both read.
      setDataKey(await unlockProfileKey(home.record, PASSPHRASE, ""));
      await expectReadBack();
      dropDataKey();
    }
    if (!home.record) {
      // Cut before the record was written: the profile is not encrypted, and reads as it did.
      expect(await unlockProfile(home, PASSPHRASE, "")).toBe(false);
      await expectReadBack();
      return;
    }
    expect(await unlockProfile(home, PASSPHRASE, "")).toBe(true);
    expect(await leaks()).toEqual([]);
    expect(await settingsOf("profileEncryption")).toBeUndefined();
    expect(takesUnsealed()).toBe(false);
    await expectReadBack();
  });

  // 0: the mark (nothing written); then among the 12 seeds resealed as version 1.
  it.each([0, 1, 4, 9, 12])("off, cut after %i seals: the next unlock finishes it, and the profile is left as clients keep it today", async (calls) => {
    const home = memoryHome();
    await encryptProfile(home, PASSPHRASE, "");
    dropDataKey();
    // Off reseals each version 2 seed as version 1 under a fresh device key: cut among those.
    const cut = failEncryptAfter(calls);
    await expect(decryptProfile(home, PASSPHRASE, "")).rejects.toThrow("cut short");
    cut.mockRestore();
    expect(hasDataKey()).toBe(false);
    expect(home.record, "the record stays until the walk back has ended").not.toBeNull();
    if (calls === 0) {
      // Cut before its mark: still encrypted, as it was.
      expect(await unlockProfile(home, PASSPHRASE, "")).toBe(true);
      expect(await leaks()).toEqual([]);
      return;
    }
    expect(await unlockProfile(home, PASSPHRASE, "")).toBe(false);
    expect(home.record).toBeNull();
    expect(hasDataKey()).toBe(false);
    await expectPlainLayout();
    await expectReadBack();
  });
});

describe("turning it off, and the passphrase", () => {
  it("off restores today's layout: plain rows, version 1 seeds beside device keys, no record, no mark, the slot empty", async () => {
    const home = memoryHome();
    await encryptProfile(home, PASSPHRASE, "");
    dropDataKey();
    await expect(decryptProfile(home, OTHER, "")).rejects.toThrow("Wrong passphrase");
    expect(hasDataKey()).toBe(false);
    await decryptProfile(home, PASSPHRASE, "");
    expect(home.record).toBeNull();
    expect(hasDataKey()).toBe(false);
    await expectPlainLayout();
    await expectReadBack();
  });

  it("a wrong passphrase at the start reads nothing and fills no slot", async () => {
    const home = memoryHome();
    await encryptProfile(home, PASSPHRASE, "");
    dropDataKey();
    await expect(unlockProfile(home, OTHER, "")).rejects.toThrow("Wrong passphrase");
    expect(hasDataKey()).toBe(false);
    await expect(unlockProfile(home, PASSPHRASE, "other-profile")).rejects.toThrow("belongs to another profile");
  });

  it("a key the client unwrapped itself (the CLI) is used the same way: an interrupted walk is finished first", async () => {
    const home = memoryHome();
    const cut = failEncryptAfter(16);
    await expect(encryptProfile(home, PASSPHRASE, "")).rejects.toThrow("cut short");
    cut.mockRestore();
    expect(await applyProfileKey(home, await unlockProfileKey(home.record!, PASSPHRASE, ""))).toBe(true);
    expect(await leaks()).toEqual([]);
    expect(takesUnsealed()).toBe(false);
    await expectReadBack();
  });

  it("a change of passphrase rewraps the record alone: the old one stops opening it, the new one does, no data changes", async () => {
    const home = memoryHome();
    await encryptProfile(home, PASSPHRASE, "");
    dropDataKey();
    const before = await rawDump();
    await expect(changeProfilePassphrase(home, OTHER, "a third throwaway pass", "")).rejects.toThrow("Wrong passphrase");
    await changeProfilePassphrase(home, PASSPHRASE, OTHER, "");
    expect(await rawDump()).toBe(before);
    expect(hasDataKey()).toBe(false);
    await expect(unlockProfile(home, PASSPHRASE, "")).rejects.toThrow("Wrong passphrase");
    expect(await unlockProfile(home, OTHER, "")).toBe(true);
    await expectReadBack();
  });
});

describe("a sealed mark", () => {
  it("written by a copy that can write the profile but not read it, a mark not sealed under its key stops the start", async () => {
    const home = memoryHome();
    await encryptProfile(home, PASSPHRASE, "");
    dropDataKey();
    await transact([STORES.settings], (s) => { s[STORES.settings].put({ v: 2, iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" }, "profileEncryption"); });
    await expect(unlockProfile(home, PASSPHRASE, "")).rejects.toThrow("could not be opened");
    expect(isSealedField(await settingsOf("profileEncryption"))).toBe(true);
  });
});
