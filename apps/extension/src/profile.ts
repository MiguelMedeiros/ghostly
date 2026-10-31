import { activeProfileId, namespaceOf, registryKey } from "../../ui/src/lib/profiles";

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

/** Written by the page that restarted the peer, once the new one runs (`restartEngine` in host.ts). */
export const ENGINE_RESTART_KEY = "ghostly_engine_restarted";

/**
 * Tells every other page that the peer was replaced (a clear of all data, a device added or taken over): the page
 * that asked reloads itself, and the others start again too rather than show what the stopped peer had. A new value
 * each time, so a second restart is heard as well.
 */
export function announceEngineRestart(): void {
  try { localStorage.setItem(ENGINE_RESTART_KEY, `${Date.now()}-${Math.random().toString(36).slice(2)}`); } catch { /* the pages reconnect on their own */ }
}

/** Calls `onRestart` when another page replaced the peer. */
export function followEngineRestart(onRestart: () => void): () => void {
  const restarted = (event: StorageEvent) => {
    if (event.key === ENGINE_RESTART_KEY && event.newValue) onRestart();
  };
  addEventListener("storage", restarted);
  return () => removeEventListener("storage", restarted);
}
