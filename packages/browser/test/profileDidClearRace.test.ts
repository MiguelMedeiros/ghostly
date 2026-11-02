import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import { openDidDhtPayload } from "@ghostly/core";
import { STORES, clearProfileStores, store, transact, wrap } from "../src/shared/idb";
import { ProfileDid } from "../src/engine/did";
// covers: did.dht.profile, app.clear-data

// The seed is sealed with a 600k-iteration PBKDF2 key; a cheap reversible seal keeps this test fast.
vi.mock("../src/engine/paymentAdapters/persistence", async importOriginal => {
  const real = await importOriginal<typeof import("../src/engine/paymentAdapters/persistence")>();
  const mix = (bytes: Uint8Array, password: string) => bytes.map((b, i) => b ^ password.charCodeAt(i % password.length));
  return {
    ...real,
    sealSeed: async (seed: string, password: string) => ({ version: 1, salt: [], iv: [], ciphertext: [...mix(new TextEncoder().encode(seed), password)] }),
    unsealSeed: async (sealed: { ciphertext: number[] }, password: string) => new TextDecoder().decode(mix(new Uint8Array(sealed.ciphertext), password)),
  };
});

const stored = async () => wrap<Record<string, unknown> | undefined>((await store(STORES.settings, "readonly")).get("profileDid"));

beforeEach(async () => {
  await transact([STORES.settings], stores => { stores[STORES.settings].delete("profileDid"); });
});

/**
 * "Clear all data" while a publish of the DID is still on its way (a background put waits for the relays' budget or a
 * slow relay): the clear ends the DID and deletes its record, and the late publish must not write it back. Before, its
 * save put the old key and document back, so the profile after the clear had the DID that was just deactivated.
 */
it("a publish still on its way when the data is cleared writes nothing back", async () => {
  const puts: Uint8Array[] = [];
  let release: (() => void) | undefined;
  let held = 0;
  const did = new ProfileDid({
    online: () => true,
    emit: () => {},
    listable: () => new Map([["domain-1", "https://example.com"]]),
    proofIds: () => ["domain-1"],
    publish: async (_key, payload) => {
      // The first publish goes; the second (the hourly one, a changed document) is held until the clear is over.
      if (puts.length === 1 && held++ === 0) await new Promise<void>(resolve => { release = resolve; });
      puts.push(payload);
    },
  });
  await did.load();
  await did.publishNow();
  await did.setListed({ id: "domain-1", listed: true });

  const late = did.publishNow();
  await vi.waitFor(() => expect(release).toBeDefined());
  await did.deactivate();
  await clearProfileStores();
  release!();
  await late;
  await new Promise(resolve => setTimeout(resolve, 20));

  expect(await stored(), "the cleared DID stays gone").toBeUndefined();
  // And the deactivated packet is the newest of the key.
  const seqs = puts.map(p => ({ seq: openDidDhtPayload(did.id, p).seq, deactivated: openDidDhtPayload(did.id, p).deactivated }));
  const ended = seqs.find(s => s.deactivated)!;
  expect(seqs.filter(s => !s.deactivated).every(s => s.seq < ended.seq)).toBe(true);
});

it("a first publish still on its way when the data is cleared is ended too", async () => {
  const puts: Uint8Array[] = [];
  let release: (() => void) | undefined;
  const did = new ProfileDid({
    online: () => true,
    emit: () => {},
    listable: () => new Map(),
    proofIds: () => [],
    publish: async (_key, payload) => {
      if (!release) await new Promise<void>(resolve => { release = resolve; });
      puts.push(payload);
    },
  });
  await did.load();
  const late = did.publishNow();
  await vi.waitFor(() => expect(release).toBeDefined());
  await did.deactivate();
  await clearProfileStores();
  release!();
  await late;

  expect(await stored()).toBeUndefined();
  const opened = puts.map(p => openDidDhtPayload(did.id, p));
  expect(opened.map(p => !!p.deactivated).sort()).toEqual([false, true]);
  expect(opened.find(p => p.deactivated)!.seq > opened.find(p => !p.deactivated)!.seq).toBe(true);
});

it("an identity change after the clear writes nothing back", async () => {
  let proofs = ["domain-1"];
  const did = new ProfileDid({
    online: () => true,
    emit: () => {},
    listable: () => new Map([["domain-1", "https://example.com"]]),
    proofIds: () => proofs,
    publish: async () => {},
  });
  await did.load();
  await did.setListed({ id: "domain-1", listed: true });
  await did.deactivate();
  await clearProfileStores();
  // A late emit of the identities (their proof gone) takes the listed one out of the DID: no save of the old record.
  proofs = [];
  did.changed();
  await new Promise(resolve => setTimeout(resolve, 20));

  expect(await stored()).toBeUndefined();
});
