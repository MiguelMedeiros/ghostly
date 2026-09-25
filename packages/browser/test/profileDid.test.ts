import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { didDhtDocument, didDhtKey, openDidDhtPayload, toBase64Url } from "@ghostly/core";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import { DID_REPUBLISH_MS, ProfileDid, type ProfileDidHost } from "../src/engine/did";
// covers: did.dht.profile, did.dht.public-links

// The seed is sealed with a 600k-iteration PBKDF2 key; a cheap reversible seal keeps these tests fast.
vi.mock("../src/engine/paymentAdapters/persistence", async importOriginal => {
  const real = await importOriginal<typeof import("../src/engine/paymentAdapters/persistence")>();
  const mix = (bytes: Uint8Array, password: string) => bytes.map((b, i) => b ^ password.charCodeAt(i % password.length));
  return {
    ...real,
    sealSeed: async (seed: string, password: string) => ({ version: 1, salt: [], iv: [], ciphertext: [...mix(new TextEncoder().encode(seed), password)] }),
    unsealSeed: async (sealed: { ciphertext: number[] }, password: string) => new TextDecoder().decode(mix(new Uint8Array(sealed.ciphertext), password)),
  };
});

/** A profile with identities (id → URI when listable) and a Pkarr that records every put. */
function world() {
  const state = {
    online: true,
    fail: null as Error | null,
    identities: new Map<string, string | null>([["nostr-1", "nostr:npub1abc"], ["domain-1", "https://example.com"], ["ssh-1", null]]),
    puts: [] as { key: string; payload: Uint8Array }[],
    emits: 0,
  };
  const host: ProfileDidHost = {
    online: () => state.online,
    emit: () => { state.emits++; },
    listable: () => new Map([...state.identities].filter((e): e is [string, string] => !!e[1])),
    proofIds: () => [...state.identities.keys()],
    publish: async (key, payload) => {
      if (state.fail) throw state.fail;
      state.puts.push({ key, payload });
    },
  };
  return { state, make: () => new ProfileDid(host) };
}

const stored = async () => wrap<Record<string, unknown> | undefined>((await store(STORES.settings, "readonly")).get("profileDid"));
const opened = (did: ProfileDid, payload: Uint8Array) => openDidDhtPayload(did.id, payload);

beforeEach(async () => {
  await transact([STORES.settings], stores => { stores[STORES.settings].delete("profileDid"); });
});
afterEach(() => { vi.useRealTimers(); });

describe("the profile's did:dht", () => {
  it("has a key of its own, made once and kept sealed", async () => {
    const { make } = world();
    const did = make();
    await did.load();
    expect(did.id).toMatch(/^did:dht:[a-z0-9]{52}$/);
    expect(() => didDhtKey(did.id)).not.toThrow();

    const again = make();
    await again.load();
    expect(again.id).toBe(did.id);
    const record = await stored();
    expect(record).toMatchObject({ listed: [], seed: { sealed: { version: 1 } } });
    expect(JSON.stringify(record)).not.toContain("seedB64");
  });

  it("publishes the identity key alone by default: no service, no alsoKnownAs", async () => {
    const { make, state } = world();
    const did = make();
    await did.load();
    await did.publishNow();
    expect(state.puts).toHaveLength(1);
    expect(state.puts[0].key).toBe(didDhtKey(did.id).z32);
    const { document, seq } = opened(did, state.puts[0].payload);
    expect(document).toEqual(didDhtDocument(didDhtKey(did.id).publicKey));
    // did:dht sequence numbers are seconds.
    expect(Math.abs(Number(seq) - Date.now() / 1000)).toBeLessThan(5);
    expect(did.view()).toMatchObject({ id: did.id, listed: [], alsoKnownAs: [], upToDate: true, published: { versionId: String(seq) } });
  });

  it("puts the same signed packet again while the document is unchanged, across a restart too", async () => {
    const { make, state } = world();
    const did = make();
    await did.load();
    await did.publishNow();
    await did.publishNow();
    const restarted = make();
    await restarted.load();
    await restarted.publishNow();
    expect(state.puts).toHaveLength(3);
    expect(toBase64Url(state.puts[1].payload)).toBe(toBase64Url(state.puts[0].payload));
    expect(toBase64Url(state.puts[2].payload)).toBe(toBase64Url(state.puts[0].payload));
  });

  it("lists only the identities the person chooses, in order, and takes them out again", async () => {
    const { make, state } = world();
    const did = make();
    await did.load();
    await did.publishNow();
    await did.setListed({ id: "domain-1", listed: true });
    await did.setListed({ id: "nostr-1", listed: true });
    await did.publishNow();
    const listed = opened(did, state.puts.at(-1)!.payload);
    expect(listed.document.alsoKnownAs).toEqual(["https://example.com", "nostr:npub1abc"]);
    expect(listed.seq).toBeGreaterThan(opened(did, state.puts[0].payload).seq);
    expect(did.view()).toMatchObject({ listed: ["domain-1", "nostr-1"], alsoKnownAs: ["https://example.com", "nostr:npub1abc"], upToDate: true });

    await did.setListed({ id: "domain-1", listed: false });
    expect(did.view()?.upToDate).toBe(false);
    await did.publishNow();
    expect(opened(did, state.puts.at(-1)!.payload).document.alsoKnownAs).toEqual(["nostr:npub1abc"]);
  });

  it("refuses an identity it cannot list, and one more than the packet holds", async () => {
    const { make, state } = world();
    const did = make();
    await did.load();
    await expect(did.setListed({ id: "ssh-1", listed: true })).rejects.toThrow("cannot be listed");
    await expect(did.setListed({ id: "nope", listed: true })).rejects.toThrow("cannot be listed");
    for (let i = 0; i < 30; i++) state.identities.set(`domain-${i}`, `https://identity-number-${i}.example.com`);
    let refused: Error | undefined;
    for (let i = 0; i < 30 && !refused; i++) await did.setListed({ id: `domain-${i}`, listed: true }).catch((e: Error) => { refused = e; });
    expect(refused?.message).toMatch(/no room for another identity/);
    expect(did.view()!.listed.length).toBeGreaterThan(10);
  });

  it("drops an identity that was removed, and leaves out one that expired", async () => {
    const { make, state } = world();
    const did = make();
    await did.load();
    await did.setListed({ id: "domain-1", listed: true });
    await did.setListed({ id: "nostr-1", listed: true });
    await did.publishNow();

    // Expired (no longer listable): still chosen, not in the document.
    state.identities.set("nostr-1", null);
    expect(did.view()).toMatchObject({ listed: ["domain-1", "nostr-1"], alsoKnownAs: ["https://example.com"], upToDate: false });
    // Removed from the profile: forgotten.
    state.identities.delete("domain-1");
    did.changed();
    await vi.waitFor(async () => expect((await stored())?.listed).toEqual(["nostr-1"]));
    await did.publishNow();
    expect(opened(did, state.puts.at(-1)!.payload).document.alsoKnownAs).toBeUndefined();
  });

  it("publishes nothing offline, and says why a publish failed", async () => {
    const { make, state } = world();
    const did = make();
    await did.load();
    state.online = false;
    await did.publishNow();
    expect(state.puts).toHaveLength(0);
    expect(did.view()?.published).toBeUndefined();

    state.online = true;
    state.fail = new Error("Publish failed on every relay");
    await did.publishNow();
    expect(did.view()).toMatchObject({ error: "Publish failed on every relay", upToDate: false });
    state.fail = null;
    await did.publishNow();
    expect(did.view()?.error).toBeUndefined();
  });

  it("publishes soon after start, again every hour, and shortly after a change", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { make, state } = world();
    const did = make();
    await did.load();
    did.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.puts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DID_REPUBLISH_MS);
    expect(state.puts).toHaveLength(2);
    await did.setListed({ id: "domain-1", listed: true });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(state.puts).toHaveLength(3);
    expect(opened(did, state.puts[2].payload).document.alsoKnownAs).toEqual(["https://example.com"]);
    did.stop();
    await vi.advanceTimersByTimeAsync(2 * DID_REPUBLISH_MS);
    expect(state.puts).toHaveLength(3);
  });

  it("tries a failed publish again after a few minutes, not an hour", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { make, state } = world();
    state.fail = new Error("offline");
    const did = make();
    await did.load();
    did.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(did.view()?.error).toBe("offline");
    state.fail = null;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(state.puts).toHaveLength(1);
    did.stop();
  });
});
