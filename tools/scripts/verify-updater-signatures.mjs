#!/usr/bin/env node
/**
 * Checks, before a release is published, that every bundle `latest.json`
 * points at verifies against its signature and the updater's public key: what
 * each installed app does before it takes an update.
 *
 * The 1.0.0 AppImage was repacked (tools/scripts/appimage-drop-wayland-libs.sh) after
 * `tauri build` had signed it, so its signature no longer matched and every
 * Linux app would have refused the next update. Nothing noticed: the manifest
 * only reads the signatures, it never checked them.
 *
 *   node tools/scripts/verify-updater-signatures.mjs <release-dir> [tauri.conf.json]
 *
 * <release-dir> holds latest.json and the files its URLs name. The public key
 * comes from plugins.updater.pubkey (default apps/desktop/tauri.conf.json).
 * Exits 1 when any platform's bundle is missing or does not verify, or when its
 * signature does not name latest.json's `version` (the apps refuse it then).
 *
 * A signature is minisign's, base64-encoded as Tauri writes it: Ed25519 over
 * the file's BLAKE2b-512 (algorithm `ED`) or over the file itself (`Ed`), plus
 * a global signature over that signature and the trusted comment.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The lines of a base64-wrapped minisign text, blank ones dropped. */
function minisignLines(base64) {
  return Buffer.from(String(base64).trim(), "base64").toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean);
}

/** { keyId, key } from Tauri's `pubkey` (base64 of minisign's public key file). */
export function parsePublicKey(pubkey) {
  const lines = minisignLines(pubkey);
  const raw = Buffer.from(lines.find((line) => !line.startsWith("untrusted comment:")) ?? "", "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") throw new Error("not a minisign Ed25519 public key");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.subarray(10, 42).toString("base64url") }, format: "jwk" });
  return { keyId: raw.subarray(2, 10), key };
}

/** { algorithm, keyId, signature, trustedComment, globalSignature } from a `.sig`/manifest signature. */
export function parseSignature(base64) {
  const lines = minisignLines(base64);
  const trustedAt = lines.findIndex((line) => line.startsWith("trusted comment: "));
  if (trustedAt < 1 || !lines[trustedAt + 1]) throw new Error("not a minisign signature");
  const raw = Buffer.from(lines[trustedAt - 1], "base64");
  if (raw.length !== 74) throw new Error("not a minisign signature");
  return {
    algorithm: raw.subarray(0, 2).toString("latin1"),
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10, 74),
    trustedComment: lines[trustedAt].slice("trusted comment: ".length),
    globalSignature: Buffer.from(lines[trustedAt + 1], "base64"),
  };
}

async function blake2b512(file) {
  const hash = createHash("blake2b512");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest();
}

/** The `version:` field of a trusted comment (tab-separated `key:value` pairs), or null. */
function signedVersion(trustedComment) {
  const field = trustedComment.split("\t").find((part) => part.startsWith("version:"));
  return field === undefined ? null : field.slice("version:".length);
}

/**
 * Why `file` does not verify against `signatureBase64` and `publicKey`, or null when it does.
 * With `version` (latest.json's), the signature must also name that version, as the apps require
 * (plugins.updater.requireSignedVersion): a leading `v` on either side is the same version.
 */
export async function signatureProblem(file, signatureBase64, publicKey, version) {
  let sig;
  try {
    sig = parseSignature(signatureBase64);
  } catch (error) {
    return error.message;
  }
  if (!sig.keyId.equals(publicKey.keyId)) return "signed with another key";
  let message;
  if (sig.algorithm === "ED") message = await blake2b512(file);
  else if (sig.algorithm === "Ed") message = readFileSync(file);
  else return `unknown signature algorithm ${JSON.stringify(sig.algorithm)}`;
  if (!verify(null, message, publicKey.key, sig.signature)) return "the file does not match its signature";
  const global = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (!verify(null, global, publicKey.key, sig.globalSignature)) return "the trusted comment does not match its signature";
  if (version === undefined) return null;
  const signed = signedVersion(sig.trustedComment);
  if (signed === null) return "the signature names no version";
  if (signed.replace(/^v/, "") !== String(version).replace(/^v/, "")) return `signed for version ${signed}, latest.json announces ${JSON.stringify(version)}`;
  return null;
}

/** [{ platform, file, problem }] for every platform of `<dir>/latest.json`. */
export async function verifyRelease(dir, pubkey) {
  const manifest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  const publicKey = parsePublicKey(pubkey);
  const results = [];
  for (const [platform, entry] of Object.entries(manifest.platforms ?? {})) {
    const file = join(dir, decodeURIComponent(basename(new URL(entry.url).pathname)));
    const problem = !existsSync(file)
      ? "the file is not in the release"
      : typeof manifest.version !== "string" || !manifest.version
        ? "latest.json announces no version"
        : await signatureProblem(file, entry.signature, publicKey, manifest.version);
    results.push({ platform, file: basename(file), problem });
  }
  if (results.length === 0) results.push({ platform: "(none)", file: "latest.json", problem: "names no platform" });
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir, config = fileURLToPath(new URL("../../apps/desktop/tauri.conf.json", import.meta.url))] = process.argv.slice(2);
  if (!dir) {
    console.error("usage: verify-updater-signatures.mjs <release-dir> [tauri.conf.json]");
    process.exit(2);
  }
  const pubkey = JSON.parse(readFileSync(config, "utf8")).plugins?.updater?.pubkey;
  if (!pubkey) {
    console.error(`${config} has no plugins.updater.pubkey`);
    process.exit(2);
  }
  const results = await verifyRelease(dir, pubkey);
  for (const { platform, file, problem } of results) console.error(`${problem ? "✗" : "✓"} ${platform}: ${file}${problem ? `: ${problem}` : ""}`);
  const failed = results.filter((result) => result.problem);
  if (failed.length) {
    console.error(`${failed.length} of ${results.length} updater bundles would be refused by the installed apps.`);
    process.exit(1);
  }
  console.error(`All ${results.length} updater bundles verify against the updater's public key.`);
}
