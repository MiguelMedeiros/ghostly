import { clearProfileStores } from "@ghostly/browser/shared/idb";
import { removeFileBytes } from "@ghostly/browser/shared/fileBytes";
import { forgetServicesOf, getBrowserHost, releaseUnusedLocalAccessOf } from "@ghostly/browser/host";
import { engine } from "@ghostly/browser/platform/engine";
import { forgetDevice } from "@ghostly/browser/devices/store";
import { LEGACY_JOIN_PREFIX, getStorageProfile, ownsKey } from "./storage";
import { activeProfileId, registryKey } from "./profiles";
import { profileDatabase } from "./profileData";
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
 *    On the web and Desktop, what the contacts' apps it opened kept on their own origins goes too (`forgetServices`);
 *    in the extension, Chrome's access to each local host it shared an app at, unless another profile shares one there.
 * 5. Its device state (WISP 06): the device record, Desktop's copy of it, and this device's signing key for the profile.
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    engine.call("clearProfileData").then(() => true, () => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), CLEAR_ENGINE_MS); }),
  ]);
  clearTimeout(timer);
  if (!stopped) await clearProfileStores().catch(() => {});
  const keysToRemove: string[] = [];
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
  await forgetDevice(profileDatabase(profileId)).catch(() => {});
  let host: ReturnType<typeof getBrowserHost> | null = null;
  try { host = getBrowserHost(); } catch { /* none in tests */ }
  await host?.restartEngine?.().catch(() => {});
}
