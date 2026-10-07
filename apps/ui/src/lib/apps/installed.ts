import { useEffect, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { appCardId, statusCardText, type AppCard } from "@ghostly/core";

/*
 * The apps installed in this profile, as the engine lists them (`appList`, no request), shared by every screen that
 * shows them: the Apps page, the composer's Apps, the app cards in chats ("Play" once installed). Read when the first
 * of them shows, and again after anything here changes them (install, update, uninstall) or the update check ran.
 */

let apps: readonly InstalledAppView[] | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const tell = () => { for (const listener of [...listeners]) listener(); };

/** Reads the list again. */
// After any update check (the engine's scheduled one included), once a screen has read the list: a version found
// removed or revoked shows as stopped.
engine.onAppsChecked(() => { if (apps !== null) void refreshInstalledApps(); });

/** Reads the list again. */
export function refreshInstalledApps(): Promise<void> {
  loading = engine.call("appList").then((list) => { apps = list; tell(); }, () => { apps ??= []; tell(); }).finally(() => { loading = null; });
  return loading;
}

/** For tests: forget what was read. */
export function forgetInstalledApps(): void {
  apps = null;
  loading = null;
}

/** The installed apps, or null until read. `enabled` false (Apps not shown here): nothing is asked of the engine. */
export function useInstalledApps(enabled: boolean): readonly InstalledAppView[] | null {
  const list = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => apps, () => apps);
  useEffect(() => { if (enabled && apps === null && !loading) void refreshInstalledApps(); }, [enabled]);
  return enabled ? list : null;
}

/**
 * The app card a person's app sends when they open (or share) an installed app in a 1:1 chat (WISP 405 § An app):
 * made from the app it installed and checked, never filled in by the person. Its `url` is where the installed version
 * came from, so a contact fetches the same bytes.
 */
export function appCardFor(app: InstalledAppView, opened: boolean): AppCard {
  return {
    kind: "app", id: appCardId(app.ref), ref: app.ref, digest: app.digest, sequence: app.sequence, title: app.title,
    ...(app.version.length <= 32 && { version: app.version }), url: app.from, ...(opened && { opened: true as const }),
  };
}

/** Sends the card, with its text as the fallback an older app shows (a link to the bundle). */
export async function sendAppCard(linkId: string, app: InstalledAppView, opened: boolean): Promise<string | null> {
  const card = appCardFor(app, opened);
  const result = await engine.call("sendMessage", { linkId, text: statusCardText(card), card, timestamp: Date.now() });
  return result.error;
}
