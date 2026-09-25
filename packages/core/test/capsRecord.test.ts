import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { createLink, type LinkParams } from "../src/invite";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64Url, utf8Encode } from "../src/bytes";
import { decrypt, encrypt } from "../src/crypto";
import { measureRecords, MAX_DNS_PACKET_BYTES, type GhostRecord, type SignedPacket } from "../src/pkarr";
import {
  CAPS_LABEL, CAPS_PUBLISH_SPACING_MS, CAPS_REFRESH_MS, CapsExchange, CapsKeys, CapsRefusedError, capsDescriptors, dialDescriptors, emptyCapsState,
  type CapsContent, type CapsState,
} from "../src/capsRecord";
import type { PairingCredentials } from "../src/pairedSession";
import { relayedTransports } from "../src/pairedTransports";

// covers: chat.caps-record

const IROH = { id: "ab".repeat(32), relay: "https://euw1-1.relay.n0.iroh.iroh.link./", addresses: ["192.0.2.1:4433", "[2001:db8::1]:4433"] };
const HYPER = { publicKey: "cd".repeat(32), host: "192.0.2.7", port: 49737 };

function content(over: Partial<CapsContent> = {}): CapsContent {
  return { versions: [1], transports: ["iroh/1", "hyperdht/1", "webrtc/1"],
    capabilities: ["chat/1", "dht-text/1", "hold/1", "files/2", "payments/1", "payments-cashu/1", "payments-lightning/1"],
    extensions: ["ping/1"], descriptors: capsDescriptors({ "iroh/1": IROH, "hyperdht/1": HYPER }), name: "Ada Lovelace", ...over };
}

/** Both ends of one chat: A's and B's keys, with their participation identities. */
function pair() {
  const link = createLink();
  const a = createIdentity(), b = createIdentity();
  return { link, a, b, aKeys: new CapsKeys(link.mine, a.seedB64), bKeys: new CapsKeys(link.invite, b.seedB64) };
}
const packetOf = (keys: CapsKeys, records: GhostRecord[]): SignedPacket => ({ pubKeyZ32: keys.identity.pubKeyZ32, timestampMicros: 0n, records });

afterEach(() => vi.useRealTimers());

describe("capability record: keys, seal and signature", () => {
  it("each side publishes under its own derived key, which is where the other side reads", () => {
    const { aKeys, bKeys } = pair();
    expect(aKeys.peerAddress).toBe(bKeys.identity.pubKeyZ32);
    expect(bKeys.peerAddress).toBe(aKeys.identity.pubKeyZ32);
    expect(aKeys.identity.pubKeyZ32).not.toBe(bKeys.identity.pubKeyZ32);
  });

  it("round-trips before the pin (invite key) and after it (participation keys)", () => {
    const { a, b, link, aKeys, bKeys } = pair();
    const before = aKeys.seal(content(), 1);
    expect(bKeys.open(packetOf(aKeys, before.records))).toMatchObject({ rev: 1, author: a.pubKeyZ32, name: "Ada Lovelace" });
    const after = aKeys.seal(content(), 2, b.pubKeyZ32);
    expect(bKeys.open(packetOf(aKeys, after.records), { pinned: a.pubKeyZ32 })).toMatchObject({ rev: 2, author: a.pubKeyZ32 });
    // Someone holding only the invite (or a reader that pinned another key) cannot open a post-pin record.
    const outsider = new CapsKeys(pair().link.invite, createIdentity().seedB64);
    expect(() => outsider.open(packetOf(aKeys, after.records))).toThrow(CapsRefusedError);
    const copied = new CapsKeys(link.invite, createIdentity().seedB64);
    expect(() => copied.open(packetOf(aKeys, after.records), { pinned: a.pubKeyZ32 })).toThrow(expect.objectContaining({ reason: "sealed" }));
  });

  it("carries no network address: only the Iroh id and relay, and the HyperDHT key", () => {
    const { aKeys, bKeys } = pair();
    const record = bKeys.open(packetOf(aKeys, aKeys.seal(content(), 1).records));
    expect(JSON.stringify(record)).not.toMatch(/192\.0\.2|2001:db8|49737/);
    expect(dialDescriptors(record.descriptors)).toEqual({ "iroh/1": { id: IROH.id, relay: IROH.relay, addresses: [], relayed: true }, "hyperdht/1": { publicKey: HYPER.publicKey } });
  });

  it("keeps the relay a browser's Iroh or HyperDHT is reached through, and refuses a relay that is not a URL", () => {
    const { aKeys, bKeys } = pair();
    // A browser's endpoints as #225 and #231 describe them: relay only.
    const browser = capsDescriptors({ "iroh/1": { id: IROH.id, relay: "https://relay.example/", addresses: [], relayed: true }, "hyperdht/1": { publicKey: HYPER.publicKey, relayed: true, relay: "wss://hyper.example/relay" } });
    const record = bKeys.open(packetOf(aKeys, aKeys.seal(content({ descriptors: browser }), 1).records));
    const dial = dialDescriptors(record.descriptors);
    expect(dial).toEqual({ "iroh/1": { id: IROH.id, relay: "https://relay.example/", addresses: [], relayed: true }, "hyperdht/1": { publicKey: HYPER.publicKey, relay: "wss://hyper.example/relay", relayed: true } });
    // Ranked as relayed: after direct paths, before the DHT floor.
    expect(relayedTransports({}, dial)).toEqual(["iroh/1", "hyperdht/1"]);
    expect(capsDescriptors({ "hyperdht/1": { publicKey: HYPER.publicKey, relay: "javascript:alert(1)" } })).toEqual({ "hyperdht/1": { publicKey: expect.any(String) } });
  });

  it("fits 1,000 bytes; past it drops the name, then the extensions, and fails rather than cut capabilities", () => {
    const { aKeys } = pair();
    const full = aKeys.seal(content({ name: "n".repeat(64) }), 1, createIdentity().pubKeyZ32);
    expect(measureRecords(aKeys.identity.pubKeyZ32, full.records)).toBeLessThanOrEqual(MAX_DNS_PACKET_BYTES);
    expect(full.dropped).toEqual([]);
    const many = (n: number) => Array.from({ length: n }, (_, i) => `capability-${i}/1`);
    const seal = (n: number) => aKeys.seal(content({ name: "n".repeat(64), capabilities: many(n), extensions: many(3) }), 1);
    let n = 1;
    while (!seal(n).dropped.length) n++;
    expect(seal(n).dropped, "the name goes first").toEqual(["name"]);
    while (seal(n).dropped.length < 2) n++;
    expect(seal(n).dropped, "then the extensions").toEqual(["name", "extensions"]);
    expect(seal(n).records[0].value.length).toBeGreaterThan(0);
    expect(() => aKeys.seal(content({ capabilities: many(32) }), 1)).toThrow(expect.objectContaining({ reason: "size" }));
  });

  it("refuses a record under the wrong key, over budget, or malformed", () => {
    const { link, aKeys, bKeys } = pair();
    const { records } = aKeys.seal(content(), 1);
    expect(() => bKeys.open({ ...packetOf(aKeys, records), pubKeyZ32: createIdentity().pubKeyZ32 })).toThrow(expect.objectContaining({ reason: "address" }));
    expect(() => bKeys.open(packetOf(aKeys, [...records, { label: "_pad", value: "x".repeat(900) }]))).toThrow(expect.objectContaining({ reason: "size" }));
    const small = aKeys.seal(content({ name: "", descriptors: {}, capabilities: ["chat/1"] }), 1).records;
    expect(() => bKeys.open(packetOf(aKeys, [...small, small[0]]))).toThrow(expect.objectContaining({ reason: "format" }));
    expect(() => bKeys.open(packetOf(aKeys, [{ label: CAPS_LABEL, value: encrypt("{", inviteKeyOf(link.mine)) }]))).toThrow(expect.objectContaining({ reason: "format" }));
  });

  it("refuses a forgery: another key under the chat's address, a tampered body, a signature for the other direction", () => {
    const { a, link, aKeys, bKeys } = pair();
    // Someone else holding the invite signs with its own participation key: fine before the pin (the first
    // contact pins it), a security refusal once A is pinned.
    const mallory = new CapsKeys(link.mine, createIdentity().seedB64);
    const forged = packetOf(aKeys, mallory.seal(content(), 9).records);
    expect(bKeys.open(forged).author).not.toBe(a.pubKeyZ32);
    expect(() => bKeys.open(forged, { pinned: a.pubKeyZ32 })).toThrow(expect.objectContaining({ reason: "author" }));
    expect(() => bKeys.open(forged, { expected: a.pubKeyZ32 })).toThrow(expect.objectContaining({ reason: "author" }));
    // A's own record, re-sealed with a changed body: the signature no longer verifies.
    const genuine = JSON.parse(decryptInvite(link.mine, aKeys.seal(content(), 1).records[0].value));
    genuine[0][9] = "Mallory";
    expect(() => bKeys.open(packetOf(aKeys, [{ label: CAPS_LABEL, value: encrypt(JSON.stringify(genuine), inviteKeyOf(link.mine)) }])))
      .toThrow(expect.objectContaining({ reason: "signature" }));
    // B's record (signed B→A) replayed under A's address does not verify as A→B.
    const reflected = JSON.parse(decryptInvite(link.invite, bKeys.seal(content(), 1).records[0].value));
    expect(() => bKeys.open(packetOf(aKeys, [{ label: CAPS_LABEL, value: encrypt(JSON.stringify(reflected), inviteKeyOf(link.mine)) }])))
      .toThrow(expect.objectContaining({ reason: expect.stringMatching(/signature|author/) }));
  });

  it("refuses a record from the future and one whose rev goes backwards", () => {
    const { aKeys, bKeys } = pair();
    const future = aKeys.seal(content(), 3, undefined, Date.now() + 120_000);
    expect(() => bKeys.open(packetOf(aKeys, future.records))).toThrow(expect.objectContaining({ reason: "future" }));
    const old = aKeys.seal(content(), 3);
    expect(() => bKeys.open(packetOf(aKeys, old.records), { minRev: 4 })).toThrow(expect.objectContaining({ reason: "rev" }));
    expect(bKeys.open(packetOf(aKeys, old.records), { minRev: 3 }).rev).toBe(3);
  });

  it("carries the chat's choice as a trailing element, and none on Automatic (WISP 100, a choice made while not live)", () => {
    const { link, aKeys, bKeys } = pair();
    const chosen = aKeys.seal(content({ choice: "iroh/1" }), 1).records;
    expect(bKeys.open(packetOf(aKeys, chosen)).choice).toBe("iroh/1");
    // The body grows by one element, which a reader from before (10 to 16 elements, the rest ignored) still opens.
    const body = JSON.parse(decryptInvite(link.mine, chosen[0].value))[0];
    expect(body).toHaveLength(11);
    expect(body[10]).toBe("iroh/1");
    // Automatic: the record is the one it was before the element existed.
    const automatic = aKeys.seal(content(), 2).records;
    expect(JSON.parse(decryptInvite(link.mine, automatic[0].value))[0]).toHaveLength(10);
    expect(bKeys.open(packetOf(aKeys, automatic))).not.toHaveProperty("choice");
  });

  it("refuses out-of-bounds fields and the DHT listed as a transport", () => {
    const { aKeys, bKeys } = pair();
    const bad: Partial<CapsContent>[] = [
      { transports: ["dht/1"] }, { versions: [0] }, { capabilities: ["Not An Id"] }, { name: "é".repeat(33) },
      { versions: Array(9).fill(1) }, { descriptors: { "iroh/1": { id: "short" } } }, { choice: "dht/1" }, { choice: "Not An Id" },
    ];
    for (const over of bad)
      expect(() => bKeys.open(packetOf(aKeys, aKeys.seal(content({ ...over, extensions: [] }), 1).records)), JSON.stringify(over))
        .toThrow(expect.objectContaining({ reason: "format" }));
  });
});

describe("capability record: publishing and reading", () => {
  function exchange() {
    const packets = new Map<string, SignedPacket>();
    const transport = {
      publish: vi.fn(async (identity: { pubKeyZ32: string }, records: GhostRecord[]) => { packets.set(identity.pubKeyZ32, { pubKeyZ32: identity.pubKeyZ32, timestampMicros: 0n, records }); }),
      resolve: vi.fn(async (key: string) => packets.get(key) ?? null),
      describe: () => ({ protocol: "memory", relays: [] }),
    };
    return { packets, transport };
  }

  it("publishes at first start, again only when the content changes, when pinned, or an hour later", async () => {
    vi.useFakeTimers();
    const { link } = pair(), { transport } = exchange();
    let name = "Ada";
    const credentials: PairingCredentials = { seedB64: createIdentity().seedB64 };
    let saved: CapsState = emptyCapsState();
    const caps = new CapsExchange({ params: link.mine, credentials, transport, local: () => content({ name }), save: async s => { saved = s; } });
    caps.start(); await vi.advanceTimersByTimeAsync(0);
    expect(transport.publish).toHaveBeenCalledTimes(1);
    expect(saved.rev).toBe(1);
    await caps.update();
    expect(transport.publish, "nothing changed").toHaveBeenCalledTimes(1);
    name = "Ada L."; await caps.update();
    expect(transport.publish, "a change right after a publication waits for the spacing").toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CAPS_PUBLISH_SPACING_MS);
    expect(transport.publish).toHaveBeenCalledTimes(2);
    expect(saved.rev).toBe(2);
    credentials.peerKey = createIdentity().pubKeyZ32; await caps.update();
    expect(transport.publish, "sealed anew for the pinned contact").toHaveBeenCalledTimes(3);
    expect(saved.rev, "the same content keeps its revision").toBe(2);
    await vi.advanceTimersByTimeAsync(CAPS_REFRESH_MS + 1_000);
    expect(transport.publish, "hourly").toHaveBeenCalledTimes(4);
    expect((transport.publish.mock.lastCall as unknown[])[2]).toEqual({ background: true });
    await caps.stop();
    // An app start within the hour, with the same content: nothing goes out.
    const again = new CapsExchange({ params: link.mine, credentials, transport, local: () => content({ name }), state: saved, save: async s => { saved = s; } });
    again.start(); await vi.advanceTimersByTimeAsync(0);
    expect(transport.publish).toHaveBeenCalledTimes(4);
    await again.stop();
  });

  it("says when a new revision went out (an envelope names it), not when the same content is sealed again", async () => {
    vi.useFakeTimers();
    const { link } = pair(), { transport } = exchange();
    let name = "Ada";
    const credentials: PairingCredentials = { seedB64: createIdentity().seedB64 };
    const published: number[] = [];
    const caps = new CapsExchange({ params: link.mine, credentials, transport, local: () => content({ name }), save: async () => {}, published: rev => published.push(rev) });
    caps.start(); await vi.advanceTimersByTimeAsync(0);
    expect(published).toEqual([1]);
    name = "Ada L."; await caps.update(); await vi.advanceTimersByTimeAsync(CAPS_PUBLISH_SPACING_MS);
    expect(published).toEqual([1, 2]);
    credentials.peerKey = createIdentity().pubKeyZ32; await caps.update();
    await vi.advanceTimersByTimeAsync(CAPS_REFRESH_MS + 1_000);
    expect(transport.publish, "sealed for the pin, then hourly").toHaveBeenCalledTimes(4);
    expect(published, "the same revision: nothing new to announce").toEqual([1, 2]);
    await caps.stop();
  });

  it("reads the contact's record at pairing and on a newer revision, keeps the last good one, reports a forged one", async () => {
    vi.useFakeTimers();
    const { link, a, b } = pair(), { transport } = exchange();
    const aCreds: PairingCredentials = { seedB64: a.seedB64, peerKey: b.pubKeyZ32 }, bCreds: PairingCredentials = { seedB64: b.seedB64, peerKey: a.pubKeyZ32 };
    let aName = "Ada";
    const aSide = new CapsExchange({ params: link.mine, credentials: aCreds, transport, local: () => content({ name: aName }), save: async () => {} });
    const changed = vi.fn(), refused = vi.fn();
    const bSide = new CapsExchange({ params: link.invite, credentials: bCreds, transport, local: () => content({ name: "Bob" }), save: async () => {}, changed, refused });
    aSide.start(); await vi.advanceTimersByTimeAsync(0);
    bSide.start(); await vi.advanceTimersByTimeAsync(0);
    expect(bSide.peer).toMatchObject({ rev: 1, name: "Ada", author: a.pubKeyZ32 });
    expect(changed).toHaveBeenCalledTimes(1);
    const reads = transport.resolve.mock.calls.length;
    bSide.peerRev(1); await vi.advanceTimersByTimeAsync(0);
    expect(transport.resolve.mock.calls.length, "the known revision is not read again").toBe(reads);
    aName = "Ada L."; await aSide.update();
    await vi.advanceTimersByTimeAsync(CAPS_PUBLISH_SPACING_MS);
    bSide.peerRev(2); await vi.advanceTimersByTimeAsync(0);
    expect(bSide.peer).toMatchObject({ rev: 2, name: "Ada L." });
    // A copied invite publishes a record under A's address, signed by another key: refused, the last good one stays.
    const mallory = new CapsKeys(link.mine, createIdentity().seedB64);
    await transport.publish(mallory.identity, mallory.seal(content({ name: "Mallory" }), 50).records);
    bSide.peerRev(50); await vi.advanceTimersByTimeAsync(0);
    expect(bSide.peer).toMatchObject({ rev: 2, name: "Ada L." });
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ reason: "author" }));
    await aSide.stop(); await bSide.stop();
  });

  it("merges reads asked for close together", async () => {
    vi.useFakeTimers();
    const { link, a, b } = pair(), { transport } = exchange();
    const side = new CapsExchange({ params: link.invite, credentials: { seedB64: b.seedB64, peerKey: a.pubKeyZ32 }, transport, local: () => content(), save: async () => {} });
    side.start(); await vi.advanceTimersByTimeAsync(0);
    const reads = transport.resolve.mock.calls.length;
    side.refresh(); side.refresh(); side.refresh();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(transport.resolve.mock.calls.length - reads).toBe(1);
    await side.stop();
  });
});

/** The invite-derived key both sides of a link derive the same way. */
function inviteKeyOf(params: LinkParams): Uint8Array {
  const from = identityFromSeedB64(params.seedB64).pubKeyZ32;
  const context = JSON.stringify(["ghostly-caps/1", [from, params.peerPubKeyZ32].sort()]);
  return hkdf(sha256, fromBase64Url(params.encKeyB64), utf8Encode(context), utf8Encode("envelope"), 32);
}
const decryptInvite = (params: LinkParams, value: string) => decrypt(value, inviteKeyOf(params));
