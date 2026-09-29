import { useSyncExternalStore } from "react";

/*
 * Installing the web app (a window of its own, an icon on the home screen or the dock). Chromium browsers say
 * when the app can be installed (`beforeinstallprompt`) and install it on request; Safari has no such event, so
 * the app says where the browser keeps it: Share, then Add to Home Screen on iPhone and iPad, File, then Add to
 * Dock on a Mac (Safari 17 and later). Firefox has none. Only the web app watches for any of it
 * (`watchInstallPrompt` in web/src/main.tsx): the extension and Desktop are installed already, and see `none`.
 *
 * Where it is offered: Settings, the account menu, and once the app has been used a little, a hint above the chat
 * list that "Not now" puts away for good (`installHintShown`).
 */

interface PromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * What the app offers: `prompt`, a button the browser answers; `ios`, the steps in Safari's Share menu (iPhone,
 * iPad); `dock`, the steps in Safari's File menu (a Mac); `installed`, running as the installed app already;
 * `none`, nothing to offer here.
 */
export type InstallState = "prompt" | "ios" | "dock" | "installed" | "none";

let watching = false;
let deferred: PromptEvent | null = null;
let justInstalled = false;
let stepsOpen = false;
/** The hint put away on this page, kept here too for a browser that remembers nothing. */
let hintAway = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** localStorage, which may be missing or refuse (a private window, blocked site data): then nothing is remembered. */
const HINT_KEY = "ghostly-install-hint";
const VISITS_KEY = "ghostly-install-visits";
function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* not remembered */ }
}

/** Running as the installed app: its own window, or opened from the iPhone or iPad home screen. */
export function isStandalone(): boolean {
  try {
    return matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/** An iPhone or iPad, including an iPad that asks for desktop sites (it says Macintosh, with a touch screen). */
export function isAppleMobile(userAgent = navigator.userAgent, touchPoints = navigator.maxTouchPoints ?? 0): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1);
}

/**
 * Safari on a Mac, from version 17: File, then Add to Dock. Its user agent keeps the same macOS version for good, so
 * Safari's own `Version/` says whether it can. Not Chrome, Edge, Opera or Firefox on a Mac (they say Safari too),
 * and not an iPad asking for desktop sites (`isAppleMobile`).
 */
export function isMacSafari(userAgent = navigator.userAgent, touchPoints = navigator.maxTouchPoints ?? 0): boolean {
  if (isAppleMobile(userAgent, touchPoints)) return false;
  if (!/Macintosh/.test(userAgent) || !/Safari\//.test(userAgent)) return false;
  if (/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(userAgent)) return false;
  const version = /Version\/(\d+)/.exec(userAgent);
  return !!version && Number(version[1]) >= 17;
}

/** Listens for the browser's offer to install. As early as possible: Chromium may make it before the app renders. */
export function watchInstallPrompt(target: Window = window): void {
  if (watching) return;
  watching = true;
  // One more visit: the hint above the chat list waits for the second.
  write(VISITS_KEY, String(installVisits() + 1));
  target.addEventListener("beforeinstallprompt", (event) => {
    // No banner of the browser's own: Settings has the button.
    event.preventDefault();
    deferred = event as PromptEvent;
    emit();
  });
  target.addEventListener("appinstalled", () => {
    deferred = null;
    justInstalled = true;
    emit();
  });
  emit();
}

export function installState(): InstallState {
  if (!watching) return "none";
  if (justInstalled || isStandalone()) return "installed";
  if (deferred) return "prompt";
  if (isAppleMobile()) return "ios";
  return isMacSafari() ? "dock" : "none";
}

/** Something to install from here: the browser's prompt, or steps in Safari's menus. */
export const canInstall = (state: InstallState) => state === "prompt" || state === "ios" || state === "dock";

/**
 * Install, from anywhere the app offers it: the browser's own prompt where there is one, the steps sheet
 * (`InstallSteps`) where Safari keeps it in a menu. Either way the hint has done its job and goes.
 */
export function startInstall(): void {
  const state = installState();
  if (!canInstall(state)) return;
  hintAway = true;
  write(HINT_KEY, "done");
  if (state === "prompt") void promptInstall();
  else stepsOpen = true;
  emit();
}

export const installStepsOpen = () => stepsOpen;

export function closeInstallSteps(): void {
  if (!stepsOpen) return;
  stepsOpen = false;
  hintAway = false;
  emit();
}

/** How many times this browser opened the web app (counted from `watchInstallPrompt`). */
export function installVisits(): number {
  const count = Number(read(VISITS_KEY));
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/** Not now: the hint above the chat list goes, in this browser, for good. Install stays in Settings and the menu. */
export function dismissInstallHint(): void {
  hintAway = true;
  write(HINT_KEY, "dismissed");
  emit();
}

const hintPutAway = () => hintAway || read(HINT_KEY) !== null;

/**
 * The hint above the chat list: something to install, never put away or used, and the app used a little first
 * (a chat or a group of its own, or a second visit), so it is never the first thing a newcomer sees.
 */
export function installHintShown(state: InstallState, hasChats: boolean): boolean {
  if (!canInstall(state) || hintPutAway()) return false;
  return hasChats || installVisits() >= 2;
}

/** Asks the browser to install the app. Resolves whether the person said yes. The offer can be used once. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = null;
  emit();
  try {
    await event.prompt();
    return (await event.userChoice).outcome === "accepted";
  } catch {
    return false;
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribe, installState, () => "none");
}

/** Whether the steps sheet is open (`startInstall` opens it for Safari). */
export function useInstallStepsOpen(): boolean {
  return useSyncExternalStore(subscribe, installStepsOpen, () => false);
}

/** `installHintShown`, kept current: the hint goes the moment it is put away or used. */
export function useInstallHint(hasChats: boolean): boolean {
  const state = useInstallState();
  // Read on every change the store announces (a dismissal is one), not only when the state moves.
  const away = useSyncExternalStore(subscribe, hintPutAway, () => true);
  return !away && installHintShown(state, hasChats);
}

/** Tests only. */
export function resetInstallPrompt(): void {
  watching = false;
  deferred = null;
  justInstalled = false;
  stepsOpen = false;
  hintAway = false;
  emit();
}
