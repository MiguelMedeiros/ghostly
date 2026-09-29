import { fromBase64Url, toBase64Url } from "./codec";

/** The clear part of a bundle (WISP 05): only what decryption needs. */
export interface Envelope {
  format: "ghostly-backup";
  version: 1;
  kdf: { name: "PBKDF2-SHA256"; iterations: number; salt: string };
  cipher: { name: "AES-256-GCM"; iv: string };
  compression: "gzip" | "none";
  ciphertext: string;
}
export const BACKUP_MEDIA_TYPE = "application/vnd.ghostly.backup+json";
const ITERATIONS = 600_000;

async function keyFrom(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
/** A profile with years of files is large, but not this large: past it, a bundle is refused, not read. */
export const MAX_BACKUP_BYTES = 1024 * 1024 * 1024;

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    size += next.value.length;
    if (size > MAX_BACKUP_BYTES) { await reader.cancel(); throw new Error("This backup is too large to restore"); }
    chunks.push(next.value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/**
 * The clear header is authenticated with the ciphertext (AES-GCM associated data): changing any of it,
 * the compression included, makes the bundle fail to open instead of being read differently.
 */
const header = (e: Pick<Envelope, "format" | "version" | "kdf" | "cipher" | "compression">) =>
  new TextEncoder().encode([e.format, e.version, e.kdf.name, e.kdf.iterations, e.kdf.salt, e.cipher.name, e.cipher.iv, e.compression].join("\n"));
const canCompress = () => typeof CompressionStream !== "undefined";

/** Compresses and encrypts a payload under a passphrase the person chose. */
export async function seal(payload: string, passphrase: string): Promise<string> {
  if (passphrase.length < 12) throw new Error("Use at least 12 characters for the backup passphrase");
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(payload);
  const compression = canCompress() ? "gzip" : "none";
  const body = compression === "gzip" ? await through(plain, new CompressionStream("gzip")) : plain;
  const clear = { format: "ghostly-backup", version: 1, kdf: { name: "PBKDF2-SHA256", iterations: ITERATIONS, salt: toBase64Url(salt) }, cipher: { name: "AES-256-GCM", iv: toBase64Url(iv) }, compression } as const;
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: header(clear) as BufferSource }, await keyFrom(passphrase, salt, ITERATIONS), body as BufferSource));
  const envelope: Envelope = { ...clear, ciphertext: toBase64Url(ciphertext) };
  return JSON.stringify(envelope);
}

/** Checks, decrypts and decompresses a bundle. Nothing from a bundle is used before this succeeds. */
export async function open(text: string, passphrase: string): Promise<string> {
  if (text.length > MAX_BACKUP_BYTES * 1.4) throw new Error("This backup is too large to restore");
  let envelope: Envelope;
  try { envelope = JSON.parse(text) as Envelope; } catch { throw new Error("This is not a Ghostly backup"); }
  if (envelope?.format !== "ghostly-backup") throw new Error("This is not a Ghostly backup");
  if (envelope.version !== 1) throw new Error("This backup comes from a newer Ghostly; update to restore it");
  if (envelope.kdf?.name !== "PBKDF2-SHA256" || !(envelope.kdf.iterations >= ITERATIONS) || envelope.kdf.iterations > 10_000_000 || envelope.cipher?.name !== "AES-256-GCM" || !["gzip", "none"].includes(envelope.compression)) throw new Error("Unsupported backup encryption");
  let body: Uint8Array;
  try {
    body = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(envelope.cipher.iv) as BufferSource, additionalData: header(envelope) as BufferSource }, await keyFrom(passphrase, fromBase64Url(envelope.kdf.salt), envelope.kdf.iterations), fromBase64Url(envelope.ciphertext) as BufferSource));
  } catch { throw new Error("Wrong passphrase, or the backup was changed"); }
  const plain = envelope.compression === "gzip" ? await through(body, new DecompressionStream("gzip")) : body;
  return new TextDecoder().decode(plain);
}
