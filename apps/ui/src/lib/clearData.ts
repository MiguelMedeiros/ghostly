import { clearProfileStores } from "@ghostly/browser/shared/idb";
import { removeFileBytes } from "@ghostly/browser/shared/fileBytes";
import { getBrowserHost } from "@ghostly/browser/host";
import { engine } from "@ghostly/browser/platform/engine";
import { LEGACY_JOIN_PREFIX, getStorageProfile, ownsKey } from "./storage";
import { activeProfileId, registryKey } from "./profiles";
import { pushPlatform } from "./wakePush";

/** How long the peer may take to take things back from the network and stop, before the clear goes on without it. */
export const CLEAR_ENGINE_MS = 15_000;

/**
 * "Clear all data" (WISP 04): everything of the active profile on this device except its wallets. Other profiles and
 * the list of profiles stay.
 *
 * 1. The peer takes back what it can from the network (items held for contacts, its DID, its identity proofs), stops,
 *    and empties its database but for the wallets (`clearProfileStores`). Never waited on for long: a peer that does
 *    not answer in time is left behind, and its database is emptied from here.
 * 2. The profile's local keys: chats, drafts, settings (lock screen and backup storage included).
 * 3. Its files, wherever they are kept.
 * 4. Its push subscription ends at the push service, so contacts who kept it can no longer wake this app.
 * 5. A host whose peer outlives the page starts a new one. The caller then reloads.
 */
export async function clearAllData(): Promise<void> {
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
  await removeFileBytes().catch(() => {});
  await pushPlatform()?.unsubscribe(activeProfileId()).catch(() => {});
  let host: ReturnType<typeof getBrowserHost> | null = null;
  try { host = getBrowserHost(); } catch { /* none in tests */ }
  await host?.restartEngine?.().catch(() => {});
}
