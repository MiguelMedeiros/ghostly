import { classifyTurnRead, firstDeviceSetSecret, fromBase64Url, randomBytes, toBase64Url, turnKeys, type TurnNetwork, type TurnResult } from "@ghostly/core";
import { MAX_DEVICES, type DevicePatch, type DeviceSlot } from "./state";

/*
 * A backup restored where a device set exists (WISP 06 § A backup restored where a device set exists). A bundle of an
 * enrolled profile carries the device-set secret `D`, the set and the turn it was made at (never a device signing key);
 * a bundle made before enrollment carries the DID key, from which the first `D` derives. Before the restored profile is
 * registered the turn is read at that address:
 *
 * 1. no record and no device set in the bundle: restored as today (a profile that was never enrolled);
 * 2. a record with a device active, or no record while the bundle carries a device set (the record expired; the
 *    devices may still be alive): the copy does not start. "This profile is active on <device>", with Add this device
 *    instead, Take over, Cancel;
 * 3. a tombstone: the bundle is from before a device was removed; it starts only as a profile of its own;
 * 4. the record cannot be read: with a device set in the bundle the copy does not start, and the app says so.
 *
 * Whatever the case, a copy that does start raises its counters before its engine starts (`raise.ts`).
 */

/** What a bundle carries of the device set, in a record of its own (`t: "devices"`), right after the profile's head. */
export interface BundleDevices {
  d: string;
  set: (DeviceSlot | null)[];
  turn: number;
  takeovers: number;
}

export function isBundleDevices(value: unknown): value is BundleDevices {
  const v = value as Partial<BundleDevices> | null;
  if (!v || typeof v !== "object" || typeof v.d !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(v.d)) return false;
  if (!Array.isArray(v.set) || v.set.length > MAX_DEVICES) return false;
  if (!v.set.every((slot) => slot === null || (!!slot && typeof slot.key === "string" && /^[A-Za-z0-9_-]{43}$/.test(slot.key) && typeof slot.name === "string" && slot.name.length <= 64))) return false;
  return Number.isSafeInteger(v.turn) && v.turn! >= 0 && v.turn! <= 2 ** 32 - 1 && Number.isSafeInteger(v.takeovers) && v.takeovers! >= 0;
}

/** What a read of the turn at a bundle's address says, as the page may know it: names, never a key's secret. */
export interface TurnPeek {
  result: TurnResult;
  /** The record the result is about: its turn, the active slot and the slots. */
  record?: { turn: number; active: number; slots: (DeviceSlot | null)[] };
}

/** Reads the turn at the address of `d`, as a device that holds no record of the set yet. */
export async function peekTurn(d: Uint8Array, network: TurnNetwork): Promise<TurnPeek> {
  const keys = turnKeys(d);
  const answers = await network.turnRead(keys.identity.pubKeyZ32);
  const read = classifyTurnRead({ keys, ownKey: randomBytes(32), stored: null }, answers);
  if (!read.record) return { result: read.result };
  const slots = read.record.slots.map((slot) => slot && { key: toBase64Url(slot.key), name: slot.name });
  return { result: read.result, record: { turn: read.record.turn, active: read.record.active, slots } };
}

/** The device-set secret a bundle leads to: its own, or the first one from its DID key's seed. Null with neither. */
export function bundleSecret(devices: BundleDevices | undefined, didSeed: Uint8Array | null): Uint8Array | null {
  if (devices) return fromBase64Url(devices.d);
  return didSeed ? firstDeviceSetSecret(didSeed) : null;
}

export type RestoreCase = "plain" | "active" | "tombstone" | "unreadable";

/** Which case of the WISP's list a read puts a restore in. */
export function restoreCase(devices: BundleDevices | undefined, peek: TurnPeek | null): RestoreCase {
  if (!peek) return devices ? "unreadable" : "plain";
  switch (peek.result) {
    case "tombstone": return "tombstone";
    case "none": return devices ? "active" : "plain";
    case "unreachable": case "closed": return devices ? "unreadable" : "plain";
    default: return "active";
  }
}

/** The name of the device the copy would stop, from the record or, when it expired, from the bundle's set. */
export function activeName(devices: BundleDevices | undefined, peek: TurnPeek | null): string | undefined {
  const record = peek?.record;
  if (record && record.active < MAX_DEVICES) return record.slots[record.active]?.name;
  return devices?.set.find((slot) => slot)?.name;
}

/**
 * The device record of a restored copy that will take over (WISP 06 § Forced takeover: "a restored copy takes a free
 * slot with its new device signing key, or the lost device's slot when all four are used"): on standby, with the copy
 * it holds marked `restored`, the set as the record (or the bundle) lists it and this copy's key in its slot.
 */
export function restoredStandby(devices: BundleDevices | undefined, didSeed: Uint8Array | null, peek: TurnPeek | null, ownKey: Uint8Array, name: string): DevicePatch {
  const d = bundleSecret(devices, didSeed);
  if (!d) throw new Error("This backup leads to no device set");
  const listed = peek?.record?.slots ?? devices?.set ?? [];
  const set: (DeviceSlot | null)[] = Array.from({ length: MAX_DEVICES }, (_, i) => listed[i] ?? null);
  const active = peek?.record && peek.record.active < MAX_DEVICES ? peek.record.active : set.findIndex((slot) => slot);
  let own = set.findIndex((slot) => !slot);
  if (own < 0) own = active >= 0 ? active : 0;
  set[own] = { key: toBase64Url(ownKey), name };
  while (set.length && set[set.length - 1] === null) set.pop();
  return {
    d: toBase64Url(d), deviceSet: set, ownSlot: own, ...(active >= 0 && active !== own ? { activeSlot: active } : {}),
    turn: peek?.record?.turn ?? devices?.turn ?? 0, rev: 0, takeovers: devices?.takeovers ?? 0, copy: "restored",
  };
}
