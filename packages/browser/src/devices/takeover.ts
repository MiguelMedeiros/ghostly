import { handoffAttemptAllowed, handoffAttemptFailed, handoffAttemptSucceeded, handoffRetryAfter } from "@ghostly/core";
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
 * - the person types the name of the device that stops, so a slip of the finger does not stop it;
 * - a wrong password, a wrong name, a refusal: nothing is written to the turn, and the active device goes on;
 * - a takeover that loses its settle read (another device took the turn at the same moment) goes back to what it was;
 * - and a device replaced by a takeover it did not want ("It wasn't me") takes the turn back the same way.
 */

/** Why a forced takeover was refused before anything was written. Its message starts with `takeover-<reason>:`. */
export class TakeoverRefusal extends Error {
  constructor(readonly reason: "state" | "no-copy" | "no-password" | "password" | "name" | "locked-out" | "refused" | "offline", message: string, readonly retry?: number) {
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
  if (record.activeSlot === undefined || record.activeSlot === record.ownSlot) return undefined;
  return record.deviceSet[record.activeSlot]?.name;
}

/** Whether this device may offer a forced takeover at all: a standby or a replaced device that holds a copy. */
export function canTakeOver(record: DeviceRecord | null): boolean {
  return !!record && (record.state === "standby" || record.state === "superseded") && !!record.copy;
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
    let right = false;
    try { right = await ports.proves(record.verifier, request.password); } catch { right = false; }
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
  const outcome = await keeper.raise();
  if (!outcome) throw new TakeoverRefusal("state", "This profile has no device set.");
  return outcome;
}
