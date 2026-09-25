import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  ATPROTO_PROOF_COLLECTION, AtprotoCid, AtprotoProofError, atprotoCidFor, atprotoDidMethod, atprotoProofRecord, atprotoProofRkey,
  checkAtprotoProofRecord, decodeAtprotoCommit, decodeDagCbor, encodeDagCbor, findInMst, identityStatement, normalizeAtprotoHandle,
  parseAtprotoCar, parseAtprotoDidDocument, parseAtprotoDidKey, parseAtprotoVerificationKey, readAtprotoCid, shortAtprotoDid,
  unsignedCommitBytes, verifyAtprotoRecordProof, verifyAtprotoSignature, type CborValue, type IdentityBinding,
} from "../src";

// covers: proofs.atproto.repo

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/atproto/${name}`, import.meta.url)));
const json = (name: string) => JSON.parse(new TextDecoder().decode(fixture(name)));

// Captured from a local PDS (e2e/infra/atproto, the legacy key form of the PLC it runs) and from bsky.app's own
// public repository on a Bluesky PDS (the Multikey form, a real tree several levels deep).
const binding = json("local-binding.json") as IdentityBinding;
const statement = identityStatement(binding);
const local = parseAtprotoDidDocument(json("local-did.json"), binding.subject);
const BSKY = "did:plc:z72i7hdynmk6r22z27h6tvur";
const bsky = parseAtprotoDidDocument(json("bsky-app-did.json"), BSKY);
const localProof = { did: binding.subject, key: local.key, collection: ATPROTO_PROOF_COLLECTION, rkey: binding.key };

/** Writes a CAR back from its parts, for tampering with one. */
function writeCar(roots: AtprotoCid[], blocks: { cid: AtprotoCid; data: Uint8Array }[]): Uint8Array {
  const varint = (n: number) => { const out: number[] = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return out; };
  const header = encodeDagCbor({ roots, version: 1 });
  const parts = [...varint(header.length), ...header];
  for (const b of blocks) parts.push(...varint(b.cid.bytes.length + b.data.length), ...b.cid.bytes, ...b.data);
  return new Uint8Array(parts);
}

describe("repository record proofs", () => {
  it("verifies a Ghostly proof record written on a PDS, against the DID's key", () => {
    const proof = verifyAtprotoRecordProof(fixture("local-proof.car"), localProof);
    expect(proof.commit.did).toBe(binding.subject);
    expect(proof.record).not.toBeNull();
    expect(() => checkAtprotoProofRecord(proof.record!.value, statement)).not.toThrow();
  });

  it("proves the record absent once it is deleted", () => {
    expect(verifyAtprotoRecordProof(fixture("local-deleted.car"), localProof).record).toBeNull();
  });

  it("walks a real tree several levels deep (bsky.app's profile), in both directions", () => {
    const found = verifyAtprotoRecordProof(fixture("bsky-app-profile.car"), { did: BSKY, key: bsky.key, collection: "app.bsky.actor.profile", rkey: "self" });
    expect(found.record?.value.$type).toBe("app.bsky.actor.profile");
    const missing = verifyAtprotoRecordProof(fixture("bsky-app-missing.car"), { did: BSKY, key: bsky.key, collection: ATPROTO_PROOF_COLLECTION, rkey: binding.key });
    expect(missing.record).toBeNull();
    const car = parseAtprotoCar(fixture("bsky-app-profile.car"));
    expect(car.blocks.size).toBeGreaterThan(3);
  });

  it("refuses a commit signed by another key, or for another account", () => {
    expect(() => verifyAtprotoRecordProof(fixture("local-proof.car"), { ...localProof, key: bsky.key })).toThrow("not signed by the account's key");
    expect(() => verifyAtprotoRecordProof(fixture("local-proof.car"), { ...localProof, did: BSKY })).toThrow("another account");
  });

  it("refuses a block that does not match its hash", () => {
    const car = fixture("local-proof.car");
    const tampered = car.slice();
    tampered[tampered.length - 5] ^= 1;
    expect(() => verifyAtprotoRecordProof(tampered, localProof)).toThrow(AtprotoProofError);
  });

  it("refuses a proof missing a block of the path, and a truncated file", () => {
    const { roots, blocks } = parseAtprotoCar(fixture("bsky-app-profile.car"));
    const commit = decodeAtprotoCommit(blocks.get(roots[0].key)!.data);
    const withoutRoot = [...blocks.values()].filter(b => !b.cid.equals(commit.data));
    expect(() => verifyAtprotoRecordProof(writeCar(roots, withoutRoot), { did: BSKY, key: bsky.key, collection: "app.bsky.actor.profile", rkey: "self" }))
      .toThrow("missing part of the repository tree");
    const car = fixture("local-proof.car");
    expect(() => verifyAtprotoRecordProof(car.subarray(0, car.length - 10), localProof)).toThrow(AtprotoProofError);
    expect(() => verifyAtprotoRecordProof(new Uint8Array(0), localProof)).toThrow(AtprotoProofError);
  });

  it("refuses a proof whose record block is missing, or a CAR without its commit", () => {
    const { roots, blocks } = parseAtprotoCar(fixture("local-proof.car"));
    const proof = verifyAtprotoRecordProof(fixture("local-proof.car"), localProof);
    const noRecord = [...blocks.values()].filter(b => !b.cid.equals(proof.record!.cid));
    expect(() => verifyAtprotoRecordProof(writeCar(roots, noRecord), localProof)).toThrow("missing the record");
    const noCommit = [...blocks.values()].filter(b => !b.cid.equals(roots[0]));
    expect(() => verifyAtprotoRecordProof(writeCar(roots, noCommit), localProof)).toThrow("no commit");
  });

  it("caps the number of blocks", () => {
    expect(() => parseAtprotoCar(fixture("bsky-app-profile.car"), { maxBlocks: 2 })).toThrow("Too many blocks");
  });

  it("signs over the commit without its sig, and only low-S signatures count", () => {
    const { roots, blocks } = parseAtprotoCar(fixture("local-proof.car"));
    const data = blocks.get(roots[0].key)!.data;
    const commit = decodeAtprotoCommit(data);
    const unsigned = unsignedCommitBytes(data);
    expect(verifyAtprotoSignature(local.key, unsigned, commit.sig)).toBe(true);
    // The same signature with s → n − s is valid ECDSA, but malleable: atproto refuses it.
    const sig = secp256k1.Signature.fromBytes(commit.sig, "compact");
    const high = new secp256k1.Signature(sig.r, secp256k1.Point.CURVE().n - sig.s).toBytes("compact");
    expect(verifyAtprotoSignature(local.key, unsigned, high)).toBe(false);
    expect(verifyAtprotoSignature(local.key, unsigned, commit.sig.subarray(0, 63))).toBe(false);
  });

  it("finds nothing in an empty tree, and refuses a non-dag-cbor node", () => {
    const empty = encodeDagCbor({ e: [], l: null });
    const cid = atprotoCidFor(empty);
    expect(findInMst(new Map([[cid.key, { cid, data: empty }]]), cid, "a/b")).toBeNull();
    const raw = atprotoCidFor(empty, 0x55);
    expect(() => findInMst(new Map([[raw.key, { cid: raw, data: empty }]]), raw, "a/b")).toThrow("Malformed tree node");
  });

  it("refuses tree entries out of order or with a bad prefix", () => {
    const leaf = atprotoCidFor(encodeDagCbor({ a: 1 }));
    const node = (e: CborValue[]) => { const data = encodeDagCbor({ e, l: null }); const cid = atprotoCidFor(data); return { blocks: new Map([[cid.key, { cid, data }]]), cid }; };
    const bytes = (s: string) => new TextEncoder().encode(s);
    const unordered = node([{ k: bytes("b/1"), p: 0, t: null, v: leaf }, { k: bytes("a/1"), p: 0, t: null, v: leaf }]);
    expect(() => findInMst(unordered.blocks, unordered.cid, "a/1")).toThrow("out of order");
    const prefix = node([{ k: bytes("a/1"), p: 9, t: null, v: leaf }]);
    expect(() => findInMst(prefix.blocks, prefix.cid, "a/1")).toThrow("Malformed tree entry");
  });
});

describe("DAG-CBOR", () => {
  it("round-trips what atproto uses", () => {
    const cid = atprotoCidFor(new Uint8Array([1, 2, 3]));
    const value = { a: 1, bb: [true, false, null, -5, 70000, 2 ** 40], c: new Uint8Array([9]), link: cid, text: "é" } as CborValue;
    const decoded = decodeDagCbor(encodeDagCbor(value)) as Record<string, CborValue>;
    expect(decoded.bb).toEqual([true, false, null, -5, 70000, 2 ** 40]);
    expect((decoded.link as AtprotoCid).equals(cid)).toBe(true);
    expect(encodeDagCbor(decoded)).toEqual(encodeDagCbor(value));
  });

  it("maps are prototype-free: a __proto__ key is just a key", () => {
    const decoded = decodeDagCbor(encodeDagCbor(JSON.parse('{"__proto__":1}'))) as Record<string, CborValue>;
    expect(Object.getPrototypeOf(decoded)).toBeNull();
    expect(decoded.__proto__).toBe(1);
  });

  it.each([
    ["a non-minimal length", [0x18, 0x05]],
    ["a non-minimal 16-bit length", [0x19, 0x00, 0x10]],
    ["an indefinite-length array", [0x9f, 0xff]],
    ["a float", [0xfb, 0x3f, 0xf0, 0, 0, 0, 0, 0, 0]],
    ["undefined", [0xf7]],
    ["a tag other than 42", [0xc1, 0x00]],
    ["trailing bytes", [0x01, 0x01]],
    ["keys out of order", [0xa2, 0x62, 0x62, 0x62, 0x01, 0x61, 0x61, 0x02]],
    ["a repeated key", [0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02]],
    ["a non-text key", [0xa1, 0x01, 0x02]],
    ["invalid UTF-8", [0x61, 0xff]],
    ["a truncated byte string", [0x45, 0x01]],
    ["an array longer than the input", [0x9a, 0x00, 0x10, 0x00, 0x00]],
    ["an integer beyond 2^53", [0x1b, 0x00, 0x40, 0, 0, 0, 0, 0, 0]],
    ["a CID link without the 0x00 prefix", [0xd8, 0x2a, 0x42, 0x01, 0x71]],
  ])("refuses %s", (_name, bytes) => {
    expect(() => decodeDagCbor(new Uint8Array(bytes))).toThrow(AtprotoProofError);
  });

  it("refuses nesting deeper than the limit", () => {
    expect(() => decodeDagCbor(new Uint8Array([...Array(40).fill(0x81), 0x01]))).toThrow("nested too deeply");
  });

  it("refuses CIDs atproto does not use", () => {
    expect(() => readAtprotoCid(new Uint8Array([0x12, 0x20, ...new Uint8Array(32)]))).toThrow("CIDv1");
    expect(() => readAtprotoCid(new Uint8Array([1, 0x70, 0x12, 0x20, ...new Uint8Array(32)]))).toThrow("codec");
    expect(() => readAtprotoCid(new Uint8Array([1, 0x71, 0x13, 0x40, ...new Uint8Array(64)]))).toThrow("SHA-256");
    expect(() => readAtprotoCid(new Uint8Array([1, 0x71, 0x12, 0x20, 1, 2]))).toThrow("digest");
  });

  it("refuses floats when encoding", () => {
    expect(() => encodeDagCbor(1.5)).toThrow(AtprotoProofError);
  });
});

describe("DID documents and keys", () => {
  it("reads the key, the PDS and the claimed handle, in both key encodings", () => {
    expect(local).toMatchObject({ did: binding.subject, pds: "https://pds.ghostly.test", handle: "alice.pds.ghostly.test" });
    expect(local.key.type).toBe("secp256k1");
    expect(bsky).toMatchObject({ did: BSKY, pds: "https://puffball.us-east.host.bsky.network", handle: "bsky.app" });
    expect(bsky.key.key.length).toBe(33);
  });

  const doc = (patch: Record<string, unknown>) => ({ ...json("bsky-app-did.json"), ...patch });
  it.each([
    ["for another DID", { id: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" }, "another account"],
    ["without a signing key", { verificationMethod: [] }, "no atproto signing key"],
    ["with an unknown key type", { verificationMethod: [{ id: "#atproto", type: "Ed25519VerificationKey2020", publicKeyMultibase: "z6Mk" }] }, "not supported"],
    ["without a PDS", { service: [] }, "names no server"],
    ["with an http PDS", { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "http://pds.example.com" }] }, "https"],
    ["with a PDS path", { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example.com/x" }] }, "https"],
    ["with a PDS of another type", { service: [{ id: "#atproto_pds", type: "Other", serviceEndpoint: "https://pds.example.com" }] }, "names no server"],
  ])("refuses a document %s", (_name, patch, message) => {
    expect(() => parseAtprotoDidDocument(doc(patch), BSKY)).toThrow(message);
  });

  it("refuses a document that is not an object", () => {
    expect(() => parseAtprotoDidDocument(null, BSKY)).toThrow("malformed");
    expect(() => parseAtprotoDidDocument([], BSKY)).toThrow("malformed");
  });

  it("keeps no handle when the claimed one is invalid, and takes the first at:// entry", () => {
    expect(parseAtprotoDidDocument(doc({ alsoKnownAs: ["at://not a handle"] }), BSKY).handle).toBeUndefined();
    expect(parseAtprotoDidDocument(doc({ alsoKnownAs: ["https://x.example.com", "at://First.Example.com", "at://second.example.com"] }), BSKY).handle).toBe("first.example.com");
  });

  it("parses did:key and refuses what is not one", () => {
    const key = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true);
    const multibase = parseAtprotoVerificationKey("Multikey", json("bsky-app-did.json").verificationMethod[0].publicKeyMultibase);
    expect(parseAtprotoDidKey(`did:key:${json("bsky-app-did.json").verificationMethod[0].publicKeyMultibase}`)).toEqual(multibase);
    expect(() => parseAtprotoDidKey("did:web:example.com")).toThrow("Not a did:key");
    expect(() => parseAtprotoVerificationKey("Multikey", "zzzz")).toThrow();
    expect(() => parseAtprotoVerificationKey("Multikey", "m" + key)).toThrow("Unsupported key encoding");
  });
});

describe("handles, DIDs, record keys and the record", () => {
  it.each([
    ["alice.bsky.social", "alice.bsky.social"],
    ["@Alice.Bsky.Social", "alice.bsky.social"],
    ["  miguel.example.com ", "miguel.example.com"],
    ["alice.pds.ghostly.test", "alice.pds.ghostly.test"],
    ["xn--ls8h.example.com", "xn--ls8h.example.com"],
  ])("normalizes %s", (input, handle) => expect(normalizeAtprotoHandle(input)).toBe(handle));

  it.each(["alice", "alice.local", "a.onion", "a.example", "-a.bsky.social", "a..b.com", "a.1com", "did:plc:abc", "a b.com", `${"a".repeat(64)}.com`])(
    "refuses the handle %s", input => expect(normalizeAtprotoHandle(input)).toBeNull());

  it("knows did:plc and hostname-level did:web only", () => {
    expect(atprotoDidMethod("did:plc:z72i7hdynmk6r22z27h6tvur")).toBe("plc");
    expect(atprotoDidMethod("did:web:example.com")).toBe("web");
    for (const did of ["did:plc:Z72I7HDYNMK6R22Z27H6TVUR", "did:plc:short", "did:web:example.com:8080", "did:web:example.com%3A8080", "did:web:localhost", "did:key:z6Mk", "did:web:ex ample.com"])
      expect(atprotoDidMethod(did)).toBeNull();
  });

  it("writes a DID short", () => {
    expect(shortAtprotoDid("did:plc:z72i7hdynmk6r22z27h6tvur")).toBe("did:plc:z72i7h…tvur");
    expect(shortAtprotoDid("did:web:a.com")).toBe("did:web:a.com");
  });

  it("uses the proof key as the record key", () => {
    expect(atprotoProofRkey(binding.key)).toBe(binding.key);
    expect(() => atprotoProofRkey("../x")).toThrow();
  });

  it("builds the record, and refuses one with another statement or other fields", () => {
    const record = atprotoProofRecord(statement, new Date(Date.UTC(2026, 8, 21)));
    expect(record).toEqual({ $type: ATPROTO_PROOF_COLLECTION, statement: statement.text, createdAt: "2026-09-21T00:00:00.000Z" });
    const value = decodeDagCbor(encodeDagCbor(record)) as Record<string, CborValue>;
    expect(() => checkAtprotoProofRecord(value, statement)).not.toThrow();
    const other = identityStatement({ ...binding, nonce: "BBBBBBBBBBBBBBBBBBBBBB" });
    expect(() => checkAtprotoProofRecord(value, other)).toThrow("another statement");
    expect(() => checkAtprotoProofRecord({ ...value, extra: 1 }, statement)).toThrow("not a Ghostly proof");
    expect(() => checkAtprotoProofRecord({ ...value, $type: "app.bsky.feed.post" }, statement)).toThrow("not a Ghostly proof");
    expect(() => checkAtprotoProofRecord({ ...value, createdAt: 5 }, statement)).toThrow("not a Ghostly proof");
  });
});
