import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FedimintWallet, fedimintTiming } from "../src/engine/paymentAdapters/fedimintWallet";
import { STORES, openDb, store, transact, wrap } from "../src/shared/idb";
import { dropDataKey, setDataKey } from "../src/engine/dataKey";
import { newDeviceKey, sealSeed } from "../src/engine/paymentAdapters/persistence";
import { decryptProfile, encryptProfile } from "../src/engine/profileEncryption";
import { isSealedField, type ProfileKeyRecord } from "../src/shared/profileKey";
import { FakeFedimintSdk, type FakeFederation } from "./helpers/fakeFedimint";
import { TEST_PHRASE } from "./helpers/phraseLeaks";
// covers: wallet.fedimint.join, wallet.fedimint.backup

/** The Fedimint wallet's mnemonic and the profile's data key slot (WISP 04, Encrypted profile). */
fedimintTiming.pollMs = 20;
let fake: FakeFedimintSdk;
let federation: FakeFederation;

async function wallet() {
  const w = new FedimintWallet("testnet", { changed: vi.fn(), received: vi.fn() }, fake.sdk());
  await w.start();
  return w;
}
const record = async () => wrap<Record<string, unknown>>((await store(STORES.settings, "readonly")).get("fedimintWallet-testnet"));

beforeEach(async () => {
  fake = new FakeFedimintSdk();
  federation = fake.federation({ name: "Regtest federation" });
  await openDb();
  await transact([STORES.settings], (s) => { s[STORES.settings].clear(); });
});
afterEach(() => { dropDataKey(); });

describe("the Fedimint wallet's mnemonic", () => {
  it("with the slot empty, is version 1 beside a device key, as before", async () => {
    const w = await wallet();
    await w.join(federation.invite);
    await w.stop();
    const saved = await record();
    expect(saved.seed).toMatchObject({ version: 1 });
    expect(typeof saved.deviceKey).toBe("string");
  });

  it("is not made while the profile is encrypted: joining and restoring are refused before anything is written (WISP 04)", async () => {
    setDataKey(await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
    const w = await wallet();
    await expect(w.join(federation.invite)).rejects.toThrow("Fedimint does not work on an encrypted profile");
    await expect(w.restorePhrase(TEST_PHRASE, [federation.invite])).rejects.toThrow("Fedimint does not work on an encrypted profile");
    expect(await record()).toBeUndefined();
    expect(fake.databases.size).toBe(0);
  });

  it("a mnemonic sealed by turning encryption on opens through the wallet, and again once it is turned off", async () => {
    const deviceKey = newDeviceKey(), seed = await sealSeed(TEST_PHRASE, deviceKey);
    await transact([STORES.settings], (s) => { s[STORES.settings].put({ seed, deviceKey, federations: [] }, "fedimintWallet-testnet"); });
    let saved: ProfileKeyRecord | null = null;
    const home = { read: async () => saved, write: async (r: ProfileKeyRecord) => { saved = r; }, remove: async () => { saved = null; } };
    await encryptProfile(home, "throwaway passphrase 1", "");
    expect(isSealedField((await record()).seed)).toBe(true);
    expect(await record()).not.toHaveProperty("deviceKey");
    expect((await (await wallet()).backup()).mnemonic).toBe(TEST_PHRASE);
    await decryptProfile(home, "throwaway passphrase 1", "");
    expect(typeof (await record()).deviceKey).toBe("string");
    expect((await (await wallet()).backup()).mnemonic).toBe(TEST_PHRASE);
  });
});
