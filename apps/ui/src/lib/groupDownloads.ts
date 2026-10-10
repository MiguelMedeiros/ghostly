import { useEffect, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { getStorageProfile } from "./storage";

/*
 * Settings → Data & storage → Download automatically in groups (WISP 503 § Automatic and asked downloads): a group's
 * voice messages, and its files up to 8 MiB while what came that way stays within 256 MiB a group, come by themselves.
 * The engine knows on or off (`autoDownloads`, absent means on). "Wi-Fi only" is this device's: kept here, it turns the
 * engine's switch on while the browser says the connection is Wi-Fi (or a cable) and off otherwise. Nothing about it is
 * sent to the groups.
 */

export type GroupDownloads = "off" | "wifi" | "always";

type Connection = EventTarget & { type?: string };
const connection = (): Connection | undefined =>
  typeof navigator === "undefined" ? undefined : (navigator as Navigator & { connection?: Connection }).connection;

/** Whether this browser says what kind of connection it is on (Chrome on Android does; desktop browsers do not). */
export const wifiKnown = (): boolean => typeof connection()?.type === "string";

/** On Wi-Fi, or on a cable: a connection that does not cost by the byte. */
export const onWifi = (): boolean => connection()?.type === "wifi" || connection()?.type === "ethernet";

/** Per profile, as the app's settings are (WISP 04). Only "wifi" is kept here; off and always are the engine's. */
const key = () => (getStorageProfile() ? `ghostly_${getStorageProfile()}_group_downloads` : "ghostly_group_downloads");

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const off = engine.subscribe(listener);
  return () => { listeners.delete(listener); off(); };
};

function wifiOnly(): boolean {
  try { return localStorage.getItem(key()) === "wifi"; } catch { return false; }
}

/** The choice as Settings shows it: Wi-Fi only when chosen here, else what the engine keeps. */
export function groupDownloads(): GroupDownloads {
  if (wifiOnly()) return "wifi";
  return engine.state?.settings.autoDownloads === false ? "off" : "always";
}

export function useGroupDownloads(): GroupDownloads {
  return useSyncExternalStore(subscribe, groupDownloads);
}

/** What the engine is told for a choice, on the connection this device is on now. */
const autoDownloadsFor = (mode: GroupDownloads): boolean => mode === "always" || (mode === "wifi" && onWifi());

export async function setGroupDownloads(mode: GroupDownloads): Promise<void> {
  try {
    if (mode === "wifi") localStorage.setItem(key(), "wifi");
    else localStorage.removeItem(key());
  } catch { /* storage unavailable: the engine's switch still follows */ }
  for (const listener of listeners) listener();
  await engine.call("updateSettings", { settings: { autoDownloads: autoDownloadsFor(mode) } });
}

/**
 * Wi-Fi only: the engine's switch follows the connection while the app runs, from the start and on every change of
 * network. Mounted once, at the app's root.
 */
export function useGroupDownloadsSync(): void {
  const mode = useGroupDownloads();
  const ready = useSyncExternalStore(subscribe, () => engine.state !== null && engine.state !== undefined);
  useEffect(() => {
    if (mode !== "wifi" || !ready) return;
    const sync = () => {
      const on = onWifi();
      if ((engine.state?.settings.autoDownloads !== false) !== on) void engine.call("updateSettings", { settings: { autoDownloads: on } }).catch(() => {});
    };
    sync();
    const network = connection();
    network?.addEventListener("change", sync);
    return () => network?.removeEventListener("change", sync);
  }, [mode, ready]);
}
