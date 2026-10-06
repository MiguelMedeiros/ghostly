import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { expect } from "vitest";
import {
  APP_PREFIXES, assembleAppBundle, canonicalJsonBytes, seedSigner, signAppObject, toBase64Url, toZ32, utf8Encode,
  type AppPrefix, type Signer,
} from "../src/index";

/*
 * What the apps vectors (WISP 1200 · Test vectors) are built from. Every key is made from a fixed label: its seed is the
 * SHA-256 of `ghostly apps vectors: <label>`, a test value and never a real key. A vector file is written again with
 * `APPS_VECTORS_WRITE=1 npx vitest run test/app` and otherwise read and compared, so a change to a format shows in
 * review as a changed vector.
 */

/** The reader's clock for every vector, Unix seconds. */
export const APPS_NOW = 1_790_000_000;
export const appSeed = (label: string) => sha256(utf8Encode(`ghostly apps vectors: ${label}`));
export const appSigner = (label: string): Signer => seedSigner(appSeed(label));
export const appKey = (label: string) => toZ32(appSigner(label).publicKey);

/**
 * Bytes as the vector files hold them: hex, with long runs of one byte written as a fill so a 16 MiB bundle stays a
 * few lines. A reader concatenates the segments in order.
 */
export type Segment = { hex: string } | { fill: string; size: number };
const RUN = 1024;
export function toSegments(bytes: Uint8Array): Segment[] {
  const out: Segment[] = [];
  let start = 0;
  let i = 0;
  while (i < bytes.length) {
    let j = i + 1;
    while (j < bytes.length && bytes[j] === bytes[i]) j++;
    if (j - i >= RUN) {
      if (i > start) out.push({ hex: bytesToHex(bytes.subarray(start, i)) });
      out.push({ fill: bytesToHex(bytes.subarray(i, i + 1)), size: j - i });
      start = j;
    }
    i = j;
  }
  if (start < bytes.length || out.length === 0) out.push({ hex: bytesToHex(bytes.subarray(start)) });
  return out;
}
export function fromSegments(segments: Segment[]): Uint8Array {
  const parts = segments.map((s) => ("hex" in s ? hexToBytes(s.hex) : new Uint8Array(s.size).fill(hexToBytes(s.fill)[0]!)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A file of a bundle. */
export interface FileInput { path: string; bytes: Uint8Array }
export const file = (path: string, content: string | Uint8Array): FileInput => ({ path, bytes: typeof content === "string" ? utf8Encode(content) : content });
export const fill = (size: number, byte = 0) => new Uint8Array(size).fill(byte);
/** A PNG's signature and header chunk with the size given, padded with zeros to `size` bytes. */
export function png(width: number, height: number, size = 64): Uint8Array {
  const out = new Uint8Array(size);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(out.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  out.set([8, 6, 0, 0, 0], 24);
  return out;
}
export const entries = (files: FileInput[]) => files.map((f) => ({ path: f.path, size: f.bytes.length, sha256: toBase64Url(sha256(f.bytes)) }));
export const byPath = (files: FileInput[]) => [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

export const ENTRY = file("index.html", "<!doctype html><meta charset=utf-8><title>Chess</title><p>Chess</p>");
/** The fields of the vectors' app, but `publisher` and `files`. */
export const DRAFT = {
  name: "chess",
  version: "1.0.0",
  sequence: 1,
  kind: "mini-app" as const,
  title: "Chess",
  tagline: "Play chess with a contact",
  entry: "index.html",
  permissions: ["chat" as const],
  runtime: { host: ">=1.2", clients: ["web" as const, "desktop" as const] },
  license: "MIT",
};

/**
 * A bundle made by hand, so it can break any rule: the manifest is `fields` with `ghostlyApp`, `publisher` and the
 * files' entries filled in unless given, signed as the options say, and the files in the order given.
 */
export async function handBundle(fields: Record<string, unknown>, files: FileInput[], options: {
  signer?: Signer; prefix?: AppPrefix; manifestBytes?: Uint8Array; statementBytes?: Uint8Array; statementKey?: string;
} = {}): Promise<Uint8Array> {
  const signer = options.signer ?? appSigner("publisher");
  const manifest = { ghostlyApp: 1, publisher: toZ32(signer.publicKey), files: entries(files), ...fields };
  const manifestBytes = options.manifestBytes ?? canonicalJsonBytes(manifest);
  let statementBytes = options.statementBytes;
  if (!statementBytes) {
    const { signature } = await signAppObject(options.prefix ?? APP_PREFIXES.app, manifest, signer);
    statementBytes = canonicalJsonBytes(options.statementKey ? { ...signature, key: options.statementKey } : signature);
  }
  // The signature covers the canonical form; a hand-written manifest is signed as the bytes it carries are read.
  return assembleAppBundle(manifestBytes, statementBytes, files.map((f) => f.bytes));
}

/** Writes a vector file when asked (or when it is missing), then checks the built vectors against the checked-in file. */
export function matchVectorFile<T>(path: string, built: T): T {
  if (process.env.APPS_VECTORS_WRITE === "1") writeFileSync(path, `${JSON.stringify(built, null, 2)}\n`);
  expect(existsSync(path), "write it with APPS_VECTORS_WRITE=1").toBe(true);
  const file = JSON.parse(readFileSync(path, "utf8")) as T;
  expect(JSON.parse(JSON.stringify(built))).toEqual(file);
  return file;
}
