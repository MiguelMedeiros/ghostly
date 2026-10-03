/*
 * Where a new device may be enrolled (WISP 06 § Adding a device). On iPhone and iPad a browser tab keeps other storage
 * than the app on the Home Screen, and may lose it, so "Add this device to my profile" is offered only in the installed
 * app: a tab says "Add Ghostly to your Home Screen first." Elsewhere the client asks the browser to keep its storage
 * (`navigator.storage.persist()`) and, when it is not granted, warns and goes on.
 */

/** What the check reads of the browser. Tests give their own. */
export interface InstallEnv {
  userAgent: string;
  /** `navigator.platform`: iPadOS asks for desktop pages as a Mac, and only its touch points tell it apart. */
  platform?: string;
  maxTouchPoints?: number;
  /** Safari's own `navigator.standalone`: true in the app on the Home Screen. */
  standalone?: boolean;
  /** `(display-mode: standalone)`: an installed web app, in any browser that has them. */
  displayStandalone?: boolean;
}

/** This page's browser, or null where there is no `navigator` (a worker with none, a test). */
export function currentInstallEnv(): InstallEnv | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & { standalone?: boolean };
  let displayStandalone = false;
  try { displayStandalone = typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches; } catch { /* no media queries here */ }
  return { userAgent: nav.userAgent ?? "", platform: nav.platform, maxTouchPoints: nav.maxTouchPoints, standalone: nav.standalone, displayStandalone };
}

/** An iPhone, an iPad (also one that says it is a Mac) or an iPod: every browser there is WebKit with a tab's storage. */
export function isIos(env: InstallEnv): boolean {
  if (/\b(iPhone|iPad|iPod)\b/.test(env.userAgent)) return true;
  return env.platform === "MacIntel" && (env.maxTouchPoints ?? 0) > 1;
}

/** A tab of a browser on iPhone or iPad, not the app on the Home Screen: a device is not enrolled there. */
export function isIosBrowserTab(env: InstallEnv | null = currentInstallEnv()): boolean {
  if (!env || !isIos(env)) return false;
  return env.standalone !== true && env.displayStandalone !== true;
}

/** Thrown where a device may not be enrolled: an iPhone or iPad tab. */
export class HomeScreenRequiredError extends Error {
  constructor() {
    super("Add Ghostly to your Home Screen first.");
    this.name = "HomeScreenRequiredError";
  }
}

/**
 * Asks the browser to keep this origin's storage. True when it is kept (asked now or granted before), false when the
 * browser said no, null where it has no such thing. Never throws: a refusal is a warning, not a stop.
 */
export async function askPersistentStorage(storage: Pick<StorageManager, "persist" | "persisted"> | undefined = typeof navigator === "undefined" ? undefined : navigator.storage): Promise<boolean | null> {
  if (!storage || typeof storage.persist !== "function") return null;
  try {
    if (typeof storage.persisted === "function" && await storage.persisted()) return true;
    return await storage.persist();
  } catch { return false; }
}
