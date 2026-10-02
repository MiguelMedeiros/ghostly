import { useEffect, useSyncExternalStore } from "react";
import { isDesktopApp } from "./externalLink";
import { isStandalone } from "./installPrompt";
import { notificationPermission } from "./notifications";
import { getStorageProfile } from "./storage";

/*
 * Keeping the browser from clearing the app's data. A browser's storage (IndexedDB, OPFS, localStorage) is "best
 * effort" until the site asks for more: under storage pressure the browser may clear a whole origin, and here that is
 * every key, chat, file and wallet. `navigator.storage.persist()` asks it not to. Chromium answers by itself, yes for
 * an installed app, one allowed to notify, or a site used a lot; Firefox asks the person; Safari answers by its own
 * rules, and treats an app on the Home Screen better than a tab.
 *
 * When the app asks: once the profile holds something worth keeping (a chat, a group or a wallet), never on a cold
 * first visit, and once per profile per browser. It asks again only when something changed that makes a yes likely:
 * the app was installed, or notifications were allowed. Firefox shows a prompt, so there the app asks only right
 * after the person did something (the click that made the chat or the wallet), or from the button in Settings.
 *
 * The Desktop app keeps its data in the system's app folder and the CLI in a folder of its own: neither is a browser
 * that evicts, so neither asks and Settings shows no line there. The extension's pages and its engine share one
 * origin, so the page asks for both.
 */

/** `protected`: the browser keeps the data until the person removes it. `unsupported`: the browser does not say. */
export type StorageProtection = "protected" | "unprotected" | "unsupported";

/** What the origin uses and may use, in bytes, as the browser estimates it. */
export interface StorageEstimate { used: number; quota: number }

/** What was true the last time this profile asked, in this browser. */
export interface PersistAsk { at: number; granted: boolean; installed: boolean; notifications: boolean }

export interface PersistMoment {
  /** The Desktop app: not a browser that evicts. */
  desktop: boolean;
  /** The browser has `navigator.storage.persist`. */
  supported: boolean;
  /** Already protected. */
  persisted: boolean;
  /** The profile holds a chat, a group or a wallet. */
  hasData: boolean;
  /** Running as the installed app. */
  installed: boolean;
  /** Notifications are allowed. */
  notifications: boolean;
  /** The browser answers with a prompt (Firefox), so the call has to follow something the person did. */
  prompts: boolean;
  /** The person just did something on the page (transient activation). */
  gesture: boolean;
  /** The last ask of this profile in this browser, if any. */
  asked: PersistAsk | null;
}

/** Whether to call `persist()` now. */
export function shouldAskPersist(m: PersistMoment): boolean {
  if (m.desktop || !m.supported || m.persisted || !m.hasData) return false;
  // Once per profile per browser, unless a yes became likely since: installed, or allowed to notify.
  if (m.asked && !((m.installed && !m.asked.installed) || (m.notifications && !m.asked.notifications))) return false;
  return !m.prompts || m.gesture;
}

/** The asks made in this browser, per profile. Not under the profile's own prefix: a backup must not carry it away. */
const ASKED_KEY = "ghostly-storage-persist";
const profileKey = () => getStorageProfile() || "default";
function readAsks(): Record<string, PersistAsk> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ASKED_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, PersistAsk> : {};
  } catch { return {}; }
}
function lastAsk(): PersistAsk | null {
  const ask = readAsks()[profileKey()];
  return ask && typeof ask === "object" ? ask : null;
}
function remember(ask: PersistAsk): void {
  try { localStorage.setItem(ASKED_KEY, JSON.stringify({ ...readAsks(), [profileKey()]: ask })); } catch { /* not remembered */ }
}

let protection: StorageProtection | null = null;
let estimate: StorageEstimate | null = null;
/** Whether the profile held something the last time the app said (`considerPersist`). */
let holdsData = false;
let asking: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

const manager = (): StorageManager | undefined => {
  try { return typeof navigator === "undefined" ? undefined : navigator.storage; } catch { return undefined; }
};
const canPersist = (storage: StorageManager | undefined): storage is StorageManager =>
  typeof storage?.persist === "function" && typeof storage.persisted === "function";

/** Firefox answers `persist()` with a prompt of its own. Not Firefox on iPhone (`FxiOS`), which is WebKit. */
export const browserPrompts = (userAgent = navigator.userAgent) => /Firefox\//.test(userAgent);
const justActed = () => (navigator as { userActivation?: { isActive?: boolean } }).userActivation?.isActive === true;

function set(next: StorageProtection | null): void {
  if (next === protection) return;
  protection = next;
  emit();
}

/** Reads what the browser says now: protected or not, and how much is used. Nothing on Desktop. */
export async function refreshStorageProtection(): Promise<void> {
  if (isDesktopApp()) { set(null); return; }
  const storage = manager();
  if (!canPersist(storage)) { set("unsupported"); return; }
  try { set(await storage.persisted() ? "protected" : "unprotected"); } catch { set("unsupported"); }
  try {
    const { usage, quota } = await storage.estimate();
    const next = typeof usage === "number" && typeof quota === "number" && quota > 0 ? { used: usage, quota } : null;
    if (next?.used !== estimate?.used || next?.quota !== estimate?.quota) { estimate = next; emit(); }
  } catch { /* no estimate here */ }
}

async function decide(force: boolean): Promise<void> {
  const storage = manager();
  const desktop = isDesktopApp();
  if (desktop || !canPersist(storage)) { set(desktop ? null : "unsupported"); return; }
  let persisted: boolean;
  try { persisted = await storage.persisted(); } catch { set("unsupported"); return; }
  const installed = isStandalone();
  const notifications = await notificationPermission() === "granted";
  const ask = force ? !persisted : shouldAskPersist({
    desktop, supported: true, persisted, hasData: holdsData, installed, notifications, prompts: browserPrompts(), gesture: justActed(), asked: lastAsk(),
  });
  if (ask) {
    try { persisted = await storage.persist(); } catch { persisted = false; }
    remember({ at: Date.now(), granted: persisted, installed, notifications });
  }
  set(persisted ? "protected" : "unprotected");
}

function run(force: boolean): Promise<void> {
  // One at a time: a second call while the browser answers waits for that answer, then looks again.
  const next = (asking ?? Promise.resolve()).then(() => decide(force)).catch(() => {});
  asking = next;
  void next.finally(() => { if (asking === next) asking = null; });
  return next;
}

/** The app says what the profile holds; the browser is asked when the time is right (`shouldAskPersist`). */
export function considerPersist(hasData: boolean): Promise<void> {
  holdsData = hasData;
  return run(false);
}

/** Something changed that may turn a no into a yes (notifications allowed, the app installed): look again. */
export function reconsiderPersist(): Promise<void> {
  return run(false);
}

/** The button in Settings: the person asks, so the browser is asked whatever was asked before. */
export function requestPersist(): Promise<void> {
  return run(true);
}

export const storageProtection = () => protection;
export const storageEstimate = () => estimate;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** What the browser says about this device's storage, read on mount and whenever the window comes back. */
export function useStorageProtection(): { protection: StorageProtection | null; estimate: StorageEstimate | null } {
  useEffect(() => {
    const refresh = () => { void refreshStorageProtection(); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  return { protection: useSyncExternalStore(subscribe, storageProtection, () => null), estimate: useSyncExternalStore(subscribe, storageEstimate, () => null) };
}

/** The current answer without asking for a fresh one: for a component that only words itself after it. */
export function useStorageProtected(): StorageProtection | null {
  return useSyncExternalStore(subscribe, storageProtection, () => null);
}

/** Tests only. */
export function resetStoragePersistence(): void {
  protection = null;
  estimate = null;
  holdsData = false;
  asking = null;
  emit();
}
