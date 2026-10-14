import { bytesEqual, fromBase64Url, handoffAttemptAllowed, handoffAttemptFailed, handoffAttemptSucceeded, handoffRetryAfter, turnStatedVerifier, turnVerifierMark, type TurnRecord } from "@ghostly/core";
import type { DevicePatch, DeviceRecord } from "./state";
import type { TurnKeeper, TurnOutcome } from "./turn";

/*
 * A forced takeover (WISP 06 § Forced takeover): "My other device is lost or broken" on a device that holds a copy of
 * the profile, for when the active device cannot be reached. The device takes the turn above every turn it knows,
 * waits the settle time, and only then starts, with its counters raised (`raise.ts`), admin work off in every group
 * and signed payments parked.
 *
 * What keeps it from being a way to lock the owner out:
 * - only a device with a copy takes over. A standby enrolled that never held the profile holds the device-set secret
 *   and nothing else: taken over, it would start an empty profile and stop the real one;
 * - the lock password is typed and checked against the profile's password proof verifier, which the active device
 *   keeps beside this device's state. A stolen standby gets a handful of guesses: five in an hour, then an hour's
 *   wait; after fifteen with no right one, none on this device (the same limits as a pull);
 * - that verifier is the one the profile had when this device last gave it up. The active device states in the turn
 *   record which one the profile has now (the verifier mark), and a standby whose own is another one does not take
 *   over: the lock password was changed since, and the one this device would check is no longer the profile's;
 * - the person types the name of the device that stops, so a slip of the finger does not stop it;
 * - a wrong password, a wrong name, a refusal: nothing is written to the turn, and the active device goes on;
 * - a takeover that loses its settle read (another device took the turn at the same moment) goes back to what it was;
 * - and a device replaced by a takeover it did not want ("It wasn't me") takes the turn back the same way.
 */

/** Why a forced takeover was refused before anything was written. Its message starts with `takeover-<reason>:`. */
export class TakeoverRefusal extends Error {
  constructor(readonly reason: "state" | "no-copy" | "no-password" | "password" | "changed" | "name" | "locked-out" | "refused" | "offline", message: string, readonly retry?: number) {
    super(`takeover-${reason}: ${message}`);
    this.name = "TakeoverRefusal";
  }
}

export interface TakeoverPorts {
  read(): Promise<DeviceRecord | null>;
  amend(patch: DevicePatch): Promise<DeviceRecord>;
  /** Whether `password` is the one the verifier checks (`provesHandoffPassword`). */
  proves(verifier: NonNullable<DeviceRecord["verifier"]>, password: string): Promise<boolean>;
  /** The turn keeper, or null where the turn cannot be read (offline, no turn path). */
  keeper(): Promise<TurnKeeper | null>;
  now?: () => number;
}

export interface TakeoverRequest {
  /** The profile's lock password. */
  password: string;
  /** The name of the device that stops, as the person typed it. */
  name: string;
}

/** The device a takeover stops: the one the stored record names active, when it is not this one. */
export function takeoverTarget(record: DeviceRecord): string | undefined {
  // A device that released the turn names the device it gave it to, even before that device's record came back.
  const taker = record.handoff?.release?.to;
  if (taker) { const slot = record.deviceSet.find((s) => s?.key === taker); if (slot && slot.key !== record.deviceSet[record.ownSlot ?? -1]?.key) return slot.name; }
  if (record.activeSlot === undefined || record.activeSlot === record.ownSlot) return undefined;
  return record.deviceSet[record.activeSlot]?.name;
}

/** Whether this device may offer a forced takeover at all: a standby or a replaced device that holds a copy. */
export function canTakeOver(record: DeviceRecord | null): boolean {
  return !!record && (record.state === "standby" || record.state === "superseded") && !!record.copy;
}

/**
 * Whether the verifier this standby keeps is still the profile's, by the last record of the device set it knows (the
 * one just read, or the one it stored): false only when that record states the mark of another verifier. A record that
 * states none (an app from before wrote it) leaves the device with what it has, and so does this device's own record.
 * Only a standby is held to it: a device replaced by a takeover it did not want takes the turn back with the password
 * it knows, whatever the device that replaced it states.
 */
export function verifierStands(record: DeviceRecord, latest: TurnRecord | null): boolean {
  if (record.state !== "standby" || !record.verifier || !latest || latest.tombstone) return true;
  const own = record.ownSlot === undefined ? undefined : record.deviceSet[record.ownSlot]?.key;
  const author = latest.slots[latest.author];
  if (own && author && bytesEqual(author.key, fromBase64Url(own))) return true;
  const stated = turnStatedVerifier(latest.instance);
  return !stated || bytesEqual(stated, turnVerifierMark(record.verifier));
}

const sameName = (a: string, b: string) => a.normalize("NFC").trim().toLocaleLowerCase() === b.normalize("NFC").trim().toLocaleLowerCase();

/**
 * Checks the request and forces the takeover. Resolves to the keeper's outcome: `start` when this device is the active
 * one now (its record says `active`, with the raise to make before the engine starts), anything else when it is not.
 * Throws `TakeoverRefusal` before anything is written.
 */
export async function forceTakeover(ports: TakeoverPorts, request: TakeoverRequest): Promise<TurnOutcome> {
  const now = ports.now ?? Date.now;
  const record = await ports.read();
  if (!record || (record.state !== "standby" && record.state !== "superseded")) throw new TakeoverRefusal("state", "Only a device on standby takes over.");
  if (!record.copy) throw new TakeoverRefusal("no-copy", "This device holds no copy of the profile. Use here moves it from the active device.");
  // The limits first: a device locked out is not even asked for the password.
  const allowed = handoffAttemptAllowed(record.takeoverAttempts, now());
  if (allowed !== "ok") throw new TakeoverRefusal(allowed, allowed === "locked-out" ? "Too many tries. Try again later." : "Too many tries on this device.", allowed === "locked-out" ? handoffRetryAfter(record.takeoverAttempts, now()) : undefined);
  // A copy restored from a backup was opened with the backup's passphrase, which is the profile; a frozen copy needs the
  // lock password, checked against the verifier the active device left here.
  if (record.copy === "frozen" || record.verifier) {
    if (!record.verifier) throw new TakeoverRefusal("no-password", "This device cannot check the profile's password yet.");
    if (typeof request.password !== "string" || !request.password) throw new TakeoverRefusal("password", "Type the profile's password.");
    const right = await ports.proves(record.verifier, request.password).catch(() => false);
    if (!right) {
      await ports.amend({ takeoverAttempts: handoffAttemptFailed(record.takeoverAttempts, now()) });
      throw new TakeoverRefusal("password", "Wrong password.");
    }
  }
  const target = takeoverTarget(record);
  if (target && (typeof request.name !== "string" || !sameName(request.name, target))) throw new TakeoverRefusal("name", `Type ${target} to confirm.`);
  if (record.takeoverAttempts && (record.takeoverAttempts.total > 0 || record.takeoverAttempts.recent.length)) await ports.amend({ takeoverAttempts: handoffAttemptSucceeded() });
  const keeper = await ports.keeper();
  if (!keeper) throw new TakeoverRefusal("offline", "Go online to take over.");
  // After the read the takeover acts on, before anything is written: the last record there is to know.
  const outcome = await keeper.raise({
    before: (latest) => { if (!verifierStands(record, latest)) throw new TakeoverRefusal("changed", `The lock password was changed${target ? ` on ${target}` : ""}. Use here moves the profile with the new one.`); },
  });
  if (!outcome) throw new TakeoverRefusal("state", "This profile has no device set.");
  return outcome;
}
