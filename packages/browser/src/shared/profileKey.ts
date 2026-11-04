import { fromBase64Url, toBase64Url } from "../backup/codec";

/**
 * The encrypted profile's keys (WISP 04, Encrypted profile): a random data key (DK) per profile seals each secret
 * field, and is stored only wrapped under a key derived from the passphrase (KEK). The passphrase never encrypts
 * data directly, so changing it rewraps 32 bytes and rewrites nothing else.
 */
export interface ProfileKeyRecord {
  format: "ghostly-profile-key";
  version: 1;
  kdf: { name: "PBKDF2-SHA256"; iterations: number; salt: string };
  cipher: { name: "AES-256-GCM"; iv: string };
  /** The profile id, empty for the default: the record opens only in its own profile's slot. */
  profile: string;
  ciphertext: string;
}
/** A field sealed under DK. Version 1 is the `{version:1,salt,iv,ciphertext}` seed sealed with a device key. */
export interface SealedField { v: 2; iv: string; ct: string }
/**
 * Where a sealed field lives: a ciphertext moved to another database, store, record or field fails to open instead
 * of being read as that one. `db` is `local` for local storage.
 */
export interface FieldBinding { db: string; store: string; key: string; field: string }

const ITERATIONS = 600_000;
const MAX_ITERATIONS = 10_000_000;
const DK_BYTES = 32;
const TAG_BYTES = 16;

async function kekFrom(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt", "unwrapKey"]);
}

/** The clear header is the wrap's associated data, `profile` included: changing any of it makes the record fail to open. */
const header = (r: Omit<ProfileKeyRecord, "ciphertext">) =>
  new TextEncoder().encode([r.format, r.version, r.kdf.name, r.kdf.iterations, r.kdf.salt, r.cipher.name, r.cipher.iv, r.profile].join("\n"));

const importDataKey = (raw: Uint8Array) => crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

function checkPassphrase(passphrase: string) {
  if (passphrase.length < 12) throw new Error("Use at least 12 characters for the profile passphrase");
}

async function wrap(raw: Uint8Array, passphrase: string, profile: string): Promise<ProfileKeyRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const clear = { format: "ghostly-profile-key", version: 1, kdf: { name: "PBKDF2-SHA256", iterations: ITERATIONS, salt: toBase64Url(salt) }, cipher: { name: "AES-256-GCM", iv: toBase64Url(iv) }, profile } as const;
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: header(clear) as BufferSource }, await kekFrom(passphrase, salt, ITERATIONS), raw as BufferSource));
  return { ...clear, ciphertext: toBase64Url(ciphertext) };
}

/** Refuses what this version can't read before any KDF runs, as backups do. */
function checked(record: ProfileKeyRecord, profile: string) {
  if (record?.format !== "ghostly-profile-key") throw new Error("This is not a Ghostly profile key");
  if (record.version !== 1) throw new Error("This profile key comes from a newer Ghostly; update to open it");
  if (record.kdf?.name !== "PBKDF2-SHA256" || !Number.isInteger(record.kdf.iterations) || record.kdf.iterations < ITERATIONS || record.kdf.iterations > MAX_ITERATIONS || record.cipher?.name !== "AES-256-GCM") throw new Error("Unsupported profile key encryption");
  if (typeof record.profile !== "string" || record.profile !== profile) throw new Error("This profile key belongs to another profile");
  const salt = fromBase64Url(record.kdf.salt), iv = fromBase64Url(record.cipher.iv), ciphertext = fromBase64Url(record.ciphertext);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length !== DK_BYTES + TAG_BYTES) throw new Error("Unsupported profile key encryption");
  return { salt, iv, ciphertext };
}

/** Turning encryption on: a fresh DK, wrapped under the passphrase, and the DK itself as a key that can't be read back. */
export async function createProfileKey(passphrase: string, profile: string): Promise<{ record: ProfileKeyRecord; key: CryptoKey }> {
  checkPassphrase(passphrase);
  const raw = crypto.getRandomValues(new Uint8Array(DK_BYTES));
  try { return { record: await wrap(raw, passphrase, profile), key: await importDataKey(raw) }; } finally { raw.fill(0); }
}

/** The start gate: the DK as a non-extractable key, or "Wrong passphrase" with nothing else read. */
export async function unlockProfileKey(record: ProfileKeyRecord, passphrase: string, profile: string): Promise<CryptoKey> {
  const { salt, iv, ciphertext } = checked(record, profile);
  const kek = await kekFrom(passphrase, salt, record.kdf.iterations);
  try {
    return await crypto.subtle.unwrapKey("raw", ciphertext as BufferSource, kek, { name: "AES-GCM", iv: iv as BufferSource, additionalData: header(record) as BufferSource }, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } catch { throw new Error("Wrong passphrase"); }
}

/** Change passphrase: the same DK under a new KEK, salt and nonce. No sealed field changes. */
export async function rewrapProfileKey(record: ProfileKeyRecord, passphrase: string, next: string, profile: string): Promise<ProfileKeyRecord> {
  checkPassphrase(next);
  const { salt, iv, ciphertext } = checked(record, profile);
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: header(record) as BufferSource }, await kekFrom(passphrase, salt, record.kdf.iterations), ciphertext as BufferSource));
  } catch { throw new Error("Wrong passphrase"); }
  try { return await wrap(raw, next, profile); } finally { raw.fill(0); }
}

/**
 * Only the record key can hold a newline: the other parts come from the code, so the joined binding still reads one
 * way (the first two lines, the last line, and the key between them).
 */
function binding(b: FieldBinding): Uint8Array {
  for (const part of [b.db, b.store, b.field]) if (!part || part.includes("\n")) throw new Error("Invalid sealed field binding");
  return new TextEncoder().encode(["ghostly-field/2", b.db, b.store, b.key, b.field].join("\n"));
}

export function isSealedField(value: unknown): value is SealedField {
  const v = value as Partial<SealedField> | null;
  return !!v && typeof v === "object" && v.v === 2 && typeof v.iv === "string" && typeof v.ct === "string";
}

/** Seals one field under DK with a fresh random 96-bit nonce and no KDF per field. */
export async function sealField(key: CryptoKey, where: FieldBinding, value: string): Promise<SealedField> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: binding(where) as BufferSource }, key, new TextEncoder().encode(value)));
  return { v: 2, iv: toBase64Url(iv), ct: toBase64Url(ct) };
}

/** Opens a field sealed for exactly this place under this DK; anything else fails instead of opening wrong. */
export async function openField(key: CryptoKey, where: FieldBinding, sealed: SealedField): Promise<string> {
  if (!isSealedField(sealed)) throw new Error("Unsupported sealed field version");
  const aad = binding(where);
  try {
    const iv = fromBase64Url(sealed.iv);
    if (iv.length !== 12) throw new Error("nonce");
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource }, key, fromBase64Url(sealed.ct) as BufferSource));
  } catch { throw new Error("A sealed field could not be opened: it was changed, or it belongs to another record"); }
}
