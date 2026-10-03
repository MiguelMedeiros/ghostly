import type { DeviceRecord } from "./state";

/*
 * When the device set must move to a new device-set secret `D` (WISP 06 § Removing a device, § Adding a device).
 *
 * The move itself is removal's (`remove.ts`): a new random `D'`, the tombstone at the old address, one signed
 * `set-update` stored before anything leaves the device, delivered over the old links until each staying device
 * acknowledges it. "New device secret" runs those steps with nobody removed. It is due beyond a removal:
 *
 * - `unfinished-grant`: a grant this device sent while adding a device whose `enroll-done` never came back (part 4
 *   notes them in `unfinishedGrants`). That device may hold `D` and is in no record, so it can read the turn record and
 *   take the turn; a new `D`, given to the devices the record lists and to nobody else, is what takes `D` from it. The
 *   active device makes this move by itself (the engine, after an enrollment that did not finish and at start), and
 *   the grants it covered are dropped from `unfinishedGrants` in the same write as `D'`: the slot that grant was given
 *   is free, and no one who holds the old `D` can claim it any more.
 * - `takeover`: this device took over from another one, which still holds `D` (WISP 06 § After a forced takeover).
 *   Offered, not made: removing that device makes the move too, and says more.
 */

/** Why the set should move to a new `D`, and the keys that may hold the old one without being in the set. */
export interface NewSecretDue {
  why: "unfinished-grant" | "takeover";
  /** Signing keys of the devices that were granted `D` and never finished, base64url. Empty for a takeover. */
  keys: string[];
}

/** Whether this device's set should move to a new `D` now. Only the active device moves a set. */
export function newDeviceSecretDue(record: DeviceRecord | null): NewSecretDue | null {
  if (!record || record.state !== "active") return null;
  const listed = new Set(record.deviceSet.flatMap((slot) => (slot ? [slot.key] : [])));
  const keys = (record.unfinishedGrants ?? []).map((grant) => grant.key).filter((key) => !listed.has(key));
  if (keys.length) return { why: "unfinished-grant", keys };
  return record.secretOffer ? { why: "takeover", keys: [] } : null;
}
