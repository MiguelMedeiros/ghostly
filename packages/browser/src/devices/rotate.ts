import type { DeviceRecord } from "./state";

/*
 * When the device set must move to a new device-set secret `D` (WISP 06 § Removing a device, § Adding a device).
 *
 * The move itself is removal's (part 7 of WISP 06): a new random `D'`, the tombstone at the old address, one signed
 * `set-update` stored before anything leaves the device, delivered over the old links until each staying device
 * acknowledges it, and the `moving` state. Nothing here makes it. What this part adds is when it is due beyond a
 * removal: a grant this device sent while adding a device whose `enroll-done` never came back (part 4 notes them in
 * `unfinishedGrants`). That device may hold `D` and is in no record, so it can read the turn record and take the turn;
 * a new `D`, given to the devices the record lists and to nobody else, is what takes `D` from it.
 *
 * Part 7 is expected to call `newDeviceSecretDue` on the active device (after an enrollment that did not finish, and
 * when the Devices section opens), offer "New device secret" when it answers, and run its removal steps with nobody
 * removed: the staying devices are the ones the record lists; the unfinished grants' keys get no `set-update`. Once the
 * move is stored, the grants it covered are dropped from `unfinishedGrants` in the same write as `D'`.
 */

/** Why the set should move to a new `D`, and the keys that may hold the old one without being in the set. */
export interface NewSecretDue {
  why: "unfinished-grant";
  /** Signing keys of the devices that were granted `D` and never finished, base64url. */
  keys: string[];
}

/** Whether this device's set should move to a new `D` now. Only the active device moves a set. */
export function newDeviceSecretDue(record: DeviceRecord | null): NewSecretDue | null {
  if (!record || record.state !== "active") return null;
  const listed = new Set(record.deviceSet.flatMap((slot) => (slot ? [slot.key] : [])));
  const keys = (record.unfinishedGrants ?? []).map((grant) => grant.key).filter((key) => !listed.has(key));
  return keys.length ? { why: "unfinished-grant", keys } : null;
}
