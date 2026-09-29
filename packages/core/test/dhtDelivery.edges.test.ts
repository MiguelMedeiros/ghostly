import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64Url, randomBytes, toBase64Url, utf8Encode } from "../src/bytes";
import { decrypt, encrypt } from "../src/crypto";
import { createIdentity, identityFromSeed, identityFromSeedB64, publicKeyFromZ32, sign } from "../src/identity";
import { createLink } from "../src/invite";
import { DhtDelivery, DHT_MESSAGE_TTL, DHT_TEXT_REFUSED, LEAVING_DHT_FAST_MS, LIVE_POLL_MS, emptyDhtDeliveryState, type DhtDeliveryState, type DhtDeliveryView } from "../src/dhtDelivery";
import type { PairingCredentials } from "../src/pairedSession";
import type { GhostRecord, SignedPacket } from "../src/pkarr";
import { DiscoveryBudgetError } from "../src/transport";

// covers: chat.dht.delivery, chat.dht.send, chat.dht.errors

const ID = "abcdefghijklmnopqrstuv", ID2 = "bcdefghijklmnopqrstuvw", ID3 = "cdefghijklmnopqrstuvwx", ID4 = "defghijklmnopqrstuvwxy", ID5 = "efghijklmnopqrstuvwxyz";

/**
 * Bob's DhtDelivery reads whatever packet the test puts at Alice's mailbox address. Alice's side is
 * forged by hand from the link secret and her participation seed, exactly what a peer holding them
 * can do, so every refusal branch of the receiver can be reached with otherwise valid cryptography.
 */
/** Credentials of a Bob that pinned some contact already: no first contact under way. */
const pinned = (): PairingCredentials => ({ seedB64: createIdentity().seedB64, peerKey: createIdentity().pubKeyZ32 });

function setup(options: { mode?: "stream" | "dht"; pollMs?: number | null; state?: DhtDeliveryState; bobCredentials?: PairingCredentials;
  capsRev?: number; peerCapsRev?: (rev: number) => void; peerAcceptsText?: () => boolean } = {}) {
  const link = createLink();
  const alice = identityFromSeedB64(createIdentity().seedB64), bobSeed = createIdentity().seedB64;
  const bobParticipation = identityFromSeedB64(bobSeed);
  const aliceRdv = identityFromSeedB64(link.mine.seedB64).pubKeyZ32, bobRdv = link.mine.peerPubKeyZ32;
  const context = JSON.stringify(["ghostly-dht-delivery/1", [aliceRdv, bobRdv].sort()]);
  const derive = (label: string) => hkdf(sha256, fromBase64Url(link.mine.encKeyB64), utf8Encode(context), utf8Encode(label), 32);
  const mailbox = identityFromSeed(derive(`mailbox:${aliceRdv}`)).pubKeyZ32;
  const envelopeKey = derive("envelope");
  const sealedKey = (peer: string, seed = alice.seed) => hkdf(sha256, x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(seed), ed25519.utils.toMontgomery(publicKeyFromZ32(peer))),
    envelopeKey, utf8Encode("ghostly-dht-participation-envelope/1"), 32);

  let packet: SignedPacket | null = null;
  /** Packets at given addresses; any other address reads `packet`. */
  const at = new Map<string, SignedPacket | null>();
  let failSave = false;
  const saved: DhtDeliveryState[] = [];
  const credentials: PairingCredentials = options.bobCredentials ?? { seedB64: bobSeed };
  const messages: { id: string; text: string; timestamp: number }[] = [];
  const receipts: string[] = [], views: DhtDeliveryView[] = [], pins: string[] = [];
  const transport = {
    publish: vi.fn(async (_identity: unknown, _records: GhostRecord[]) => {}),
    resolve: vi.fn(async (key: string): Promise<SignedPacket | null> => at.has(key) ? at.get(key)! : packet),
    describe: () => ({ protocol: "forged fixture", relays: [] }),
  };
  const bob = new DhtDelivery({ params: link.invite, mode: options.mode ?? "dht", state: options.state, credentials, transport,
    save: async state => { if (failSave) throw new Error("disk full"); saved.push(structuredClone(state)); }, pin: async key => { pins.push(key); },
    message: async m => { messages.push(m); }, receipt: async id => { receipts.push(id); }, changed: view => { views.push(view); },
    capsRev: () => options.capsRev, peerCapsRev: options.peerCapsRev, peerAcceptsText: options.peerAcceptsText,
    ...(options.pollMs === null ? {} : { pollMs: options.pollMs ?? 100 }) });

  type Body = unknown[];
  const now = () => Date.now();
  const body = (over: Partial<Record<number, unknown>> = {}, seq = 1): Body => {
    const b: Body = [1, seq, now(), now() + 60_000, alice.pubKeyZ32, "dht", [ID, now(), "hello"], null];
    for (const [i, v] of Object.entries(over)) b[Number(i)] = v;
    return b;
  };
  const signature = (b: Body, recipient = "invite", seed = alice.seed) =>
    toBase64Url(sign(utf8Encode(JSON.stringify(["ghostly-dht-envelope", aliceRdv, bobRdv, recipient, b])), seed));
  /** A pre-pin envelope under the invite key, as a first contact would publish it. */
  const invitePacket = (b: Body, sig = signature(b), plaintext?: string): SignedPacket => ({ pubKeyZ32: mailbox, timestampMicros: 0n,
    records: [{ label: "_dm", value: encrypt(plaintext ?? JSON.stringify([b, sig]), envelopeKey), ttl: 60 }] });
  /** A post-pin envelope sealed to Bob's participation key, with Alice's key as the hint. */
  const pinnedPacket = (b: Body, hint = alice.pubKeyZ32, sealer = alice.seed, address = mailbox): SignedPacket => ({ pubKeyZ32: address, timestampMicros: 0n, records: [
    { label: "_dm", value: encrypt(JSON.stringify([b, signature(b, bobParticipation.pubKeyZ32)]), sealedKey(bobParticipation.pubKeyZ32, sealer)), ttl: 60 },
    { label: "_dmk", value: encrypt(hint, envelopeKey), ttl: 60 }] });
  const put = async (p: SignedPacket | null) => { packet = p; await vi.advanceTimersByTimeAsync(options.pollMs ?? 100); };
  /**
   * The mailboxes once pinned (WISP 403, revision 0.3), from the secret Alice's and Bob's participation keys share:
   * Alice's, where Bob reads, and Bob's, where he publishes.
   */
  const pinnedBox = (rdv: string) => identityFromSeed(hkdf(sha256, x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(alice.seed),
    ed25519.utils.toMontgomery(publicKeyFromZ32(bobParticipation.pubKeyZ32))), envelopeKey, utf8Encode(`ghostly-dht-pinned-mailbox/1:${rdv}`), 32)).pubKeyZ32;
  const alicePinned = pinnedBox(aliceRdv), bobPinned = pinnedBox(bobRdv);
  const bobInvite = identityFromSeed(derive(`mailbox:${bobRdv}`)).pubKeyZ32;
  /** Puts a packet at one address only (null: nothing there), then lets one read happen. */
  const putAt = async (address: string, p: SignedPacket | null) => { at.set(address, p); await vi.advanceTimersByTimeAsync(options.pollMs ?? 100); };
  /** Addresses Bob read, in order, and the one he last published at. */
  const reads = () => transport.resolve.mock.calls.map(c => c[0]);
  const publishedAt = () => (transport.publish.mock.lastCall![0] as { pubKeyZ32: string }).pubKeyZ32;
  const last = () => saved.at(-1) ?? options.state ?? emptyDhtDeliveryState();
  const setFailSave = (on: boolean) => { failSave = on; };
  /** The body of the last first-contact envelope Bob published. */
  const openPublished = (): unknown[] => JSON.parse(decrypt(transport.publish.mock.lastCall![1][0].value, envelopeKey))[0];
  /** The body of the last envelope Bob published sealed to Alice. */
  const openPublishedSealed = (): unknown[] => JSON.parse(decrypt(transport.publish.mock.lastCall![1][0].value, sealedKey(bobParticipation.pubKeyZ32)))[0];
  return { setFailSave, openPublished, link, alice, bob, credentials, mailbox, envelopeKey, transport, saved, messages, receipts, views, pins, body, signature,
    invitePacket, pinnedPacket, put, last, bobParticipation, openPublishedSealed, alicePinned, bobPinned, bobInvite, putAt, reads, publishedAt };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("DHT delivery: what a receiver refuses", () => {
  it("accepts a hand-forged first-contact envelope (the harness is faithful), pinning its author", async () => {
    const h = setup(); await h.bob.start();
    await h.put(h.invitePacket(h.body()));
    expect(h.messages.map(m => m.text)).toEqual(["hello"]);
    expect(h.pins).toEqual([h.alice.pubKeyZ32]);
    expect(h.credentials.peerKey).toBe(h.alice.pubKeyZ32);
    expect(h.credentials.requireSignedSignals).toBe(true);
    expect(h.last()).toMatchObject({ peerSequence: 1, peerMode: "dht", receipt: { id: ID, attempts: 0 } });
    await h.bob.stop();
  });

  const refused = async (h: ReturnType<typeof setup>, packet: SignedPacket) => {
    await h.put(packet);
    expect(h.messages).toEqual([]);
    expect(h.pins).toEqual([]);
    expect(h.credentials.peerKey).toBeUndefined();
    expect(h.last().peerSequence).toBe(0);
    await h.bob.stop();
  };

  it("ignores a packet from any address but the contact's mailbox", async () => {
    const h = setup(); await h.bob.start();
    await refused(h, { ...h.invitePacket(h.body()), pubKeyZ32: createIdentity().pubKeyZ32 });
  });

  it("ignores a packet larger than a DHT packet", async () => {
    const h = setup(); await h.bob.start(); const p = h.invitePacket(h.body());
    await refused(h, { ...p, records: [...p.records, { label: "_pad", value: "x".repeat(1200), ttl: 60 }] });
  });

  it("ignores a packet with no envelope, or with two", async () => {
    const h = setup(); await h.bob.start(); const p = h.invitePacket(h.body());
    await h.put({ ...p, records: [] });
    await refused(h, { ...p, records: [p.records[0], h.invitePacket(h.body({ 1: 2 })).records[0]] });
  });

  it("ignores a packet with two key hints, or a hint that does not decrypt", async () => {
    const h = setup(); await h.bob.start(); const p = h.pinnedPacket(h.body());
    await h.put({ ...p, records: [...p.records, p.records[1]] });
    await refused(h, { ...p, records: [p.records[0], { label: "_dmk", value: encrypt(h.alice.pubKeyZ32, randomBytes(32)), ttl: 60 }] });
  });

  it("ignores an envelope that does not decrypt, or whose hint names a key that is not a key", async () => {
    const h = setup(); await h.bob.start();
    await h.put({ pubKeyZ32: h.mailbox, timestampMicros: 0n, records: [{ label: "_dm", value: encrypt("[]", randomBytes(32)), ttl: 60 }] });
    await h.put({ pubKeyZ32: h.mailbox, timestampMicros: 0n, records: [{ label: "_dm", value: "not base64 at all!", ttl: 60 }] });
    const p = h.pinnedPacket(h.body());
    await refused(h, { ...p, records: [p.records[0], { label: "_dmk", value: encrypt("not-a-key", h.envelopeKey), ttl: 60 }] });
  });

  it.each([
    ["over 900 bytes", (h: ReturnType<typeof setup>) => JSON.stringify([h.body({ 6: [ID, Date.now(), "x".repeat(900)] }), "A".repeat(86)])],
    ["not JSON", () => "{nope"],
    ["an object", () => "{}"],
    ["three elements", (h: ReturnType<typeof setup>) => JSON.stringify([h.body(), "A".repeat(86), 1])],
    ["a body that is not a list", () => JSON.stringify(["body", "A".repeat(86)])],
  ])("ignores a decrypted envelope that is %s", async (_, plaintext) => {
    const h = setup(); await h.bob.start();
    await refused(h, h.invitePacket([], "", plaintext(h)));
  });

  it.each([
    ["seven fields", (b: unknown[]) => b.slice(0, 7)],
    ["version 2", (b: unknown[]) => Object.assign([...b], { 0: 2 })],
    ["sequence 0", (b: unknown[]) => Object.assign([...b], { 1: 0 })],
    ["a fractional sequence", (b: unknown[]) => Object.assign([...b], { 1: 1.5 })],
    ["a string issue date", (b: unknown[]) => Object.assign([...b], { 2: "now" })],
    ["a string expiry", (b: unknown[]) => Object.assign([...b], { 3: "later" })],
    // The receiver reads 100 ms after the body is built: 30.2 s ahead at build is still over 30 s ahead then.
    ["an issue date over 30 s ahead", (b: unknown[]) => Object.assign([...b], { 2: Date.now() + 30_200, 3: Date.now() + 90_000, 6: null })],
    ["an expiry already past", (b: unknown[]) => Object.assign([...b], { 2: Date.now() - 2000, 3: Date.now() })],
    ["a control lifetime over 10 minutes", (b: unknown[]) => Object.assign([...b], { 3: (b[2] as number) + 10 * 60_000 + 1, 6: null })],
    ["an unknown mode", (b: unknown[]) => Object.assign([...b], { 5: "carrier-pigeon" })],
    ["a numeric author", (b: unknown[]) => Object.assign([...b], { 4: 7 })],
  ])("ignores a validly signed body with %s", async (_, mutate) => {
    const h = setup(); await h.bob.start();
    await refused(h, h.invitePacket(mutate(h.body())));
  });

  it("ignores a malformed signature, a signature that does not verify, and one by another key", async () => {
    const h = setup(); await h.bob.start(); const b = h.body();
    await h.put(h.invitePacket(b, "A".repeat(85)));
    await h.put(h.invitePacket(b, 7 as unknown as string));
    await h.put(h.invitePacket(b, "A".repeat(86)));
    await h.put(h.invitePacket(b, h.signature(b, "invite", createIdentity().seed)));
    // Signed for Bob's participation key but sent as a first contact: the recipient is part of what is signed.
    await h.put(h.invitePacket(b, h.signature(b, h.bobParticipation.pubKeyZ32)));
    await refused(h, h.invitePacket(h.body({ 4: "not-a-key" })));
  });

  it("ignores a sealed envelope whose hint names someone other than its author", async () => {
    const h = setup(); await h.bob.start();
    await h.put(h.pinnedPacket(h.body(), createIdentity().pubKeyZ32));
    // The contact's signed body, re-sealed by a third party under its own key and hint, is not the contact's envelope.
    const relay = createIdentity();
    await refused(h, h.pinnedPacket(h.body(), relay.pubKeyZ32, relay.seed));
  });

  it.each([
    ["a message that is not a list", () => "hello"],
    ["a message of two fields", () => [ID, 1]],
    ["a numeric message id", (issued: number) => [7, issued, "hi"]],
    ["a short message id", (issued: number) => ["abc", issued, "hi"]],
    ["a zero timestamp", () => [ID, 0, "hi"]],
    ["a timestamp over 30 s past the issue date", (issued: number) => [ID, issued + 30_001, "hi"]],
    ["a numeric text", (issued: number) => [ID, issued, 42]],
    ["a text of 257 UTF-8 bytes", (issued: number) => [ID, issued, "x".repeat(257)]],
  ])("ignores %s, signed and in sequence", async (_, message) => {
    const h = setup(); await h.bob.start();
    const b = h.body(); b[6] = message(b[2] as number);
    await refused(h, h.invitePacket(b));
  });

  it("accepts a text of exactly 256 bytes, and refuses a message living longer than a DHT message may", async () => {
    const h = setup(); await h.bob.start();
    const b = h.body(); b[3] = (b[2] as number) + DHT_MESSAGE_TTL + 1;
    await h.put(h.invitePacket(b));
    expect(h.messages).toEqual([]);
    await h.put(h.invitePacket(h.body({ 6: [ID, Date.now(), "é".repeat(128)] })));
    expect(h.messages.map(m => m.text)).toEqual(["é".repeat(128)]);
    await h.bob.stop();
  });

  it.each([["a numeric receipt", 7], ["a short receipt", "abc"]])("ignores %s", async (_, receipt) => {
    const h = setup(); await h.bob.start();
    await refused(h, h.invitePacket(h.body({ 7: receipt })));
  });

  it("accepts a control envelope with no message for up to ten minutes, learning the peer's mode", async () => {
    const h = setup(); await h.bob.start();
    const b = h.body({ 5: "stream", 6: null }); b[3] = (b[2] as number) + 10 * 60_000;
    await h.put(h.invitePacket(b));
    expect(h.messages).toEqual([]);
    expect(h.bob.peerMode).toBe("stream");
    expect(h.last()).toMatchObject({ peerSequence: 1, peerMode: "stream" });
    await h.bob.stop();
  });
});

describe("DHT delivery: ordering and replay", () => {
  it("ignores an older or equal sequence after a newer one, whatever it carries", async () => {
    const h = setup(); await h.bob.start();
    await h.put(h.invitePacket(h.body({}, 5)));
    const replay = h.invitePacket(h.body({}, 5));
    await h.put(h.invitePacket(h.body({ 6: [ID2, Date.now(), "late"] }, 4)));
    await h.put(replay);
    await h.put(h.invitePacket(h.body({ 6: [ID2, Date.now(), "equal"] }, 5)));
    expect(h.messages.map(m => m.text)).toEqual(["hello"]);
    expect(h.last().peerSequence).toBe(5);
    await h.put(h.invitePacket(h.body({ 6: [ID2, Date.now(), "next"] }, 6)));
    expect(h.messages.map(m => m.text)).toEqual(["hello", "next"]);
    await h.bob.stop();
  });

  it("keeps anti-replay across a restart from the saved state", async () => {
    const h = setup(); await h.bob.start();
    const first = h.invitePacket(h.body({}, 3));
    await h.put(first); await h.bob.stop();
    const again = new DhtDelivery({ params: h.link.invite, mode: "dht", state: h.last(), credentials: h.credentials, transport: h.transport,
      save: async () => {}, pin: async () => {}, message: async m => { h.messages.push(m); }, receipt: async () => {}, changed: () => {}, pollMs: 100 });
    await again.start(); await vi.advanceTimersByTimeAsync(300);
    expect(h.messages).toHaveLength(1);
    await again.stop();
  });

  it("before the pin, takes only the key a ghostly1 invite named, and forgets an impostor's envelope", async () => {
    // covers: invite.pin
    const seedB64 = createIdentity().seedB64;
    const named = setup({ bobCredentials: { seedB64, expectedPeerKey: createIdentity().pubKeyZ32 } }); await named.bob.start();
    await named.put(named.invitePacket(named.body()));
    expect(named.messages).toEqual([]);
    expect(named.pins).toEqual([]);
    // Another invite holder can write to this mailbox, so a refusal is not remembered: the chat stays usable.
    expect(named.last()).not.toHaveProperty("peerRejected");
    expect(named.views.at(-1)?.error).toBeUndefined();
    await named.bob.stop();
    const h = setup(); h.credentials.expectedPeerKey = h.alice.pubKeyZ32; await h.bob.start();
    await h.put(h.invitePacket(h.body()));
    expect(h.messages.map(m => m.text)).toEqual(["hello"]);
    expect(h.pins).toEqual([h.alice.pubKeyZ32]);
    await h.bob.stop();
  });

  it("after the pin, ignores an envelope another key signed in the invite's mailbox: no stop, nothing kept, a passive warning", async () => {
    // covers: chat.dht.key-change
    const other = createIdentity().pubKeyZ32;
    const h = setup({ bobCredentials: { seedB64: createIdentity().seedB64, peerKey: other }, pollMs: 10_000 });
    await h.bob.start(); await vi.advanceTimersByTimeAsync(0);
    const published = h.transport.publish.mock.calls.length;
    // Anyone holding a copy of the invite can publish here, signed by a key of their own.
    await h.put(h.invitePacket(h.body()));
    expect(h.messages).toEqual([]);
    expect(h.last()).not.toHaveProperty("peerRejected");
    expect(h.last().peerSequence).toBe(0);
    expect(h.views.at(-1)?.error).toBeUndefined();
    expect(h.views.at(-1)?.foreignKeySeenAt).toBeGreaterThan(0);
    expect(h.bob.validate("hi", Date.now(), ID), "the chat still sends").toBeNull();
    expect(h.credentials.peerKey, "the pin is not replaced").toBe(other);
    // Publications go on as before.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.transport.publish.mock.calls.length).toBeGreaterThan(published);
    expect(await h.bob.send("still here", Date.now(), ID)).toBeNull();
    await h.bob.stop();
  });

  it("drops a key-mismatch stop an older app saved: the chat is usable again", async () => {
    const other = createIdentity().pubKeyZ32;
    const state = { ...emptyDhtDeliveryState(), peerRejected: true } as DhtDeliveryState;
    const h = setup({ bobCredentials: { seedB64: createIdentity().seedB64, peerKey: other }, state });
    expect(h.bob.view.error).toBeUndefined();
    expect(h.bob.validate("hi", Date.now(), ID)).toBeNull();
    await h.bob.start(); await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).not.toHaveProperty("peerRejected");
    await h.bob.stop();
  });

  it("an older contact, whose envelopes say nothing of the pinned mailbox, keeps the invite's mailbox both ways", async () => {
    const h = setup(); await h.bob.start();
    await h.put(h.invitePacket(h.body({ 6: null })));
    for (let seq = 2; seq < 6; seq++) await h.put(h.pinnedPacket(h.body({ 6: null }, seq)));
    expect(h.last().peerSequence).toBe(5);
    expect(h.last().peerPinned).toBeUndefined();
    expect(await h.bob.send("to an older app", Date.now(), ID2)).toBeNull();
    expect(h.publishedAt()).toBe(h.bobInvite);
    expect(h.reads().filter(a => a === h.alicePinned), "its mailbox held its envelope: no need to look further").toEqual([]);
    await h.bob.stop();
  });

  it("moves to the pinned mailbox in two steps, and then a copy of the invite cannot overwrite the contact's texts", async () => {
    const h = setup(); await h.bob.start();
    // First contact: nothing sealed to Bob yet, so nothing said about the pinned mailbox.
    await h.put(h.invitePacket(h.body({ 6: null, 8: null, 9: 1 })));
    expect(h.last().peerPinned).toBeUndefined();
    expect(await h.bob.send("first", Date.now(), ID2)).toBeNull();
    expect(h.publishedAt(), "Alice has not pinned Bob yet: the invite's mailbox").toBe(h.bobInvite);
    expect(h.openPublishedSealed()[9], "Bob can use it").toBe(1);
    // Sealed to Bob, flag 1: she can use it. Bob reads there first now, and still publishes where she reads.
    await h.put(h.pinnedPacket(h.body({ 6: null, 7: ID2, 8: null, 9: 1 }, 2)));
    expect(h.last().peerPinned).toBe("can");
    expect(h.reads().at(-1), "looked in at once").toBe(h.alicePinned);
    expect(await h.bob.send("second", Date.now(), ID)).toBeNull();
    expect(h.publishedAt()).toBe(h.bobInvite);
    expect(h.openPublishedSealed()[9], "Bob reads there first").toBe(2);
    // Flag 2: she reads there first too. Bob publishes there from now on.
    await h.put(h.pinnedPacket(h.body({ 6: null, 7: ID, 8: null, 9: 2 }, 3)));
    expect(h.last().peerPinned).toBe("reads");
    expect(await h.bob.send("third", Date.now(), ID3)).toBeNull();
    expect(h.publishedAt()).toBe(h.bobPinned);
    // Her envelope in the pinned mailbox: Bob reads only there from now on.
    await h.putAt(h.alicePinned, h.pinnedPacket(h.body({ 6: [ID4, Date.now(), "in the pinned mailbox"], 8: null, 9: 2 }, 4), undefined, undefined, h.alicePinned));
    expect(h.last().peerPinned).toBe("seen");
    expect(h.messages.map(m => m.text)).toContain("in the pinned mailbox");
    // A copy of the invite overwrites her invite mailbox, signed by a key of its own: never read again, never a stop.
    const reads = h.reads().length;
    const copy = identityFromSeedB64(createIdentity().seedB64);
    await h.put(h.invitePacket(h.body({ 4: copy.pubKeyZ32 }, 99), h.signature(h.body({ 4: copy.pubKeyZ32 }, 99), "invite", copy.seed)));
    await h.putAt(h.alicePinned, h.pinnedPacket(h.body({ 6: [ID5, Date.now(), "still arrives"], 8: null, 9: 2 }, 5), undefined, undefined, h.alicePinned));
    expect(h.reads().slice(reads).every(a => a === h.alicePinned)).toBe(true);
    expect(h.messages.map(m => m.text)).toContain("still arrives");
    expect(h.views.at(-1)?.error).toBeUndefined();
    await h.bob.stop();
  });

  it("before the contact said anything, looks in the pinned mailbox when the invite's held something that is not the contact's", async () => {
    const h = setup(); await h.bob.start();
    await h.put(h.invitePacket(h.body({ 6: null })));
    const reads = () => h.reads().filter(a => a === h.alicePinned).length;
    expect(reads()).toBe(0);
    // Her invite mailbox now holds someone else's envelope (or her own, expired): the pinned one is looked in, once a minute at most.
    const copy = identityFromSeedB64(createIdentity().seedB64);
    await h.put(h.invitePacket(h.body({ 4: copy.pubKeyZ32 }, 9), h.signature(h.body({ 4: copy.pubKeyZ32 }, 9), "invite", copy.seed)));
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(reads()).toBe(2);
    // She moved there while Bob was away: found, and read there from now on.
    await h.putAt(h.alicePinned, h.pinnedPacket(h.body({ 6: [ID4, Date.now(), "moved"], 8: null, 9: 2 }, 6), undefined, undefined, h.alicePinned));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.messages.map(m => m.text)).toContain("moved");
    expect(h.last().peerPinned).toBe("seen");
    await h.bob.stop();
  });

  it("clears the pending text only on a receipt for that very id", async () => {
    const h = setup(); await h.bob.start();
    await h.put(h.invitePacket(h.body({ 6: null })));
    expect(await h.bob.send("to alice", Date.now(), ID2)).toBeNull();
    await h.put(h.pinnedPacket(h.body({ 6: null, 7: ID }, 2)));
    expect(h.receipts).toEqual([]);
    expect(h.last().pending?.message[0]).toBe(ID2);
    await h.put(h.pinnedPacket(h.body({ 6: null, 7: ID2 }, 3)));
    expect(h.receipts).toEqual([ID2]);
    expect(h.last().pending).toBeUndefined();
    expect(h.last().confirmed).toBe(ID2);
    await h.bob.stop();
  });
});

describe("DHT delivery: sending and lifecycle", () => {
  it("validates the id and timestamp of an outgoing text", async () => {
    const h = setup();
    expect(h.bob.validate("hi", Date.now(), "short")).toBe("Invalid message.");
    expect(h.bob.validate("hi", 0, ID)).toBe("Invalid message.");
    expect(h.bob.validate("hi", 1.5, ID)).toBe("Invalid message.");
    expect(h.bob.validate("hi", Date.now(), ID)).toBeNull();
    expect(h.bob.comparisonCode).toBeUndefined();
  });

  it("keeps the first deadline when the same text is sent again, and stops at the retry budget", async () => {
    const h = setup(); await h.bob.start();
    expect(await h.bob.send("once", Date.now(), ID)).toBeNull();
    const deadline = h.last().pending!.expires;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await h.bob.send("once", Date.now(), ID)).toBeNull();
    expect(h.last().pending!.expires).toBe(deadline);
    await h.bob.stop();
    const exhausted = setup({ state: { ...emptyDhtDeliveryState(), pending: { message: [ID, Date.now(), "once"], expires: Date.now() + 60_000, attempts: 8, next: 0 } } });
    expect(exhausted.bob.validate("once", Date.now(), ID)).toMatch(/retry budget exhausted/);
    expect(exhausted.bob.validate("other", Date.now(), ID2)).toMatch(/One DHT text/);
  });

  it("stops publishing a text once its retry budget is spent", async () => {
    const h = setup(); await h.bob.start();
    expect(await h.bob.send("retry me", Date.now(), ID)).toBeNull();
    await vi.advanceTimersByTimeAsync(DHT_MESSAGE_TTL - 10_000);
    expect(h.last().pending!.attempts).toBe(8);
    const withText = h.transport.publish.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    // Control envelopes may still go out, but none carries the text past its budget.
    expect(h.transport.publish.mock.calls.length - withText).toBeLessThanOrEqual(1);
    expect(h.last().pending!.attempts).toBe(8);
    await h.bob.stop();
  });

  it("acknowledging over a stream cancels only the matching pending text", async () => {
    const h = setup(); await h.bob.start();
    expect(await h.bob.send("hi", Date.now(), ID)).toBeNull();
    await h.bob.acknowledge(ID2);
    expect(h.last().pending?.message[0]).toBe(ID);
    await h.bob.acknowledge(ID);
    expect(h.last().pending).toBeUndefined();
    expect(h.last().confirmed).toBe(ID);
    await h.bob.stop();
  });

  it("replays a confirmed receipt on start, and starting twice polls once", async () => {
    const h = setup({ state: { ...emptyDhtDeliveryState(), confirmed: ID } });
    await h.bob.start(); await h.bob.start();
    expect(h.receipts).toEqual([ID]);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.transport.resolve).toHaveBeenCalledOnce();
    await h.bob.stop();
  });

  it("reports read and publication failures in the view, including non-Error values, and recovers", async () => {
    const h = setup();
    h.transport.resolve.mockRejectedValueOnce("relay down");
    h.transport.publish.mockRejectedValueOnce(new Error("quota"));
    await h.bob.start(); await vi.advanceTimersByTimeAsync(0);
    expect(h.views.at(-1)?.error).toBe("Could not read DHT delivery: relay down. Could not publish DHT delivery: quota");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.views.at(-1)?.error).toBe("Could not publish DHT delivery: quota");
    h.transport.publish.mockRejectedValueOnce("no route");
    expect(await h.bob.send("hi", Date.now(), ID)).toMatch(/DHT publication failed: no route/);
    // The bounded retry publishes the pending text again, fails once more, then succeeds and the error goes away.
    h.transport.publish.mockRejectedValueOnce("flaky");
    await vi.advanceTimersByTimeAsync(4_200);
    expect(h.views.at(-1)?.error).toBe("Could not publish DHT delivery: flaky");
    await vi.advanceTimersByTimeAsync(8_200);
    expect(h.views.at(-1)?.error).toBeUndefined();
    await h.bob.stop();
  });

  it("a save that fails rejects that call only; later operations still run in order", async () => {
    const h = setup(); await h.bob.start();
    expect(await h.bob.send("hi", Date.now(), ID)).toBeNull();
    h.setFailSave(true);
    await expect(h.bob.acknowledge(ID)).rejects.toThrow(/disk full/);
    h.setFailSave(false);
    expect(h.last().pending?.message[0]).toBe(ID);
    await h.bob.acknowledge(ID);
    expect(h.last().pending).toBeUndefined();
    await h.bob.stop();
  });

  it("drops a packet that resolves after stop", async () => {
    const h = setup(); let release!: (p: SignedPacket) => void;
    h.transport.resolve.mockImplementationOnce(() => new Promise(r => { release = r; }));
    await h.bob.start(); await vi.advanceTimersByTimeAsync(0);
    const stopping = h.bob.stop();
    release(h.invitePacket(h.body()));
    await stopping;
    expect(h.messages).toEqual([]);
  });

  it("polls every 4 s in DHT mode and every 30 s otherwise, without a configured interval", async () => {
    const dht = setup({ pollMs: null }); await dht.bob.start();
    await vi.advanceTimersByTimeAsync(4_000 * 3 + 10);
    expect(dht.transport.resolve).toHaveBeenCalledTimes(4);
    await dht.bob.stop();
    const stream = setup({ pollMs: null, mode: "stream", bobCredentials: pinned() }); await stream.bob.start();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(stream.transport.resolve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_010);
    expect(stream.transport.resolve).toHaveBeenCalledTimes(2);
    await stream.bob.stop();
  });

  it("announces a change of method at once, however recently it last published", async () => {
    const h = setup({ pollMs: null }); await h.bob.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.transport.publish).toHaveBeenCalledTimes(1);
    await h.bob.setMode("stream"); await vi.advanceTimersByTimeAsync(0);
    expect(h.transport.publish, "not held back by the 4 s spacing").toHaveBeenCalledTimes(2);
    await h.bob.stop();
  });

  it("after leaving DHT-only, reads a contact still there at the DHT pace for two minutes, then at 30 s", async () => {
    const h = setup({ pollMs: null, state: { ...emptyDhtDeliveryState(), peerMode: "dht" }, bobCredentials: pinned() }); await h.bob.start();
    await vi.advanceTimersByTimeAsync(0);
    await h.bob.setMode("stream"); await vi.advanceTimersByTimeAsync(0);
    const reads = h.transport.resolve.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4_000 * 3 + 10);
    expect(h.transport.resolve.mock.calls.length - reads).toBe(3);
    await vi.advanceTimersByTimeAsync(LEAVING_DHT_FAST_MS + 4_000);
    const later = h.transport.resolve.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.transport.resolve.mock.calls.length - later, "two reads a minute, not fifteen").toBe(2);
    await h.bob.stop();
  });

  it("a first contact is read at 30 s until the contact shows up, then at the signaling pace for two minutes", async () => {
    const h = setup({ pollMs: null, mode: "stream" }); await h.bob.start(); await vi.advanceTimersByTimeAsync(0);
    const first = h.transport.resolve.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.transport.resolve.mock.calls.length - first, "an invite nobody opened spends no relay budget").toBe(2);
    h.bob.expect(); await vi.advanceTimersByTimeAsync(0);
    const expected = h.transport.resolve.mock.calls.length;
    expect(expected - first, "a fresh packet of the contact is looked at once").toBe(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.transport.resolve.mock.calls.length - expected).toBe(5);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const later = h.transport.resolve.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.transport.resolve.mock.calls.length - later).toBe(2);
    await h.bob.stop();
  });

  it("reads every 5 minutes while live, at once when layer 1 is lost; 10 s open, 30 s in the background", async () => {
    const h = setup({ pollMs: null, mode: "stream", bobCredentials: pinned() }); await h.bob.start(); await vi.advanceTimersByTimeAsync(0);
    h.bob.setLive(true);
    const live = h.transport.resolve.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS - 1_000);
    expect(h.transport.resolve.mock.calls.length - live, "no read while live").toBe(0);
    await vi.advanceTimersByTimeAsync(1_010);
    expect(h.transport.resolve.mock.calls.length - live).toBe(1);
    h.bob.setLive(false); await vi.advanceTimersByTimeAsync(0);
    const dropped = h.transport.resolve.mock.calls.length;
    expect(dropped - live, "read at once on the drop").toBe(2);
    const lastOptions = () => (h.transport.resolve.mock.lastCall as unknown[] | undefined)?.[1];
    expect(lastOptions(), "a read asked for is not a background one").toBeUndefined();
    const after = h.transport.resolve.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.transport.resolve.mock.calls.length - after, "back to 30 s in the background").toBe(2);
    expect(lastOptions(), "the slow periodic look is served from the relays' background share").toEqual({ background: true });
    h.bob.setActive(true); await vi.advanceTimersByTimeAsync(0);
    const active = h.transport.resolve.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_010);
    expect(h.transport.resolve.mock.calls.length - active, "10 s while the chat is open on the DHT").toBe(3);
    // A text of ours awaiting its receipt: 4 s, the receipt is what the person watches for.
    expect(await h.bob.send("hello", Date.now(), ID)).toBeNull();
    const sent = h.transport.resolve.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_010);
    expect(h.transport.resolve.mock.calls.length - sent).toBeGreaterThanOrEqual(4);
    await h.bob.stop();
  });

  it("tells its capability-record revision in the envelope and reports the contact's", async () => {
    const revs: number[] = [];
    const h = setup({ mode: "dht", capsRev: 7, peerCapsRev: rev => revs.push(rev) }); await h.bob.start(); await vi.advanceTimersByTimeAsync(0);
    const body = h.openPublished();
    expect(body.length).toBe(10);
    expect(body[8]).toBe(7);
    expect(body[9], "it can use the pinned mailbox").toBe(1);
    await h.put(h.invitePacket(h.body({ 8: 3 })));
    expect(revs).toEqual([3]);
    await h.put(h.invitePacket(h.body({ 8: "x", 9: ["later"] }, 2)));
    expect(revs, "a malformed or unknown trailing element is ignored, the envelope still read").toEqual([3]);
    expect(h.last().peerSequence, "the envelope with an unknown element was still read").toBe(2);
    await h.bob.stop();
  });

  it("names a new capability-record revision in an envelope at once, and only once", async () => {
    const options = { mode: "dht" as const, capsRev: 7 };
    const h = setup(options); await h.bob.start(); await vi.advanceTimersByTimeAsync(0);
    const published = h.transport.publish.mock.calls.length;
    await h.bob.announce();
    expect(h.transport.publish, "the last envelope named this revision already").toHaveBeenCalledTimes(published);
    // A native transport started: the record's revision 8 says how to dial it, and the contact must hear of it now,
    // not with a control envelope four minutes later.
    options.capsRev = 8;
    await h.bob.announce();
    expect(h.transport.publish).toHaveBeenCalledTimes(published + 1);
    expect(h.openPublished()[8]).toBe(8);
    await h.bob.announce();
    expect(h.transport.publish, "said once").toHaveBeenCalledTimes(published + 1);
    await h.bob.stop();
  });

  it("refuses text for a contact whose capability record lacks dht-text/1", async () => {
    const h = setup({ mode: "stream", bobCredentials: pinned(), peerAcceptsText: () => false });
    expect(h.bob.validate("hello", Date.now(), ID)).toBe(DHT_TEXT_REFUSED);
  });

  it("reads now when asked, and once more right after a read that was already in flight", async () => {
    const h = setup({ pollMs: null, mode: "stream" }); let release!: (p: SignedPacket | null) => void;
    h.transport.resolve.mockImplementationOnce(() => new Promise(r => { release = r; }));
    await h.bob.start(); await vi.advanceTimersByTimeAsync(0);
    expect(h.transport.resolve).toHaveBeenCalledTimes(1);
    h.bob.refresh();
    release(null); await vi.advanceTimersByTimeAsync(0);
    expect(h.transport.resolve, "the asked-for read, not the one 30 s later").toHaveBeenCalledTimes(2);
    h.bob.refresh(); await vi.advanceTimersByTimeAsync(0);
    expect(h.transport.resolve).toHaveBeenCalledTimes(3);
    await h.bob.stop();
  });
});

describe("DHT delivery: the relays' request budget", () => {
  const held = (ms: number) => new DiscoveryBudgetError(ms);

  it("keeps an envelope the budget held back due, says no error, and sends it when the budget frees a request", async () => {
    const h = setup({ pollMs: null, mode: "dht", bobCredentials: pinned() }); await h.bob.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.transport.publish).toHaveBeenCalledTimes(1);
    // Leaving DHT only while the minute is spent: the envelope that says so waits 20 s for the budget…
    h.transport.publish.mockRejectedValueOnce(held(20_000));
    await h.bob.setMode("stream"); await vi.advanceTimersByTimeAsync(0);
    expect(h.transport.publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(h.transport.publish, "no attempt while the budget is known to be spent").toHaveBeenCalledTimes(2);
    // …and goes the moment it frees, not with the next control envelope four minutes later.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(h.transport.publish).toHaveBeenCalledTimes(3);
    expect(h.views.every(v => !v.error), "a wait for the budget is no error").toBe(true);
    await h.bob.stop();
  });

  it("a text the budget held back is queued, not failed, and keeps all eight attempts", async () => {
    const h = setup({ bobCredentials: pinned() }); await h.bob.start();
    await vi.advanceTimersByTimeAsync(0);
    h.transport.publish.mockRejectedValueOnce(held(10_000));
    expect(await h.bob.send("hi", Date.now(), ID)).toBeNull();
    expect(h.last().pending).toMatchObject({ attempts: 0 });
    const calls = h.transport.publish.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.transport.publish.mock.calls.length).toBe(calls);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(h.transport.publish.mock.calls.length).toBe(calls + 1);
    expect(h.last().pending).toMatchObject({ attempts: 1 });
    expect(h.views.every(v => !v.error)).toBe(true);
    await h.bob.stop();
  });

  it("a read the budget held back is no error either", async () => {
    const h = setup({ bobCredentials: pinned() });
    h.transport.resolve.mockRejectedValue(held(5_000));
    await h.bob.start(); await vi.advanceTimersByTimeAsync(1_000);
    expect(h.views.length).toBeGreaterThan(0);
    expect(h.views.every(v => !v.error)).toBe(true);
    await h.bob.stop();
  });

  it("a receipt forces envelopes with a text's backoff, and none once the contact's newer envelope no longer carries the text", async () => {
    const h = setup(); await h.bob.start();
    // A text with its whole lifetime ahead: a sender that sends it anew keeps this deadline.
    const text = h.body({ 3: Date.now() + DHT_MESSAGE_TTL });
    await h.put(h.invitePacket(text));
    expect(h.messages.map(m => m.text)).toEqual(["hello"]);
    const start = Date.now(), first = h.transport.publish.mock.calls.length;
    // Every tick (100 ms here) used to publish the receipt again, 4 s apart, until eight: now 4, 8, 16 s apart.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(Date.now() - start).toBeGreaterThanOrEqual(29_000);
    expect(h.transport.publish.mock.calls.length - first).toBeLessThanOrEqual(3);
    expect(h.last().receipt).toMatchObject({ id: ID });
    // Alice's next envelope has no text: she has her receipt (on either path), so it forces nothing more…
    await h.put(h.pinnedPacket(h.body({ 6: null }, 2)));
    expect(h.last().receipt).toMatchObject({ id: ID, settled: true });
    const settled = h.transport.publish.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.transport.publish.mock.calls.length).toBe(settled);
    // …until she asks for it again (the text sent anew after a lost session): then it goes at once.
    await h.put(h.pinnedPacket(h.body({ 3: text[3] }, 3)));
    expect(h.last().receipt).toMatchObject({ id: ID });
    expect(h.last().receipt?.settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.transport.publish.mock.calls.length).toBe(settled + 1);
    await h.bob.stop();
  });
});
