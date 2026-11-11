import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FedimintWallet, fedimintTiming } from "../src/engine/paymentAdapters/fedimintWallet";
import { STORES, openDb, store, transact, wrap } from "../src/shared/idb";
import { dropDataKey, setDataKey } from "../src/engine/dataKey";
import { isSealedField } from "../src/shared/profileKey";
import { FakeFedimintSdk, type FakeFederation } from "./helpers/fakeFedimint";
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

  it("under the profile's data key, is version 2 with no device key, and the federation opens again", async () => {
    setDataKey(await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
    const w = await wallet();
    await w.join(federation.invite);
    await w.stop();
    const [{ mnemonic }] = [...fake.databases.values()];
    const saved = await record();
    expect(isSealedField(saved.seed)).toBe(true);
    expect(saved).not.toHaveProperty("deviceKey");
    expect(JSON.stringify(saved)).not.toContain(mnemonic);
    const again = await wallet();
    await again.ensureReady();
    expect(again.view.federations.map((f) => f.status)).toEqual(["ready"]);
    expect((await again.backup()).mnemonic).toBe(mnemonic);
    await again.stop();
  });
});
