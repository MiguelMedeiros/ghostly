import { firstDeviceSetSecret, fromBase64Url, randomBytes, toBase64Url, turnName, type TurnNetwork } from "@ghostly/core";
import { createDeviceSigningKey, loadDeviceSigningKey, type DeviceSigningKey } from "./signingKey";
import type { DevicePatch, DeviceRecord } from "./state";
import { readDeviceRecord } from "./store";
import { TurnKeeper, type TurnKeeperOptions } from "./turn";

/*
 * What a device holds of its device set (WISP 06 § Terms), put together from where each part lives: the device-set
 * secret `D`, the set and this device's slot from the device record (`store.ts`), and the device signing key from its
 * own database (`signingKey.ts`). The turn keeper and the device links both start from here.
 *
 * Nothing calls this for a `single` profile, and for one it reads the device record (which makes no database) and
 * stops there: no key is loaded and none is made.
 */

/** The device record names a device set this device cannot act in: it lacks `D`, its slot, or the key the slot names. */
export class DeviceSetError extends Error {
  constructor(what: string, options?: ErrorOptions) {
    super(`This device cannot use its device set: ${what}`, options);
    this.name = "DeviceSetError";
  }
}

/** The first turn of a device set: random under 2^29, so the sequence says nothing about how often the person switched (WISP 06 § Record). */
export function firstTurn(random: (length: number) => Uint8Array = randomBytes): number {
  const b = random(4);
  return (((b[0] & 0x1f) << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}

/**
 * The fields of the first device record of a profile that gets a device set: this device alone, in slot 0, active,
 * under the first `D`, which comes from the DID key's seed so that every backup of the profile leads to the same turn
 * address. The device signing key is made now, if this device has none for the profile. The caller writes the record
 * (`enrollDevice(profile, "active", patch)`): enrollment, in the part that adds a second device.
 */
export async function firstDeviceSet(profile: string, didSeed: Uint8Array, name: string, options: { forceSeed?: boolean; turn?: number } = {}): Promise<DevicePatch> {
  const key = await createDeviceSigningKey(profile, { forceSeed: options.forceSeed });
  return {
    d: toBase64Url(firstDeviceSetSecret(didSeed)),
    deviceSet: [{ key: toBase64Url(key.publicKey), name: turnName(name) }],
    ownSlot: 0,
    activeSlot: 0,
    turn: options.turn ?? firstTurn(),
    rev: 0,
    signingKey: key.kind,
  };
}

/** A device's own part in its set, checked: the secret, its slot, and a key that is the one the slot names. */
export interface DeviceIdentity {
  record: DeviceRecord;
  d: Uint8Array;
  ownSlot: number;
  key: DeviceSigningKey;
}

/**
 * This device's part in the profile's device set, or null for a `single` profile. Throws `DeviceSetError` when the
 * record cannot carry one (no `D`, no slot) or the stored signing key is missing or is not the key the record names
 * (storage copied in part, or a key database that was cleared): a device in that state signs nothing.
 */
export async function deviceIdentity(profile: string, sources: { record?: DeviceRecord | null; loadKey?: (profile: string) => Promise<DeviceSigningKey | null> } = {}): Promise<DeviceIdentity | null> {
  const record = sources.record === undefined ? await readDeviceRecord(profile) : sources.record;
  if (!record) return null;
  if (!record.d) throw new DeviceSetError("the device state has no device-set secret");
  const d = fromBase64Url(record.d);
  if (d.length !== 32) throw new DeviceSetError("the device-set secret is not 32 bytes");
  const ownSlot = record.ownSlot;
  const own = ownSlot === undefined ? undefined : record.deviceSet[ownSlot];
  if (ownSlot === undefined || !own) throw new DeviceSetError("the device state does not say which slot is this device's");
  let key: DeviceSigningKey | null;
  // A stored key that cannot be read (no key object, a seed that does not match, a database that fails) is no key.
  try { key = await (sources.loadKey ?? loadDeviceSigningKey)(profile); }
  catch (error) { throw new DeviceSetError(`its signing key cannot be read (${error instanceof Error ? error.message : String(error)})`, { cause: error }); }
  if (!key) throw new DeviceSetError("this device has no signing key");
  if (toBase64Url(key.publicKey) !== own.key) throw new DeviceSetError("the signing key stored here is not the one the device state names");
  return { record, d, ownSlot, key };
}

/**
 * The turn keeper of a profile on this device (`turn.ts`), signing with the device signing key: non-extractable or a
 * seed, the keeper does not know which. It reads `D` and the device's slot from the device record at each step. Null
 * for a `single` profile, which has no turn: nothing is read, put or signed.
 */
export async function openTurnKeeper(profile: string, network: TurnNetwork, options: Partial<Omit<TurnKeeperOptions, "profile" | "network" | "signer">> & { loadKey?: (profile: string) => Promise<DeviceSigningKey | null> } = {}): Promise<TurnKeeper | null> {
  const { loadKey, ...rest } = options;
  const record = await (rest.store ? rest.store.read(profile) : readDeviceRecord(profile));
  const identity = await deviceIdentity(profile, { record, loadKey });
  if (!identity) return null;
  return new TurnKeeper({ ...rest, profile, network, signer: (bytes) => identity.key.sign(bytes) });
}
