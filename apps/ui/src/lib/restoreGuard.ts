import { toBase64Url } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { activeName, bundleSecret, markRestoreUnchecked, restoreCase, restoredStandby, type RestoreCase, type TurnPeek } from "@ghostly/browser/devices/restoreGuard";
import { createDeviceSigningKey } from "@ghostly/browser/devices/signingKey";
import { enrollDevice, forgetDevice } from "@ghostly/browser/devices/store";
import { bundleDidSeed, restoreOpenedBackup, type BackupRun, type OpenedProfileBackup } from "./profileBackup";
import type { ProfileEntry } from "./profiles";
import { defaultDeviceName } from "./devices";

/*
 * The restore guard (WISP 06 § A backup restored where a device set exists), as the profile page runs it: the turn is
 * read at the bundle's address before its profile is registered, and the case decides what the person is offered.
 */

export interface RestoreGuard {
  case: RestoreCase;
  /** The device the copy would stop, by name. */
  device?: string;
  peek: TurnPeek | null;
  didSeed: Uint8Array | null;
}

/**
 * Reads the turn for a bundle: through the engine running now (the active device's, or a standby's links), so the read
 * goes through the person's relays and, on Desktop, the DHT. A bundle that leads to no device set is `plain`.
 */
export async function guardRestore(opened: OpenedProfileBackup): Promise<RestoreGuard> {
  const didSeed = opened.devices ? null : await bundleDidSeed(opened);
  const d = bundleSecret(opened.devices, didSeed);
  if (!d) return { case: "plain", peek: null, didSeed };
  const peek: TurnPeek | null = await engine.call("deviceTurnPeek", { d: toBase64Url(d) }).catch(() => null);
  const found = restoreCase(opened.devices, peek);
  const device = activeName(opened.devices, peek);
  return { case: found, ...(device ? { device } : {}), peek, didSeed };
}

/**
 * "Take over" on a restore: the profile is restored, and on this device it is on standby with its copy marked
 * `restored` and a device signing key of its own in a free slot (or the lost device's). It starts nothing: the standby
 * screen it opens on offers the takeover, which takes the turn, waits the settle time and then starts it.
 */
export async function restoreForTakeover(opened: OpenedProfileBackup, guard: RestoreGuard, run: BackupRun = {}): Promise<ProfileEntry> {
  // The standby record is written before the profile is listed: a crash between the two never leaves a listed copy
  // that starts as a profile on one device. The bundle's verifier goes into it, so a backup holder also needs the lock
  // password to take over.
  return restoreOpenedBackup(opened, run, async (database) => {
    try {
      const key = await createDeviceSigningKey(database);
      await enrollDevice(database, "standby", {
        ...restoredStandby(opened.devices, guard.didSeed, guard.peek, key.publicKey, defaultDeviceName().slice(0, 16)), signingKey: key.kind,
        ...(opened.verifier ? { verifier: opened.verifier } : {}),
      });
    } catch (error) { await forgetDevice(database).catch(() => {}); throw error; }
  });
}

/**
 * What a restore whose turn could not be read writes before the profile is listed (case `unchecked`: a bundle made
 * before enrollment): the mark that starts the copy in limited mode until a read says whether another device runs it.
 * Passed to `restoreOpenedBackup` as its last step before the profile is registered.
 */
export const markUncheckedRestore = (database: string): Promise<void> => markRestoreUnchecked(database, defaultDeviceName().slice(0, 16));
