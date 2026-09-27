import { useSyncExternalStore } from "react";

/*
 * Installing the web app (a window of its own, an icon on the home screen or the dock). Chromium browsers say
 * when the app can be installed (`beforeinstallprompt`) and install it on request; Safari on iPhone and iPad
 * has no such event, so the app says where Add to Home Screen is. Only the web app watches for either
 * (`watchInstallPrompt` in web/src/main.tsx): the extension and Desktop are installed already.
 */

interface PromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * What Settings offers: `prompt`, a button the browser answers; `ios`, the steps in Safari's Share menu;
 * `installed`, running as the installed app already; `none`, nothing to offer here.
 */
export type InstallState = "prompt" | "ios" | "installed" | "none";

let watching = false;
let deferred: PromptEvent | null = null;
let justInstalled = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

function standalone(): boolean {
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

/** Listens for the browser's offer to install. As early as possible: Chromium may make it before the app renders. */
export function watchInstallPrompt(target: Window = window): void {
  if (watching) return;
  watching = true;
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
  if (justInstalled || standalone()) return "installed";
  if (deferred) return "prompt";
  return isAppleMobile() ? "ios" : "none";
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

/** Tests only. */
export function resetInstallPrompt(): void {
  watching = false;
  deferred = null;
  justInstalled = false;
  emit();
}
