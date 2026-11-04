import { activeProfileId, lastRouteOf, namespaceOf, registryKey } from "../../ui/src/lib/profiles";

/**
 * Local profiles in the extension (WISP 04). Every extension page and the offscreen document share one
 * origin, so one registry in localStorage says which profile is in use; the peer and the pages each read
 * it when they start. There is one peer, in the offscreen document, so the extension runs one profile at a
 * time: switching restarts that document on the other profile's storage (see background.ts).
 */

/** The namespace of the profile in use now: empty for the first profile, whose names never changed. */
export const activeNamespace = (): string => namespaceOf(activeProfileId());
/** The profile's peer database, as the web app and desktop name it. */
export const databaseFor = (ns: string): string => (ns ? `ghostly_${ns}` : "ghostly");
/** Held by the peer running a profile, for as long as it runs: no second peer ever starts on it. */
export const peerLockFor = (ns: string): string => (ns ? `ghostly-peer-${ns}` : "ghostly-peer");

let pageProfile: string | null = null;
/** A page takes the profile in use when it starts, and keeps it until it reloads. */
export function openPageProfile(): string {
  pageProfile = activeNamespace();
  return pageProfile;
}
/** False once another page switched: this one must not reach the peer, which runs the other profile now. */
export const pageProfileIsCurrent = (): boolean => pageProfile === null || pageProfile === activeNamespace();

/**
 * Set by the page that started the peer again (`restartEngine`: Clear all data, the device gate) once the new one
 * runs. Not a profile's key: it outlives the clear.
 */
export const ENGINE_RESTART_KEY = "ghostly_engine_restarted";

/** The other pages hear the mark and start again (`followEngineRestart`); the page that set it reloads by itself. */
export function markEngineRestart(): void {
  try { localStorage.setItem(ENGINE_RESTART_KEY, String(Date.now())); } catch { /* storage full or refused: no page hears it */ }
}

/**
 * Calls `onRestart` when another page started the peer again. This page held what the old peer told it (a cleared
 * chat open, a device that is on standby now) and would go on showing it over the new one.
 */
export function followEngineRestart(onRestart: () => void): () => void {
  const restarted = (event: StorageEvent) => {
    if (event.key === ENGINE_RESTART_KEY && event.newValue !== null) onRestart();
  };
  addEventListener("storage", restarted);
  return () => removeEventListener("storage", restarted);
}

/**
 * Starts this page again as the profile in use, on the page that profile was left on, as the tab that switched does
 * (`switchProfile`). The address this page showed belongs to the profile before the switch: a chat or group of its
 * own reads as gone from this device in the other one.
 */
export function startAsProfileInUse(): void {
  history.replaceState(null, "", `#${lastRouteOf(activeProfileId())}`);
  location.reload();
}

/**
 * Calls `onSwitch` when another page makes a different profile the one in use. A page runs as the profile
 * it started with; once the peer follows the switch, the page has to start again too.
 */
export function followProfileSwitch(running: string, onSwitch: () => void): () => void {
  const changed = (event: StorageEvent) => {
    if (event.key !== null && event.key !== registryKey()) return;
    if (activeNamespace() !== running) onSwitch();
  };
  addEventListener("storage", changed);
  return () => removeEventListener("storage", changed);
}
