import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  APP_PREFIXES, appFingerprint, appRef, appSignedBytes, buildAppBundle, canonicalJson, canonicalJsonBytes, isAppRef, readAppRevocation,
  readAppRevocations, signAppObject, signAppRevocation, toBase64Url, utf8Encode, verifyAppStatementBytes, type AppPrefix, type AppRevokeStatement,
  type AppSignature, type SignedAppRevocation,
} from "../src/index";
import { DRAFT, ENTRY, appKey, appSigner, matchVectorFile } from "./appVectors";
// covers: apps.bundle

/*
 * The signed statements of WISP 1200 (Signatures, Publisher keys): one object signed under each phase 1 prefix with its
 * signed bytes, and the publisher's `ghostly-revoke/1` revocations, by digests and up to a sequence. Pinned by
 * `vectors/app-statements.json`; write it again with `APPS_VECTORS_WRITE=1 npx vitest run test/appStatements.test.ts`.
 */

const FILE = fileURLToPath(new URL("./vectors/app-statements.json", import.meta.url));
const publisher = appSigner("publisher");
const other = appSigner("other publisher");
const store = appSigner("store");
const REF = appRef(appKey("publisher"), "chess");

type StatementCase = { name: string; prefix: AppPrefix; json: string; key: string; signedBytes?: string; signature: AppSignature };
type InvalidCase =
  | { name: string; check: "statement"; refusal: string; prefix: AppPrefix; json: string; key: string; signature: AppSignature }
  | { name: string; check: "revocation"; refusal: string; value: unknown }
  | { name: string; check: "revocations-file"; refusal: string; json: string };
interface Vectors {
  about: Record<string, string>;
  inputs: { keys: Record<string, { label: string; key: string }>; ref: string };
  valid: { statements: StatementCase[]; revocations: { name: string; value: SignedAppRevocation }[]; file: { json: string; count: number } };
  invalid: InvalidCase[];
}

async function signed(name: string, prefix: AppPrefix, value: unknown, signer = publisher): Promise<StatementCase> {
  const { bytes, signature } = await signAppObject(prefix, value, signer);
  return { name, prefix, json: new TextDecoder().decode(bytes), key: signature.key, signedBytes: bytesToHex(appSignedBytes(prefix, bytes)), signature };
}

async function build(): Promise<Vectors> {
  const chess = await buildAppBundle(DRAFT, [ENTRY], publisher);
  const chess2 = await buildAppBundle({ ...DRAFT, version: "1.0.1", sequence: 2 }, [ENTRY], publisher);
  const byDigests: AppRevokeStatement = { ghostlyRevoke: 1, app: REF, digests: [chess.digest, chess2.digest], reason: "Leaked a test key" };
  const upTo: AppRevokeStatement = { ghostlyRevoke: 1, app: REF, upTo: 2 };
  const index = { ghostlyStore: 1, key: appKey("store"), name: "Vectors", kind: "curated", sequence: 1, expires: 1_790_000_000, apps: [], removed: [], revoked: [] };

  const statements = [
    await signed("a manifest, ghostly-app/1", APP_PREFIXES.app, chess.manifest),
    await signed("a store index, ghostly-store/1", APP_PREFIXES.store, index, store),
    await signed("a revocation by digests, ghostly-revoke/1", APP_PREFIXES.revoke, byDigests),
    await signed("a revocation up to a sequence, ghostly-revoke/1", APP_PREFIXES.revoke, upTo),
  ];
  const r1 = await signAppRevocation(byDigests, publisher);
  const r2 = await signAppRevocation(upTo, publisher);
  const revocations = [{ name: "by digests, with a reason", value: r1 }, { name: "every version up to sequence 2", value: r2 }];

  const invalid: InvalidCase[] = [];
  const rev = statements[2]!;
  invalid.push({ name: "a revocation checked as a manifest", check: "statement", refusal: "bad-signature", prefix: APP_PREFIXES.app, json: rev.json, key: rev.key, signature: rev.signature });
  invalid.push({ name: "a manifest checked as a store index", check: "statement", refusal: "bad-signature", prefix: APP_PREFIXES.store, json: statements[0]!.json, key: rev.key, signature: statements[0]!.signature });
  invalid.push({ name: "a statement that is not canonical", check: "statement", refusal: "not-canonical", prefix: APP_PREFIXES.revoke, json: JSON.stringify(byDigests), key: rev.key, signature: rev.signature });
  invalid.push({ name: "a statement checked under another key", check: "statement", refusal: "signature-key", prefix: APP_PREFIXES.revoke, json: rev.json, key: appKey("other publisher"), signature: rev.signature });

  const bySig = async (statement: AppRevokeStatement, signer = publisher, prefix: AppPrefix = APP_PREFIXES.revoke, key?: string) => {
    const { signature } = await signAppObject(prefix, statement, signer);
    return { statement, signature: key ? { ...signature, key } : signature };
  };
  const revoke = (name: string, refusal: string, value: unknown) => invalid.push({ name, check: "revocation", refusal, value });
  revoke("both digests and upTo", "bad-revocation", await bySig({ ...byDigests, upTo: 2 } as unknown as AppRevokeStatement));
  revoke("neither digests nor upTo", "bad-revocation", await bySig({ ghostlyRevoke: 1, app: REF } as unknown as AppRevokeStatement));
  revoke("no digest", "bad-revocation", await bySig({ ghostlyRevoke: 1, app: REF, digests: [] }));
  revoke("a digest twice", "bad-revocation", await bySig({ ghostlyRevoke: 1, app: REF, digests: [chess.digest, chess.digest] }));
  revoke("65 digests", "bad-revocation", await bySig({ ghostlyRevoke: 1, app: REF, digests: Array.from({ length: 65 }, (_, n) => toBase64Url(sha256(utf8Encode(`version ${n}`)))) }));
  revoke("upTo 0", "bad-revocation", await bySig({ ghostlyRevoke: 1, app: REF, upTo: 0 }));
  revoke("a reason of two lines", "bad-revocation", await bySig({ ...upTo, reason: "Leaked\nkey" }));
  revoke("an unknown key", "bad-revocation", await bySig({ ...upTo, at: 1 } as unknown as AppRevokeStatement));
  revoke("format version 2", "bad-revocation", await bySig({ ...upTo, ghostlyRevoke: 2 } as unknown as AppRevokeStatement));
  revoke("a reference that is not one", "bad-revocation", await bySig({ ...upTo, app: "chess" }));
  revoke("signed by another key, named", "signature-key", await bySig(upTo, other));
  revoke("signed by another key, under the publisher's name", "bad-signature", await bySig(upTo, other, APP_PREFIXES.revoke, appKey("publisher")));
  revoke("signed as a manifest", "bad-signature", await bySig(upTo, publisher, APP_PREFIXES.app));
  revoke("a signature statement with another algorithm", "bad-signature-statement", { statement: upTo, signature: { ...r2.signature, alg: "ed448" } });
  revoke("no signature", "bad-revocation", { statement: upTo });

  const fileJson = canonicalJson([r1, r2]);
  invalid.push({ name: "a ghostly-revoke.json that is not canonical", check: "revocations-file", refusal: "not-canonical", json: JSON.stringify([r1, r2], null, 2) });
  invalid.push({ name: "a ghostly-revoke.json that is not a list", check: "revocations-file", refusal: "bad-revocation", json: canonicalJson(r1) });
  invalid.push({ name: "a ghostly-revoke.json with one bad entry", check: "revocations-file", refusal: "signature-key", json: canonicalJson([r1, await bySig(upTo, other)]) });

  return {
    about: {
      pins: "Signing under each phase 1 prefix (ghostly-app/1, ghostly-store/1, ghostly-revoke/1) and the ghostly-revoke/1 revocations",
      wisp: "WISP 1200, Signatures, Publisher keys and Test vectors",
      test: "packages/core/test/appStatements.test.ts (APPS_VECTORS_WRITE=1 writes this file again)",
      signedBytes: "The prefix, a zero byte, then the SHA-256 of the object's canonical JSON, in hex: what Ed25519 signs",
    },
    inputs: {
      keys: Object.fromEntries(["publisher", "other publisher", "store"].map((label) => [label.replace(" ", "-"), { label, key: appKey(label) }])),
      ref: REF,
    },
    valid: { statements, revocations, file: { json: fileJson, count: 2 } },
    invalid,
  };
}

describe("app statement vectors", () => {
  it("match the checked-in file, and a reader reads each case as it says", async () => {
    const vectors = matchVectorFile(FILE, await build());
    for (const s of vectors.valid.statements) {
      const bytes = utf8Encode(s.json);
      expect(bytesToHex(appSignedBytes(s.prefix, bytes)), s.name).toBe(s.signedBytes);
      expect(verifyAppStatementBytes(s.prefix, bytes, s.signature, s.key).ok, s.name).toBe(true);
    }
    for (const r of vectors.valid.revocations) expect(readAppRevocation(r.value), r.name).toEqual({ ok: true, revocation: r.value });
    const file = readAppRevocations(utf8Encode(vectors.valid.file.json));
    expect(file.ok && file.revocations.length).toBe(vectors.valid.file.count);
    for (const c of vectors.invalid) {
      const result = c.check === "statement" ? verifyAppStatementBytes(c.prefix, utf8Encode(c.json), c.signature, c.key)
        : c.check === "revocation" ? readAppRevocation(c.value) : readAppRevocations(utf8Encode(c.json));
      expect(result.ok ? "accepted" : result.reason, c.name).toBe(c.refusal);
    }
  });
});

describe("statements", () => {
  it("never verify under a prefix they were not signed with", async () => {
    const value = { ghostlyRevoke: 1, app: REF, upTo: 1 };
    for (const signedAs of Object.values(APP_PREFIXES)) {
      const { bytes, signature } = await signAppObject(signedAs, value, publisher);
      for (const checkedAs of Object.values(APP_PREFIXES)) {
        expect(verifyAppStatementBytes(checkedAs, bytes, signature, appKey("publisher")).ok, `${signedAs} as ${checkedAs}`).toBe(signedAs === checkedAs);
      }
    }
  });

  it("sign the bytes the WISP names: prefix, zero, SHA-256 of the canonical JSON", () => {
    const bytes = canonicalJsonBytes({ b: 1, a: [true, null, "x"] });
    expect(new TextDecoder().decode(bytes)).toBe('{"a":[true,null,"x"],"b":1}');
    const signed = appSignedBytes(APP_PREFIXES.store, bytes);
    expect(new TextDecoder().decode(signed.subarray(0, 15))).toBe("ghostly-store/1");
    expect(signed[15]).toBe(0);
    expect(signed.length).toBe(15 + 1 + 32);
  });

  it("refuse a revocation signed by a key that is not its app's publisher", async () => {
    await expect(signAppRevocation({ ghostlyRevoke: 1, app: REF, upTo: 1 }, other)).rejects.toThrow(/publisher/);
  });

  it("show a publisher's fingerprint as 16 characters in four groups", () => {
    const key = appKey("publisher");
    expect(appFingerprint(key)).toMatch(/^[a-z0-9]{4} [a-z0-9]{4} [a-z0-9]{4} [a-z0-9]{4}$/);
    expect(appFingerprint(key).replace(/ /g, "")).toBe(key.slice(0, 16));
    expect(isAppRef(REF)).toBe(true);
    for (const no of ["chess", `${appKey("publisher")}/Chess`, `${appKey("publisher")}chess`, `${appKey("publisher")}/`, `${appKey("publisher")}/a/b`]) expect(isAppRef(no), no).toBe(false);
  });
});
