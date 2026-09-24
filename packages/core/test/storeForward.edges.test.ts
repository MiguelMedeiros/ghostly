import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, fromBase64Url, randomBytes, toBase64Url, utf8Encode } from "../src/bytes";
import { encrypt } from "../src/crypto";
import { createIdentity, identityFromSeedB64, publicKeyFromZ32, sign } from "../src/identity";
import { createLink } from "../src/invite";
import type { LinkParams } from "../src/invite";
import type { GhostRecord, SignedPacket } from "../src/pkarr";
import { HOLD_LIMITS, HoldKeys, HoldRefusedError, isHoldUrl, newHoldMailbox, readManifest, type HoldPointer } from "../src/storeForward";

const NOW = 1_800_000_000_000;

/**
 * Alice (link.mine) and Bob (link.invite) pinned each other. The sealing key is derived here from the
 * documented inputs, the way a peer holding the link secret and its own participation seed can: that is
 * what lets these tests hand Bob bundles and pointers no honest `seal` would produce.
 */
function setup(link = createLink(), aliceSeed = createIdentity().seedB64, bobSeed = createIdentity().seedB64) {
  const alicePub = identityFromSeedB64(aliceSeed).pubKeyZ32, bobPub = identityFromSeedB64(bobSeed).pubKeyZ32;
  const alice = new HoldKeys(link.mine, aliceSeed, bobPub), bob = new HoldKeys(link.invite, bobSeed, alicePub);
  const sealKey = deriveSealKey(link.mine, aliceSeed, bobPub);
  const aliceParticipation = identityFromSeedB64(aliceSeed);
  const mailbox = newHoldMailbox();
  /** The 13 header fields Alice's `seal` would write. */
  const fields = (body: Uint8Array, over: Partial<Record<number, unknown>> = {}) => {
    const f: unknown[] = [1, alice.from, alice.to, alice.me, alice.peer, mailbox, 1, "abcdefghij", NOW, "text", null, toBase64Url(sha256(body)), NOW + 60_000];
    for (const [i, v] of Object.entries(over)) f[Number(i)] = v;
    return f;
  };
  const signFields = (f: unknown[], seed = aliceParticipation.seed) => toBase64Url(sign(utf8Encode(JSON.stringify(["ghostly-hold-bundle", f])), seed));
  /** Seals any plaintext under the link's bundle key, with the real framing around it. */
  const box = (plain: Uint8Array, version = 1) => {
    const nonce = randomBytes(24);
    return concatBytes(utf8Encode("GHLD"), new Uint8Array([version]), nonce, xsalsa20poly1305(sealKey, nonce).encrypt(plain));
  };
  const framed = (header: Uint8Array, body: Uint8Array, length = header.length) => {
    const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, length);
    return box(concatBytes(prefix, header, body));
  };
  const bundle = (body: Uint8Array, f = fields(body), signature = signFields(f)) => framed(utf8Encode(JSON.stringify([f, signature])), body);
  /** A pointer body as Alice would sign it, for Bob to read. */
  const pointerPacket = (body: unknown[], signature?: string, records?: GhostRecord[]): SignedPacket => {
    const sig = signature ?? toBase64Url(sign(utf8Encode(JSON.stringify(["ghostly-hold-pointer", alice.from, alice.to, body])), aliceParticipation.seed));
    return { pubKeyZ32: alice.identity.pubKeyZ32, timestampMicros: 0n,
      records: records ?? [{ label: "_hold", value: encrypt(JSON.stringify([body, sig]), sealKey), ttl: 60 }] };
  };
  return { link, alice, bob, sealKey, mailbox, fields, signFields, box, framed, bundle, pointerPacket, aliceSeed, bobSeed };
}

function deriveSealKey(params: LinkParams, participationSeed: string, peerKey: string): Uint8Array {
  const from = identityFromSeedB64(params.seedB64).pubKeyZ32, to = params.peerPubKeyZ32;
  const context = JSON.stringify(["ghostly-hold/1", [from, to].sort()]);
  const envelope = hkdf(sha256, fromBase64Url(params.encKeyB64), utf8Encode(context), utf8Encode("envelope"), 32);
  const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(identityFromSeedB64(participationSeed).seed), ed25519.utils.toMontgomery(publicKeyFromZ32(peerKey)));
  return hkdf(sha256, shared, envelope, utf8Encode("ghostly-hold-envelope/1"), 32);
}

const reason = (run: () => unknown): string | undefined => {
  try { run(); } catch (error) { if (error instanceof HoldRefusedError) return error.reason; throw error; }
  return undefined;
};

describe("held bundles: framing refusals", () => {
  it("opens a hand-built bundle exactly like a sealed one (the harness is faithful)", () => {
    const h = setup(), body = utf8Encode("hi");
    expect(h.bob.open(h.bundle(body), { now: NOW }).header).toMatchObject({ seq: 1, id: "abcdefghij", kind: "text", mailbox: h.mailbox });
  });

  it("refuses a newer framing version and a wrong magic", () => {
    const h = setup(), body = utf8Encode("hi");
    const newer = h.bundle(body); newer[4] = 2;
    expect(() => h.bob.open(newer, { now: NOW })).toThrow(/newer Ghostly/);
    const magic = h.bundle(body); magic[0] ^= 1;
    expect(reason(() => h.bob.open(magic, { now: NOW }))).toBe("format");
  });

  it("accepts a bundle exactly at the byte limit and refuses one byte over", () => {
    const h = setup(), bytes = h.bundle(utf8Encode("hi"));
    expect(() => h.bob.open(bytes, { now: NOW, maxBytes: bytes.length })).not.toThrow();
    expect(reason(() => h.bob.open(bytes, { now: NOW, maxBytes: bytes.length - 1 }))).toBe("size");
  });

  it("refuses an authenticated plaintext too short to carry a header length", () => {
    const h = setup();
    expect(reason(() => h.bob.open(h.box(new Uint8Array(0)), { now: NOW }))).toBe("format");
    expect(reason(() => h.bob.open(h.box(new Uint8Array(3)), { now: NOW }))).toBe("format");
  });

  it("refuses a header length over 128 KiB, or past the end of the plaintext", () => {
    const h = setup(), header = utf8Encode("[]");
    expect(reason(() => h.bob.open(h.framed(header, new Uint8Array(), 128 * 1024 + 1), { now: NOW }))).toBe("format");
    expect(reason(() => h.bob.open(h.framed(header, new Uint8Array(), header.length + 1), { now: NOW }))).toBe("format");
  });

  it.each([
    ["not JSON", utf8Encode("{nope")],
    ["invalid UTF-8", new Uint8Array([0xff, 0xfe])],
    ["an object", utf8Encode("{}")],
    ["three elements", utf8Encode(JSON.stringify([[], "x", 1]))],
    ["fields that are not a list", utf8Encode(JSON.stringify(["fields", "A".repeat(86)]))],
    ["twelve fields", utf8Encode(JSON.stringify([Array(12).fill(1), "A".repeat(86)]))],
    ["a numeric signature", utf8Encode(JSON.stringify([Array(13).fill(1), 1]))],
    ["a short signature", utf8Encode(JSON.stringify([Array(13).fill(1), "A".repeat(85)]))],
  ])("refuses a header that is %s", (_, header) => {
    const h = setup();
    expect(reason(() => h.bob.open(h.framed(header, new Uint8Array()), { now: NOW }))).toBe("format");
  });

  it.each([
    ["a version other than 1", 0, 2],
    ["a numeric from", 1, 5],
    ["a numeric to", 2, 5],
    ["a numeric author", 3, 5],
    ["a numeric recipient", 4, 5],
    ["a malformed mailbox", 5, "short"],
    ["a negative sequence", 6, -1],
    ["a fractional sequence", 6, 1.5],
    ["an id too short", 7, "abc"],
    ["an id with a slash", 7, "abc/defghij"],
    ["a zero timestamp", 8, 0],
    ["an unknown kind", 9, "video"],
    ["a numeric kind", 9, 3],
    ["a numeric digest", 11, 3],
    ["a string expiry", 12, "later"],
  ])("refuses a validly signed header with %s", (_, index, value) => {
    const h = setup(), body = utf8Encode("hi");
    expect(reason(() => h.bob.open(h.bundle(body, h.fields(body, { [index]: value })), { now: NOW }))).toBe("format");
  });
});

describe("held bundles: who, what and when", () => {
  it("refuses a header naming another author before looking at the signature", () => {
    const h = setup(), body = utf8Encode("hi"), other = createIdentity();
    const f = h.fields(body, { 3: other.pubKeyZ32 });
    expect(reason(() => h.bob.open(h.bundle(body, f, h.signFields(f, other.seed)), { now: NOW }))).toBe("author");
  });

  it("refuses a well-formed signature that does not verify, and one made by another key", () => {
    const h = setup(), body = utf8Encode("hi"), f = h.fields(body);
    expect(reason(() => h.bob.open(h.bundle(body, f, "A".repeat(86)), { now: NOW }))).toBe("signature");
    expect(reason(() => h.bob.open(h.bundle(body, f, h.signFields(f, createIdentity().seed)), { now: NOW }))).toBe("signature");
    // A signature over other fields (the next sequence) does not carry over.
    expect(reason(() => h.bob.open(h.bundle(body, f, h.signFields(h.fields(body, { 6: 2 }))), { now: NOW }))).toBe("signature");
  });

  it("refuses a body swapped under a validly signed header", () => {
    const h = setup(), f = h.fields(utf8Encode("original"));
    expect(reason(() => h.bob.open(h.bundle(utf8Encode("replaced"), f), { now: NOW }))).toBe("digest");
  });

  it("refuses a bundle replayed from another link between the same two people", () => {
    const aliceSeed = createIdentity().seedB64, bobSeed = createIdentity().seedB64;
    const first = setup(createLink(), aliceSeed, bobSeed), second = setup(createLink(), aliceSeed, bobSeed);
    const bytes = first.alice.seal({ mailbox: first.mailbox, seq: 1, id: "abcdefghij", ts: NOW, kind: "text", expires: NOW + 1000 }, utf8Encode("hi"));
    expect(reason(() => second.bob.open(bytes, { now: NOW }))).toBe("tampered");
    expect(first.bob.open(bytes, { now: NOW }).header.seq).toBe(1);
  });

  it("dates: accepts the edge of clock skew and lifetime, refuses one millisecond past either", () => {
    const h = setup(), body = utf8Encode("hi");
    const at = (ts: number, expires: number) => h.bundle(body, h.fields(body, { 8: ts, 12: expires }));
    expect(reason(() => h.bob.open(at(NOW + HOLD_LIMITS.clockSkewMs, NOW + HOLD_LIMITS.clockSkewMs + 1), { now: NOW }))).toBeUndefined();
    expect(reason(() => h.bob.open(at(NOW + HOLD_LIMITS.clockSkewMs + 1, NOW + 2 * HOLD_LIMITS.clockSkewMs), { now: NOW }))).toBe("future");
    const longest = NOW + HOLD_LIMITS.ttlMs + HOLD_LIMITS.clockSkewMs;
    expect(reason(() => h.bob.open(at(NOW, longest), { now: NOW }))).toBeUndefined();
    expect(reason(() => h.bob.open(at(NOW, longest + 1), { now: NOW }))).toBe("limits");
    expect(reason(() => h.bob.open(at(NOW, NOW), { now: NOW }))).toBe("limits");
    expect(reason(() => h.bob.open(at(NOW, NOW - 1), { now: NOW }))).toBe("limits");
  });

  it("per kind: text and payment requests at their limit pass and one byte over is refused", () => {
    const h = setup();
    const of = (kind: string, body: Uint8Array, meta: unknown = null) => reason(() => h.bob.open(h.bundle(body, h.fields(body, { 9: kind, 10: meta })), { now: NOW }));
    expect(of("text", new Uint8Array(HOLD_LIMITS.maxTextBytes).fill(0x61))).toBeUndefined();
    expect(of("pay-req", new Uint8Array(HOLD_LIMITS.maxPaymentRequestBytes))).toBeUndefined();
    expect(of("pay-req", new Uint8Array(HOLD_LIMITS.maxPaymentRequestBytes + 1))).toBe("limits");
  });

  it.each([
    ["no description", null],
    ["a string description", "file.png"],
    ["a name that is not a string", { name: 1, size: 2, mime: "a/b" }],
    ["a name over 255 characters", { name: "n".repeat(256), size: 2, mime: "a/b" }],
    ["a missing type", { name: "x", size: 2 }],
    ["a type over 255 characters", { name: "x", size: 2, mime: "m".repeat(256) }],
    ["a size that does not match", { name: "x", size: 3, mime: "a/b" }],
  ])("refuses a file with %s", (_, meta) => {
    const h = setup(), body = new Uint8Array(2);
    expect(reason(() => h.bob.open(h.bundle(body, h.fields(body, { 9: "file", 10: meta })), { now: NOW }))).toBe("limits");
  });

  it("refuses a manifest that carries a body or malformed entries", () => {
    const h = setup(), empty = new Uint8Array(), some = new Uint8Array(1);
    expect(reason(() => h.bob.open(h.bundle(some, h.fields(some, { 9: "manifest", 10: { entries: [] } })), { now: NOW }))).toBe("limits");
    expect(reason(() => h.bob.open(h.bundle(empty, h.fields(empty, { 9: "manifest", 10: null })), { now: NOW }))).toBe("limits");
    expect(reason(() => h.bob.open(h.bundle(empty, h.fields(empty, { 9: "manifest", 10: { entries: [] } })), { now: NOW }))).toBeUndefined();
  });

  it("never throws anything but a refusal, whatever bytes arrive or however a good bundle is damaged", () => {
    const h = setup(), good = h.bundle(utf8Encode("hello"));
    fc.assert(fc.property(fc.uint8Array({ maxLength: 200 }), bytes => {
      expect(reason(() => h.bob.open(bytes, { now: NOW }))).toBeDefined();
    }), { numRuns: 200 });
    fc.assert(fc.property(fc.nat(good.length - 1), fc.integer({ min: 1, max: 255 }), (at, flip) => {
      const bad = good.slice(); bad[at] ^= flip;
      expect(reason(() => h.bob.open(bad, { now: NOW }))).toBeDefined();
    }), { numRuns: 200 });
    fc.assert(fc.property(fc.nat(good.length - 1), cut => {
      expect(reason(() => h.bob.open(good.subarray(0, cut), { now: NOW }))).toBeDefined();
    }), { numRuns: 100 });
  });
});

describe("hold pointers: refusals", () => {
  const body = (over: Partial<Record<number, unknown>> = {}) => {
    const b: unknown[] = [1, 3, NOW, NOW + 60_000, "https://s3.example/m", 4, 2, 1, 100, [1, 2]];
    for (const [i, v] of Object.entries(over)) b[Number(i)] = v;
    return b;
  };

  it("reads a hand-built pointer, and one from before refusals were listed", () => {
    const h = setup();
    expect(h.bob.readPointer(h.pointerPacket(body()), NOW)).toEqual({ rev: 3, issued: NOW, expires: NOW + 60_000, manifestUrl: "https://s3.example/m", top: 4, ack: 2, count: 1, bytes: 100, refused: [1, 2] });
    expect(h.bob.readPointer(h.pointerPacket(body().slice(0, 9)), NOW)?.refused).toEqual([]);
    expect(h.bob.readPointer(h.pointerPacket(body({ 4: null })), NOW)?.manifestUrl).toBeNull();
  });

  it("refuses a packet under another key, with no or two pointer records, or too large", () => {
    const h = setup(), good = h.pointerPacket(body());
    expect(h.bob.readPointer({ ...good, pubKeyZ32: h.bob.identity.pubKeyZ32 }, NOW)).toBeNull();
    expect(h.bob.readPointer({ ...good, records: [] }, NOW)).toBeNull();
    expect(h.bob.readPointer({ ...good, records: [{ ...good.records[0], label: "_dm" }] }, NOW)).toBeNull();
    expect(h.bob.readPointer({ ...good, records: [good.records[0], good.records[0]] }, NOW)).toBeNull();
    expect(h.bob.readPointer({ ...good, records: [good.records[0], { label: "_pad", value: "x".repeat(1200), ttl: 60 }] }, NOW)).toBeNull();
  });

  it("refuses a record that does not decrypt, or decrypts to something that is not a pointer", () => {
    const h = setup();
    const raw = (plain: string) => h.pointerPacket([], "", [{ label: "_hold", value: encrypt(plain, h.sealKey), ttl: 60 }]);
    expect(h.bob.readPointer(h.pointerPacket([], "", [{ label: "_hold", value: encrypt("[]", randomBytes(32)), ttl: 60 }]), NOW)).toBeNull();
    for (const plain of ["{", "{}", "[1,2]", JSON.stringify([body(), "A".repeat(86), 1]), JSON.stringify(["body", "A".repeat(86)]),
      JSON.stringify([body().slice(0, 8), "A".repeat(86)]), JSON.stringify([[...body(), 1], "A".repeat(86)]), JSON.stringify([body(), 7]), JSON.stringify([body(), "short"])]) {
      expect(h.bob.readPointer(raw(plain), NOW)).toBeNull();
    }
  });

  it.each([
    ["version 2", { 0: 2 }],
    ["a negative revision", { 1: -1 }],
    ["a fractional count", { 7: 0.5 }],
    ["a string byte total", { 8: "100" }],
    ["a numeric manifest URL", { 4: 42 }],
    ["a manifest URL over 2048 characters", { 4: `https://s3.example/${"a".repeat(2048)}` }],
    ["an issue date past clock skew", { 2: NOW + HOLD_LIMITS.clockSkewMs + 1 }],
    ["refusals that are not a list", { 9: "1,2" }],
    ["33 refusals", { 9: Array.from({ length: 33 }, (_, i) => i + 1) }],
    ["a zero refusal", { 9: [0] }],
  ])("refuses a validly signed pointer with %s", (_, over) => {
    const h = setup();
    expect(h.bob.readPointer(h.pointerPacket(body(over)), NOW)).toBeNull();
  });

  it("accepts an issue date at the edge of clock skew", () => {
    const h = setup();
    expect(h.bob.readPointer(h.pointerPacket(body({ 2: NOW + HOLD_LIMITS.clockSkewMs })), NOW)?.issued).toBe(NOW + HOLD_LIMITS.clockSkewMs);
  });

  it("refuses a pointer whose signature does not verify, or was made for the other direction", () => {
    const h = setup();
    expect(h.bob.readPointer(h.pointerPacket(body(), "A".repeat(86)), NOW)).toBeNull();
    const reversed = toBase64Url(sign(utf8Encode(JSON.stringify(["ghostly-hold-pointer", h.alice.to, h.alice.from, body()])), identityFromSeedB64(h.aliceSeed).seed));
    expect(h.bob.readPointer(h.pointerPacket(body(), reversed), NOW)).toBeNull();
    // A newer revision signed over an older body does not pass either.
    const older = toBase64Url(sign(utf8Encode(JSON.stringify(["ghostly-hold-pointer", h.alice.from, h.alice.to, body({ 1: 2 })])), identityFromSeedB64(h.aliceSeed).seed));
    expect(h.bob.readPointer(h.pointerPacket(body(), older), NOW)).toBeNull();
  });

  it("keeps only the last 32 refusals when publishing, and clamps the record lifetime", () => {
    const h = setup();
    const pointer: HoldPointer = { rev: 1, issued: NOW, expires: NOW + 10 * 24 * 3600_000, manifestUrl: null, top: 0, ack: 0, count: 0, bytes: 0,
      refused: Array.from({ length: 40 }, (_, i) => i + 1) };
    const records = h.alice.pointerRecords(pointer, NOW);
    expect(records[0].ttl).toBe(24 * 3600);
    expect(h.alice.pointerRecords({ ...pointer, expires: NOW }, NOW)[0].ttl).toBe(60);
    const read = h.bob.readPointer({ pubKeyZ32: h.alice.identity.pubKeyZ32, timestampMicros: 0n, records }, NOW)!;
    expect(read.refused).toEqual(pointer.refused.slice(-32));
  });
});

describe("manifests and storage addresses", () => {
  const entry = (over: Partial<Record<number, unknown>> = {}) => {
    const e: unknown[] = [1, "abcdefgh", "text", 10, "https://s3.example/o", NOW];
    for (const [i, v] of Object.entries(over)) e[Number(i)] = v;
    return e;
  };
  it.each([
    ["no meta", null],
    ["no entries", {}],
    ["entries that are not a list", { entries: "x" }],
  ])("refuses a manifest with %s", (_, meta) => {
    expect(() => readManifest(meta)).toThrow(/too many/);
  });

  it.each([
    ["an entry that is not a list", "entry"],
    ["an entry of five fields", entry().slice(0, 5)],
    ["a sequence of zero", entry({ 0: 0 })],
    ["a fractional sequence", entry({ 0: 1.5 })],
    ["a bad id", entry({ 1: "a b" })],
    ["a manifest listed inside a manifest", entry({ 2: "manifest" })],
    ["an unknown kind", entry({ 2: "video" })],
    ["negative bytes", entry({ 3: -1 })],
    ["a numeric URL", entry({ 4: 1 })],
    ["a fractional expiry", entry({ 5: 1.5 })],
  ])("refuses a manifest with %s", (_, e) => {
    expect(() => readManifest({ entries: [e] })).toThrow(HoldRefusedError);
  });

  it("accepts exactly the mailbox bundle and byte limits", () => {
    expect(readManifest({ entries: Array.from({ length: HOLD_LIMITS.maxMailboxBundles }, (_, i) => entry({ 0: i + 1, 3: 1 })) })).toHaveLength(64);
    expect(readManifest({ entries: Array.from({ length: 8 }, (_, i) => entry({ 0: i + 1, 3: HOLD_LIMITS.maxBundleBytes })) })).toHaveLength(8);
    expect(readManifest({ entries: [entry({ 3: HOLD_LIMITS.maxBundleBytes })] })).toHaveLength(1);
  });

  it("only trusts HTTPS, or plain HTTP to this very machine", () => {
    for (const url of ["https://s3.example/o", "http://localhost:9000/o", "http://127.0.0.1/o", "http://[::1]:9000/o"]) expect(isHoldUrl(url)).toBe(true);
    for (const url of [42, null, "", "not a url", "http://10.0.0.1/o", "http://localhost.evil.example/o", "file:///etc/passwd", "javascript:alert(1)", `https://s3.example/${"a".repeat(2048)}`]) {
      expect(isHoldUrl(url)).toBe(false);
    }
  });
});
