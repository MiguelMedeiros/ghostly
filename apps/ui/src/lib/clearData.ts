import { clearProfileStores } from "@ghostly/browser/shared/idb";
import { dropFileSpace, removeFileBytes } from "@ghostly/browser/shared/fileBytes";
import { forgetServicesOf, getBrowserHost, releaseUnusedLocalAccessOf } from "@ghostly/browser/host";
import { engine } from "@ghostly/browser/platform/engine";
import { forgetDevice, readDeviceRecord } from "@ghostly/browser/devices/store";
import { handoffProfileHost } from "@ghostly/browser/devices/handoffHost";
import { databaseExists } from "@ghostly/browser/backup/database";
import { LEGACY_JOIN_PREFIX, getStorageProfile, keyOwner } from "./storage";
import { activeProfileId, listProfiles, registryKey } from "./profiles";
import { keysOfSpace, profileDatabase } from "./profileData";
import { clearPeek } from "./profilePeek";
import { linkedFilesDatabase } from "./apps/webFiles";
import { pushPlatform } from "./wakePush";
import { forgetGifSearches } from "./gifSearch";
import { resetIncomingShare } from "./incomingShare";

/** How long the peer may take to take things back from the network and stop, before the clear goes on without it. */
export const CLEAR_ENGINE_MS = 15_000;

/**
 * "Clear all data" (WISP 04): everything of the active profile on this device except its wallets. Other profiles and
 * the list of profiles stay.
 *
 * 1. The peer takes back what it can from the network (items held for contacts, its DID, its identity proofs), stops,
 *    and empties its database but for the wallets (`clearProfileStores`). Never waited on for long: a peer that does
 *    not answer in time is left behind, and its database is emptied from here.
 * 2. The profile's local keys: chats, drafts, settings (lock screen and backup storage included), and its GIF searches.
 * 3. Its files, wherever they are kept, and on the web its apps' linked files (the paths and folders they were given;
 *    the Desktop's go with its files).
 * 4. Its push subscription ends at the push service, so contacts who kept it can no longer wake this app.
 *    On the web, Desktop and the extension, what the contacts' apps it opened kept on their own origins goes too
 *    (`forgetServices`); in the extension, Chrome's access to each local host it shared an app at, unless another
 *    profile shares one there.
 * 5. Its device state (WISP 06): the device record, Desktop's copy of it, and this device's signing key for the profile.
 *    Before the record goes, what only it names: the forks a handoff kept of the profile, each emptied as the profile is
 *    (all but its wallets), and what a pull of it that stopped staged. And what another profile's peek saw of it.
 * 6. A host whose peer outlives the page starts a new one. The caller then reloads.
 *
 * All of it is the profile's this page runs as, should another tab switch to another profile meanwhile.
 */
export function clearAllData(): Promise<void> {
  // The shares this page holds are the profile's too: the reload after the clear would carry them to the next page.
  resetIncomingShare();
  clearing ??= clearProfile(activeProfileId()).finally(() => { clearing = null; });
  return clearing;
}

/** The clear this page runs, if one does: a page that starts again for a switch in another tab waits for it. */
export const clearInProgress = (): Promise<void> | null => clearing;
let clearing: Promise<void> | null = null;

async function clearProfile(profileId: string): Promise<void> {
  // The forks and a stopped pull's staging namespace: the device record is the only thing that names them.
  const dbName = profileDatabase(profileId);
  const record = await readDeviceRecord(dbName).catch(() => null);
  const forks = record?.forks ?? [];
  const staged = record?.handoff?.role === "taking" ? record.handoff.staging : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    engine.call("clearProfileData").then(() => true, () => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), CLEAR_ENGINE_MS); }),
  ]);
  clearTimeout(timer);
  if (!stopped) await clearProfileStores().catch(() => {});
  const keysToRemove: string[] = [], ownsKey = keyOwner();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || key === registryKey()) continue;
    // The join flags of older versions are not in the namespace, and each one
    // carries the session id of a chat that existed; they are the default profile's.
    if (ownsKey(key) || (!getStorageProfile() && key.startsWith(LEGACY_JOIN_PREFIX))) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => localStorage.removeItem(key));
  // Its GIF searches are kept in the tab's session, which the reload after the clear keeps.
  forgetGifSearches();
  await removeFileBytes().catch(() => {});
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(linkedFilesDatabase(profileDatabase(profileId)));
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    } catch { resolve(); }
  });
  await pushPlatform()?.unsubscribe(profileId).catch(() => {});
  await forgetServicesOf({ profile: profileId });
  // Its shared apps went with its database: the extension gives back the local hosts no other profile shares one at.
  await releaseUnusedLocalAccessOf();
  // Its device state, as Delete profile drops it (WISP 06): the record (and Desktop's copy) and this device's signing
  // key for it. The emptied profile starts again as a device of no set, and keeps no key the other devices trust.
  const listed = new Set(listProfiles().map((p) => profileDatabase(p.id)));
  for (const fork of new Set(forks)) if (fork !== dbName && !listed.has(fork)) await clearFork(fork);
  // A staged copy is the giver's state, which the giver still holds: it goes whole, as a pull that fails drops it.
  if (staged && staged !== dbName && !listed.has(staged)) await handoffProfileHost()?.staging.drop(staged).catch(() => {});
  await forgetDevice(dbName).catch(() => {});
  // What another profile's peek saw of it (its contacts' keys, link and message ids), as deleting it clears.
  clearPeek(profileId);
  let host: ReturnType<typeof getBrowserHost> | null = null;
  try { host = getBrowserHost(); } catch { /* none in tests */ }
  await host?.restartEngine?.().catch(() => {});
}

/**
 * A fork of the profile (WISP 06 § Installing the staged state), cleared as the profile itself is: its local keys, its
 * files and linked files, and in its peer database all but its wallets (`clearProfileStores`), whose proofs may be
 * money only this copy holds. No screen lists it once the record is gone.
 */
async function clearFork(fork: string): Promise<void> {
  const owned = keysOfSpace(fork === "ghostly" ? "" : fork.replace(/^ghostly_/, ""));
  for (const key of Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((k): k is string => !!k && owned(k))) localStorage.removeItem(key);
  await dropFileSpace(fork).catch(() => {});
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(linkedFilesDatabase(fork));
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    } catch { resolve(); }
  });
  if (await databaseExists(fork).catch(() => false)) await clearProfileStores(fork).catch(() => {});
}
