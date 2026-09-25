import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base58 } from "@scure/base";
import {
  checkDidJws, checkDidSignature, didGhostlyServiceEntry, didSignedMessages, didWebDocumentUrl, didWebFile, didWebFileNames, didWebFileUrl,
  didWebHost, DidError, normalizeDid, parseDid, parseDidDocument, parseDidJws, parseDidSignaturePaste, signingKeys, staticDidDocument,
  toBase64Url, utf8Encode, type DidCurve,
} from "../src";
// covers: proofs.did

const b64u = (b: Uint8Array) => toBase64Url(b);
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const json64 = (v: unknown) => b64u(utf8Encode(JSON.stringify(v)));

// did:key spec test vectors (w3c-ccg/did-method-key, test-vectors/*.json).
const ED_DID = "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp"; // seed 0x00 × 32
const SECP_DID = "did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme";
const P256_DID = "did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169";
// did:jwk spec examples (quartzjer/did-jwk): a P-256 key, and an X25519 key marked for encryption.
const JWK_P256 = "did:jwk:eyJjcnYiOiJQLTI1NiIsImt0eSI6IkVDIiwieCI6ImFjYklRaXVNczNpOF91c3pFakoydHBUdFJNNEVVM3l6OTFQSDZDZEgyVjAiLCJ5IjoiX0tjeUxqOXZXTXB0bm1LdG00NkdxRHo4d2Y3NEk1TEtncmwyR3pIM25TRSJ9";
const JWK_X25519 = "did:jwk:eyJrdHkiOiJPS1AiLCJjcnYiOiJYMjU1MTkiLCJ1c2UiOiJlbmMiLCJ4IjoiM3A3YmZYdDl3YlRUVzJIQzdPUTFOei1EUThoYmVHZE5yZngtRkctSUswOCJ9";

const STATEMENT = "Ghostly identity proof v1: I control did:key:x and authorize the Ghostly key k to present it. Nonce: n";
const messages = didSignedMessages(STATEMENT);

/** A key pair on a curve, its did:key, and signers in the shapes people paste. */
function keyOn(curve: DidCurve) {
  const lib = curve === "Ed25519" ? ed25519 : curve === "secp256k1" ? secp256k1 : p256;
  const secret = lib.utils.randomSecretKey();
  const pub = curve === "Ed25519" ? ed25519.getPublicKey(secret) : (lib as typeof p256).getPublicKey(secret, true);
  const prefix = { Ed25519: [0xed, 0x01], secp256k1: [0xe7, 0x01], "P-256": [0x80, 0x24] }[curve];
  const did = `did:key:z${base58.encode(Uint8Array.from([...prefix, ...pub]))}`;
  const alg = { Ed25519: "EdDSA", secp256k1: "ES256K", "P-256": "ES256" }[curve];
  const raw = (message: Uint8Array) => curve === "Ed25519" ? ed25519.sign(message, secret) : (lib as typeof p256).sign(message, secret);
  const jws = (header: Record<string, unknown>, message = utf8Encode(STATEMENT), detached = false) => {
    const h = json64({ alg, ...header });
    const payload = b64u(message);
    return `${h}.${detached ? "" : payload}.${b64u(raw(utf8Encode(`${h}.${payload}`)))}`;
  };
  return { did, secret, pub, alg, raw, jws, doc: () => staticDidDocument(did) };
}

describe("DID syntax", () => {
  it("accepts the four methods and gives the canonical form", () => {
    expect(parseDid(ED_DID)).toEqual({ did: ED_DID, method: "key", id: ED_DID.slice(8) });
    expect(normalizeDid(`  ${JWK_P256}\n`)).toBe(JWK_P256);
    expect(normalizeDid("did:web:Example.COM")).toBe("did:web:example.com");
    expect(normalizeDid("did:web:example.com%3a8443:user:alice")).toBe("did:web:example.com%3A8443:user:alice");
    const dht = "did:dht:" + "y".repeat(52);
    expect(normalizeDid(dht.toUpperCase().replace("DID:DHT", "did:dht"))).toBe(dht);
  });

  it("refuses other methods as not supported yet, and says which are", () => {
    expect(() => parseDid("did:plc:ewvi7nxzyoun6zhxrhs64oiz")).toThrow(/did:plc is not supported yet.*did:key, did:jwk, did:dht and did:web/);
    expect(() => parseDid("did:ion:EiClkZMDxPKqC9c-umQfTkR8vvZ9JPhl_xLDI9Nfk38w5w")).toThrow(/not supported yet/);
  });

  it("refuses what is not a DID, or a DID URL", () => {
    for (const bad of ["", "example.com", "did:", "did:key", "did::abc", "did:key:z6Mk abc", `${ED_DID}#key-1`, "did:web:example.com/path", "did:web:example.com?x=1", "DID:KEY:" + ED_DID.slice(8)])
      expect(() => parseDid(bad), bad).toThrow(DidError);
    expect(() => parseDid("did:KEY:z6Mk")).toThrow(/lowercase/);
    expect(() => parseDid("did:web:" + "a".repeat(600) + ".com")).toThrow(/too long/);
  });

  it("checks did:web domains like the domain proof: public names only, no IP addresses, sane paths", () => {
    for (const bad of ["did:web:localhost", "did:web:192.168.1.10", "did:web:printer.local", "did:web:example", "did:web:example.com:..", "did:web:example.com:a%2Fb", "did:web:ex%41mple.com", "did:web:example.com%3A99999"])
      expect(() => parseDid(bad), bad).toThrow(DidError);
  });

  it("checks the did:dht key", () => {
    expect(() => parseDid("did:dht:abc")).toThrow(/52 z-base-32/);
    expect(() => parseDid("did:dht:" + "0".repeat(52))).toThrow(/52 z-base-32/);
  });
});

describe("did:web URLs", () => {
  it("builds did.json and the statement file beside it (spec examples)", () => {
    expect(didWebDocumentUrl("did:web:w3c-ccg.github.io")).toBe("https://w3c-ccg.github.io/.well-known/did.json");
    expect(didWebDocumentUrl("did:web:w3c-ccg.github.io:user:alice")).toBe("https://w3c-ccg.github.io/user/alice/did.json");
    expect(didWebDocumentUrl("did:web:example.com%3A3000:user:alice")).toBe("https://example.com:3000/user/alice/did.json");
    const id = "a".repeat(64);
    expect(didWebFileUrl("did:web:example.com", id)).toBe(`https://example.com/.well-known/ghostly/${id}.json`);
    expect(didWebFileUrl("did:web:example.com:user:alice", id)).toBe(`https://example.com/user/alice/ghostly/${id}.json`);
    expect(() => didWebFileUrl("did:web:example.com", "../x")).toThrow();
    expect(didWebHost("did:web:example.com%3A3000:u")).toBe("example.com");
    expect(() => didWebDocumentUrl(ED_DID)).toThrow(/Not a did:web/);
  });

  it("a statement file names exactly this DID and statement", () => {
    const file = didWebFile("did:web:example.com", STATEMENT);
    expect(didWebFileNames(file, "did:web:example.com", STATEMENT)).toBe(true);
    expect(didWebFileNames(file, "did:web:example.org", STATEMENT)).toBe(false);
    expect(didWebFileNames(file, "did:web:example.com", `${STATEMENT}x`)).toBe(false);
    expect(didWebFileNames("not json", "did:web:example.com", STATEMENT)).toBe(false);
    expect(didWebFileNames(JSON.stringify({ ghostly: 1, did: "did:web:example.com", statement: STATEMENT, pad: "x".repeat(20_000) }), "did:web:example.com", STATEMENT)).toBe(false);
  });
});

describe("did:key and did:jwk documents", () => {
  it("reads the spec vectors: Ed25519, secp256k1 and P-256", () => {
    const ed = staticDidDocument(ED_DID).keys[0];
    expect(ed).toMatchObject({ id: `${ED_DID}#${ED_DID.slice(8)}`, curve: "Ed25519", relationships: ["authentication", "assertionMethod"] });
    expect(hex(ed.publicKey)).toBe(hex(ed25519.getPublicKey(new Uint8Array(32))));
    expect(base58.encode(ed.publicKey)).toBe("4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS");
    const secp = staticDidDocument(SECP_DID).keys[0];
    expect(secp.curve).toBe("secp256k1");
    expect(b64u(secp256k1.Point.fromBytes(secp.publicKey).toBytes(false).slice(1, 33))).toBe("h0wVx_2iDlOcblulc8E5iEw1EYh5n1RYtLQfeSTyNc0");
    const nist = staticDidDocument(P256_DID).keys[0];
    expect(nist.curve).toBe("P-256");
    expect(b64u(p256.Point.fromBytes(nist.publicKey).toBytes(false).slice(33))).toBe("hW2ojTNfH7Jbi8--CJUo3OCbH3y5n91g-IMA9MLMbTU");
  });

  it("reads did:jwk: #0, and no signing for a key marked for encryption", () => {
    const k = staticDidDocument(JWK_P256).keys[0];
    expect(k).toMatchObject({ id: `${JWK_P256}#0`, curve: "P-256", relationships: ["authentication", "assertionMethod"] });
    expect(b64u(p256.Point.fromBytes(k.publicKey).toBytes(false).slice(1, 33))).toBe("acbIQiuMs3i8_uszEjJ2tpTtRM4EU3yz91PH6CdH2V0");
    expect(() => staticDidDocument(JWK_X25519)).toThrow(/not an Ed25519, secp256k1 or P-256/);
    const edEnc = `did:jwk:${json64({ kty: "OKP", crv: "Ed25519", use: "enc", x: b64u(ed25519.getPublicKey(new Uint8Array(32))) })}`;
    expect(staticDidDocument(edEnc).keys[0].relationships).toEqual([]);
  });

  it("refuses a did:jwk carrying a private key, and malformed ones", () => {
    const secret = ed25519.utils.randomSecretKey();
    const leaked = `did:jwk:${json64({ kty: "OKP", crv: "Ed25519", x: b64u(ed25519.getPublicKey(secret)), d: b64u(secret) })}`;
    expect(() => parseDid(leaked)).toThrow(/private key/);
    expect(() => parseDid("did:jwk:bm90IGpzb24")).toThrow(/JSON Web Key/);
    expect(() => parseDid(`did:jwk:${json64({ kty: "EC", crv: "P-256", x: "AAAA", y: "AAAA" })}`)).toThrow(/malformed/);
    expect(() => parseDid(`did:jwk:${json64({ kty: "EC", crv: "P-256", x: b64u(new Uint8Array(32)), y: b64u(new Uint8Array(32)) })}`)).toThrow(/not a valid point/);
  });

  it("refuses an X25519 did:key (encryption only) and unknown codecs", () => {
    const x = `did:key:z${base58.encode(Uint8Array.from([0xec, 0x01, ...new Uint8Array(32).fill(9)]))}`;
    expect(() => parseDid(x)).toThrow(/X25519 encryption key/);
    expect(() => parseDid(`did:key:z${base58.encode(Uint8Array.from([0x12, 0x00, 1, 2, 3]))}`)).toThrow(/Ghostly can read/);
    expect(() => parseDid("did:key:m1234")).toThrow(/Ghostly can read/);
  });
});

describe("DID documents", () => {
  const did = "did:web:example.com";
  const ed = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  const p = p256.getPublicKey(p256.utils.randomSecretKey(), false);
  const doc = {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: did,
    verificationMethod: [
      { id: `${did}#key-1`, type: "JsonWebKey2020", controller: did, publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: b64u(ed) } },
      { id: "#key-2", type: "JsonWebKey", controller: did, publicKeyJwk: { kty: "EC", crv: "P-256", x: b64u(p.slice(1, 33)), y: b64u(p.slice(33)) } },
      { id: `${did}#agree`, type: "X25519KeyAgreementKey2020", controller: did, publicKeyMultibase: `z${base58.encode(Uint8Array.from([0xec, 0x01, ...new Uint8Array(32).fill(7)]))}` },
      { id: `${did}#only-listed`, type: "Multikey", controller: did, publicKeyMultibase: `z${base58.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(new Uint8Array(32))]))}` },
      { id: "did:web:other.example#key-1", type: "Multikey", publicKeyMultibase: "z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp" },
    ],
    authentication: [`${did}#key-1`, { id: `${did}#embedded`, type: "Ed25519VerificationKey2018", publicKeyBase58: base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(1))) }],
    assertionMethod: ["#key-2", `${did}#key-1`, `${did}#agree`],
    keyAgreement: [`${did}#agree`],
    service: [
      didGhostlyServiceEntry(did, "y".repeat(52), "c".repeat(64)),
      { id: `${did}#hub`, type: "LinkedDomains", serviceEndpoint: "https://example.com" },
      { id: `${did}#bad`, type: "GhostlyIdentityProof", serviceEndpoint: { key: "nope", proof: "c".repeat(64) } },
    ],
  };

  it("keeps usable keys with their relationships, counts the rest, and reads Ghostly services", () => {
    const view = parseDidDocument(did, doc);
    expect(view.keys.map(k => [k.id.slice(did.length), k.curve, k.relationships.join("+")])).toEqual([
      ["#key-1", "Ed25519", "authentication+assertionMethod"],
      ["#key-2", "P-256", "assertionMethod"],
      ["#only-listed", "Ed25519", ""],
      ["#embedded", "Ed25519", "authentication"],
    ]);
    expect(view.skipped).toBe(2); // the X25519 key and the other DID's
    expect(signingKeys(view).map(k => k.id)).not.toContain(`${did}#only-listed`);
    expect(view.services).toEqual([{ id: `${did}#ghostly-cccccccccccc`, key: "y".repeat(52), proof: "c".repeat(64) }]);
  });

  it("refuses a document for another DID, or not an object", () => {
    expect(() => parseDidDocument(did, { ...doc, id: "did:web:evil.example" })).toThrow(/another DID/);
    expect(() => parseDidDocument(did, [])).toThrow(/not a JSON object/);
    expect(() => parseDidDocument(did, { ...doc, verificationMethod: {} })).toThrow(/not a list/);
  });
});

describe("DID signatures", () => {
  it("verifies the RFC 8037 Ed25519 JWS (A.4)", () => {
    const x = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    const jwk = `did:jwk:${json64({ kty: "OKP", crv: "Ed25519", x })}`;
    const jws = "eyJhbGciOiJFZERTQSJ9.RXhhbXBsZSBvZiBFZDI1NTE5IHNpZ25pbmc.hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR6dWbhijcNR4ki4iylGjg5BhVsPt9g7sVvpAr_MuM0KAg";
    expect(checkDidJws(jws, [utf8Encode("Example of Ed25519 signing")], staticDidDocument(jwk))).toMatchObject({ alg: "EdDSA", key: { id: `${jwk}#0` } });
    expect(() => checkDidJws(jws, messages, staticDidDocument(jwk))).toThrow(/another text/);
  });

  it.each(["Ed25519", "secp256k1", "P-256"] as const)("%s: attached and detached JWS, with and without kid, and raw signatures", curve => {
    const k = keyOn(curve);
    const doc = k.doc();
    const vm = doc.keys[0].id;
    expect(checkDidJws(k.jws({}), messages, doc).key.id).toBe(vm);
    expect(checkDidJws(k.jws({ kid: vm }, undefined, true), messages, doc).alg).toBe(k.alg);
    expect(checkDidJws(k.jws({ kid: `#${vm.split("#")[1]}` }), messages, doc).key.id).toBe(vm);
    // RFC 7797: the statement signed as it is.
    const h = json64({ alg: k.alg, b64: false, crit: ["b64"] });
    const unencoded = `${h}..${b64u(k.raw(Uint8Array.from([...utf8Encode(`${h}.`), ...utf8Encode(STATEMENT)])))}`;
    expect(checkDidJws(unencoded, messages, doc).key.id).toBe(vm);
    // Raw: 64 bytes, hex or base64, with the newline echo adds, and DER for ECDSA.
    const sig = k.raw(utf8Encode(STATEMENT));
    const checked = checkDidSignature(sig, messages, doc);
    expect(hex(checked.signature)).toBe(hex(sig));
    expect(checkDidSignature(k.raw(utf8Encode(`${STATEMENT}\n`)), messages, doc, vm).key.id).toBe(vm);
    if (curve !== "Ed25519") {
      const lib = curve === "secp256k1" ? secp256k1 : p256;
      const der = lib.Signature.fromBytes(sig, "compact").toBytes("der");
      expect(hex(checkDidSignature(der, messages, doc).signature)).toBe(hex(sig));
    }
  });

  it("refuses another key, another text, and a kid of another DID or the wrong curve", () => {
    const k = keyOn("Ed25519"), other = keyOn("Ed25519");
    expect(() => checkDidJws(other.jws({}), messages, k.doc())).toThrow(/does not match/);
    expect(() => checkDidJws(k.jws({}, utf8Encode("something else")), messages, k.doc())).toThrow(/another text/);
    expect(() => checkDidJws(k.jws({ kid: `${other.did}#x` }), messages, k.doc())).toThrow(/not a key of/);
    expect(() => checkDidJws(k.jws({ kid: `${k.did}#nope` }), messages, k.doc())).toThrow(/lists no key/);
    expect(() => checkDidSignature(other.raw(utf8Encode(STATEMENT)), messages, k.doc())).toThrow(/does not match/);
    const secp = keyOn("secp256k1");
    expect(() => checkDidJws(secp.jws({}), messages, k.doc())).toThrow(/no secp256k1 key/);
  });

  it("refuses a key the document lists but not for authentication or assertionMethod", () => {
    const k = keyOn("Ed25519");
    const did = "did:web:example.com";
    const view = parseDidDocument(did, { id: did, verificationMethod: [{ id: "#delegate", type: "Multikey", publicKeyMultibase: k.did.slice(8) }], capabilityDelegation: ["#delegate"] });
    expect(() => checkDidJws(k.jws({}), messages, view)).toThrow(/not list under authentication or assertionMethod/);
    expect(() => checkDidSignature(k.raw(utf8Encode(STATEMENT)), messages, view)).toThrow(/not list under authentication or assertionMethod/);
  });

  it("parses only JWS it can check", () => {
    const k = keyOn("Ed25519");
    const sig = b64u(new Uint8Array(64));
    for (const [header, why] of [
      [{ alg: "HS256" }, /Ghostly checks EdDSA, ES256K and ES256/],
      [{ alg: "none" }, /Ghostly checks/],
      [{ alg: "EdDSA", crit: ["exp"] }, /crit/],
      [{ alg: "EdDSA", b64: false }, /crit/],
      [{ alg: "EdDSA", b64: "no" }, /b64/],
      [{ alg: "EdDSA", kid: 5 }, /kid/],
    ] as const) expect(() => parseDidJws(`${json64(header)}..${sig}`), JSON.stringify(header)).toThrow(why);
    expect(() => parseDidJws(`${json64({ alg: "EdDSA", b64: false, crit: ["b64"] })}.${b64u(utf8Encode("x"))}.${sig}`)).toThrow(/detached/);
    expect(() => parseDidJws("a.b")).toThrow(/three parts/);
    expect(() => parseDidJws(`${json64({ alg: "EdDSA" })}..${b64u(new Uint8Array(63))}`)).toThrow(/64 bytes/);
    expect(() => parseDidJws(`${json64({ alg: "EdDSA" })}=..${sig}`)).toThrow(/base64url/);
    expect(() => parseDidJws("x".repeat(5000))).toThrow();
    expect(parseDidJws(k.jws({ kid: "#a" }))).toMatchObject({ alg: "EdDSA", curve: "Ed25519", kid: "#a", b64: true });
  });
});

describe("pasted signatures", () => {
  const sig = Uint8Array.from({ length: 64 }, (_, i) => i);
  it("tells a JWS from a raw signature, in hex, base64 or base64url, with an optional key id", () => {
    const jws = `${json64({ alg: "EdDSA" })}..${b64u(sig)}`;
    expect(parseDidSignaturePaste(`  ${jws}\n`)).toEqual({ kind: "jws", jws });
    expect(parseDidSignaturePaste(`${jws.slice(0, 30)}\n${jws.slice(30)}`)).toEqual({ kind: "jws", jws });
    expect(parseDidSignaturePaste(hex(sig))).toEqual({ kind: "raw", vm: undefined, signature: sig });
    expect(parseDidSignaturePaste(btoa(String.fromCharCode(...sig)))).toEqual({ kind: "raw", vm: undefined, signature: sig });
    expect(parseDidSignaturePaste(`#key-1 ${b64u(sig)}`)).toEqual({ kind: "raw", vm: "#key-1", signature: sig });
    expect(parseDidSignaturePaste(`did:web:example.com#k\n${hex(sig).slice(0, 64)}\n${hex(sig).slice(64)}`)).toMatchObject({ vm: "did:web:example.com#k", signature: sig });
  });
  it("refuses what is not a signature", () => {
    expect(() => parseDidSignaturePaste("")).toThrow(/Paste/);
    expect(() => parseDidSignaturePaste("hello world!")).toThrow(/not a signature/);
    expect(() => parseDidSignaturePaste(`#k ${json64({ alg: "EdDSA" })}..${b64u(sig)}`)).toThrow(/JWS alone/);
    expect(() => parseDidSignaturePaste("a".repeat(500))).toThrow(/too long/);
  });
});
