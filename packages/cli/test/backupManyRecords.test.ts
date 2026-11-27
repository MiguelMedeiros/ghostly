// covers: headless.backup
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { restoreProfile } from "../src/backup";
import { home } from "./support/cli";

const RECORDS = 200_000;
/**
 * The stated bound: 200,000 tiny records open in well under this (~1.5-3 s here; ~6-17 s with a WebCrypto call per
 * frame, ~36 s with a DecompressionStream per gzip frame, ~7 s with a write per bytes frame).
 */
const BOUND_MS = 7_000;
const PASSPHRASE = "correct horse battery";

const frame = (kind: number, body: Uint8Array) => { const head = Buffer.alloc(5); head[0] = kind; head.writeUInt32BE(body.length, 1); return Buffer.concat([head, body]); };
const sha256 = (...parts: Uint8Array[]) => { const hash = createHash("sha256"); for (const part of parts) hash.update(part); return hash.digest(); };

/**
 * What the many tiny records are: `{}` JSON a restore skips, the same gzipped in a frame each (as writers before
 * 2026-11-18 wrote every JSON record), or the store file in one-byte frames.
 */
type Shape = "json" | "gzip" | "bytes";

/**
 * A whole backup of a headless profile (WISP 05, version 2) that carries `RECORDS` tiny records, built here with
 * node:crypto: the app's writer takes as long as the restore did to write them.
 */
function manyRecords(sealed: boolean, shape: Shape): Buffer {
  const json = (text: string) => ({ kind: 2, plain: Buffer.from(text) });
  const storeSize = shape === "bytes" ? RECORDS : 5;
  const records = [
    json(JSON.stringify({ t: "profile", format: "ghostly-cli-profile/2", createdAt: 1, files: 0, bytes: 0 })),
    json(JSON.stringify({ t: "file", kind: "store", size: storeSize })),
    ...(shape === "bytes"
      ? Array.from({ length: RECORDS }, () => ({ kind: 3, plain: Buffer.from("S") }))
      : [{ kind: 3, plain: Buffer.from("STORE") }, ...Array.from({ length: RECORDS }, () => shape === "gzip" ? { kind: 1, plain: gzipSync("{}") } : json("{}"))]),
    json(JSON.stringify({ t: "end", files: 0, bytes: 0 })),
  ];
  const salt = randomBytes(16), base = randomBytes(7);
  const header = sealed
    ? { format: "ghostly-backup", version: 2, protection: "passphrase", kdf: { name: "PBKDF2-SHA256", iterations: 600_000, salt: salt.toString("base64url") }, cipher: { name: "AES-256-GCM", nonce: base.toString("base64url") } }
    : { format: "ghostly-backup", version: 2, protection: "none", check: { name: "SHA-256-chain" } };
  const line = Buffer.from(`${JSON.stringify(header)}\n`);
  const out: Buffer[] = [line];
  let chain = sha256(line);
  if (sealed) {
    const key = pbkdf2Sync(PASSPHRASE, salt, 600_000, 32, "sha256");
    [...records, { kind: 255, plain: Buffer.alloc(0) }].forEach(({ kind, plain }, n) => {
      const iv = Buffer.alloc(12);
      base.copy(iv);
      iv.writeUInt32BE(n, 7);
      iv[11] = kind;
      const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(chain);
      out.push(frame(kind, Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])));
    });
  } else {
    for (const { kind, plain } of records) { const bytes = frame(kind, plain); out.push(bytes); chain = sha256(chain, bytes); }
    out.push(frame(255, chain));
  }
  return Buffer.concat(out);
}

afterEach(() => { vi.restoreAllMocks(); });

// A record costs its bytes, not an async call or a write each: 200,000 tiny ones (a few MB) took 6-36 s to open.
it.each([
  ["sealed", true, "json"], ["made without a passphrase", false, "json"],
  ["sealed, each gzipped", true, "gzip"], ["made without a passphrase, each gzipped", false, "gzip"],
  ["sealed, one byte each of a file", true, "bytes"], ["made without a passphrase, one byte each of a file", false, "bytes"],
] as const)("a backup of 200,000 tiny records %s restores within a bound, without an async call or a write each", async (_, sealed, shape) => {
  const tag = `${sealed ? "sealed" : "none"}-${shape}`;
  const dir = home(`backup-many-records-${tag}`);
  const file = join(dir, "many.ghostly-backup");
  writeFileSync(file, manyRecords(sealed, shape));
  const probe = await open(file, "r");
  const write = vi.spyOn(Object.getPrototypeOf(probe) as { write: () => unknown }, "write");
  await probe.close();
  const decrypt = vi.spyOn(crypto.subtle, "decrypt"), digest = vi.spyOn(crypto.subtle, "digest");
  const started = performance.now();
  const restored = await restoreProfile(home(`backup-many-records-to-${tag}`), "back", file, sealed ? PASSPHRASE : undefined);
  const took = performance.now() - started;
  expect(readFileSync(join(restored.db, "snapshot.bin")).toString()).toBe(shape === "bytes" ? "S".repeat(RECORDS) : "STORE");
  expect(decrypt.mock.calls.length + digest.mock.calls.length).toBeLessThan(10);
  expect(write.mock.calls.length).toBeLessThan(10);
  expect(took).toBeLessThan(BOUND_MS);
}, 120_000);
