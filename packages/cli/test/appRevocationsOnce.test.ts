import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonBytes, readAppBundle, readAppRevocations, seedSigner, signAppRevocation, toBase64Url, type SignedAppRevocation } from "@ghostly/core";
import { revokeApp, signStore } from "../src/apps";
// covers: apps.bundle, apps.store

/*
 * A publisher command checks each revocation's signature once per run, however many times it reads the list: the
 * revocations it read from the held file, and the ones it just wrote itself, are not verified again entry by entry.
 * Before, `app revoke` verified the held list twice and `store sign` every revocation three or four times, so 4095 of
 * them took 6 to 13 seconds. Ed25519 verifications are counted at noble, the only verifier the core uses.
 */

const verifies = vi.hoisted(() => ({ count: 0 }));
vi.mock("@noble/curves/ed25519.js", async (importOriginal) => {
  const noble = await importOriginal<typeof import("@noble/curves/ed25519.js")>();
  const verify: typeof noble.ed25519.verify = (...args) => {
    verifies.count++;
    return noble.ed25519.verify(...args);
  };
  return { ...noble, ed25519: { ...noble.ed25519, verify } };
});

const VECTORS = resolve(import.meta.dirname, "../../core/test/vectors");
const tmp = () => mkdtempSync(join(tmpdir(), "ghostly-revocations-once-"));
const seedOf = (label: string) => new Uint8Array(createHash("sha256").update(`ghostly apps vectors: ${label}`).digest());

/** A key file for a vector label, as apps.test.ts writes it (PKCS #8 PEM of the vector's seed). */
function keyFile(dir: string, label: string, header = ""): string {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seedOf(label)]);
  const path = join(dir, `${label.replace(/\W/g, "-")}.pem`);
  writeFileSync(path, `${header}-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----\n`, { mode: 0o600 });
  return path;
}

/** The chess vector's bundle, in a folder of its own, signed by the vector key "publisher". */
function chessFolder(): { dir: string; ref: string } {
  const vectors = JSON.parse(readFileSync(join(VECTORS, "app-bundle.json"), "utf8")) as { valid: { bytes: ({ hex: string } | { fill: string; size: number })[] }[] };
  const bytes = new Uint8Array(Buffer.concat(vectors.valid[0].bytes.map((s) => ("hex" in s ? Buffer.from(s.hex, "hex") : Buffer.alloc(s.size, Number.parseInt(s.fill, 16))))));
  const read = readAppBundle(bytes);
  if (!read.ok) throw new Error("vector 0 does not read");
  const dir = tmp();
  writeFileSync(join(dir, "app.ghostlyapp"), bytes);
  return { dir, ref: `${read.bundle.manifest.publisher}/${read.bundle.manifest.name}` };
}

/** `count` digest revocations of `ref`, each its own statement, signed by the vector key "publisher". */
async function revocations(ref: string, count: number, from = 0): Promise<SignedAppRevocation[]> {
  const signer = seedSigner(seedOf("publisher"));
  const digest = (i: number) => toBase64Url(createHash("sha256").update(`revoked build ${i}`).digest());
  return Promise.all(Array.from({ length: count }, (_, i) => signAppRevocation({ ghostlyRevoke: 1, app: ref, digests: [digest(from + i)] }, signer)));
}

const HELD = 40;

beforeEach(() => { verifies.count = 0; });

describe("a publisher command checks each revocation once per run", () => {
  it("app revoke verifies the held list once and, of the list it writes, only the new statement", async () => {
    const { dir, ref } = chessFolder();
    writeFileSync(join(dir, "ghostly-revoke.json"), canonicalJsonBytes(await revocations(ref, HELD) as never));
    const key = keyFile(tmp(), "publisher");
    verifies.count = 0;
    const added = await revokeApp(dir, key, { digests: [toBase64Url(createHash("sha256").update("the new one").digest())] });
    expect(added).toMatchObject({ added: true, revocations: HELD + 1 });
    // The bundle's signature, each held revocation, and the new one: 81 more before (the held list read back again).
    expect(verifies.count).toBe(1 + HELD + 1);
    expect(readAppRevocations(new Uint8Array(readFileSync(join(dir, "ghostly-revoke.json"))))).toMatchObject({ ok: true, revocations: { length: HELD + 1 } });
  }, 60_000);

  it("store sign verifies each revocation once, on a first index and over the held one", async () => {
    const vector = JSON.parse((JSON.parse(readFileSync(join(VECTORS, "app-store.json"), "utf8")) as { valid: { index: string }[] }).valid[0].index) as Record<string, unknown> & { key: string; sequence: number };
    const { ref } = chessFolder();
    const { key: _key, ...index } = { ...vector, revoked: await revocations(ref, HELD), expires: Math.floor(Date.now() / 1000) + 86_400 };
    const dir = tmp();
    const key = keyFile(tmp(), "store");
    writeFileSync(join(dir, "index.json"), JSON.stringify(index));
    verifies.count = 0;
    expect(await signStore(join(dir, "index.json"), key)).toMatchObject({ previous: null });
    // Each revocation and the index's own signature: 3 × 40 + 1 before (the index check, signing's check, the read-back).
    expect(verifies.count).toBe(HELD + 1);

    writeFileSync(join(dir, "index.json"), JSON.stringify({ ...index, sequence: index.sequence + 1 }));
    verifies.count = 0;
    expect(await signStore(join(dir, "index.json"), key)).toMatchObject({ previous: index.sequence, sequence: index.sequence + 1 });
    // The held index (its signature and revocations), then only the new index's signature: 4 × 40 + 2 before.
    expect(verifies.count).toBe(HELD + 2);
  }, 60_000);
});
