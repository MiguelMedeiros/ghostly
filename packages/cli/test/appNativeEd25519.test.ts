import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonBytes, readAppBundle, seedSigner, signAppRevocation, toBase64Url } from "@ghostly/core";
import { revokeApp, verifyApp } from "../src/apps";
// covers: apps.bundle

/*
 * The publisher tools check signatures with Node's Ed25519 (tens of microseconds each) rather than the core's portable
 * one (most of a millisecond), so `app verify` beside a list of 4096 revocations answers in a fraction of a second, not
 * in 3 s. The portable check is counted at noble: a good bundle and a good list never reach it.
 */

const portable = vi.hoisted(() => ({ count: 0 }));
vi.mock("@noble/curves/ed25519.js", async (importOriginal) => {
  const noble = await importOriginal<typeof import("@noble/curves/ed25519.js")>();
  const verify: typeof noble.ed25519.verify = (...args) => {
    portable.count++;
    return noble.ed25519.verify(...args);
  };
  return { ...noble, ed25519: { ...noble.ed25519, verify } };
});

const VECTORS = resolve(import.meta.dirname, "../../core/test/vectors");
const tmp = () => mkdtempSync(join(tmpdir(), "ghostly-native-ed25519-"));
const seedOf = (label: string) => new Uint8Array(createHash("sha256").update(`ghostly apps vectors: ${label}`).digest());
const digest = (text: string) => toBase64Url(createHash("sha256").update(text).digest());

/** The chess vector's bundle, signed by the vector key "publisher", in a folder with `count` of its revocations. */
async function revokedChess(count: number): Promise<{ dir: string; key: string }> {
  const vectors = JSON.parse(readFileSync(join(VECTORS, "app-bundle.json"), "utf8")) as { valid: { bytes: ({ hex: string } | { fill: string; size: number })[] }[] };
  const bytes = new Uint8Array(Buffer.concat(vectors.valid[0].bytes.map((s) => ("hex" in s ? Buffer.from(s.hex, "hex") : Buffer.alloc(s.size, Number.parseInt(s.fill, 16))))));
  const read = readAppBundle(bytes);
  if (!read.ok) throw new Error("vector 0 does not read");
  const dir = tmp();
  writeFileSync(join(dir, "app.ghostlyapp"), bytes);
  const signer = seedSigner(seedOf("publisher"));
  const app = `${read.bundle.manifest.publisher}/${read.bundle.manifest.name}`;
  const list = await Promise.all(Array.from({ length: count }, (_, i) => signAppRevocation({ ghostlyRevoke: 1, app, digests: [digest(`revoked build ${i}`)] }, signer)));
  writeFileSync(join(dir, "ghostly-revoke.json"), canonicalJsonBytes(list as never));
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seedOf("publisher")]);
  const key = join(tmp(), "publisher.pem");
  writeFileSync(key, `-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----\n`, { mode: 0o600 });
  return { dir, key };
}

beforeEach(() => { portable.count = 0; });

describe("the publisher tools verify with Node's Ed25519", () => {
  it("app verify and app revoke check a good bundle and a good list without the portable check", async () => {
    const { dir, key } = await revokedChess(40);
    portable.count = 0;
    expect(await verifyApp(join(dir, "app.ghostlyapp"))).toMatchObject({ valid: true });
    expect(await revokeApp(dir, key, { digests: [digest("the new one")] })).toMatchObject({ added: true, revocations: 41 });
    expect(portable.count).toBe(0);
  }, 60_000);

  it("still refuses a list with one forged signature, as a client does", async () => {
    const { dir, key } = await revokedChess(3);
    const list = JSON.parse(readFileSync(join(dir, "ghostly-revoke.json"), "utf8")) as { signature: { sig: string } }[];
    list[1].signature.sig = list[0].signature.sig;
    writeFileSync(join(dir, "ghostly-revoke.json"), canonicalJsonBytes(list as never));
    await expect(revokeApp(dir, key, { digests: [digest("the new one")] })).rejects.toThrow(/is not a valid ghostly-revoke.json/);
  }, 60_000);
});
