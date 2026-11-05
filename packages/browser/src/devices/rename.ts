import { TURN_NAME_BYTES, turnName, utf8Encode } from "@ghostly/core";
import { MAX_DEVICES, type DeviceRecord, type DeviceSlot } from "./state";
import { readDeviceRecord } from "./store";
import type { TurnKeeper } from "./turn";

/*
 * Rename (WISP 06 § User experience, the row menu; § Record): the active device writes its next record, `rev` plus one,
 * with the name in that device's slot changed, as it does for a device added. Nothing new goes on the wire: every app
 * reads the names from the slots of the record, and a standby takes them from the next record it reads (at once on the
 * turn hint the active device sends over each live link, else when its screen opens and every 10 minutes). Only the
 * active device writes a record, so only the active device renames, any device of the set, itself included.
 */

/** Why a rename was refused before anything was written. Its message starts with `rename-<reason>:`. */
export class RenameRefusal extends Error {
  constructor(readonly reason: "name" | "long" | "device" | "state" | "unreachable" | "replaced", message: string) {
    super(`rename-${reason}: ${message}`);
    this.name = "RenameRefusal";
  }
}

/**
 * The name a rename writes: trimmed, and otherwise exactly what the slot keeps (`turnName`). One the slot would change
 * is refused rather than cut or cleaned behind the person's back: empty or invisible, over 16 bytes of UTF-8, or with a
 * control, invisible or direction-changing character in it.
 */
export function renamedDeviceName(name: unknown): string {
  if (typeof name !== "string") throw new RenameRefusal("name", "Give the device a name.");
  const typed = name.trim();
  const kept = turnName(typed);
  if (!kept) throw new RenameRefusal("name", "Give the device a name.");
  if (kept === typed) return kept;
  if (utf8Encode(typed).length > TURN_NAME_BYTES) throw new RenameRefusal("long", `A device name holds at most ${TURN_NAME_BYTES} bytes.`);
  throw new RenameRefusal("name", "A device name cannot hold this character.");
}

export interface RenameOptions {
  /** The profile's peer database name: the key of its device record. */
  profile: string;
  /** The profile's turn keeper, signing with this device's key. */
  keeper: TurnKeeper;
  /** The device signing key of the device renamed (base64url). */
  key: string;
  /** The new name, as `renamedDeviceName` returns it. */
  name: string;
  /** The device record (tests give their own store). */
  read?: () => Promise<DeviceRecord | null>;
}

/**
 * Renames a device of the set on the active device. Reads the turn first, as an enrollment does before it writes the
 * new slot: on `mine`, `none` or `behind` it writes the next record with the new name; anything else (another device
 * took the turn) is refused, and the keeper does what this device's state asks for. False when the name is the one
 * the slot already holds (nothing is written).
 */
export async function renameDevice(options: RenameOptions): Promise<boolean> {
  const read = options.read ?? (() => readDeviceRecord(options.profile));
  const name = renamedDeviceName(options.name);
  const before = await read();
  if (!before || before.state !== "active" || before.ownSlot === undefined) throw new RenameRefusal("state", "Only the active device renames a device.");
  const index = before.deviceSet.findIndex((slot) => slot?.key === options.key);
  if (index < 0) throw new RenameRefusal("device", "That device is not in this profile.");
  if (before.deviceSet[index]!.name === name) return false;
  const turn = await options.keeper.read();
  if (!turn?.good) throw new RenameRefusal("unreachable", "Can't check which device is active. Try again.");
  if (turn.result !== "mine" && turn.result !== "none" && turn.result !== "behind") {
    await options.keeper.check(false).catch(() => null);
    throw new RenameRefusal("replaced", "Another device holds the profile now.");
  }
  // Read again after the turn read (it may have moved the mark), and the slot found again by its key.
  const record = await read();
  if (!record || record.state !== "active") throw new RenameRefusal("state", "Only the active device renames a device.");
  const at = record.deviceSet.findIndex((slot) => slot?.key === options.key);
  if (at < 0) throw new RenameRefusal("device", "That device is not in this profile.");
  const slots: (DeviceSlot | null)[] = Array.from({ length: MAX_DEVICES }, (_, i) => {
    const slot = record.deviceSet[i] ?? null;
    return slot && i === at ? { ...slot, name } : slot;
  });
  // A takeover's offer keeps the device it stopped by its key, and shows the name its slot holds: nothing to change there.
  await options.keeper.write(turn.conditions, { slots });
  return true;
}
