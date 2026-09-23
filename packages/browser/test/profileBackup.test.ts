import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import { STORES, openDb, transact, wrap } from "../src/shared/idb";
import { setStorageProfile } from "../../../src/lib/storage";
import { listProfiles } from "../../../src/lib/profiles";
import { createProfileBackup, restoreProfileBackup } from "../../../src/lib/profileBackup";

class FakeStorage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(k: string) { return this.entries.get(k) ?? null; }
  setItem(k: string, v: string) { this.entries.set(k, v); }
  removeItem(k: string) { this.entries.delete(k); }
}
let storage: FakeStorage;
beforeEach(() => {
  storage = new FakeStorage();
  setStorageProfile("");
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: vi.fn(), location: { hash: "", reload: vi.fn() } }, configurable: true });
});

async function makeArkDatabase(walletId: string) {
  const request = indexedDB.open(`ghostly-ark-${walletId}`, 3);
  request.onupgradeneeded = () => {
    for (const name of ["vtxos", "utxos", "transactions", "walletState", "contracts", "contractsCollections"]) request.result.createObjectStore(name, { keyPath: "id" });
    request.transaction!.objectStore("vtxos").put({ id: "vtxo-1", value: 5000n });
  };
  (await wrap(request)).close();
}
async function readAll(dbName: string, store: string) {
  const db = await wrap(indexedDB.open(dbName));
  try { return await wrap(db.transaction(store, "readonly").objectStore(store).getAll()); } finally { db.close(); }
}

it("backs up a whole profile and restores it as a new one, wallets relocated and nothing secret leaked", async () => {
  storage.setItem("ghostly_0123456789abcdef0123456789abcdef", JSON.stringify({ id: "0123456789abcdef0123456789abcdef", mySeedB64: "c2VlZA", peerPubKeyB64: "peer", encKeyB64: "ZW5j", messages: [] }));
  storage.setItem("ghostly_app_settings", JSON.stringify({ colorTheme: "purple", defaultNickname: "Miguel", backupS3: { accessKeyId: "AKIA", secretAccessKey: "top-secret" } }));
  await openDb();
  await makeArkDatabase("wallet-old");
  await transact([STORES.links, STORES.messages, STORES.files, STORES.settings, STORES.intents], (s) => {
    s[STORES.links].put({ id: "link1", seedB64: "seed", peerPubKeyZ32: "peer" });
    s[STORES.messages].put({ linkId: "link1", id: "m1", text: "hello" });
    s[STORES.files].put({ id: "link1-in-f", linkId: "link1", blob: new Blob([new Uint8Array([1, 2, 3, 250])], { type: "application/octet-stream" }), createdAt: 1 });
    s[STORES.settings].put({ config: { walletId: "wallet-old", network: "bitcoin" }, seed: { version: 1 }, deviceKey: "dk" }, "arkWallet");
    s[STORES.intents].put({ review: { id: "i1", state: "submitted", method: "arkade" }, prepared: {} });
  });

  const bundle = await createProfileBackup("a long backup passphrase");
  expect(bundle).not.toContain("top-secret");
  expect(bundle).not.toContain("hello");
  await expect(restoreProfileBackup(bundle, "not the passphrase")).rejects.toThrow("Wrong passphrase");

  const restored = await restoreProfileBackup(bundle, "a long backup passphrase");
  expect(restored.name).toBe("Personal (restored)");
  expect(listProfiles().map((p) => p.id)).toEqual(["", restored.id]);
  const db = `ghostly_${restored.id}`;
  expect(await readAll(db, STORES.messages)).toEqual([{ linkId: "link1", id: "m1", text: "hello" }]);
  const [file] = await readAll(db, STORES.files) as { blob: Blob }[];
  expect(new Uint8Array(await file.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 250]));
  const [intent] = await readAll(db, STORES.intents) as { review: { state: string } }[];
  expect(intent.review.state, "an unfinished attempt cannot authorize a new send").toBe("unknown");
  const [wallet] = await readAll(db, STORES.settings) as { config: { walletId: string }; deviceKey: string }[];
  expect(wallet.config.walletId).not.toBe("wallet-old");
  expect(wallet.deviceKey).toBe("dk");
  const [vtxo] = await readAll(`ghostly-ark-${wallet.config.walletId}`, "vtxos") as { value: bigint }[];
  expect(vtxo.value).toBe(5000n);
  expect(JSON.parse(storage.getItem(`ghostly_${restored.id}_app_settings`)!)).toEqual({ colorTheme: "purple", defaultNickname: "Miguel" });
  expect(storage.getItem(`ghostly_${restored.id}_0123456789abcdef0123456789abcdef`)).toContain("peerPubKeyB64");
});

it("deletes another profile completely, after an optional backup of it, and never the active or first one", async () => {
  const { createProfile, activeProfileId } = await import("../../../src/lib/profiles");
  const { deleteProfile, profileSummary } = await import("../../../src/lib/profileData");
  const work = createProfile("Work");
  // Work's data, made the way its own session would.
  storage.setItem(`ghostly_${work.id}_fedcba9876543210fedcba9876543210`, JSON.stringify({ id: "x", mySeedB64: "s", peerPubKeyB64: "p", encKeyB64: "e", messages: [] }));
  await makeArkDatabase("wallet-work");
  const request = indexedDB.open(`ghostly_${work.id}`, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore("settings").put({ config: { walletId: "wallet-work" } }, "arkWallet");
    db.createObjectStore("proofs", { keyPath: "secret" }).put({ secret: "a", amount: 64 });
    db.createObjectStore("services", { keyPath: "id" }).put({ id: "atlas" });
  };
  (await wrap(request)).close();
  storage.setItem("ghostly_0123456789abcdef0123456789abcdef", JSON.stringify({ id: "y", mySeedB64: "s", peerPubKeyB64: "keep", encKeyB64: "e", messages: [] }));

  expect(await profileSummary(work.id)).toEqual({ chats: 1, cashuSats: 64, ark: true, usdt: false, services: 1 });
  const bundle = await createProfileBackup("a long backup passphrase", work.id);
  expect(bundle).toContain("ghostly-backup");

  await expect(deleteProfile("")).rejects.toThrow("first profile");
  await deleteProfile(work.id);
  expect(listProfiles().map((p) => p.id)).toEqual([""]);
  expect([...storage.entries.keys()].some((k) => k.includes(work.id))).toBe(false);
  expect(storage.getItem("ghostly_0123456789abcdef0123456789abcdef"), "other profiles stay").toContain("keep");
  const names = (await indexedDB.databases()).map((d) => d.name);
  expect(names).not.toContain(`ghostly_${work.id}`);
  expect(names).not.toContain("ghostly-ark-wallet-work");
  expect(activeProfileId()).toBe("");

  // And the backup made before deleting brings it all back.
  const back = await restoreProfileBackup(bundle, "a long backup passphrase");
  expect(back.name).toBe("Work (restored)");
  expect(await profileSummary(back.id)).toMatchObject({ chats: 1, cashuSats: 64, ark: true, services: 1 });
});

it("a restored copy never shares an Ark database with its original, and deleting it leaves the original's alone", async () => {
  const { registerProfile } = await import("../../../src/lib/profiles");
  const { deleteProfile } = await import("../../../src/lib/profileData");
  // The original, in the first profile: an Ark wallet whose database this device has.
  await makeArkDatabase("wallet-original");
  await transact([STORES.settings], (s) => { s[STORES.settings].put({ config: { walletId: "wallet-original" }, seed: { version: 1 } }, "arkWallet-retired-1"); });
  // A bundle made where that wallet had never opened its database: only the record travels.
  const other = registerProfile("abcdefghij", "Elsewhere");
  const request = indexedDB.open(`ghostly_${other.id}`, 1);
  request.onupgradeneeded = () => { request.result.createObjectStore("settings").put({ config: { walletId: "wallet-original" }, seed: { version: 1 } }, "arkWallet"); };
  (await wrap(request)).close();
  const bundle = await createProfileBackup("a long backup passphrase", other.id);

  const copy = await restoreProfileBackup(bundle, "a long backup passphrase");
  const [record] = await readAll(`ghostly_${copy.id}`, STORES.settings) as { config: { walletId: string } }[];
  expect(record.config.walletId, "a fresh id even without a database to copy").not.toBe("wallet-original");

  // "Elsewhere" still names the original's wallet: deleting it must not take that database away.
  await deleteProfile(other.id);
  await deleteProfile(copy.id);
  expect((await indexedDB.databases()).map((d) => d.name)).toContain("ghostly-ark-wallet-original");
});

it("a profile running in another tab is not deleted, and nothing of it is touched", async () => {
  const { registerProfile } = await import("../../../src/lib/profiles");
  const { deleteProfile } = await import("../../../src/lib/profileData");
  const busy = registerProfile("klmnopqrst", "Busy");
  storage.setItem(`ghostly_${busy.id}_app_settings`, "{}");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { locks: { query: async () => ({ held: [{ name: `ghostly-peer-${busy.id}` }] }) } }, configurable: true });
  try {
    await expect(deleteProfile(busy.id)).rejects.toThrow("open in another window");
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous); else Reflect.deleteProperty(globalThis, "navigator");
  }
  expect(listProfiles().map((p) => p.id)).toContain(busy.id);
  expect(storage.getItem(`ghostly_${busy.id}_app_settings`)).toBe("{}");
});

it("a backup of a wallet whose database cannot be read fails instead of leaving the wallet out", async () => {
  const { registerProfile } = await import("../../../src/lib/profiles");
  const broken = registerProfile("uvwxyzabcd", "Broken");
  const request = indexedDB.open(`ghostly_${broken.id}`, 1);
  request.onupgradeneeded = () => { request.result.createObjectStore("settings").put({ config: { walletId: "wallet-odd" } }, "arkWallet"); };
  (await wrap(request)).close();
  // A database under the wallet's name that is not an Ark wallet's.
  const odd = indexedDB.open("ghostly-ark-wallet-odd", 1);
  odd.onupgradeneeded = () => { odd.result.createObjectStore("something-else"); };
  (await wrap(odd)).close();
  await expect(createProfileBackup("a long backup passphrase", broken.id)).rejects.toThrow("Could not read the Ark wallet");
});

it("a locked profile is backed up or deleted from another one only with its lock password, and new profiles keep the lock", async () => {
  const { registerProfile, createProfile, settingsKeyFor } = await import("../../../src/lib/profiles");
  const { deleteProfile } = await import("../../../src/lib/profileData");
  const { hashPassword } = await import("../../../src/lib/settings");
  const lockScreen = { enabled: true, passwordHash: await hashPassword("hunter2 hunter2"), timeoutMinutes: 5 };
  const locked = registerProfile("lockedprof", "Locked");
  storage.setItem(settingsKeyFor(locked.id), JSON.stringify({ lockScreen }));

  await expect(createProfileBackup("a long backup passphrase", locked.id)).rejects.toThrow("lock password");
  await expect(createProfileBackup("a long backup passphrase", locked.id, "wrong")).rejects.toThrow("lock password");
  expect(await createProfileBackup("a long backup passphrase", locked.id, "hunter2 hunter2")).toContain("ghostly-backup");
  await expect(deleteProfile(locked.id, "wrong")).rejects.toThrow("lock password");
  expect(listProfiles().map((p) => p.id)).toContain(locked.id);
  await deleteProfile(locked.id, "hunter2 hunter2");
  expect(listProfiles().map((p) => p.id)).not.toContain(locked.id);

  // Locking the first profile, then making a new one: the new one is locked the same way.
  storage.setItem(settingsKeyFor(""), JSON.stringify({ lockScreen, language: "pt" }));
  const fresh = createProfile("Fresh");
  expect(JSON.parse(storage.getItem(settingsKeyFor(fresh.id))!).lockScreen).toEqual(lockScreen);
});

it("a wallet parked by the other wallet mode travels in the backup and gets a fresh id too", async () => {
  const { registerProfile } = await import("../../../src/lib/profiles");
  const parkedOwner = registerProfile("parkedprof", "Parked");
  const request = indexedDB.open(`ghostly_${parkedOwner.id}`, 1);
  request.onupgradeneeded = () => { request.result.createObjectStore("settings").put({ config: { walletId: "wallet-parked", network: "mutinynet" } }, "arkWallet-mode-testnet"); };
  (await wrap(request)).close();
  const copy = await restoreProfileBackup(await createProfileBackup("a long backup passphrase", parkedOwner.id), "a long backup passphrase");
  const db = await wrap(indexedDB.open(`ghostly_${copy.id}`));
  try {
    const parked = await wrap(db.transaction("settings").objectStore("settings").get("arkWallet-mode-testnet")) as { config: { walletId: string } };
    expect(parked.config.walletId).not.toBe("wallet-parked");
  } finally { db.close(); }
});
