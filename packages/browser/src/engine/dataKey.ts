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
/**
 * The profile's migration is over (no `migrating` mark): a sealed place then takes version 2 only. A version 1 or plain
 * value there was put by someone who could write the profile's database but not read it, and is refused.
 */
let sealedOnly = false;
const onDrop = new Set<() => void>();
const LOCKED = "This profile is locked. Enter its passphrase first.";

export function setDataKey(key: CryptoKey): void { slot = key; }
export function hasDataKey(): boolean { return slot !== null; }
/** Off until the migration that seals every place has ended; set by it. */
export function setSealedOnly(on: boolean): void { sealedOnly = on; }
/** Whether a sealed place may still hold a version 1 or plain value. */
export function takesUnsealed(): boolean { return !(slot && sealedOnly); }
/** "Lock and stop", or a profile switch: the key goes, and so does every secret opened with it and kept in memory. */
export function dropDataKey(): void {
  slot = null;
  sealedOnly = false;
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

/** Version 2 only, for a field the database layer seals: refused while the profile is locked, never version 1. */
export async function sealPlace(value: string, at: SecretPlace): Promise<SealedField> {
  if (!slot) throw new Error(LOCKED);
  return sealField(slot, { db: PEER_DB, ...at }, value);
}

/** Reads both versions: a profile being encrypted holds some of each until its migration ends. */
export async function openSecret(secret: SealedSecret, at: SecretPlace): Promise<string> {
  if (!isSealedField(secret)) {
    if (!takesUnsealed()) throw new Error("A secret of this profile was not sealed with its key");
    return unsealSeed(secret.sealed, secret.deviceKey);
  }
  if (!slot) throw new Error(LOCKED);
  return openField(slot, { db: PEER_DB, ...at }, secret);
}
