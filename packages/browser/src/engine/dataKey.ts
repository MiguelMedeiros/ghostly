import { isSealedField, openField, sealField, type FieldBinding, type SealedField } from "../shared/profileKey";
import { newDeviceKey, sealSeed, unsealSeed, type EncryptedSeed } from "./paymentAdapters/persistence";

/** Version 1: sealed under a random key stored beside it. It keeps a secret from a log, not from a reader of the profile. */
export interface DeviceSealed { sealed: EncryptedSeed; deviceKey: string }
/** A secret the engine keeps: version 1 while the profile is not encrypted, version 2 under its data key once it is. */
export type SealedSecret = DeviceSealed | SealedField;
/**
 * Where a secret belongs, in the peer database (WISP 04, Encrypted profile): its store, its own id (stable when the
 * secret moves inside its record, as a proof key does into the revocations) and what it is.
 */
export type SecretPlace = Omit<FieldBinding, "db">;

const PEER_DB = "ghostly";

/**
 * The profile's data key (DK), when the profile is encrypted and unlocked: the one slot the engine owns. A
 * non-extractable key; nothing writes it anywhere. Empty, every secret is sealed as today (version 1).
 */
let slot: CryptoKey | null = null;
const onDrop = new Set<() => void>();

export function setDataKey(key: CryptoKey): void { slot = key; }
export function hasDataKey(): boolean { return slot !== null; }
/** "Lock and stop", or a profile switch: the key goes, and so does every secret opened with it and kept in memory. */
export function dropDataKey(): void {
  slot = null;
  for (const drop of [...onDrop]) drop();
}
/** A cache of opened secrets empties itself when the key goes. Returns the way to stop listening. */
export function whenDataKeyDropped(drop: () => void): () => void {
  onDrop.add(drop);
  return () => { onDrop.delete(drop); };
}

export async function sealSecret(value: string, at: SecretPlace): Promise<SealedSecret> {
  if (slot) return sealField(slot, { db: PEER_DB, ...at }, value);
  const deviceKey = newDeviceKey();
  return { sealed: await sealSeed(value, deviceKey), deviceKey };
}

/** Reads both versions: a profile being encrypted holds some of each until its migration ends. */
export async function openSecret(secret: SealedSecret, at: SecretPlace): Promise<string> {
  if (!isSealedField(secret)) return unsealSeed(secret.sealed, secret.deviceKey);
  if (!slot) throw new Error("This profile is locked. Enter its passphrase first.");
  return openField(slot, { db: PEER_DB, ...at }, secret);
}

/**
 * A secret field of a wallet record (`seed`, an API key, a source's secrets). Version 1 is sealed with the record's
 * one `deviceKey`, kept beside its fields as wallet records always kept it; a record of version 2 fields has none.
 */
export type RecordSecret = EncryptedSeed | SealedField;
export interface RecordSealer {
  /** What the record keeps beside its secrets: its device key (version 1), or nothing (version 2). */
  beside: { deviceKey?: string };
  seal(value: string, field: string): Promise<RecordSecret>;
}

/** Seals the secrets of one record as the profile wants them now: all under one fresh device key, or each under DK. */
export function recordSealer(at: Omit<SecretPlace, "field">): RecordSealer {
  const key = slot;
  if (key) return { beside: {}, seal: (value, field) => sealField(key, { db: PEER_DB, ...at, field }, value) };
  const deviceKey = newDeviceKey();
  return { beside: { deviceKey }, seal: (value) => sealSeed(value, deviceKey) };
}

/** Opens one secret of a record, either version: `deviceKey` is the one the record keeps, if any. */
export function openRecordSecret(secret: RecordSecret, deviceKey: string | undefined, at: SecretPlace): Promise<string> {
  return openSecret(isSealedField(secret) ? secret : { sealed: secret, deviceKey: deviceKey ?? "" }, at);
}
