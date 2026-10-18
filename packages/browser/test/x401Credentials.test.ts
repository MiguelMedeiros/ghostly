import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { fromBase64Url, newX401HolderKey } from "@ghostly/core";
import { p256 } from "@noble/curves/nist.js";
import { issueSdJwtVc } from "../../core/test/support/sdJwtIssuer";
import { snapshotDatabase } from "../src/backup/database";
import { unsealSeed, type EncryptedSeed } from "../src/engine/paymentAdapters/persistence";
import { X401Credentials, X401_KEY } from "../src/engine/x401";
import { PROFILE_SETTINGS_KEYS, STORES, clearProfileStores, databaseName, store, wrap } from "../src/shared/idb";

/*
 * x401 credentials, engine side (WISP 3xx § Credentials kept per profile): holder keys sealed in the settings store,
 * credentials kept with the key they are bound to, carried by a backup and gone with "Clear all data".
 */

interface Kept { id: string; jwk: Record<string, string>; secret: { sealed: EncryptedSeed; deviceKey: string } }
const record = async () => wrap<{ keys: Kept[]; credentials: { label: string; holderKey: Kept }[] } | undefined>((await store(STORES.settings, "readonly")).get(X401_KEY));

beforeEach(async () => { await clearProfileStores(); });

describe("x401 credentials in the profile", { timeout: 60_000 }, () => {
  it("keeps a holder key sealed: only its public JWK is in the clear, and the sealed secret is that key's", async () => {
    const x401 = new X401Credentials();
    const { id, jwk } = await x401.newKey();
    const [kept] = (await record())!.keys;
    expect(kept.id).toBe(id);
    expect(kept.jwk).toEqual(jwk);
    expect(kept.jwk).not.toHaveProperty("d");
    expect(kept.secret.sealed.ciphertext.length).toBeGreaterThan(32);
    const secret = fromBase64Url(await unsealSeed(kept.secret.sealed, kept.secret.deviceKey));
    expect(p256.getPublicKey(secret, false).slice(1, 33)).toEqual(fromBase64Url(jwk.x));
  });

  it("keeps at most 8 keys that wait for an issuer, the newest", async () => {
    const x401 = new X401Credentials();
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push((await x401.newKey()).id);
    expect((await record())!.keys.map((k) => k.id)).toEqual(ids.slice(1));
  });

  it("moves the key into the credential bound to it, and keeps two credentials added at once", async () => {
    const x401 = new X401Credentials();
    const a = await x401.newKey(), b = await x401.newKey();
    await Promise.all([x401.add({ credential: issueSdJwtVc({ holder: a.jwk }), label: "a" }), x401.add({ credential: issueSdJwtVc({ holder: b.jwk }), label: "b" })]);
    const stored = (await record())!;
    expect(stored.keys).toEqual([]);
    expect(stored.credentials.map((c) => [c.label, c.holderKey.id]).sort()).toEqual([["a", a.id], ["b", b.id]]);
    await expect(x401.add({ credential: issueSdJwtVc({ holder: newX401HolderKey().jwk }) })).rejects.toThrow(/x401 key new/);
  });

  it("a credential on a key this profile made, but that waits no more, is refused with what became of the key", async () => {
    const x401 = new X401Credentials();
    // A second credential on a key that already holds one.
    const used = await x401.newKey();
    const first = await x401.add({ credential: issueSdJwtVc({ holder: used.jwk }), label: "Bank" });
    await expect(x401.add({ credential: issueSdJwtVc({ holder: used.jwk, payload: { vct: "https://example.com/other" } }) }))
      .rejects.toThrow(`This credential's key already holds credential ${first.id} (Bank): a key takes one credential`);
    // A key pushed out by 8 newer ones: `key new` says it went.
    const waiting = await x401.newKey();
    const made: { id: string; dropped?: string }[] = [];
    for (let i = 0; i < 8; i++) made.push(await x401.newKey());
    expect(made.map((k) => k.dropped)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined, waiting.id]);
    await expect(x401.add({ credential: issueSdJwtVc({ holder: waiting.jwk }) })).rejects.toThrow("This credential's key was dropped: a profile keeps the 8 newest keys waiting for a credential");
    // A key that went with its credential.
    expect(await x401.remove({ id: first.id })).toBe(true);
    await expect(x401.add({ credential: issueSdJwtVc({ holder: used.jwk }) })).rejects.toThrow(`This credential's key went with credential ${first.id} when it was removed`);
    // Each says where a key that works comes from; one never made here says so as before.
    await expect(x401.add({ credential: issueSdJwtVc({ holder: used.jwk }) })).rejects.toThrow(/x401 key new$/);
    await expect(x401.add({ credential: issueSdJwtVc({ holder: newX401HolderKey().jwk }) })).rejects.toThrow(/did not make/);
  });

  it("keeps a credential that is not valid yet, and lists when it becomes valid", async () => {
    const x401 = new X401Credentials();
    const soon = await x401.newKey(), now = await x401.newKey();
    const added = await x401.add({ credential: issueSdJwtVc({ holder: soon.jwk, payload: { nbf: 4_000_000_000 } }) });
    expect(added.notBefore).toBe(4_000_000_000_000);
    await x401.add({ credential: issueSdJwtVc({ holder: now.jwk }) });
    expect((await x401.list()).map((c) => c.notBefore)).toEqual([4_000_000_000_000, null]);
  });

  it("goes into a backup, and \"Clear all data\" takes it", async () => {
    const x401 = new X401Credentials();
    const { jwk } = await x401.newKey();
    await x401.add({ credential: issueSdJwtVc({ holder: jwk }) });
    const settings = (await snapshotDatabase(databaseName(), ["fileChunks"]))!.stores.find((s) => s.name === STORES.settings)!;
    expect((settings.values[settings.keys.indexOf(X401_KEY)] as { credentials: unknown[] }).credentials).toHaveLength(1);
    expect(PROFILE_SETTINGS_KEYS).toContain(X401_KEY);
    await clearProfileStores();
    expect(await record()).toBeUndefined();
    expect(await x401.list()).toEqual([]);
  });
});
